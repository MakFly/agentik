import { createHash } from "node:crypto";
import type { ToolCall } from "./types.ts";

/**
 * Per-task guard against the two ways a worker burns its steps: retrying the same failing call
 * and looping on a call whose result never changes. Both are read from what actually happened
 * (the gate's refusals, the executor's answers), never from the worker's prose.
 *
 *   - same call (tool + canonical args) failed twice  → warning in the task context
 *   - same call failed three times                     → blocked: repeated_failing_call
 *   - same result hash three times in a row (any call) → blocked: no_progress
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
  private readonly recentResults: string[] = [];
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
    if (this.recentResults.length >= NO_PROGRESS_AT && new Set(this.recentResults.slice(-NO_PROGRESS_AT)).size === 1) {
      return { block: `no_progress: the last ${NO_PROGRESS_AT} tool results were identical — the task is looping; change approach or stop` };
    }
    return {};
  }

  after(call: Pick<ToolCall, "tool" | "args">, ok: boolean, output: string): void {
    const h = callHash(call.tool, call.args);
    if (ok) this.failures.delete(h);
    else this.failures.set(h, (this.failures.get(h) ?? 0) + 1);
    this.recentResults.push(resultHash(`${ok ? "ok" : "fail"}\n${output}`));
    if (this.recentResults.length > NO_PROGRESS_AT) this.recentResults.shift();
  }
}
