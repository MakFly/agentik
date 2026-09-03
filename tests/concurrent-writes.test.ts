import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentikHome, memoryPaths } from "../src/home.ts";
import { parseEntries } from "../src/memory-store.ts";
import { readSkillUsage } from "../src/skill-usage.ts";
import { upsertSkill } from "../src/skill-factory.ts";

/**
 * The corruption these tests exist for: "read the whole file, change it in memory, write it all
 * back" with no lock between PROCESSES. Two agentik sessions (a conductor and a detached
 * reviewer, two `agentik spawn` workers, a git hook and a run) share one home, and every one of
 * them reported success while dropping the others' writes.
 *
 * Nothing here is simulated: each case starts N real `bun src/cli.ts …` processes at once against
 * a throwaway home and counts what survived. Before `src/home-lock.ts` the counts were 5/8, 8/10
 * and 18/20; the assertions are the full counts, so a regression that removes the lock fails here.
 */

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function makeHome(prefix: string): Promise<string> {
  // Outside the repository: a home is not a workspace, and nothing here should ever be seen by
  // git (or by the code index, which walks `<repo>/.tmp`).
  return mkdtemp(join(tmpdir(), prefix));
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Start every command at once and wait for all of them; the overlap is the point. */
async function runAll(home: string, commands: string[][]): Promise<Ran[]> {
  const procs = commands.map((argv) =>
    Bun.spawn(["bun", CLI, ...argv], {
      env: { ...process.env, AGENTIK_HOME: home, AGENTIK_INDEX_AUTO: "0", AGENTIK_PROFILE: "" },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  return Promise.all(
    procs.map(async (p) => ({
      code: await p.exited,
      stdout: await new Response(p.stdout).text(),
      stderr: await new Response(p.stderr).text(),
    })),
  );
}

function failures(ran: Ran[]): string {
  // A losing writer used to exit 3 with an empty stderr and a "rejected: … modified out of band"
  // on stdout: it read the file between another process's write and its seal. Show both streams.
  return ran
    .filter((r) => r.code !== 0)
    .map((r) => `exit ${r.code}: ${[r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join(" | ")}`)
    .join("\n");
}

describe("concurrent writers against one agentik home", () => {
  test("8 simultaneous `memory retain` keep all 8 entries", async () => {
    const home = await makeHome("ak-conc-memory-");
    try {
      const ran = await runAll(
        home,
        Array.from({ length: 8 }, (_, i) => ["memory", "retain", `concurrent fact number ${i} about the store`]),
      );
      expect(failures(ran)).toBe("");

      const body = await readFile(memoryPaths(home).hot, "utf8");
      const entries = parseEntries(body);
      expect(entries.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(entries.some((e) => e.includes(`concurrent fact number ${i} `))).toBe(true);
      }

      // The audit trail and the content must agree. Before the lock the journal held 8 rows and
      // the file held 5 — a silent, permanent divergence between what agentik says it wrote and
      // what it kept.
      const { listMemoryOps } = await import("../src/memory-log.ts");
      const log = await listMemoryOps({ home, limit: 100 });
      expect(log.filter((op) => op.op === "add").length).toBe(8);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("8 simultaneous `memory retain` leave the file sealed and readable", async () => {
    const home = await makeHome("ak-conc-seal-");
    try {
      await runAll(home, Array.from({ length: 8 }, (_, i) => ["memory", "retain", `sealed fact ${i} kept whole`]));
      const { memorySnapshot } = await import("../src/memory-store.ts");
      const snap = await memorySnapshot("memory", home);
      // Lost writes used to be *sealed*: the seal matched the truncated file, so nothing ever
      // reported the loss. The seal must still match — and now over all 8 entries.
      expect(snap.diverged).toBeUndefined();
      expect(parseEntries(snap.body).length).toBe(8);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("10 simultaneous `skill update` keep all 10 lines", async () => {
    const home = await makeHome("ak-conc-skill-");
    try {
      await upsertSkill({
        name: "concurrent-store-writes",
        description: "how a shared store survives parallel writers",
        steps: ["baseline step"],
        home,
      });
      const ran = await runAll(
        home,
        Array.from({ length: 10 }, (_, i) => [
          "skill",
          "update",
          "concurrent-store-writes",
          `parallel patch number ${i} landed`,
        ]),
      );
      expect(failures(ran)).toBe("");

      const body = await readFile(join(memoryPaths(home).skills, "concurrent-store-writes", "SKILL.md"), "utf8");
      const landed = Array.from({ length: 10 }, (_, i) => i).filter((i) =>
        body.includes(`parallel patch number ${i} landed`),
      );
      expect(landed.length).toBe(10);

      // The ledger already recorded 10 writes and 10 backups existed; only the body lost lines.
      const { readLedger } = await import("../src/curator.ts");
      const ledger = await readLedger({ home });
      expect(ledger.filter((e) => "action" in e && e.action === "update").length).toBe(10);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("the legacy sweep does not eat a `memory retain` racing it", async () => {
    const home = await makeHome("ak-conc-sweep-");
    try {
      // Every open of the sessions store rewrites MEMORY.md whole when a `- (session)` line is
      // still in it (sweepLegacySessionLines / migrateLegacyMemory). Six retains open that store
      // at the same time, so the sweep and the writes overlap by construction.
      await mkdir(memoryPaths(home).memoryDir, { recursive: true });
      await writeFile(
        memoryPaths(home).hot,
        "a durable fact from before\n§\n- (session) session: did a thing [completed] artifacts=none\n",
        "utf8",
      );
      const ran = await runAll(home, Array.from({ length: 6 }, (_, i) => ["memory", "retain", `swept-era fact ${i} survives`]));
      expect(failures(ran)).toBe("");

      const body = await readFile(memoryPaths(home).hot, "utf8");
      expect(body).not.toContain("- (session)"); // the sweep did run
      const entries = parseEntries(body);
      for (let i = 0; i < 6; i++) expect(entries.some((e) => e.includes(`swept-era fact ${i} `))).toBe(true);
      expect(entries.some((e) => e.includes("a durable fact from before"))).toBe(true);
      expect(entries.length).toBe(7);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("20 simultaneous `skills view` count 20 views", async () => {
    const home = await makeHome("ak-conc-usage-");
    try {
      await upsertSkill({
        name: "parallel-view-counter",
        description: "usage counters under parallel readers",
        steps: ["baseline step"],
        home,
      });
      const ran = await runAll(home, Array.from({ length: 20 }, () => ["skills", "view", "parallel-view-counter"]));
      expect(failures(ran)).toBe("");

      const usage = await readSkillUsage({ home });
      // Under-counting is not cosmetic: `agentik skills curate` archives on this number, so a
      // skill several workers use in parallel ages faster than it is used.
      expect(usage["parallel-view-counter"]?.views).toBe(20);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

test("the throwaway homes never resolve to the developer's own", () => {
  expect(agentikHome("/tmp/somewhere")).toBe("/tmp/somewhere");
});
