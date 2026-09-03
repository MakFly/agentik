import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeBackend,
  CLAUDE_EFFORTS,
  claudeCliArgs,
  claudeEffortFor,
  phaseDirective,
  renderCompletePrompt,
  REVIEW_ACT_DIRECTIVE,
  systemPromptFor,
} from "../src/backends.ts";
import { refreshIndex } from "../src/code-index.ts";
import { runLoop, TASK_SUMMARY_MAX } from "../src/loop.ts";
import { INSTRUCTION_MAX, TASK_SUMMARY_MAX as TASK_SUMMARY_MAX_LEAF } from "../src/types.ts";
import { buildPlan, classifyGoal, defaultAllowedTools } from "../src/plan.ts";
import { INSTRUCTION_MAX as INSTRUCTION_MAX_SCHEMA, validatePlan } from "../src/plan-schema.ts";
import { workerToolNames } from "../src/tool-catalog.ts";
import type { Backend, CompleteRequest, Phase, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

/**
 * What a run pays for beyond the work itself: the prose it writes and throws away, the phase that
 * calls tools nobody reads, the effort level it burns on every phase, and the tool it proposes to
 * workers that can only refuse it. Every number here comes from a measured live run.
 */

/** Plans what it is told, acts by script per task id, answers synthesize by script, records all. */
class Scripted implements Backend {
  seen: CompleteRequest[] = [];
  constructor(
    readonly id: string,
    private readonly plan: WorkerMessage["tasks"],
    private readonly acts: Record<string, WorkerMessage[]> = {},
    private readonly synth: WorkerMessage = { text: "done" },
  ) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    if (req.phase === "plan") return { text: "plan", tasks: this.plan };
    if (req.phase === "synthesize") return this.synth;
    const id = req.task?.id ?? "?";
    const n = this.seen.filter((r) => r.phase === "act" && r.task?.id === id).length;
    return this.acts[id]?.[n - 1] ?? { text: `${id} finished`, toolCalls: [] };
  }
}

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

/** A tiny checkout with a real code index behind it (chunks > 0). */
async function indexed(): Promise<{ ws: string; home: string }> {
  const ws = await makeWorkspace("run-cost-idx-ws-");
  const home = await makeWorkspace("run-cost-idx-home-");
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "seal.ts"), "export function writeSeal() {}\nexport function checkSeal() {}\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  await refreshIndex(home, ws);
  return { ws, home };
}

function actPrompt(): string {
  const req: CompleteRequest = {
    role: "worker_a",
    phase: "act",
    trustedGoal: "goal",
    envelopes: [],
    system: "SYSTEM",
  };
  return renderCompletePrompt(req);
}

describe("cost of a run: final-message budget", () => {
  test("the act prompt names the real TASK_SUMMARY_MAX budget for a tool-less final message", () => {
    // Measured: the last invocation of a task calls no tool and cost 34-42s for ~4k output tokens,
    // of which loop.ts kept 2000 characters. The budget must be IN the prompt, and be the constant.
    const prompt = actPrompt();
    expect(prompt).toContain(String(TASK_SUMMARY_MAX));
    expect(prompt).toMatch(/characters MAXIMUM/);
    expect(prompt).toMatch(/empty toolCalls array/);
    expect(prompt).toMatch(/no markdown headings/i);
    expect(prompt).toMatch(/discarded and paid for/);
    // One constant, in a leaf module, re-exported by loop.ts: no second hardcoded 2000.
    expect(TASK_SUMMARY_MAX).toBe(TASK_SUMMARY_MAX_LEAF);
    expect(phaseDirective("act")).toContain(String(TASK_SUMMARY_MAX));
    expect(phaseDirective("plan")).toBe("");
  });

  test("the act prompt asks for independent tool calls in ONE message", () => {
    // Measured: one worker spread 5 independent calls over 3 invocations; each avoided invocation
    // is 5-40s of wall clock.
    const prompt = actPrompt();
    expect(prompt).toMatch(/ONE message every tool call that does not depend/);
    expect(prompt).toMatch(/wait for a result only when the next call genuinely needs it/);
  });
});

describe("cost of a run: the synthesis calls no tool", () => {
  test("a toolCall in the synthesize message is not executed (the final text is already written)", async () => {
    const ws = await makeWorkspace("run-cost-synth-");
    const plan: WorkerMessage["tasks"] = [
      // read_file only: this test is about the SYNTHESIZE phase. A task allowed write_file that
      // writes nothing is now `refused` (mutation declared, mutation nil) and the run is `blocked`,
      // which would hide what is actually under test here.
      { id: "solo", assignee: "worker_a", instruction: "do the thing", allowedTools: ["read_file"], maxSteps: 2 },
    ];
    const a = new Scripted("s-a", plan, { solo: [{ text: "solo done", toolCalls: [] }] });
    // The synthesizer is the last assigned subagent (worker_b here).
    const b = new Scripted("s-b", plan, {}, {
      text: "the synthesis",
      toolCalls: [{ tool: "write_file", args: { path: "late.txt", content: "written after the answer" } }],
    });
    const report = await runLoop({ goal: "write a file", workspace: ws, workerA: a, workerB: b, codeIndex: false });
    expect(report.status).toBe("completed");
    expect(report.synthesis).toBe("the synthesis");
    // Neither executed nor blocked: the call is not made at all, so it costs nothing.
    expect(report.executedTools.some((t) => t.tool === "write_file")).toBe(false);
    expect(report.blockedTools.some((t) => t.tool === "write_file")).toBe(false);
    expect(existsSync(join(ws, "late.txt"))).toBe(false);
  });

  test("the synthesize prompt says no tools and points at the DATA", () => {
    const req: CompleteRequest = {
      role: "worker_b",
      phase: "synthesize",
      trustedGoal: "goal",
      envelopes: [],
      system: "SYSTEM",
    };
    const prompt = renderCompletePrompt(req);
    expect(prompt).toMatch(/SYNTHESIZE: no tools/);
    expect(prompt).toMatch(/task results and sources given as DATA/);
  });
});

describe("cost of a run: claude effort per phase", () => {
  const withEnv = <T,>(value: string | undefined, fn: () => T): T => {
    const prev = process.env.AGENTIK_CLAUDE_EFFORT;
    if (value === undefined) delete process.env.AGENTIK_CLAUDE_EFFORT;
    else process.env.AGENTIK_CLAUDE_EFFORT = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTIK_CLAUDE_EFFORT;
      else process.env.AGENTIK_CLAUDE_EFFORT = prev;
    }
  };

  test("plan keeps high, act and synthesize drop to medium", () => {
    withEnv(undefined, () => {
      expect(claudeEffortFor("plan")).toBe("high");
      expect(claudeEffortFor("act")).toBe("medium");
      expect(claudeEffortFor("synthesize")).toBe("medium");
    });
  });

  test("AGENTIK_CLAUDE_EFFORT overrides every phase; an unknown value is ignored", () => {
    // `claude --effort bogus --version` answers: "Valid values: low, medium, high, xhigh, max."
    expect([...CLAUDE_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(claudeEffortFor("act", { env: { AGENTIK_CLAUDE_EFFORT: "xhigh" } })).toBe("xhigh");
    expect(claudeEffortFor("plan", { env: { AGENTIK_CLAUDE_EFFORT: "low" } })).toBe("low");
    expect(claudeEffortFor("plan", { env: { AGENTIK_CLAUDE_EFFORT: "  MAX  " } })).toBe("max");
    // The human's A/B knob reaches the review too — it is set on purpose, unlike the phase default.
    expect(claudeEffortFor("act", { role: "reviewer", env: { AGENTIK_CLAUDE_EFFORT: "low" } })).toBe("low");
    // Unknown: the default stands, the CLI never sees the bad value.
    expect(claudeEffortFor("plan", { env: { AGENTIK_CLAUDE_EFFORT: "turbo" } })).toBe("high");
    expect(claudeEffortFor("act", { env: { AGENTIK_CLAUDE_EFFORT: "turbo" } })).toBe("medium");
  });

  test("claudeCliArgs takes the effort as a parameter (default high, unchanged for old callers)", () => {
    expect(claudeCliArgs("p", "sonnet")[claudeCliArgs("p", "sonnet").indexOf("--effort") + 1]).toBe("high");
    const medium = claudeCliArgs("p", "sonnet", "medium");
    expect(medium[medium.indexOf("--effort") + 1]).toBe("medium");
    expect(medium).toContain("--restricted");
  });

  test("the argv the CLI really receives carries the phase's effort (ClaudeBackend, not the default)", async () => {
    // The one line wiring claudeEffortFor to claudeCliArgs was untested: the unit tests above both
    // passed with a backend that never called it. This goes through ClaudeBackend.complete.
    const seen: Array<{ effort: string; prompt: string }> = [];
    const runner = async (_cmd: string, args: string[]) => {
      seen.push({ effort: args[args.indexOf("--effort") + 1], prompt: args[args.indexOf("-p") + 1] });
      return { stdout: JSON.stringify({ text: "ok" }), stderr: "", exitCode: 0, timedOut: false, signal: null };
    };
    const backend = new ClaudeBackend("sonnet", 1000, { runner });
    const req = (phase: Phase, role: CompleteRequest["role"] = "worker_a"): CompleteRequest => ({
      role,
      phase,
      trustedGoal: "goal",
      envelopes: [],
      system: "SYSTEM",
    });
    await withEnv(undefined, async () => {
      await backend.complete(req("plan"));
      await backend.complete(req("act"));
      await backend.complete(req("synthesize"));
      await backend.complete({ ...req("act", "reviewer"), task: { id: "review", assignee: "reviewer", instruction: "decide", allowedTools: ["memory"], maxSteps: 4 } });
    });
    expect(seen.map((s) => s.effort)).toEqual(["high", "medium", "medium", "high"]);
    // And the prompt that argv carries is the one the phase asks for.
    expect(seen[1].prompt).toContain(String(TASK_SUMMARY_MAX));
    expect(seen[2].prompt).toMatch(/SYNTHESIZE: no tools/);
  });
});

describe("cost of a run: the review is not a worker", () => {
  test("the reviewer keeps effort high and the pre-existing act directive (no 2000 cap, no batching)", () => {
    // reviewer.ts calls the backend with phase "act" but role "reviewer". Three things of the act
    // directive are false there: its summary is never truncated (ReviewOutcome.summary), batching
    // independent calls would break the view_before_create invariant, and its effort is a product
    // decision. The evals replay script.json, so they cannot catch any of it.
    expect(claudeEffortFor("act", { role: "reviewer" })).toBe("high");
    const reviewPrompt = renderCompletePrompt({
      role: "reviewer",
      phase: "act",
      trustedGoal: "Review the run for: x",
      envelopes: [],
      system: "REVIEW SYSTEM",
    });
    expect(reviewPrompt).toContain(REVIEW_ACT_DIRECTIVE);
    expect(reviewPrompt).not.toContain(String(TASK_SUMMARY_MAX));
    expect(reviewPrompt).not.toMatch(/discarded and paid for/);
    expect(reviewPrompt).not.toMatch(/ONE message every tool call/);
    // A worker in the same phase does get the new directive.
    expect(actPrompt()).not.toContain(REVIEW_ACT_DIRECTIVE);
  });
});

describe("cost of a run: one coherent prompt", () => {
  test("the general auto-run sentence is scoped to ACT, so it no longer contradicts SYNTHESIZE", () => {
    const sys = systemPromptFor("worker_a");
    expect(sys).toMatch(/In the ACT phase the orchestrator auto-runs/);
    expect(sys).toMatch(/In the SYNTHESIZE phase nothing runs/);
    // The old unconditional claim is gone.
    expect(sys).not.toMatch(/^The orchestrator auto-runs allowed low\/medium tools and feeds results back\./m);
    // The plan line quotes the validator's own constant, not a second literal.
    expect(sys).toContain(`instruction (≤${INSTRUCTION_MAX} chars)`);
    expect(INSTRUCTION_MAX).toBe(INSTRUCTION_MAX_SCHEMA);
  });
});

describe("cost of a run: no search_code when the index is off", () => {
  test("--no-index removes search_code from the planner prompt and from the fallback plan", () => {
    const off = workerToolNames().filter((n) => n !== "search_code");
    expect(systemPromptFor("worker_a", 2, { tools: off })).not.toContain("search_code");
    expect(systemPromptFor("worker_a")).toContain("search_code");
    expect(defaultAllowedTools(classifyGoal("implement the parser"), { codeIndex: false })).not.toContain("search_code");
    expect(defaultAllowedTools(classifyGoal("implement the parser"))).toContain("search_code");
    expect(buildPlan("fix the failing test", 5, { codeIndex: false }).some((t) => t.allowedTools.includes("search_code"))).toBe(false);
    expect(buildPlan("fix the failing test", 5).every((t) => t.allowedTools.includes("search_code"))).toBe(true);
  });

  test("a model plan that still asks for search_code is stripped, not rejected", async () => {
    const ws = await makeWorkspace("run-cost-noindex-");
    const plan: WorkerMessage["tasks"] = [
      { id: "solo", assignee: "worker_a", instruction: "read the code", allowedTools: ["read_file", "search_code"], maxSteps: 1 },
    ];
    // The validator keeps accepting search_code: a plan is not invalid because it hoped for an
    // index, and rejecting it would cost a whole reprompt.
    expect(validatePlan(plan, { workerCount: 1, workspace: ws }).ok).toBe(true);
    const a = new Scripted("s-a", plan, { solo: [{ text: "solo done", toolCalls: [] }] });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "read the code", workspace: ws, workerA: a, workerB: b, codeIndex: false });
    expect(report.planSource).toBe("model");
    expect(report.tasks[0].allowedTools).toEqual(["read_file"]);
    const planReq = a.seen.find((r) => r.phase === "plan")!;
    expect(planReq.system).not.toContain("search_code");
    const actReq = a.seen.find((r) => r.phase === "act")!;
    expect(actReq.task?.allowedTools).toEqual(["read_file"]);
  });

  test("with a REAL index (chunks > 0), search_code survives the plan untouched", async () => {
    const { ws, home } = await indexed();
    const plan: WorkerMessage["tasks"] = [
      { id: "solo", assignee: "worker_a", instruction: "read the code", allowedTools: ["read_file", "search_code"], maxSteps: 1 },
    ];
    const a = new Scripted("s-a", plan, { solo: [{ text: "solo done", toolCalls: [] }] });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "read the code", workspace: ws, home, workerA: a, workerB: b });
    expect(report.codeIndex?.chunks).toBeGreaterThan(0);
    expect(report.tasks[0].allowedTools).toEqual(["read_file", "search_code"]);
    expect(a.seen.find((r) => r.phase === "plan")!.system).toContain("search_code");
  });

  test("no usable index (not just --no-index) also drops search_code from the plan", async () => {
    // The flag is one cause among several: `too_big`, `failed`, `disabled`, or simply no index at
    // all leave the executor with nothing to read. Here the auto-build is off (tests/preload.ts),
    // so the run has NO index while `codeIndex` is left at its default true.
    const ws = await makeWorkspace("run-cost-noidx-real-");
    const home = await makeWorkspace("run-cost-noidx-home-");
    const plan: WorkerMessage["tasks"] = [
      { id: "solo", assignee: "worker_a", instruction: "read the code", allowedTools: ["read_file", "search_code"], maxSteps: 1 },
    ];
    const a = new Scripted("s-a", plan, { solo: [{ text: "solo done", toolCalls: [] }] });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "read the code", workspace: ws, home, workerA: a, workerB: b });
    expect(report.codeIndex?.chunks ?? 0).toBe(0);
    expect(report.tasks[0].allowedTools).toEqual(["read_file"]);
    expect(a.seen.find((r) => r.phase === "plan")!.system).not.toContain("search_code");
  });

  test("a task left with nothing keeps read_file rather than an empty allowlist", async () => {
    const ws = await makeWorkspace("run-cost-emptytools-");
    const plan: WorkerMessage["tasks"] = [
      { id: "solo", assignee: "worker_a", instruction: "look around", allowedTools: ["search_code"], maxSteps: 1 },
    ];
    const a = new Scripted("s-a", plan, { solo: [{ text: "solo done", toolCalls: [] }] });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "look around", workspace: ws, workerA: a, workerB: b, codeIndex: false });
    expect(report.tasks[0].allowedTools).toEqual(["read_file"]);
  });
});
