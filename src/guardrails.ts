import { createHash } from "node:crypto";
import type { ToolCall } from "./types.ts";

/**
 * Per-task guard against the two ways a worker burns its steps: retrying the same failing call
 * and looping on a call whose result never changes. Both are read from what actually happened
 * (the gate's refusals, the executor's answers), never from the worker's prose.
 *
 *   - same call (tool + canonical args) failed twice  → warning in the task context
 *   - same call failed three times                     → blocked: repeated_failing_call
 *   - same result hash three times in a row, and this call is one of the calls that produced
 *     them → blocked: no_progress. A call with NEW arguments always runs: a refused call never
 *     reaches `after`, so without this a task whose first three calls were refused identically
 *     (seen live: `pattern` instead of `query`) could never run its corrected call — every
 *     later call was refused with no_progress for the rest of the task.
 *
 * Both counters are about a WORLD THAT DID NOT MOVE, so both are re-armed by `progress()`: a
 * writing tool that succeeded changed the workspace, and `bun test` failing three times before
 * the fix says nothing about `bun test` after it. Without this the guard was monotone for the
 * whole task — the natural shape of a fix (run the check, see it red, write the file, run the
 * check again) hit `repeated_failing_call` on the very call that would have proved the fix.
 * The loop decides what counts as progress (`WRITING_TOOLS` in src/loop.ts); the guard only
 * counts, exactly as it takes its failures from what happened and not from the worker's prose.
 */

export const REPEAT_WARN_AT = 2;
export const REPEAT_BLOCK_AT = 3;
export const NO_PROGRESS_AT = 3;

/** Stable JSON: keys sorted at every level, so {a,b} and {b,a} hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function callHash(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${tool}\n${canonicalJson(args)}`).digest("hex");
}

export function resultHash(output: string): string {
  return createHash("sha256").update(output).digest("hex");
}

export interface GuardVerdict {
  /** Reason to refuse the call before the gate sees it. */
  block?: string;
  /** Something to tell the worker, without refusing. */
  warn?: string;
}

export class ToolGuard {
  private readonly failures = new Map<string, number>();
  private readonly recentResults: { call: string; result: string }[] = [];
  private lastWarnedFor?: string;

  before(call: Pick<ToolCall, "tool" | "args">): GuardVerdict {
    const h = callHash(call.tool, call.args);
    const n = this.failures.get(h) ?? 0;
    if (n >= REPEAT_BLOCK_AT) {
      return { block: `repeated_failing_call: ${call.tool} with these exact arguments failed ${n} times — change the arguments or stop` };
    }
    if (n >= REPEAT_WARN_AT && this.lastWarnedFor !== h) {
      this.lastWarnedFor = h;
      return { warn: `warning: ${call.tool} with these exact arguments already failed ${n} times; a third failure blocks it` };
    }
    const recent = this.recentResults.slice(-NO_PROGRESS_AT);
    if (recent.length >= NO_PROGRESS_AT && new Set(recent.map((r) => r.result)).size === 1 && recent.some((r) => r.call === h)) {
      return { block: `no_progress: the last ${NO_PROGRESS_AT} tool results were identical — the task is looping; change approach or stop` };
    }
    return {};
  }

  after(call: Pick<ToolCall, "tool" | "args">, ok: boolean, output: string): void {
    const h = callHash(call.tool, call.args);
    if (ok) this.failures.delete(h);
    else this.failures.set(h, (this.failures.get(h) ?? 0) + 1);
    this.recentResults.push({ call: h, result: resultHash(`${ok ? "ok" : "fail"}\n${output}`) });
    if (this.recentResults.length > NO_PROGRESS_AT) this.recentResults.shift();
  }

  /**
   * The world moved: forget every failure and every repeated result. Called by the loop after a
   * writing tool succeeded (see `WRITING_TOOLS`), never inferred from prose. Idempotent, and safe
   * to call on a guard that has counted nothing.
   */
  progress(): void {
    this.failures.clear();
    this.recentResults.length = 0;
    this.lastWarnedFor = undefined;
  }
}
