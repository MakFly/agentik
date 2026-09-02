import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { callHash, canonicalJson, ToolGuard } from "../src/guardrails.ts";
import { runLoop } from "../src/loop.ts";
import { executeTool } from "../src/tools.ts";
import type { Backend, CompleteRequest, ToolCall, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

describe("ToolGuard", () => {
  test("canonical hash: key order does not matter, values do", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(callHash("run_command", { cmd: "ls", timeout_s: 5 })).toBe(callHash("run_command", { timeout_s: 5, cmd: "ls" }));
    expect(callHash("run_command", { cmd: "ls" })).not.toBe(callHash("run_command", { cmd: "ls -la" }));
  });

  test("same failing call: warn at 2, block at 3; a success resets", () => {
    const g = new ToolGuard();
    const call = { tool: "run_command", args: { cmd: "bun test" } };
    expect(g.before(call)).toEqual({});
    g.after(call, false, "exit 1");
    expect(g.before(call)).toEqual({});
    g.after(call, false, "exit 1 again");
    expect(g.before(call).warn).toContain("already failed 2 times");
    expect(g.before(call)).toEqual({}); // warned once
    g.after(call, false, "exit 1 yet again");
    expect(g.before(call).block).toContain("repeated_failing_call");
    expect(g.before({ tool: "run_command", args: { cmd: "bun test x" } })).toEqual({});
    const g2 = new ToolGuard();
    g2.after(call, false, "a");
    g2.after(call, false, "b");
    g2.after(call, true, "ok");
    expect(g2.before(call)).toEqual({});
  });

  test("no_progress: the same result three times in a row blocks the next call", () => {
    const g = new ToolGuard();
    const a = { tool: "read_file", args: { path: "x" } };
    const b = { tool: "read_file", args: { path: "y" } };
    g.after(a, true, "same");
    g.after(b, true, "same");
    expect(g.before(a)).toEqual({});
    g.after(a, true, "same");
    expect(g.before(b).block).toContain("no_progress");
    g.after(b, true, "different");
    expect(g.before(a)).toEqual({});
  });

  test("no_progress never blocks a call with new arguments: a refused call never reaches after()", () => {
    const g = new ToolGuard();
    const wrong = { tool: "search_code", args: { pattern: "x" } };
    for (let i = 0; i < 3; i++) g.after(wrong, false, "search_code: query is required");
    expect(g.before(wrong).block).toContain("repeated_failing_call");
    // The corrected call is new: it must run (before the fix every later call was refused for good).
    const fixed = { tool: "search_code", args: { query: "x" } };
    expect(g.before(fixed)).toEqual({});
    const other = { tool: "read_file", args: { path: "a" } };
    expect(g.before(other)).toEqual({});
    // Once the new call joins the identical streak it is a loop again.
    g.after(fixed, true, "same");
    g.after(fixed, true, "same");
    g.after(fixed, true, "same");
    expect(g.before(fixed).block).toContain("no_progress");
    expect(g.before(other)).toEqual({});
  });
});

describe("fs_destructive executor: bounded and double-locked", () => {
  const call = (id: string, args: Record<string, unknown>): ToolCall => ({ id, tool: "fs_destructive", args, proposedBy: "worker_a" });

  test("nothing runs without the gate's release; approved delete / move work inside the workspace", async () => {
    const ws = await makeWorkspace("fsd-");
    await writeFile(join(ws, "a.txt"), "a", "utf8");
    const noLock = await executeTool(call("c1", { action: "delete", path: "a.txt" }), { workspace: ws });
    expect(noLock.ok).toBe(false);
    expect(noLock.output).toContain("not released by the gate");
    expect(existsSync(join(ws, "a.txt"))).toBe(true);
    const wrongId = await executeTool(call("c1", { action: "delete", path: "a.txt" }), { workspace: ws, approved: new Set(["c2"]) });
    expect(wrongId.ok).toBe(false);
    const ok = await executeTool(call("c1", { action: "delete", path: "a.txt" }), { workspace: ws, approved: new Set(["c1"]) });
    expect(ok.ok).toBe(true);
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
    await writeFile(join(ws, "b.txt"), "b", "utf8");
    const moved = await executeTool(call("c3", { action: "move", path: "b.txt", to: "dir/c.txt" }), { workspace: ws, approved: new Set(["c3"]) });
    expect(moved.ok).toBe(true);
    expect(existsSync(join(ws, "dir", "c.txt"))).toBe(true);
    await writeFile(join(ws, "d.txt"), "d", "utf8");
    const noOverwrite = await executeTool(call("c4", { action: "move", path: "d.txt", to: "dir/c.txt" }), { workspace: ws, approved: new Set(["c4"]) });
    expect(noOverwrite.ok).toBe(false);
    expect(noOverwrite.output).toContain("no overwrite");
  });

  test("root, .git/, .agentik/, escapes and outward symlinks are refused even when approved", async () => {
    const ws = await makeWorkspace("fsd-protect-");
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, ".git", "HEAD"), "ref", "utf8");
    await mkdir(join(ws, ".agentik"), { recursive: true });
    await writeFile(join(ws, ".agentik", "x"), "x", "utf8");
    const outside = await makeWorkspace("fsd-outside-");
    await writeFile(join(outside, "secret.txt"), "s", "utf8");
    await symlink(join(outside, "secret.txt"), join(ws, "link.txt"));
    const approved = new Set(["c"]);
    for (const [args, re] of [
      [{ action: "delete", path: "." }, /workspace root/],
      [{ action: "delete", path: "" }, /workspace root/],
      [{ action: "delete", path: ".git/HEAD" }, /\.git\/ is protected/],
      [{ action: "delete", path: ".git" }, /\.git\/ is protected/],
      [{ action: "delete", path: ".agentik/x" }, /\.agentik\/ is protected/],
      [{ action: "delete", path: "../escape" }, /escapes workspace/],
      [{ action: "delete", path: "link.txt" }, /symlink pointing outside/],
      [{ action: "move", path: "link.txt", to: "x" }, /symlink pointing outside/],
      [{ action: "wipe", path: "x" }, /action must be delete or move/],
      [{ action: "delete", path: "ghost.txt" }, /does not exist/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const r = await executeTool(call("c", args), { workspace: ws, approved });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(re);
    }
    expect(existsSync(join(ws, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(outside, "secret.txt"))).toBe(true);
  });
});

class Scripted implements Backend {
  seen: CompleteRequest[] = [];
  constructor(readonly id: string, private readonly plan: WorkerMessage["tasks"], private readonly acts: WorkerMessage[]) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    if (req.phase === "plan") return { text: "plan", tasks: this.plan };
    if (req.phase === "synthesize") return { text: "done" };
    const n = this.seen.filter((r) => r.phase === "act").length;
    return this.acts[n - 1] ?? { text: "stop", toolCalls: [] };
  }
}

describe("guardrails and the destructive lock inside runLoop", () => {
  test("the same failing command four times: warned, then blocked with repeated_failing_call", async () => {
    const ws = await makeWorkspace("guard-loop-");
    // Each step also runs something that works, so the task is not ended as barren before the guard speaks.
    const failing: WorkerMessage = { text: "try", toolCalls: [{ tool: "run_command", args: { argv: ["true"] } }, { tool: "run_command", args: { argv: ["sh", "-c", "exit 3"] } }] };
    const plan = [{ id: "t", assignee: "worker_a" as const, instruction: "x", allowedTools: ["run_command"], maxSteps: 8 }];
    const a = new Scripted("s-a", plan, [failing, failing, failing, failing, failing]);
    const report = await runLoop({ goal: "x", workspace: ws, workerA: a, workerB: new Scripted("s-b", plan, []) });
    const reasons = report.blockedTools.map((b) => b.reason.split("\n")[0]);
    expect(reasons.filter((r) => r.startsWith("exit 3")).length).toBe(3);
    expect(reasons.some((r) => r.startsWith("repeated_failing_call"))).toBe(true);
    const acts = a.seen.filter((r) => r.phase === "act");
    expect(acts.some((r) => r.envelopes.some((e) => e.origin === "guardrails" && e.body.includes("already failed 2 times")))).toBe(true);
    expect(report.taskResults[0].evidence.executed).toBeGreaterThanOrEqual(4);
  });

  test("an approved fs_destructive really deletes (the gate feeds the lock); unapproved does nothing", async () => {
    const ws = await makeWorkspace("guard-fsd-");
    await writeFile(join(ws, "old.log"), "x", "utf8");
    const plan = [{ id: "t", assignee: "worker_a" as const, instruction: "remove old.log", allowedTools: ["fs_destructive"] }];
    const act: WorkerMessage = { text: "removing", toolCalls: [{ tool: "fs_destructive", args: { action: "delete", path: "old.log" } }] };
    const withheld = await runLoop({ goal: "remove old.log", workspace: ws, workerA: new Scripted("s-a", plan, [act, { text: "stop", toolCalls: [] }]), workerB: new Scripted("s-b", plan, []) });
    expect(withheld.status).toBe("awaiting_approval");
    expect(existsSync(join(ws, "old.log"))).toBe(true);
    const approved = await runLoop({ goal: "remove old.log", workspace: ws, workerA: new Scripted("s-a", plan, [act, { text: "stop", toolCalls: [] }]), workerB: new Scripted("s-b", plan, []), autoApproveHighBlast: true });
    expect(approved.status).toBe("completed");
    expect(existsSync(join(ws, "old.log"))).toBe(false);
    expect(approved.executedTools.some((t) => t.tool === "fs_destructive" && t.artifact === "old.log")).toBe(true);
  });
});
