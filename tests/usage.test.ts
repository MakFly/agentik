import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { formatReport, runLoop } from "../src/loop.ts";
import { BackendError, ClaudeBackend, CodexBackend, GrokBackend, type SpawnResult } from "../src/backends.ts";
import { addRunUsage, emptyRunUsage, extractUsage, formatRunUsage, usageOfFailure, type RunUsage } from "../src/usage.ts";
import type { Backend, CompleteRequest, Phase, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

describe("extractUsage", () => {
  test("claude json: usage + total_cost_usd + duration_ms + num_turns", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success", result: "{\"text\":\"hi\"}", usage: { input_tokens: 12_300, cache_read_input_tokens: 5_000, output_tokens: 4_100 }, total_cost_usd: 0.31, duration_ms: 84_200, num_turns: 3 });
    expect(extractUsage("claude", stdout)).toEqual({ inputTokens: 12_300, cachedInputTokens: 5_000, outputTokens: 4_100, costUsd: 0.31, turns: 3, durationMs: 84_200 });
  });

  /**
   * Cache WRITE is billed above the fresh price and is the term that moves when a prompt changes.
   * The numbers are the ones a real `claude -p` printed in bench/ablation/runs/noL5-1.json.
   */
  test("cache_creation_input_tokens is read, under every spelling, and never folded into the others", () => {
    const claude = extractUsage("claude", JSON.stringify({ is_error: true, num_turns: 6, total_cost_usd: 0.1460416, usage: { input_tokens: 8, cache_creation_input_tokens: 21_234, cache_read_input_tokens: 81_488, output_tokens: 3_027 } }));
    expect(claude).toEqual({ inputTokens: 8, cachedInputTokens: 81_488, cacheCreationInputTokens: 21_234, outputTokens: 3_027, costUsd: 0.1460416, turns: 6 });
    // grok's own envelope (tests/fixtures/grok-envelope-with-tools.json) uses the same snake keys…
    expect(extractUsage("grok", JSON.stringify({ text: "x", usage: { input_tokens: 11_146, cache_read_input_tokens: 5_760, cache_creation_input_tokens: 0, output_tokens: 42 }, num_turns: 1 }))).toEqual({ inputTokens: 11_146, cachedInputTokens: 5_760, cacheCreationInputTokens: 0, outputTokens: 42, turns: 1 });
    // …and its modelUsage block the camel ones, which some builds hoist into `usage`.
    expect(extractUsage("grok", JSON.stringify({ text: "x", usage: { inputTokens: 10, cacheReadInputTokens: 4, cacheCreationInputTokens: 7, outputTokens: 2 }, num_turns: 1 }))).toEqual({ inputTokens: 10, cachedInputTokens: 4, cacheCreationInputTokens: 7, outputTokens: 2, turns: 1 });
    // codex sums it across turns like the rest; a stream that never mentions it says nothing.
    const codex = extractUsage("codex", [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 30 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 800, cache_creation_input_tokens: 25, output_tokens: 70 } }),
    ].join("\n"));
    expect(codex).toEqual({ inputTokens: 3000, cachedInputTokens: 1000, cacheCreationInputTokens: 75, outputTokens: 100, turns: 2 });
    expect(extractUsage("claude", JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 } }))).not.toHaveProperty("cacheCreationInputTokens");
  });

  test("grok envelope: usage, total_cost_usd else ticks / 1e10; read before the unwrapper", () => {
    const env = JSON.stringify({ text: "{\"text\":\"hi\",\"toolCalls\":[]}", stopReason: "end_turn", sessionId: "s", usage: { inputTokens: 900, outputTokens: 50 }, total_cost_usd_ticks: 43_220_800, num_turns: 1 });
    expect(extractUsage("grok", env)).toEqual({ inputTokens: 900, outputTokens: 50, costUsd: 0.00432208, turns: 1 });
    expect(extractUsage("grok", JSON.stringify({ text: "x", stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.5, total_cost_usd_ticks: 7 }))?.costUsd).toBe(0.5);
  });

  test("codex JSONL: turn.completed.usage summed; nothing → undefined", () => {
    const lines = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"text\":\"a\"}" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 30 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 800, output_tokens: 70 } }),
    ].join("\n");
    expect(extractUsage("codex", lines)).toEqual({ inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 100, turns: 2 });
    expect(extractUsage("codex", "not json at all")).toBeUndefined();
    expect(extractUsage("claude", JSON.stringify({ result: "ok" }))).toBeUndefined();
    expect(extractUsage("claude", "")).toBeUndefined();
  });

  test("banner line before the JSON is tolerated", () => {
    const stdout = `Welcome to grok\n${JSON.stringify({ text: "x", usage: { inputTokens: 5, outputTokens: 6 }, num_turns: 2 })}`;
    expect(extractUsage("grok", stdout)).toEqual({ inputTokens: 5, outputTokens: 6, turns: 2 });
  });

  test("addRunUsage / formatRunUsage", () => {
    const u = emptyRunUsage();
    addRunUsage(u, { inputTokens: 12_000, cachedInputTokens: 300, outputTokens: 4_000, costUsd: 0.2, turns: 1 });
    addRunUsage(u, { inputTokens: 300, outputTokens: 100, costUsd: 0.11, turns: 1 });
    addRunUsage(u, undefined);
    expect(u).toEqual({ inputTokens: 12_300, cachedInputTokens: 300, cacheCreationInputTokens: 0, outputTokens: 4_100, costUsd: 0.31, invocations: 2, callsWithoutUsage: 1 });
    expect(formatRunUsage(u, 84_200)).toBe("84.2s · tokens 12.3k in + 300 cache-read / 4.1k out · $0.31 · 1 call(s) without usage");
    expect(formatRunUsage(undefined, 250)).toBe("250ms · tokens (none reported)");
    expect(formatRunUsage(u, 84_200, { calls: 3, savedChars: 41_000 })).toBe("84.2s · tokens 12.3k in + 300 cache-read / 4.1k out · $0.31 · 1 call(s) without usage · shaped −41.0k chars");
    expect(formatRunUsage(undefined, 250, { calls: 0, savedChars: 0 })).toBe("250ms · tokens (none reported)");
    expect(formatRunUsage(undefined, 250, { calls: 1, savedChars: 12 })).toBe("250ms · tokens (none reported) · shaped −12 chars");
  });

  /**
   * The run line used to print `tokens 12 in (38.3k cached) / 8.5k out` for the real aggregate of
   * bench/ablation/runs/noL5-1.json — which reads as "12 tokens of prompt, mostly cached" when the
   * truth was 12 fresh + 38.3k read from the cache + 21.2k WRITTEN to it, three prices, one sum.
   */
  test("formatRunUsage: fresh, cache-read and cache-write are three additive terms, never one", () => {
    const u = emptyRunUsage();
    addRunUsage(u, { inputTokens: 12, cachedInputTokens: 38_274, cacheCreationInputTokens: 21_234, outputTokens: 8_533, costUsd: 0.1533758, turns: 5 });
    expect(u.cacheCreationInputTokens).toBe(21_234);
    expect(formatRunUsage(u, 60_000)).toBe("60.0s · tokens 12 in + 38.3k cache-read + 21.2k cache-write / 8.5k out · $0.15");
    // A run with no caching at all prints exactly what it always printed.
    const plain = emptyRunUsage();
    addRunUsage(plain, { inputTokens: 900, outputTokens: 50, turns: 1 });
    expect(formatRunUsage(plain, 1_000)).toBe("1.0s · tokens 900 in / 50 out");
  });

  test("a failed invocation is counted, marked billed, and named in the line", () => {
    const u = emptyRunUsage();
    addRunUsage(u, { inputTokens: 8, cachedInputTokens: 81_488, cacheCreationInputTokens: 21_234, outputTokens: 3_027, costUsd: 0.1460416, turns: 6 }, { failed: true });
    addRunUsage(u, { inputTokens: 4, cachedInputTokens: 100, outputTokens: 10, costUsd: 0.0073342, turns: 1 });
    expect(u.invocations).toBe(2);
    expect(u.failedInvocations).toBe(1);
    expect(u.costUsd).toBeCloseTo(0.1533758, 7);
    expect(formatRunUsage(u, 60_000)).toContain("1 failed invocation(s) (billed)");
    // Nothing is marked when nothing failed: the field stays absent, the line unchanged.
    const clean = emptyRunUsage();
    addRunUsage(clean, { inputTokens: 4, outputTokens: 10, turns: 1 });
    expect(clean.failedInvocations).toBeUndefined();
    expect(formatRunUsage(clean, 1_000)).not.toContain("failed");
  });

  test("usageOfFailure reads BackendError.usage and refuses anything else", () => {
    const err = new BackendError("claude-sonnet", "exit", "boom", { inputTokens: 8, outputTokens: 3_027, costUsd: 0.146, turns: 6 });
    expect(usageOfFailure(err)?.costUsd).toBe(0.146);
    expect(usageOfFailure(new BackendError("grok", "auth", "nope"))).toBeUndefined();
    expect(usageOfFailure(new Error("plain"))).toBeUndefined();
    expect(usageOfFailure(undefined)).toBeUndefined();
    expect(usageOfFailure({ usage: { inputTokens: "8" } })).toBeUndefined();
  });
});

/**
 * A CLI that dies has already bought its tokens. Before this, the usage was extracted only on the
 * success path, so a run that failed over lost the whole cost of the attempt that failed —
 * measured: bench/ablation/runs/noL5-1.json reported $0.1534 for a run whose single failed
 * `claude -p` was worth $0.1460 on its own.
 */
describe("usage of an invocation that failed", () => {
  const runner = (stdout: string, exitCode = 1, timedOut = false) =>
    async (): Promise<SpawnResult> => ({ stdout, stderr: "", exitCode, timedOut, signal: null });
  const req = (phase: Phase = "act"): CompleteRequest => ({ role: "worker_a", phase, trustedGoal: "goal", envelopes: [], system: "SYSTEM" });

  const claudeFailure = JSON.stringify({
    is_error: true,
    duration_api_ms: 34_485,
    num_turns: 6,
    stop_reason: "tool_use",
    total_cost_usd: 0.1460416,
    usage: { input_tokens: 8, cache_creation_input_tokens: 21_234, cache_read_input_tokens: 81_488, output_tokens: 3_027 },
  });

  test("claude: a non-zero exit still carries its usage on the error", async () => {
    const backend = new ClaudeBackend("sonnet", 1000, { runner: runner(claudeFailure) });
    const err = await backend.complete(req()).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).kind).toBe("exit");
    expect((err as BackendError).usage).toEqual({ inputTokens: 8, cachedInputTokens: 81_488, cacheCreationInputTokens: 21_234, outputTokens: 3_027, costUsd: 0.1460416, turns: 6 });
  });

  test("grok: an auth failure that still printed its envelope is billed too", async () => {
    const stdout = JSON.stringify({ text: "", stopReason: "error", usage: { input_tokens: 900, output_tokens: 50 }, total_cost_usd_ticks: 43_220_800, num_turns: 1, error: "session expired" });
    const backend = new GrokBackend(1000, { runner: runner(stdout) });
    const err = (await backend.complete(req()).then(() => undefined, (e: unknown) => e)) as BackendError;
    expect(err.kind).toBe("auth");
    expect(err.usage?.costUsd).toBeCloseTo(0.00432208, 8);
  });

  test("codex: the turns completed before turn.failed are billed; a timeout keeps what it printed", async () => {
    // An isolated home + workspace: the schema-capability learning must not touch ~/.agentik, and
    // the failure message deliberately avoids the structured-output signature (no retry here).
    const home = await makeWorkspace("usage-codex-home-");
    const ws = await makeWorkspace("usage-codex-ws-");
    const stream = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, cache_creation_input_tokens: 40, output_tokens: 30 } }),
      JSON.stringify({ type: "turn.failed", message: "the model stopped mid-turn" }),
    ].join("\n");
    const cReq = { ...req(), workspace: ws };
    const backend = new CodexBackend(1000, { runner: runner(stream), home });
    const err = (await backend.complete(cReq).then(() => undefined, (e: unknown) => e)) as BackendError;
    expect(err.usage).toEqual({ inputTokens: 1000, cachedInputTokens: 200, cacheCreationInputTokens: 40, outputTokens: 30, turns: 1 });

    const killed = new CodexBackend(1000, { runner: runner(stream, 143, true), home });
    const err2 = (await killed.complete(cReq).then(() => undefined, (e: unknown) => e)) as BackendError;
    expect(err2.kind).toBe("timeout");
    expect(err2.usage?.inputTokens).toBe(1000);
  });

  test("a failure that printed no accounting leaves usage undefined, not zero", async () => {
    const backend = new ClaudeBackend("sonnet", 1000, { runner: runner("command not found", 127) });
    const err = (await backend.complete(req()).then(() => undefined, (e: unknown) => e)) as BackendError;
    expect(err.usage).toBeUndefined();
  });
});

class WithUsage implements Backend {
  constructor(readonly id: string) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    await new Promise((r) => setTimeout(r, 5));
    const usage = { inputTokens: 100, outputTokens: 10, costUsd: 0.001, turns: 1 };
    if (req.phase === "plan") return { text: "plan", tasks: [{ id: "t", assignee: "worker_a", instruction: "x", allowedTools: ["read_file"] }], usage };
    return { text: "done", toolCalls: [], usage };
  }
}

describe("run-level usage and durations", () => {
  test("every invocation carries durationMs and usage; the report aggregates; formatReport shows them", async () => {
    const ws = await makeWorkspace("usage-loop-");
    const report = await runLoop({ goal: "x", workspace: ws, workerA: new WithUsage("u-a"), workerB: new WithUsage("u-b") });
    expect(report.workersInvoked.length).toBeGreaterThanOrEqual(3);
    for (const w of report.workersInvoked) {
      expect(w.durationMs).toBeGreaterThanOrEqual(4);
      expect(w.usage?.inputTokens).toBe(100);
    }
    const n = report.workersInvoked.length;
    // The cast is the one visible seam of this change: `RunReport["usage"]` (src/types.ts) still
    // declares the older shape, so the cache-write count travels in the JSON but not in the type.
    expect(report.usage as RunUsage).toEqual({ inputTokens: 100 * n, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10 * n, costUsd: expect.closeTo(0.001 * n, 6), invocations: n, callsWithoutUsage: 0 });
    expect(report.durationMs).toBeGreaterThanOrEqual(5 * n - 5);
    expect(formatReport(report)).toMatch(/worker_a \(u-a\) plan \d+ms in=100 out=10 \$0\.0010/);
    for (const t of report.taskResults) for (const c of t.evidence.calls) expect(typeof c.durationMs).toBe("number");
  });

  test("a mock run prints the run line with (none reported)", async () => {
    const ws = await makeWorkspace("usage-cli-ws-");
    const home = await makeWorkspace("usage-cli-home-");
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    let code: number;
    try {
      code = await main(["--backend", "mock", "--workspace", ws, "--agentik-home", home, "Create a.txt containing X"]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    const line = out.join("\n").match(/^run: (\S+) · (.+)$/m);
    expect(line).toBeTruthy();
    expect(line![1]).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    expect(line![2]).toMatch(/^\d+(\.\d)?(ms|s) · tokens \(none reported\)$/);
    expect(out.join("\n")).toMatch(/^run file: .+\.json$/m);
  });
});
