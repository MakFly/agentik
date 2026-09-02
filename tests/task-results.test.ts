import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { formatReport, mergeClaims, runLoop, taskResultEnvelope } from "../src/loop.ts";
import type { Backend, BoundedTask, CompleteRequest, WorkerMessage } from "../src/types.ts";
import { makeWorkspace, pair } from "./helpers.ts";

/** Plans what it is told, acts by script per task id, records every request. */
class Scripted implements Backend {
  seen: CompleteRequest[] = [];
  constructor(readonly id: string, private readonly plan: WorkerMessage["tasks"], private readonly acts: Record<string, WorkerMessage[]>) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    if (req.phase === "plan") return { text: "plan", tasks: this.plan };
    if (req.phase === "synthesize") return { text: "all done\nsecond line of the synthesis", claims: [{ text: "claim one" }] };
    const id = req.task?.id ?? "?";
    const n = this.seen.filter((r) => r.phase === "act" && r.task?.id === id).length;
    return this.acts[id]?.[n - 1] ?? { text: `${id} finished`, toolCalls: [] };
  }
}

const write = (path: string, content: string): WorkerMessage => ({ text: `writing ${path}`, toolCalls: [{ tool: "write_file", args: { path, content } }] });
const stop = (text: string): WorkerMessage => ({ text, toolCalls: [] });

describe("TaskResult per task", () => {
  test("status, evidence.calls with durations, summary, artifacts; context is per task with dependency results as DATA", async () => {
    const ws = await makeWorkspace("tr-ctx-");
    const plan = [
      { id: "impl", assignee: "worker_a" as const, instruction: "write a.txt", allowedTools: ["write_file", "read_file"] },
      { id: "check", assignee: "worker_b" as const, instruction: "check a.txt", allowedTools: ["read_file"], dependsOn: ["impl"] },
    ];
    const a = new Scripted("s-a", plan, { impl: [write("a.txt", "A"), stop("impl done: wrote a.txt")] });
    const b = new Scripted("s-b", plan, { check: [{ text: "reading", toolCalls: [{ tool: "read_file", args: { path: "a.txt" } }] }, stop("check done")] });
    const report = await runLoop({ goal: "write a.txt then check it", workspace: ws, workerA: a, workerB: b });
    expect(report.status).toBe("completed");
    expect(report.taskResults.map((r) => [r.taskId, r.status])).toEqual([["impl", "done"], ["check", "done"]]);
    const impl = report.taskResults[0];
    expect(impl.summary).toBe("impl done: wrote a.txt");
    expect(impl.artifacts).toEqual(["a.txt"]);
    expect(impl.evidence).toMatchObject({ steps: 2, executed: 1, blocked: 0 });
    expect(impl.evidence.calls).toHaveLength(1);
    expect(impl.evidence.calls[0]).toMatchObject({ tool: "write_file", ok: true, artifact: "a.txt" });
    expect(impl.evidence.calls[0].callId).toMatch(/^worker_a-write_file-\d+$/);
    expect(typeof impl.evidence.calls[0].durationMs).toBe("number");
    expect(impl.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(impl.endedAt)).toBeGreaterThanOrEqual(Date.parse(impl.startedAt));
    // Task "check" saw impl's result as DATA and nothing of impl's tool outputs or prose.
    const checkReqs = b.seen.filter((r) => r.phase === "act" && r.task?.id === "check");
    const origins = checkReqs[0].envelopes.map((e) => e.origin);
    expect(origins).toEqual(["task:impl"]);
    expect(checkReqs[0].envelopes[0].body).toContain('"status":"done"');
    expect(checkReqs[0].envelopes[0].body).toContain('"artifacts":["a.txt"]');
    expect(checkReqs[1].envelopes.map((e) => e.origin)).toEqual(["task:impl", "worker_b", "tool:read_file"]);
    // Call ids are monotone across tasks.
    const ids = report.taskResults.flatMap((r) => r.evidence.calls.map((c) => Number(c.callId.split("-").pop())));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    // The synthesizer got the task results and no tool outputs.
    const synth = [...a.seen, ...b.seen].find((r) => r.phase === "synthesize")!;
    expect(synth.envelopes.map((e) => e.origin)).toEqual(["task:impl", "task:check"]);
    expect(report.synthesis).toBe("all done\nsecond line of the synthesis");
    const text = formatReport(report);
    expect(text).toContain("impl worker_a · tools=write_file,read_file · done ·");
    expect(text).toContain("check worker_b · tools=read_file · after=impl · done ·");
    expect(text).toContain("synthesis:\n  all done\n  second line of the synthesis");
  });

  test("a dependency that is not done blocks its dependants without a model call", async () => {
    const ws = await makeWorkspace("tr-dep-");
    const plan = [
      { id: "impl", assignee: "worker_a" as const, instruction: "write", allowedTools: ["write_file"] },
      { id: "check", assignee: "worker_b" as const, instruction: "check", allowedTools: ["read_file"], dependsOn: ["impl"] },
    ];
    // worker_a answers nothing readable twice → stalled.
    const a = new Scripted("s-a", plan, { impl: [{ text: "", toolCalls: [] }, { text: "", toolCalls: [] }] });
    const b = new Scripted("s-b", plan, {});
    const report = await runLoop({ goal: "x", workspace: ws, workerA: a, workerB: b });
    expect(report.taskResults.map((r) => r.status)).toEqual(["stalled", "blocked"]);
    expect(report.taskResults[1].reason).toBe("dependency not done: impl");
    expect(b.seen.filter((r) => r.phase === "act")).toHaveLength(0);
    expect(report.stalledTasks.map((t) => t.taskId)).toEqual(["impl"]);
  });

  test("acceptance: untouched artifact → failed; command check runs as the orchestrator; requireTools", async () => {
    const ws = await makeWorkspace("tr-acc-");
    await writeFile(join(ws, "keep.txt"), "old", "utf8");
    const plan = [
      { id: "a", assignee: "worker_a" as const, instruction: "touch keep.txt", allowedTools: ["read_file"], acceptance: { expectArtifacts: ["keep.txt"] } },
      { id: "b", assignee: "worker_b" as const, instruction: "make b.txt", allowedTools: ["write_file"], acceptance: { expectArtifacts: ["b.txt"], requireTools: true, command: "test -f b.txt" } },
    ];
    const a = new Scripted("s-a", plan, { a: [stop("I did nothing to keep.txt")] });
    const b = new Scripted("s-b", plan, { b: [write("b.txt", "B"), stop("done")] });
    const report = await runLoop({ goal: "x", workspace: ws, workerA: a, workerB: b });
    const [ra, rb] = report.taskResults;
    expect(ra.status).toBe("failed");
    expect(ra.reason).toBe("acceptance: untouched: keep.txt");
    expect(ra.evidence.acceptance).toEqual({ ok: false, problems: ["untouched: keep.txt"] });
    expect(rb.status).toBe("done");
    expect(rb.evidence.acceptance?.ok).toBe(true);
    expect(rb.evidence.acceptance?.command).toMatchObject({ cmd: "test -f b.txt", ok: true });
    expect(rb.evidence.calls.map((c) => c.callId.startsWith("orchestrator-run_command-"))).toEqual([false, true]);
    expect(formatReport(report)).toContain("acceptance=FAILED: untouched: keep.txt");
    const noTools = new Scripted("s-c", [{ id: "c", assignee: "worker_a" as const, instruction: "x", allowedTools: ["read_file"], acceptance: { requireTools: true } }], { c: [stop("talked only")] });
    const r2 = await runLoop({ goal: "x", workspace: ws, workerA: noTools, workerB: new Scripted("s-d", [], {}) });
    expect(r2.taskResults[0]).toMatchObject({ status: "failed", reason: "acceptance: no tool executed" });
  });

  test("a withheld approval leaves the task blocked with its approval ids and the run awaiting_approval", async () => {
    const ws = await makeWorkspace("tr-appr-");
    const report = await runLoop({ goal: "server_admin remote reboot of the production hypervisor", workspace: ws, ...pair() });
    expect(report.status).toBe("awaiting_approval");
    const blockedTask = report.taskResults.find((r) => r.pendingApprovalIds.length > 0);
    expect(blockedTask).toBeDefined();
    expect(blockedTask!.status).toBe("blocked");
    expect(blockedTask!.reason).toContain("awaiting approval: approval-");
    expect(report.pendingApprovals.map((a) => a.id)).toEqual(expect.arrayContaining(blockedTask!.pendingApprovalIds));
  });

  test("mergeClaims deduplicates on (text, url); taskResultEnvelope is inter_agent DATA", () => {
    const merged = mergeClaims([{ text: "a", verified: false }], [{ text: "a", verified: false }, { text: "a", source: { url: "u", retrievedAt: "" }, verified: true }, { text: "b", verified: false }]);
    expect(merged.map((c) => `${c.text}/${c.source?.url ?? ""}`)).toEqual(["a/", "a/u", "b/"]);
    const env = taskResultEnvelope({ taskId: "t", assignee: "worker_a", backend: "m", status: "done", summary: "s", artifacts: ["x"], claims: [], evidence: { steps: 1, executed: 1, blocked: 0, calls: [] }, pendingApprovalIds: [], startedAt: "", endedAt: "", durationMs: 1 });
    expect(env.origin).toBe("task:t");
    expect(env.channel).toBe("inter_agent");
    expect(JSON.parse(env.body)).toEqual({ taskId: "t", status: "done", summary: "s", artifacts: ["x"] });
  });

  test("--json exposes taskResults with taskId, status and durationMs", async () => {
    const ws = await makeWorkspace("tr-json-");
    const home = await makeWorkspace("tr-json-home-");
    const chunks: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
    let code: number;
    try {
      code = await main(["--backend", "mock", "--workers", "3", "--json", "--workspace", ws, "--agentik-home", home, "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status"]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(chunks.find((c) => c.trim().startsWith("{"))!) as { planSource: string; taskResults: Array<{ taskId: string; status: string; durationMs: number }> };
    expect(parsed.planSource).toBe("model");
    expect(parsed.taskResults).toHaveLength(3);
    for (const r of parsed.taskResults) {
      expect(r.status).toBe("done");
      expect(typeof r.durationMs).toBe("number");
    }
  });
});
