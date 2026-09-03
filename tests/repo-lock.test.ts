import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fastForwardMerge,
  gitCommonDir,
  listRepoLocks,
  REPO_LOCK_FILE,
  REPO_LOCK_HOST,
  REPO_LOCK_NAME,
  RepoLockUnavailableError,
  repoLockPath,
  withRepoLock,
  writeRepoLockRow,
} from "../src/repo-lock.ts";

/**
 * `git merge --ff-only` is NOT atomic, and the loser of the race corrupts the checkout.
 *
 * Every repository here lives in `os.tmpdir()`, never under `<repo>/.tmp/`: git resolves the
 * hooks of a directory inside this checkout to THIS repository's `.git/hooks` (an earlier test
 * installed hooks in the main checkout that way), and these tests run real git.
 */

const SRC = join(import.meta.dir, "..", "src", "repo-lock.ts");

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], cwd: string): Promise<Ran> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } });
  return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
}

async function git(args: string[], cwd: string): Promise<Ran> {
  const res = await run(["git", ...args], cwd);
  if (res.code !== 0 && !args.includes("--ff-only")) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res;
}

async function porcelain(cwd: string): Promise<string[]> {
  const res = await git(["status", "--porcelain"], cwd);
  return res.stdout.split("\n").filter((l) => l.trim().length > 0);
}

/**
 * A throwaway repository: a base commit, a `wide` branch whose merge takes long enough to be
 * observed mid-flight, and one small branch per extra name. Every branch starts from the base, so
 * each of them is a legitimate fast-forward from it — the exact shape of "five worktrees merged
 * into develop".
 */
async function makeRepo(opts: { wideFiles?: number; branches?: string[] } = {}): Promise<{ dir: string; base: string; tips: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "ak-repo-lock-"));
  await git(["init", "-q", "-b", "main", "."], dir);
  await git(["config", "user.email", "test@agentik.local"], dir);
  await git(["config", "user.name", "agentik test"], dir);
  await git(["config", "commit.gpgsign", "false"], dir);
  await writeFile(join(dir, "base.txt"), "base\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-qm", "base"], dir);
  const base = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  const tips: Record<string, string> = {};
  if (opts.wideFiles) {
    await git(["checkout", "-q", "-b", "wide", base], dir);
    mkdirSync(join(dir, "wide"), { recursive: true });
    // Written straight to disk: 4000 files is what makes the merge's tree update long enough to
    // catch it between "the tree is written" and "the ref is updated".
    await Promise.all(
      Array.from({ length: opts.wideFiles }, (_, i) => writeFile(join(dir, "wide", `f${i}.txt`), `content ${i}\n`)),
    );
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", "wide"], dir);
    tips.wide = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  }
  for (const name of opts.branches ?? []) {
    await git(["checkout", "-q", "-b", name, base], dir);
    await writeFile(join(dir, `${name}.txt`), `${name}\n`);
    await git(["add", "-A"], dir);
    await git(["commit", "-qm", name], dir);
    tips[name] = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  }
  await git(["checkout", "-q", "main"], dir);
  return { dir, base, tips };
}

/** Poll until `path` exists (or the budget runs out): a real event, not a sleep. */
async function waitFor(path: string, budgetMs = 5000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return false;
}

describe("the fast-forward merge race (no lock)", () => {
  /**
   * The corruption, deterministically.
   *
   * Three concurrent `git merge --ff-only` reproduce it by luck — measured on this machine at
   * 8/20, 20/20 and 0/10 rounds depending on load, which is a flaky test, not a proof. So the
   * second merge is reduced to the only thing it does to us: it moves the ref while our tree
   * update runs (`git update-ref refs/heads/main <tip> <base>`, a real, separate git process,
   * with the compare-and-swap that makes the ordering unambiguous). The trigger is the appearance
   * of the first file the merge writes, so the ref moves strictly between "git started updating
   * the tree" and "git updates the ref".
   *
   * What comes out is the incident, byte for byte: the merge exits non-zero on
   * `cannot lock ref 'HEAD'`, and the checkout is left with STAGED files from a branch that was
   * never merged. The next `git commit` carries them.
   */
  test("git updates the tree first and the ref last, and restores nothing when the ref moves", async () => {
    const { dir, base, tips } = await makeRepo({ wideFiles: 4000, branches: ["other"] });
    try {
      expect(await porcelain(dir)).toEqual([]);
      const merge = Bun.spawn(["git", "merge", "--ff-only", "wide"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const started = await waitFor(join(dir, "wide", "f0.txt"));
      expect(started).toBe(true);
      const moved = await git(["update-ref", "refs/heads/main", tips.other, base], dir);
      expect(moved.code).toBe(0);
      const code = await merge.exited;
      const err = await new Response(merge.stderr).text();

      expect(code).not.toBe(0);
      expect(err).toContain("cannot lock ref 'HEAD'");
      // HEAD is `other`; the index holds `wide`'s files. Neither branch was merged into the other.
      expect((await git(["rev-parse", "HEAD"], dir)).stdout.trim()).toBe(tips.other);
      const dirty = await porcelain(dir);
      const staged = dirty.filter((l) => l.startsWith("A "));
      expect(staged.length).toBeGreaterThan(3000);
      expect(staged.some((l) => l.includes("wide/f0.txt"))).toBe(true);
      // …and `wide` is not in the history at all: these are files of a branch never merged.
      const contains = await run(["git", "merge-base", "--is-ancestor", tips.wide, "HEAD"], dir);
      expect(contains.code).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("fastForwardMerge", () => {
  test("a lone fast-forward merge is neutral: it moves HEAD and leaves the tree clean", async () => {
    const { dir, tips } = await makeRepo({ branches: ["feat"] });
    try {
      const res = await fastForwardMerge({ workspace: dir, ref: "feat" });
      expect(res.ok).toBe(true);
      expect(res.to).toBe(tips.feat);
      expect(res.alreadyUpToDate).toBe(false);
      expect(res.statusAfter).toEqual([]);
      expect((await git(["rev-parse", "HEAD"], dir)).stdout.trim()).toBe(tips.feat);
      // The lease is gone: the lock is free for the next caller.
      expect(listRepoLocks(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a diverged branch is a legible refusal, not a corruption", async () => {
    const { dir } = await makeRepo({ branches: ["a", "b"] });
    try {
      expect((await fastForwardMerge({ workspace: dir, ref: "a" })).ok).toBe(true);
      const res = await fastForwardMerge({ workspace: dir, ref: "b" });
      expect(res.ok).toBe(false);
      expect(res.failure).toBe("merge_failed");
      expect(res.reason).toContain("Not possible to fast-forward");
      expect(await porcelain(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The lock cannot make git atomic against a process that does not take it (a human's shell, an
   * editor, a hook). The `git status --porcelain` witness taken on both sides is what catches it:
   * the merge "succeeded" or failed, but the index moved during the operation, so the result is
   * `raced` and names the entries — instead of a silent staged tree the next commit would carry.
   */
  test("an index that moves during the merge is reported `raced`, never passed off as success", async () => {
    const { dir, base, tips } = await makeRepo({ wideFiles: 4000, branches: ["other"] });
    try {
      const merged = fastForwardMerge({ workspace: dir, ref: "wide" });
      expect(await waitFor(join(dir, "wide", "f0.txt"))).toBe(true);
      expect((await git(["update-ref", "refs/heads/main", tips.other, base], dir)).code).toBe(0);
      const res = await merged;
      expect(res.ok).toBe(false);
      expect(res.failure).toBe("raced");
      expect(res.reason).toContain("another process raced this repository");
      expect(res.statusBefore).toEqual([]);
      expect(res.statusAfter!.length).toBeGreaterThan(3000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * The A/B: the same three-way merge race, this time with every participant taking the lock, in
   * three REAL processes started at once. The lock serializes them, so each merge runs alone: one
   * of them fast-forwards, the other two find a diverged branch and refuse cleanly, and the
   * checkout is left with nothing staged. Without the lock this is the shape that leaves `A p2.txt`
   * in the main checkout.
   */
  test("three concurrent processes merging under the lock leave the checkout clean", async () => {
    const { dir, tips } = await makeRepo({ branches: ["p1", "p2", "p3"] });
    // The helper lives OUTSIDE the repository: a file written inside it would show up as `??` in
    // the very witness this test reads.
    const scriptDir = await mkdtemp(join(tmpdir(), "ak-repo-lock-bin-"));
    const script = join(scriptDir, "merge-under-lock.ts");
    try {
      await writeFile(
        script,
        `import { fastForwardMerge } from ${JSON.stringify(SRC)};\n` +
          `const [ws, ref] = process.argv.slice(2);\n` +
          `console.log(JSON.stringify(await fastForwardMerge({ workspace: ws, ref, waitMs: 20000 })));\n`,
      );
      const procs = ["p1", "p2", "p3"].map((ref) =>
        Bun.spawn([process.execPath, script, dir, ref], { cwd: dir, stdout: "pipe", stderr: "pipe" }),
      );
      const outs = await Promise.all(
        procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })),
      );
      expect(outs.map((o) => o.code)).toEqual([0, 0, 0]);
      const results = outs.map((o) => JSON.parse(o.out.trim()) as Awaited<ReturnType<typeof fastForwardMerge>>);
      expect(results.filter((r) => r.ok).length).toBe(1);
      for (const r of results.filter((r) => !r.ok)) {
        // Diverged is the honest answer once somebody else fast-forwarded; `raced` never appears.
        expect(r.failure).toBe("merge_failed");
      }
      // The whole point: no file of a branch that was not merged is left staged.
      expect(await porcelain(dir)).toEqual([]);
      const headSha = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
      expect(Object.values(tips)).toContain(headSha);
      expect(listRepoLocks(dir)).toEqual([]);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the repository lock itself", () => {
  test("its scope is the repository: a linked worktree takes the same lock file", async () => {
    const { dir } = await makeRepo({ branches: ["feat"] });
    const linked = join(dir, "..", `${dir.split("/").pop()}-wt`);
    try {
      await git(["worktree", "add", "-q", linked, "feat"], dir);
      const main = repoLockPath(dir);
      const wt = repoLockPath(linked);
      expect("path" in main && "path" in wt && main.path === wt.path).toBe(true);
      expect("path" in main && main.path).toBe(join(gitCommonDir(dir)!, REPO_LOCK_FILE));
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a directory that is not a git checkout is refused, never silently unlocked", async () => {
    const plain = await mkdtemp(join(tmpdir(), "ak-repo-lock-plain-"));
    try {
      const found = repoLockPath(plain);
      expect("refused" in found).toBe(true);
      await expect(withRepoLock(plain, async () => "never")).rejects.toThrow(/not a git checkout/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  }, 30_000);

  test("a live holder is refused by name after waitMs, and nothing runs", async () => {
    const { dir } = await makeRepo();
    try {
      writeRepoLockRow(dir, {
        name: REPO_LOCK_NAME,
        token: "held-by-someone-else",
        pid: process.pid, // alive by construction: this process
        host: REPO_LOCK_HOST,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      let ran = false;
      const err = await withRepoLock(dir, () => ((ran = true), "x"), { waitMs: 120, pollMs: 10 }).catch((e) => e);
      expect(err).toBeInstanceOf(RepoLockUnavailableError);
      expect(String(err)).toContain(`pid ${process.pid}`);
      expect(String(err)).toContain("nothing was run");
      expect(ran).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a holder that is gone is taken over at once, without waiting out the lease", async () => {
    const { dir } = await makeRepo();
    try {
      // A real process, really killed: its pid is gone, its lease has an hour left.
      const victim = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
      const pid = victim.pid;
      victim.kill(9);
      await victim.exited;
      writeRepoLockRow(dir, { name: REPO_LOCK_NAME, token: "dead", pid, host: REPO_LOCK_HOST, acquiredAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
      const started = Date.now();
      const got = await withRepoLock(dir, () => "taken", { waitMs: 2000, pollMs: 10 });
      expect(got).toBe("taken");
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("re-entrant in one async context, serialized between contexts", async () => {
    const { dir } = await makeRepo();
    try {
      const inner = await withRepoLock(dir, async () => withRepoLock(dir, async () => "nested"));
      expect(inner).toBe("nested");

      const order: string[] = [];
      const a = withRepoLock(dir, async () => {
        order.push("a-in");
        await new Promise((r) => setTimeout(r, 50));
        order.push("a-out");
      });
      const b = withRepoLock(dir, async () => {
        order.push("b-in");
        order.push("b-out");
      });
      await Promise.all([a, b]);
      expect(order).toEqual(["a-in", "a-out", "b-in", "b-out"]);
      expect(listRepoLocks(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a throwing critical section still releases the lock", async () => {
    const { dir } = await makeRepo();
    try {
      await expect(
        withRepoLock(dir, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(listRepoLocks(dir)).toEqual([]);
      expect(await withRepoLock(dir, () => "free")).toBe("free");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
