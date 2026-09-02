import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { formatReport, runLoop } from "../src/loop.ts";
import { addRunUsage, emptyRunUsage, extractUsage, formatRunUsage } from "../src/usage.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

describe("extractUsage", () => {
  test("claude json: usage + total_cost_usd + duration_ms + num_turns", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success", result: "{\"text\":\"hi\"}", usage: { input_tokens: 12_300, cache_read_input_tokens: 5_000, output_tokens: 4_100 }, total_cost_usd: 0.31, duration_ms: 84_200, num_turns: 3 });
    expect(extractUsage("claude", stdout)).toEqual({ inputTokens: 12_300, cachedInputTokens: 5_000, outputTokens: 4_100, costUsd: 0.31, turns: 3, durationMs: 84_200 });
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
    expect(u).toEqual({ inputTokens: 12_300, cachedInputTokens: 300, outputTokens: 4_100, costUsd: 0.31, invocations: 2, callsWithoutUsage: 1 });
    expect(formatRunUsage(u, 84_200)).toBe("84.2s · tokens 12.3k in (300 cached) / 4.1k out · $0.31 · 1 call(s) without usage");
    expect(formatRunUsage(undefined, 250)).toBe("250ms · tokens (none reported)");
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
    expect(report.usage).toEqual({ inputTokens: 100 * n, cachedInputTokens: 0, outputTokens: 10 * n, costUsd: expect.closeTo(0.001 * n, 6), invocations: n, callsWithoutUsage: 0 });
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
