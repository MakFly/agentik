import type { HarnessName } from "./availability.ts";
import type { HarnessUsage } from "./verdict.ts";

/**
 * Tokens / cost / time of one gated worker invocation, read from the CLI's own output before
 * the worker JSON is unwrapped:
 *   claude `-p --output-format json` → one object: usage {input_tokens, cache_read_input_tokens,
 *     output_tokens}, total_cost_usd, duration_ms, num_turns
 *   grok `--output-format json`      → one envelope: usage, total_cost_usd | total_cost_usd_ticks
 *     (1e-10 $), num_turns  — the envelope keys are the ones GROK_ENVELOPE_KEYS unwraps; this
 *     reads them, it does not change the unwrapper
 *   codex `exec --json`              → JSONL: every `turn.completed.usage` summed
 * Nothing reported → undefined (the report counts it as a call without usage).
 */

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function tokens(u: unknown): { input?: number; cached?: number; output?: number } {
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => num(o[k])).find((x) => x !== undefined);
  return {
    input: pick("input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
    cached: pick("cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cached_tokens", "cachedTokens"),
    output: pick("output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
  };
}

function fromObject(obj: Record<string, unknown>): HarnessUsage | undefined {
  const t = tokens(obj.usage);
  const ticks = num(obj.total_cost_usd_ticks);
  const costUsd = num(obj.total_cost_usd) ?? (ticks !== undefined ? ticks / 1e10 : undefined);
  if (t.input === undefined && t.output === undefined && costUsd === undefined) return undefined;
  return {
    inputTokens: t.input ?? 0,
    ...(t.cached !== undefined ? { cachedInputTokens: t.cached } : {}),
    outputTokens: t.output ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    turns: num(obj.num_turns) ?? 1,
    ...(num(obj.duration_ms) !== undefined ? { durationMs: num(obj.duration_ms) } : {}),
  };
}

export function extractUsage(harness: HarnessName, stdout: string): HarnessUsage | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  if (harness === "codex") {
    let acc: HarnessUsage | undefined;
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l.startsWith("{")) continue;
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        if (obj.type !== "turn.completed") continue;
        const t = tokens(obj.usage);
        if (t.input === undefined && t.output === undefined) continue;
        acc = acc ?? { inputTokens: 0, outputTokens: 0, turns: 0 };
        acc.inputTokens += t.input ?? 0;
        acc.outputTokens += t.output ?? 0;
        if (t.cached !== undefined) acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + t.cached;
        acc.turns += 1;
      } catch {
        /* not JSON */
      }
    }
    return acc;
  }
  // claude / grok: a single JSON object, possibly followed by nothing.
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return fromObject(obj as Record<string, unknown>);
  } catch {
    // Some CLIs print a banner line before the JSON: take the last line that parses.
    for (const line of text.split(/\r?\n/).reverse()) {
      const l = line.trim();
      if (!l.startsWith("{")) continue;
      try {
        const u = fromObject(JSON.parse(l) as Record<string, unknown>);
        if (u) return u;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

export interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Model invocations that reported usage / that did not. */
  invocations: number;
  callsWithoutUsage: number;
}

export function emptyRunUsage(): RunUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, invocations: 0, callsWithoutUsage: 0 };
}

export function addRunUsage(total: RunUsage, u: HarnessUsage | undefined): void {
  if (!u) {
    total.callsWithoutUsage += 1;
    return;
  }
  total.invocations += 1;
  total.inputTokens += u.inputTokens;
  total.cachedInputTokens += u.cachedInputTokens ?? 0;
  total.outputTokens += u.outputTokens;
  if (u.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + u.costUsd;
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** `84.2s · tokens 12.3k in / 4.1k out · $0.31` (+ ` · 2 calls without usage` when relevant). */
export function formatRunUsage(u: RunUsage | undefined, durationMs: number): string {
  const bits = [durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`];
  if (u && u.invocations > 0) {
    bits.push(`tokens ${kilo(u.inputTokens)} in${u.cachedInputTokens ? ` (${kilo(u.cachedInputTokens)} cached)` : ""} / ${kilo(u.outputTokens)} out`);
    if (u.costUsd !== undefined) bits.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`);
  } else {
    bits.push("tokens (none reported)");
  }
  if (u && u.callsWithoutUsage > 0 && u.invocations > 0) bits.push(`${u.callsWithoutUsage} call(s) without usage`);
  return bits.join(" · ");
}
