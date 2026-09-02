import { describe, expect, test } from "bun:test";
import {
  ClaudeBackend,
  CodexBackend,
  foreignWorkerArgs,
  GrokBackend,
  type SpawnResult,
} from "../src/backends.ts";
import { HARNESS_EFFORTS, effortProblem, modelProblem, ROUTING_ENV, routingFor } from "../src/routing.ts";
import { formatReport, runLoop } from "../src/loop.ts";
import type { Backend, CompleteRequest, Phase, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

/**
 * The routing table (harness, phase) → model + effort, observed on the argv each CLI really
 * receives. The flags themselves were checked on the installed binaries:
 * `claude --model X --effort <low|medium|high|xhigh|max>`, `codex exec -m X -c
 * model_reasoning_effort=Y`, `grok --reasoning-effort Y` (alias `--effort`, and grok validates
 * NOTHING — `--effort bogus` parses fine, which is why routing.ts validates).
 */

type Captured = { cmd: string; args: string[] };

function capture(stdout = JSON.stringify({ text: "ok" })): { seen: Captured[]; runner: (cmd: string, args: string[]) => Promise<SpawnResult> } {
  const seen: Captured[] = [];
  return {
    seen,
    runner: async (cmd: string, args: string[]) => {
      seen.push({ cmd, args });
      return { stdout, stderr: "", exitCode: 0, timedOut: false, signal: null };
    },
  };
}

function req(phase: Phase, role: CompleteRequest["role"] = "worker_a"): CompleteRequest {
  return { role, phase, trustedGoal: "goal", envelopes: [], system: "SYSTEM" };
}

/** `--flag value` from an argv, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The value of `-c key=value`, or undefined. */
function config(args: string[], key: string): string | undefined {
  const hit = args.find((a, i) => args[i - 1] === "-c" && a.startsWith(`${key}=`));
  return hit?.slice(key.length + 1);
}

describe("routing table: claude", () => {
  test("plan runs opus/high, act and synthesize run sonnet/medium — on the real argv", async () => {
    const { seen, runner } = capture();
    const backend = new ClaudeBackend("sonnet", 1000, { runner });
    for (const phase of ["plan", "act", "synthesize"] as Phase[]) await backend.complete(req(phase));
    expect(seen.map((s) => s.cmd)).toEqual(["claude", "claude", "claude"]);
    expect(seen.map((s) => [flag(s.args, "--model"), flag(s.args, "--effort")])).toEqual([
      ["opus", "high"],
      ["sonnet", "medium"],
      ["sonnet", "medium"],
    ]);
  });

  test("the model follows the PHASE, not the slot: claude-opus plans and works exactly like claude-sonnet", async () => {
    // Consequence stated in ClaudeBackend.complete: the two autoCycle entries are the same worker
    // in practice. The ids stay distinct so a report still reads, hence WorkerInvocation.routing.
    const a = capture();
    const b = capture();
    const sonnet = new ClaudeBackend("sonnet", 1000, { runner: a.runner });
    const opus = new ClaudeBackend("opus", 1000, { runner: b.runner });
    await sonnet.complete(req("act"));
    await opus.complete(req("act"));
    expect(flag(a.seen[0].args, "--model")).toBe("sonnet");
    expect(flag(b.seen[0].args, "--model")).toBe("sonnet");
    expect(sonnet.id).toBe("claude-sonnet");
    expect(opus.id).toBe("claude-opus");
  });

  test("the invocation carries the model and effort it really ran with", async () => {
    const { runner } = capture();
    const backend = new ClaudeBackend("sonnet", 1000, { runner });
    expect((await backend.complete(req("plan"))).routing).toEqual({ model: "opus", effort: "high" });
    expect((await backend.complete(req("act"))).routing).toEqual({ model: "sonnet", effort: "medium" });
  });
});

describe("routing table: codex", () => {
  test("plan runs gpt-5.6-sol/high, act and synthesize run gpt-5.6-luna/xhigh — on the real argv", async () => {
    const { seen, runner } = capture("{}");
    const backend = new CodexBackend(1000, { runner });
    for (const phase of ["plan", "act", "synthesize"] as Phase[]) await backend.complete(req(phase));
    expect(seen.map((s) => s.cmd)).toEqual(["codex", "codex", "codex"]);
    expect(seen.map((s) => [flag(s.args, "-m"), config(s.args, "model_reasoning_effort")])).toEqual([
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-luna", "xhigh"],
      ["gpt-5.6-luna", "xhigh"],
    ]);
    // `exec` stays the first token and the prompt stays last: the routing flags go in between.
    for (const s of seen) {
      expect(s.args[0]).toBe("exec");
      expect(s.args[s.args.length - 1]).toContain("TRUSTED_GOAL");
    }
  });
});

describe("routing table: grok", () => {
  test("plan runs xhigh, act and synthesize run high, and the model is left to grok's default", async () => {
    const { seen, runner } = capture(JSON.stringify({ text: "ok" }));
    const backend = new GrokBackend(1000, { runner });
    for (const phase of ["plan", "act", "synthesize"] as Phase[]) await backend.complete(req(phase));
    expect(seen.map((s) => s.cmd)).toEqual(["grok", "grok", "grok"]);
    expect(seen.map((s) => flag(s.args, "--reasoning-effort"))).toEqual(["xhigh", "high", "high"]);
    for (const s of seen) expect(s.args).not.toContain("--model");
  });
});

describe("routing table: one source of truth, validated overrides", () => {
  test("every harness has an env override for model and effort; junk never reaches the argv", () => {
    const log: string[] = [];
    expect(routingFor("codex", "act", { env: { AGENTIK_CODEX_EFFORT: "low" }, log: (l) => log.push(l) })).toMatchObject({ effort: "low" });
    expect(routingFor("grok", "plan", { env: { AGENTIK_GROK_MODEL: "grok-4-fast" }, log: (l) => log.push(l) })).toEqual({ model: "grok-4-fast", effort: "xhigh" });
    expect(routingFor("claude", "act", { env: { AGENTIK_CLAUDE_EFFORT: "xhigh" }, log: (l) => log.push(l) })).toMatchObject({ effort: "xhigh" });
    expect(log).toEqual([]);
    // Refused: a value outside the harness's list, and a model name that would read as a flag.
    const refused = routingFor("grok", "act", { env: { AGENTIK_GROK_EFFORT: "bogus", AGENTIK_GROK_MODEL: "--yolo" }, log: (l) => log.push(l) });
    expect(refused).toEqual({ effort: "high" });
    expect(log.length).toBe(2);
    expect(log[0]).toContain("AGENTIK_GROK_MODEL");
    expect(log[1]).toContain("AGENTIK_GROK_EFFORT");
    expect(effortProblem("claude", "max")).toBeUndefined();
    expect(effortProblem("grok", "max")).toBeDefined();
    expect(modelProblem("gpt-5.6-luna")).toBeUndefined();
    expect(modelProblem("-m")).toBeDefined();
    expect(Object.keys(ROUTING_ENV)).toEqual(["claude", "codex", "grok"]);
    expect(HARNESS_EFFORTS.claude).toContain("xhigh");
  });

  test("a refused grok override cannot reach the argv (grok itself accepts any value)", async () => {
    const { seen, runner } = capture();
    const backend = new GrokBackend(1000, { runner });
    const prev = process.env.AGENTIK_GROK_EFFORT;
    process.env.AGENTIK_GROK_EFFORT = "bogus";
    try {
      await backend.complete(req("act"));
    } finally {
      if (prev === undefined) delete process.env.AGENTIK_GROK_EFFORT;
      else process.env.AGENTIK_GROK_EFFORT = prev;
    }
    expect(flag(seen[0].args, "--reasoning-effort")).toBe("high");
    expect(seen[0].args).not.toContain("bogus");
  });
});

describe("routing table: out of scope stays out of scope", () => {
  test("the review keeps claude sonnet + high, and gets no routing flag on codex or grok", async () => {
    expect(routingFor("claude", "act", { role: "reviewer" })).toEqual({ effort: "high" });
    expect(routingFor("codex", "act", { role: "reviewer" })).toEqual({});
    expect(routingFor("grok", "act", { role: "reviewer" })).toEqual({});

    const c = capture();
    // The review's backend is built by `agentik review` with its own model; the table must not
    // move it (a review that suddenly plans with opus would be a product decision nobody made).
    await new ClaudeBackend("sonnet", 1000, { runner: c.runner }).complete(req("act", "reviewer"));
    expect(flag(c.seen[0].args, "--model")).toBe("sonnet");
    expect(flag(c.seen[0].args, "--effort")).toBe("high");

    const x = capture("{}");
    await new CodexBackend(1000, { runner: x.runner }).complete(req("act", "reviewer"));
    expect(x.seen[0].args).not.toContain("-m");
    expect(x.seen[0].args.some((a) => a.startsWith("model_reasoning_effort="))).toBe(false);

    const g = capture();
    await new GrokBackend(1000, { runner: g.runner }).complete(req("act", "reviewer"));
    expect(g.seen[0].args).not.toContain("--reasoning-effort");
  });

  test("agentik spawn (foreignWorkerArgs) is untouched by the table", () => {
    const claude = foreignWorkerArgs("claude", "task");
    expect(flag(claude.args, "--effort")).toBe("high");
    expect(claude.args).not.toContain("--model");
    const codex = foreignWorkerArgs("codex", "task");
    expect(codex.args).not.toContain("-m");
    expect(codex.args).not.toContain("-c");
    const grok = foreignWorkerArgs("grok", "task");
    expect(grok.args).not.toContain("--reasoning-effort");
    expect(grok.args).not.toContain("--model");
  });
});

describe("routing table: a run report stays readable", () => {
  test("the invocation and the report show the model the slot really used", async () => {
    // `worker_a (claude-sonnet) plan` alone would now be misleading (it plans with opus), so the
    // loop stamps WorkerInvocation.routing and formatReport prints `[model/effort]`.
    const plan: WorkerMessage["tasks"] = [
      { id: "solo", assignee: "worker_a", instruction: "do it", allowedTools: ["read_file"], maxSteps: 1 },
    ];
    const backend = (id: string): Backend => ({
      id,
      async complete(request: CompleteRequest): Promise<WorkerMessage> {
        const routing = routingFor("claude", request.phase);
        if (request.phase === "plan") return { text: "plan", tasks: plan, routing };
        return { text: `${request.phase} done`, toolCalls: [], routing };
      },
    });
    const ws = await makeWorkspace("routing-report-");
    const report = await runLoop({ goal: "do it", workspace: ws, workerA: backend("claude-sonnet"), workerB: backend("claude-opus"), codeIndex: false });
    const planInv = report.workersInvoked.find((w) => w.phase === "plan")!;
    const actInv = report.workersInvoked.find((w) => w.phase === "act")!;
    expect(planInv.routing).toEqual({ model: "opus", effort: "high" });
    expect(actInv.routing).toEqual({ model: "sonnet", effort: "medium" });
    const text = formatReport(report);
    expect(text).toContain("worker_a (claude-sonnet) plan [opus/high]");
    expect(text).toContain("[sonnet/medium]");
  });
});
