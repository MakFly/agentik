import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { listRuns, readRun, type RunRecord } from "../src/runs.ts";
import { makeWorkspace } from "./helpers.ts";

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

const GOAL = "server_admin remote reboot of the production hypervisor and record sandbox workspace status";

async function awaitingRun(prefix: string): Promise<{ home: string; ws: string; rec: RunRecord }> {
  const home = await makeWorkspace(`${prefix}home-`);
  const ws = await makeWorkspace(`${prefix}ws-`);
  const r = await capture(() => main(["--backend", "mock", "--workspace", ws, "--agentik-home", home, GOAL]));
  expect(r.code).toBe(4);
  const [summary] = await listRuns({ home });
  const rec = (await readRun(summary.id, { home })) as RunRecord;
  expect(rec.status).toBe("awaiting_approval");
  expect(rec.report.pendingApprovals.length).toBeGreaterThan(0);
  return { home, ws, rec };
}

describe("agentik runs resume", () => {
  test("--approve all replays only the blocked task, releases exactly the frozen calls, writes a new run with resumedFrom", async () => {
    const { home, ws, rec } = await awaitingRun("resume-");
    const blocked = rec.report.taskResults.filter((t) => t.pendingApprovalIds.length > 0).map((t) => t.taskId);
    expect(blocked.length).toBeGreaterThan(0);
    expect(existsSync(join(ws, ".agentik", "admin-action.json"))).toBe(false);
    const r = await capture(() => main(["runs", "resume", rec.id, "--approve", "all", "--agentik-home", home]));
    expect(r.code).toBe(0);
    expect(r.err).toContain(`replaying ${blocked.join(", ")} of run ${rec.id}`);
    expect(existsSync(join(ws, ".agentik", "admin-action.json"))).toBe(true);
    const runs = await listRuns({ home });
    expect(runs).toHaveLength(2);
    const resumed = (await readRun(runs.find((x) => x.id !== rec.id)!.id, { home })) as RunRecord;
    expect(resumed.resumedFrom).toBe(rec.id);
    expect(resumed.status).toBe("completed");
    expect(resumed.report.planSource).toBe("resumed");
    // Only the blocked task ran again: no plan phase, act only for its assignee, then synthesize.
    const phases = resumed.report.workersInvoked.map((w) => w.phase);
    expect(phases).not.toContain("plan");
    const actRoles = new Set(resumed.report.workersInvoked.filter((w) => w.phase === "act").map((w) => w.role));
    const blockedRoles = new Set(rec.report.taskResults.filter((t) => blocked.includes(t.taskId)).map((t) => t.assignee));
    expect(actRoles).toEqual(blockedRoles);
    // The untouched tasks kept their stored results.
    for (const t of rec.report.taskResults.filter((t) => !blocked.includes(t.taskId))) {
      expect(resumed.report.taskResults.find((x) => x.taskId === t.taskId)?.summary).toBe(t.summary);
    }
    expect(resumed.report.executedTools.some((t) => t.tool === "server_admin")).toBe(true);
    expect(resumed.report.pendingApprovals).toHaveLength(0);
  });

  test("a single approval id; a wrong id exits 2; a completed run cannot be resumed", async () => {
    const { home, rec } = await awaitingRun("resume-one-");
    const first = rec.report.pendingApprovals[0].id;
    const bad = await capture(() => main(["runs", "resume", rec.id, "--approve", "approval-999", "--agentik-home", home]));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('no pending approval "approval-999"');
    const one = await capture(() => main(["runs", "resume", rec.id, "--approve", first, "--agentik-home", home]));
    expect(one.code).toBe(0);
    const runs = await listRuns({ home });
    const resumed = (await readRun(runs.find((x) => x.id !== rec.id)!.id, { home })) as RunRecord;
    const again = await capture(() => main(["runs", "resume", resumed.id, "--approve", "all", "--agentik-home", home]));
    expect(again.code).toBe(2);
    expect(again.err).toContain("nothing to resume");
    const noArgs = await capture(() => main(["runs", "resume", rec.id, "--agentik-home", home]));
    expect(noArgs.code).toBe(2);
  });

  test("the workspace moved since the run → exit 3, nothing replayed", async () => {
    const { home, ws, rec } = await awaitingRun("resume-moved-");
    expect(rec.artifactSnapshot?.length).toBeGreaterThan(0);
    const target = rec.artifactSnapshot![0].path;
    await writeFile(join(ws, target), `${await readFile(join(ws, target), "utf8").catch(() => "")}\nchanged\n`, "utf8");
    const r = await capture(() => main(["runs", "resume", rec.id, "--approve", "all", "--agentik-home", home]));
    expect(r.code).toBe(3);
    expect(r.err).toContain("the workspace moved since run");
    expect(r.err).toContain(target);
    expect(await listRuns({ home })).toHaveLength(1);
    expect(existsSync(join(ws, ".agentik", "admin-action.json"))).toBe(false);
  });
});
