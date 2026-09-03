import type { HarnessName } from "./availability.ts";
import type { HarnessUsage } from "./verdict.ts";

/**
 * Tokens / cost / time of one gated worker invocation, read from the CLI's own output before
 * the worker JSON is unwrapped:
 *   claude `-p --output-format json` → one object: usage {input_tokens, cache_read_input_tokens,
 *     cache_creation_input_tokens, output_tokens}, total_cost_usd, duration_ms, num_turns
 *   grok `--output-format json`      → one envelope: usage, total_cost_usd | total_cost_usd_ticks
 *     (1e-10 $), num_turns  — the envelope keys are the ones GROK_ENVELOPE_KEYS unwraps; this
 *     reads them, it does not change the unwrapper
 *   codex `exec --json`              → JSONL: every `turn.completed.usage` summed
 * Nothing reported → undefined (the report counts it as a call without usage).
 *
 * THREE input counts, not one. An Anthropic-shaped `usage` object splits the prompt into
 * `input_tokens` (fresh, full price), `cache_read_input_tokens` (a tenth of the price) and
 * `cache_creation_input_tokens` (a quarter MORE than the fresh price). They do not overlap:
 * the billed prompt is their sum. Cache WRITE was read by nothing here, and it is exactly the
 * number that moves when a prompt changes — a reordered system prompt invalidates the prefix
 * and re-writes the whole cache. Measuring a prompt change without it measures nothing.
 */

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * One invocation's usage as the CLI reported it. `HarnessUsage` (src/verdict.ts) is the shared
 * shape; the cache-WRITE count is added here as an optional field so every consumer that types
 * a usage as `HarnessUsage` keeps compiling and still carries the value at runtime (the run file
 * and `WorkerInvocation.usage` are plain JSON). Widening `HarnessUsage` itself is the tidier
 * home for it — see the report.
 */
export interface InvocationUsage extends HarnessUsage {
  /** Tokens written INTO the prompt cache. Billed, and the one that moves when a prompt changes. */
  cacheCreationInputTokens?: number;
}

function tokens(u: unknown): { input?: number; cached?: number; cacheWrite?: number; output?: number } {
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => num(o[k])).find((x) => x !== undefined);
  return {
    input: pick("input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
    cached: pick("cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens", "cached_tokens", "cachedTokens"),
    cacheWrite: pick(
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cache_write_input_tokens",
      "cacheWriteInputTokens",
      "cache_creation_tokens",
      "cacheCreationTokens",
    ),
    output: pick("output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
  };
}

function fromObject(obj: Record<string, unknown>): InvocationUsage | undefined {
  const t = tokens(obj.usage);
  const ticks = num(obj.total_cost_usd_ticks);
  const costUsd = num(obj.total_cost_usd) ?? (ticks !== undefined ? ticks / 1e10 : undefined);
  if (t.input === undefined && t.output === undefined && costUsd === undefined) return undefined;
  return {
    inputTokens: t.input ?? 0,
    ...(t.cached !== undefined ? { cachedInputTokens: t.cached } : {}),
    ...(t.cacheWrite !== undefined ? { cacheCreationInputTokens: t.cacheWrite } : {}),
    outputTokens: t.output ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
    turns: num(obj.num_turns) ?? 1,
    ...(num(obj.duration_ms) !== undefined ? { durationMs: num(obj.duration_ms) } : {}),
  };
}

export function extractUsage(harness: HarnessName, stdout: string): InvocationUsage | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  if (harness === "codex") {
    let acc: InvocationUsage | undefined;
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
        if (t.cacheWrite !== undefined) acc.cacheCreationInputTokens = (acc.cacheCreationInputTokens ?? 0) + t.cacheWrite;
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
  /** Fresh prompt tokens: neither read from nor written to the cache. */
  inputTokens: number;
  /** Prompt tokens served FROM the cache (cheap). */
  cachedInputTokens: number;
  /**
   * Prompt tokens written INTO the cache (billed above the fresh price). Optional in the type so
   * a `RunReport["usage"]` written by an older run — and the structural copy of this shape in
   * `src/types.ts`, which is not this lot's to widen — still satisfies it; `emptyRunUsage` always
   * sets it, so every run this code produces carries the number.
   */
  cacheCreationInputTokens?: number;
  outputTokens: number;
  costUsd?: number;
  /** Model invocations that reported usage / that did not. */
  invocations: number;
  callsWithoutUsage: number;
  /**
   * Invocations counted here that ENDED IN A BackendError (a timeout, a non-zero exit, a failover).
   * They are billed all the same, so they belong in the total; kept apart so a reader can tell an
   * expensive run from a run that paid twice for the same work.
   */
  failedInvocations?: number;
}

export function emptyRunUsage(): RunUsage {
  return { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, invocations: 0, callsWithoutUsage: 0 };
}

/**
 * Add one invocation. `opts.failed` marks an invocation the backend threw on: its tokens were
 * still bought (`BackendError.usage` carries them), and leaving them out made every run that
 * switched backend under-report its own cost.
 */
export function addRunUsage(total: RunUsage, u: InvocationUsage | undefined, opts: { failed?: boolean } = {}): void {
  if (!u) {
    total.callsWithoutUsage += 1;
    return;
  }
  total.invocations += 1;
  if (opts.failed) total.failedInvocations = (total.failedInvocations ?? 0) + 1;
  total.inputTokens += u.inputTokens;
  total.cachedInputTokens += u.cachedInputTokens ?? 0;
  total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
  total.outputTokens += u.outputTokens;
  if (u.costUsd !== undefined) total.costUsd = (total.costUsd ?? 0) + u.costUsd;
}

/**
 * The usage of an invocation that FAILED, when the CLI still printed its accounting before dying.
 * `loop.ts`'s catch has an `unknown`; this is the one line it needs to stop losing the money:
 * `addRunUsage(usage, usageOfFailure(err), { failed: true })`.
 */
export function usageOfFailure(err: unknown): InvocationUsage | undefined {
  if (!err || typeof err !== "object") return undefined;
  const u = (err as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  return typeof o.inputTokens === "number" && typeof o.outputTokens === "number" ? (u as InvocationUsage) : undefined;
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * `84.2s · tokens 12.3k in + 38.3k cache-read + 21.2k cache-write / 8.5k out · $0.31`
 * (+ ` · 1 failed invocation (billed)`, ` · 2 calls without usage`, ` · shaped −41.0k chars`).
 *
 * The three input counts are ADDITIVE and priced differently, so they are printed as a sum, not
 * as `12 in (38.3k cached)` — which read as "12 tokens in, most of them cached" when the truth
 * was 12 fresh + 38.3k read + 21.2k written. A cache read is a tenth of the fresh price and a
 * cache write is a quarter more than it; collapsing them hid the only term that moves when a
 * prompt is edited. A term worth 0 is left out, so a run with no caching prints as before.
 */
export function formatRunUsage(u: RunUsage | undefined, durationMs: number, shaping?: { calls: number; savedChars: number }): string {
  const bits = [durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`];
  if (u && u.invocations > 0) {
    const input = [`${kilo(u.inputTokens)} in`];
    if (u.cachedInputTokens) input.push(`${kilo(u.cachedInputTokens)} cache-read`);
    if (u.cacheCreationInputTokens) input.push(`${kilo(u.cacheCreationInputTokens)} cache-write`);
    bits.push(`tokens ${input.join(" + ")} / ${kilo(u.outputTokens)} out`);
    if (u.costUsd !== undefined) bits.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`);
  } else {
    bits.push("tokens (none reported)");
  }
  if (u && u.failedInvocations && u.invocations > 0) bits.push(`${u.failedInvocations} failed invocation(s) (billed)`);
  if (u && u.callsWithoutUsage > 0 && u.invocations > 0) bits.push(`${u.callsWithoutUsage} call(s) without usage`);
  if (shaping && shaping.savedChars > 0) bits.push(`shaped −${kilo(shaping.savedChars)} chars`);
  return bits.join(" · ");
}
