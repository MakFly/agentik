import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GROK_ENVELOPE_KEYS, unwrapGrok } from "../src/backends.ts";
import { listIncidents } from "../src/incidents.ts";
import { consumeVerdictLine, formatUsage, newVerdict, type HarnessVerdict } from "../src/verdict.ts";
import type { HarnessName } from "../src/availability.ts";
import { makeWorkspace } from "./helpers.ts";

function fold(harness: HarnessName, lines: unknown[]): HarnessVerdict {
  const v = newVerdict(harness);
  for (const l of lines) consumeVerdictLine(v, JSON.stringify(l));
  return v;
}

describe("usage read from the stream", () => {
  test("claude result: usage + total_cost_usd + num_turns + duration_ms", () => {
    const v = fold("claude", [
      { type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 12_400, total_cost_usd: 0.31, result: "ok", usage: { input_tokens: 11_100, cache_read_input_tokens: 5_800, output_tokens: 42 } },
    ]);
    expect(v.usage).toEqual({ inputTokens: 11_100, cachedInputTokens: 5_800, outputTokens: 42, costUsd: 0.31, turns: 3, durationMs: 12_400 });
    expect(formatUsage(v.usage)).toBe("usage: in=11.1k (5.8k cached) out=42 cost=$0.31 turns=3 dur=12s");
  });

  test("grok end: usage, dollars else ticks / 1e10 (43220800 ticks = $0.00432208)", () => {
    const ticks = fold("grok", [{ type: "end", stopReason: "end_turn", num_turns: 1, usage: { inputTokens: 900, outputTokens: 50, cachedInputTokens: 100 }, total_cost_usd_ticks: 43_220_800 }]);
    expect(ticks.usage).toEqual({ inputTokens: 900, cachedInputTokens: 100, outputTokens: 50, costUsd: 0.00432208, turns: 1 });
    expect(formatUsage(ticks.usage)).toBe("usage: in=900 (100 cached) out=50 cost=$0.0043 turns=1");
    const dollars = fold("grok", [{ type: "end", stopReason: "end_turn", num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.5, total_cost_usd_ticks: 1 }]);
    expect(dollars.usage?.costUsd).toBe(0.5);
  });

  test("codex: turn.completed usage is cumulated over turns", () => {
    const v = fold("codex", [
      { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 30 } },
      { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 800, output_tokens: 70 } },
    ]);
    expect(v.usage).toEqual({ inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 100, turns: 2 });
    expect(formatUsage(v.usage)).toBe("usage: in=3.0k (1.0k cached) out=100 turns=2");
  });

  test("nothing reported → undefined, formatted honestly; the grok unwrapper is untouched", () => {
    const v = fold("claude", [{ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" }]);
    expect(v.usage).toBeUndefined();
    expect(formatUsage(undefined)).toBe("usage: (none reported by the harness)");
    expect(GROK_ENVELOPE_KEYS.has("usage")).toBe(true);
    expect(unwrapGrok(JSON.stringify({ text: "{\"text\":\"hi\"}", stopReason: "end_turn", usage: {} }))).toBe('{"text":"hi"}');
  });
});

describe("agentik spawn prints the usage line and stores it on incidents", () => {
  test("usage on stderr for a success; in errors of a 125", async () => {
    const home = await makeWorkspace("usage-home-");
    const ws = await makeWorkspace("usage-ws-");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 3000, total_cost_usd: 0.0043, result: "narrated", usage: { input_tokens: 11_100, cache_read_input_tokens: 5_800, output_tokens: 42 } });
    await writeFile(join(bin, "claude"), ["#!/bin/sh", `if [ "$1" = "--help" ]; then echo '  --disallowedTools deny --settings'; exit 0; fi`, `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`, `printf '%s\\n' '${result}'`, "exit 0", ""].join("\n"), "utf8");
    await chmod(join(bin, "claude"), 0o755);
    const run = (extra: string[]) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "30", ...extra, "x"], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTIK_DEPTH: undefined },
      });
      return Promise.all([new Response(proc.stderr).text(), proc.exited]);
    };
    const [okErr, okCode] = await run([]);
    expect(okCode).toBe(0);
    expect(okErr).toContain("agentik spawn: usage: in=11.1k (5.8k cached) out=42 cost=$0.0043 turns=1 dur=3s");
    const [, code125] = await run(["--require-tools"]);
    expect(code125).toBe(125);
    const incidents = await listIncidents({ home, workspace: ws });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].errors).toContain("usage: in=11.1k (5.8k cached) out=42 cost=$0.0043 turns=1 dur=3s");
    expect(incidents[0].errors[0]).toBe("evidence=none");
  });
});
