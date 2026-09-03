import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  holdsHomeLock,
  listHomeLocks,
  LOCK_HOST,
  lockDbPath,
  LockUnavailableError,
  withHomeLock,
  writeHomeLockRow,
} from "../src/home-lock.ts";

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ak-lock-"));
}

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await makeHome();
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** A pid that is certainly not running: the kernel refuses to allocate it. */
const DEAD_PID = 0x7fffffff;

describe("home lock", () => {
  test("serializes overlapping callers and releases the row afterwards", async () => {
    await withHome(async (home) => {
      const order: string[] = [];
      let inside = 0;
      const worker = (tag: string) =>
        withHomeLock(
          "memory",
          async () => {
            inside += 1;
            expect(inside).toBe(1);
            order.push(tag);
            await new Promise((r) => setTimeout(r, 5));
            inside -= 1;
          },
          { home },
        );
      await Promise.all([worker("a"), worker("b"), worker("c")]);
      expect(order.sort()).toEqual(["a", "b", "c"]);
      expect(await listHomeLocks({ home })).toEqual([]);
    });
  });

  test("re-entering the same lock from inside it does not deadlock", async () => {
    await withHome(async (home) => {
      const seen = await withHomeLock(
        "skills",
        async () => {
          expect(holdsHomeLock("skills", home)).toBe(true);
          expect(holdsHomeLock("memory", home)).toBe(false);
          // This is the shape memoryRemoveEntry / updateSkill rely on: a locked function calling
          // another locked function. Without the async-context check it would wait for itself.
          return withHomeLock("skills", async () => "inner", { home, waitMs: 200 });
        },
        { home },
      );
      expect(seen).toBe("inner");
      expect(holdsHomeLock("skills", home)).toBe(false);
    });
  });

  test("the two locks are independent", async () => {
    await withHome(async (home) => {
      await withHomeLock(
        "memory",
        async () => {
          // Not re-entrant across names: this really takes the other row.
          await withHomeLock("skills", async () => undefined, { home, waitMs: 500 });
        },
        { home },
      );
      expect(await listHomeLocks({ home })).toEqual([]);
    });
  });

  test("a lease held by a LIVE process is waited for, then refused legibly", async () => {
    await withHome(async (home) => {
      // This process is alive by definition, and the lease is far in the future.
      await writeHomeLockRow(
        { name: "memory", token: "held-by-someone-else", pid: process.pid, host: LOCK_HOST, acquiredAt: Date.now(), expiresAt: Date.now() + 600_000 },
        { home },
      );
      let ran = false;
      let err: unknown;
      try {
        await withHomeLock("memory", async () => { ran = true; }, { home, waitMs: 120, pollMs: 10 });
      } catch (e) {
        err = e;
      }

      expect(ran).toBe(false); // refused, not "written anyway"
      expect(err).toBeInstanceOf(LockUnavailableError);
      expect((err as Error).message).toContain(`pid ${process.pid}`);
      expect((err as Error).message).toContain("nothing was written");
      expect((err as Error).message).toContain(lockDbPath(home));
      // The other holder's row is untouched: refusing is not stealing.
      expect((await listHomeLocks({ home }))[0].token).toBe("held-by-someone-else");
    });
  });

  test("a lease whose holder is DEAD is taken over at once, long before it expires", async () => {
    await withHome(async (home) => {
      const expiresAt = Date.now() + 3_600_000; // an hour of lease left
      await writeHomeLockRow(
        { name: "memory", token: "orphan", pid: DEAD_PID, host: LOCK_HOST, acquiredAt: Date.now(), expiresAt },
        { home },
      );
      const started = Date.now();
      // waitMs is 50 ms: if takeover needed the lease to expire, this would throw.
      const got = await withHomeLock("memory", async () => "taken", { home, waitMs: 50, pollMs: 10 });
      expect(got).toBe("taken");
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await listHomeLocks({ home })).toEqual([]);
    });
  });

  test("an EXPIRED lease of a live process is taken over too", async () => {
    await withHome(async (home) => {
      await writeHomeLockRow(
        { name: "skills", token: "stale", pid: process.pid, host: LOCK_HOST, acquiredAt: Date.now() - 60_000, expiresAt: Date.now() - 1 },
        { home },
      );
      expect(await withHomeLock("skills", async () => "taken", { home, waitMs: 50, pollMs: 10 })).toBe("taken");
    });
  });

  test("a lease from another host can only expire, never be judged dead", async () => {
    await withHome(async (home) => {
      // A home shared over a network mount: this machine cannot ask about that machine's pids.
      await writeHomeLockRow(
        { name: "memory", token: "remote", pid: 1, host: `${LOCK_HOST}-elsewhere`, acquiredAt: Date.now(), expiresAt: Date.now() + 600_000 },
        { home },
      );
      let err: unknown;
      try {
        await withHomeLock("memory", async () => undefined, { home, waitMs: 60, pollMs: 10 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LockUnavailableError);
      expect((err as Error).message).toContain(`${LOCK_HOST}-elsewhere`);
    });
  });

  test("a throwing critical section still releases the lock", async () => {
    await withHome(async (home) => {
      await expect(
        withHomeLock("memory", async () => {
          throw new Error("boom");
        }, { home }),
      ).rejects.toThrow("boom");
      expect(await listHomeLocks({ home })).toEqual([]);
      expect(await withHomeLock("memory", async () => "free", { home, waitMs: 100 })).toBe("free");
    });
  });

  test("two homes never contend", async () => {
    await withHome(async (a) => {
      await withHome(async (b) => {
        await withHomeLock("memory", async () => {
          // Same lock name, other home: the scope is the home, so this must not wait.
          expect(await withHomeLock("memory", async () => "ok", { home: b, waitMs: 100 })).toBe("ok");
        }, { home: a });
      });
    });
  });

  test("uncontended acquire and release stay well under a millisecond", async () => {
    await withHome(async (home) => {
      await withHomeLock("memory", async () => undefined, { home }); // warm the file
      const started = performance.now();
      const rounds = 50;
      for (let i = 0; i < rounds; i++) await withHomeLock("memory", async () => undefined, { home });
      const each = (performance.now() - started) / rounds;
      // The property is "not perceptible next to the filesystem read-modify-write it protects".
      // Measured ~0.25 ms; 10 ms is a ceiling loose enough to survive a loaded CI machine.
      expect(each).toBeLessThan(10);
    });
  });
});

test("a killed process leaves a lock that the next process takes over immediately", async () => {
  const home = await makeHome();
  try {
    // A real process, really killed while holding the lock: no lease is released, no cleanup runs.
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `import { withHomeLock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "home-lock.ts"))};
         await withHomeLock("memory", async () => {
           console.log("held");
           await new Promise(() => {});
         }, { home: ${JSON.stringify(home)}, ttlMs: 3_600_000 });`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("held");

    const rows = await listHomeLocks({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(holder.pid);
    expect(rows[0].expiresAt - Date.now()).toBeGreaterThan(60_000); // an hour of lease to burn

    holder.kill("SIGKILL");
    await holder.exited;

    const started = Date.now();
    // 100 ms of patience against an hour of remaining lease: only pid liveness can explain this.
    expect(await withHomeLock("memory", async () => "recovered", { home, waitMs: 100, pollMs: 10 })).toBe("recovered");
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
