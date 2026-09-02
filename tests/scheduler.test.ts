import { describe, expect, test } from "bun:test";
import { runLoop } from "../src/loop.ts";
import { runDag } from "../src/scheduler.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";
import { makeWorkspace, pair } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runDag (pure)", () => {
  type T = { id: string; dependsOn?: string[]; key: string; ms: number };
  type R = { status: "done" | "stalled" | "blocked" | "failed"; id: string; start: number; end: number };
  const run = async (t: T): Promise<R> => {
    const start = Date.now();
    await sleep(t.ms);
    return { status: "done", id: t.id, start, end: Date.now() };
  };
  const blocked = (t: T, missing: string[]): R => ({ status: "blocked", id: `${t.id}:${missing.join(",")}`, start: 0, end: 0 });

  test("independent tasks overlap up to concurrency; dependants wait; results in plan order", async () => {
    const tasks: T[] = [
      { id: "a", key: "wa", ms: 80 },
      { id: "b", key: "wb", ms: 80, dependsOn: ["a"] },
      { id: "c", key: "wc", ms: 80, dependsOn: ["a"] },
      { id: "d", key: "wd", ms: 80 },
      { id: "e", key: "we", ms: 20, dependsOn: ["a", "b", "c", "d"] },
    ];
    const t0 = Date.now();
    const rs = await runDag(tasks, { concurrency: 5, keyOf: (t) => t.key, run, blocked });
    expect(rs.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    const by = Object.fromEntries(rs.map((r) => [r.id, r]));
    expect(by.d.start - t0).toBeLessThan(50); // d starts with a
    expect(by.b.start).toBeGreaterThanOrEqual(by.a.end); // b waits for a
    expect(by.c.start).toBeGreaterThanOrEqual(by.a.end);
    expect(Math.abs(by.b.start - by.c.start)).toBeLessThan(50); // b and c overlap
    expect(by.e.start).toBeGreaterThanOrEqual(Math.max(by.b.end, by.c.end, by.d.end));
    expect(Date.now() - t0).toBeLessThan(80 * 5); // not sequential
  });

  test("concurrency 1 is sequential; one run per key even with concurrency 5", async () => {
    const tasks: T[] = [{ id: "a", key: "k", ms: 40 }, { id: "b", key: "k", ms: 40 }, { id: "c", key: "other", ms: 40 }];
    const rs = await runDag(tasks, { concurrency: 5, keyOf: (t) => t.key, run, blocked });
    const by = Object.fromEntries(rs.map((r) => [r.id, r]));
    expect(by.b.start).toBeGreaterThanOrEqual(by.a.end); // same key never overlaps
    expect(by.c.start - by.a.start).toBeLessThan(30); // different key overlaps
    const seq = await runDag(tasks, { concurrency: 1, keyOf: (t) => t.key, run, blocked });
    const s = Object.fromEntries(seq.map((r) => [r.id, r]));
    expect(s.c.start).toBeGreaterThanOrEqual(s.b.end);
  });

  test("a dependency that is not done blocks its dependants without running them", async () => {
    const tasks: T[] = [{ id: "a", key: "wa", ms: 5 }, { id: "b", key: "wb", ms: 5, dependsOn: ["a"] }, { id: "c", key: "wc", ms: 5, dependsOn: ["b"] }];
    let calls = 0;
    const rs = await runDag(tasks, {
      concurrency: 3,
      keyOf: (t) => t.key,
      run: async (t) => {
        calls += 1;
        return { status: t.id === "a" ? "stalled" : "done", id: t.id, start: 0, end: 0 };
      },
      blocked,
    });
    expect(calls).toBe(1);
    expect(rs.map((r) => [r.status, r.id])).toEqual([["stalled", "a"], ["blocked", "b:a"], ["blocked", "c:b"]]);
  });

  test("shouldStop stops new starts; runs in flight finish; the rest is skipped", async () => {
    let stop = false;
    const tasks: T[] = [{ id: "a", key: "wa", ms: 30 }, { id: "b", key: "wb", ms: 30 }, { id: "c", key: "wc", ms: 30 }];
    const rs = await runDag(tasks, {
      concurrency: 1,
      keyOf: (t) => t.key,
      run: async (t) => {
        const r = await run(t);
        stop = true;
        return r;
      },
      blocked,
      shouldStop: () => stop,
      skipped: (t) => ({ status: "blocked", id: `${t.id}:skipped`, start: 0, end: 0 }),
    });
    expect(rs.map((r) => r.id)).toEqual(["a", "b:skipped", "c:skipped"]);
  });
});

/** Acts with a delay so overlaps are observable. */
class Slow implements Backend {
  seen: Array<{ id: string; start: number; end: number }> = [];
  constructor(readonly id: string, private readonly plan: WorkerMessage["tasks"], private readonly ms: number) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    if (req.phase === "plan") return { text: "plan", tasks: this.plan };
    if (req.phase === "synthesize") return { text: "done" };
    const start = Date.now();
    await sleep(this.ms);
    this.seen.push({ id: req.task!.id, start, end: Date.now() });
    return { text: `${req.task!.id} done`, toolCalls: [] };
  }
}

describe("runLoop with the scheduler", () => {
  const plan = [
    { id: "a", assignee: "worker_a" as const, instruction: "x", allowedTools: ["read_file"] },
    { id: "b", assignee: "worker_b" as const, instruction: "x", allowedTools: ["read_file"], dependsOn: ["a"] },
    { id: "c", assignee: "worker_c" as const, instruction: "x", allowedTools: ["read_file"] },
  ];

  test("independent tasks run side by side (default concurrency = workerCount); results keep plan order", async () => {
    const ws = await makeWorkspace("dag-loop-");
    const a = new Slow("s-a", plan, 60);
    const b = new Slow("s-b", plan, 60);
    const c = new Slow("s-c", plan, 60);
    const t0 = Date.now();
    const report = await runLoop({ goal: "x", workspace: ws, workerA: a, workerB: b, workers: [a, b, c], workerCount: 3 });
    expect(report.status).toBe("completed");
    expect(report.taskResults.map((r) => [r.taskId, r.status])).toEqual([["a", "done"], ["b", "done"], ["c", "done"]]);
    expect(report.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(c.seen[0].start - a.seen[0].start).toBeLessThan(40); // a and c overlap
    expect(b.seen[0].start).toBeGreaterThanOrEqual(a.seen[0].end); // b after a
    expect(Date.now() - t0).toBeLessThan(60 * 3 + 40);
    const seq = await runLoop({ goal: "x", workspace: ws, workerA: new Slow("s-a", plan, 30), workerB: new Slow("s-b", plan, 30), workers: [new Slow("s-a", plan, 30), new Slow("s-b", plan, 30), new Slow("s-c", plan, 30)], workerCount: 3, concurrency: 1 });
    expect(seq.taskResults.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  test("a task awaiting approval blocks only its dependants; the run is awaiting_approval (exit 4 path)", async () => {
    const ws = await makeWorkspace("dag-appr-");
    const team = pair();
    const report = await runLoop({
      goal: "server_admin remote reboot of the production hypervisor and record sandbox workspace status",
      workspace: ws,
      workerA: team.workerA,
      workerB: team.workerB,
      workerCount: 2,
    });
    expect(report.status).toBe("awaiting_approval");
    expect(report.pendingApprovals.length).toBeGreaterThan(0);
    const waiting = report.taskResults.find((r) => r.pendingApprovalIds.length > 0)!;
    expect(waiting.status).toBe("blocked");
    const others = report.taskResults.filter((r) => r.taskId !== waiting.taskId);
    // task-b depends on task-a in the fallback plan; a mock plan has no deps, so others still ran.
    expect(others.every((r) => r.status === "done" || r.reason?.startsWith("dependency not done"))).toBe(true);
  });
});
