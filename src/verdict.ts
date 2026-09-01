import type { HarnessName } from "./availability.ts";

/**
 * What a headless harness actually did, read from its own structured stream rather than
 * inferred from the exit code.
 *
 * A worker that narrates an intention and stops exits 0 exactly like one that finished the
 * job. The stream is the only place that distinguishes them: it carries the tool calls that
 * did or did not happen and the harness's own stop reason.
 */
export interface HarnessVerdict {
  harness: HarnessName;
  /** The harness reported a normal end of turn. */
  completed: boolean;
  /** The harness's own words for why the turn ended. */
  stopReason?: string;
  turns: number;
  toolCalls: number;
  toolNames: string[];
  /** Problems the stream reported, verbatim. */
  errors: string[];
  /** Assistant prose, when the stream carries it. */
  text: string;
}

/** Extra CLI args that switch a harness to its NDJSON event stream. */
export function verdictArgs(harness: HarnessName): string[] {
  if (harness === "grok") return ["--output-format", "streaming-json"];
  if (harness === "claude") return ["--output-format", "stream-json", "--verbose"];
  return ["--json"];
}

export function newVerdict(harness: HarnessName): HarnessVerdict {
  return { harness, completed: false, turns: 0, toolCalls: 0, toolNames: [], errors: [], text: "" };
}

/** Tool-ish codex item types. Anything else (agent_message, reasoning, todo_list) is not work. */
const CODEX_TOOL_ITEMS = new Set([
  "command_execution",
  "file_change",
  "patch_apply",
  "mcp_tool_call",
  "web_search",
]);

/** grok stop reasons that mean the turn was cut short rather than finished. */
const GROK_BAD_STOP = new Set(["max_tokens", "max_turns", "max_turn_requests", "refusal", "cancelled"]);

export interface RenderHooks {
  /** Assistant prose as it streams. */
  onText?: (chunk: string) => void;
  /** One line per tool call the harness starts. */
  onTool?: (name: string, detail: string) => void;
}

function record(v: HarnessVerdict, name: string, detail: string, hooks?: RenderHooks) {
  v.toolCalls += 1;
  v.toolNames.push(name);
  hooks?.onTool?.(name, detail);
}

/**
 * Fold one NDJSON line into the verdict. Unknown event types are ignored on purpose: every one
 * of these CLIs documents its type list as non-exhaustive, and a new event must never be read
 * as a failure.
 */
export function consumeVerdictLine(v: HarnessVerdict, line: string, hooks?: RenderHooks): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof obj.type === "string" ? obj.type : "";

  if (v.harness === "grok") {
    if (type === "text" && typeof obj.data === "string") {
      v.text += obj.data;
      hooks?.onText?.(obj.data);
    } else if (type === "tool_call") {
      const name = String(obj.toolName ?? obj.title ?? "tool");
      record(v, name, describeArgs(obj.rawInput), hooks);
    } else if (type === "error") {
      v.errors.push(String(obj.message ?? "error"));
    } else if (type === "max_turns_reached") {
      v.errors.push("max turns reached");
    } else if (type === "end") {
      v.stopReason = typeof obj.stopReason === "string" ? obj.stopReason : undefined;
      v.turns = numberOr(obj.num_turns, v.turns);
      v.completed = !v.stopReason || !GROK_BAD_STOP.has(v.stopReason);
    }
    return;
  }

  if (v.harness === "claude") {
    if (type === "assistant") {
      const content = (obj.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") hooks?.onText?.(p.text);
          if (p.type === "tool_use") {
            record(v, String(p.name ?? "tool"), describeArgs(p.input), hooks);
          }
        }
      }
    } else if (type === "error" || (type === "system" && obj.subtype === "error")) {
      // The harness's own error lines. Recorded verbatim but never a verdict on their own:
      // only `result` decides completion, and a run can log an error and still succeed.
      v.errors.push(claudeErrorMessage(obj));
    } else if (type === "result") {
      v.stopReason = String(obj.stop_reason ?? obj.subtype ?? "");
      v.turns = numberOr(obj.num_turns, v.turns);
      v.completed = obj.subtype === "success" && obj.is_error !== true;
      if (typeof obj.result === "string") v.text = obj.result;
      const denials = obj.permission_denials;
      if (Array.isArray(denials) && denials.length > 0) {
        v.errors.push(`${denials.length} permission denial(s)`);
      }
      if (obj.is_error === true) v.errors.push(String(obj.result ?? "run reported is_error"));
    }
    return;
  }

  // codex
  if (type === "turn.completed") {
    v.turns += 1;
    v.completed = true;
  } else if (type === "turn.failed") {
    v.completed = false;
    v.errors.push(describeArgs(obj.error) || "turn failed");
  } else if (type === "item.completed") {
    const item = obj.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType === "agent_message" && typeof item?.text === "string") {
      v.text += item.text;
      hooks?.onText?.(item.text);
    } else if (itemType === "error") {
      // Recorded, but never on its own a failure: codex emits benign error items on
      // successful runs. `turn.completed` is the authority.
      v.errors.push(String(item?.message ?? "error item"));
    } else if (CODEX_TOOL_ITEMS.has(itemType)) {
      record(v, itemType, describeArgs(item?.command ?? item?.changes ?? item?.query), hooks);
    }
  }
}

/** Longest a verbatim harness error line may get before it is cut. */
const ERROR_LINE_MAX = 200;

/**
 * The short verbatim message of a claude error event: `error.message`, then `message`, then
 * `error` as a string, then the event itself as JSON. Always non-empty, never longer than
 * ERROR_LINE_MAX characters.
 */
function claudeErrorMessage(obj: Record<string, unknown>): string {
  const err = obj.error;
  const nested = err && typeof err === "object" ? (err as Record<string, unknown>).message : undefined;
  for (const c of [nested, obj.message, err]) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, ERROR_LINE_MAX);
  }
  let json = "";
  try {
    json = JSON.stringify(obj);
  } catch {
    json = "";
  }
  return (json || "error event").slice(0, ERROR_LINE_MAX);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function describeArgs(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 80);
  try {
    return JSON.stringify(value).slice(0, 80);
  } catch {
    return "";
  }
}

export function summarizeVerdict(v: HarnessVerdict): string {
  const bits = [
    v.completed ? "completed" : "did NOT complete",
    v.stopReason ? `stop=${v.stopReason}` : "",
    `turns=${v.turns}`,
    `tools=${v.toolCalls}`,
  ].filter(Boolean);
  return bits.join(" · ");
}

/**
 * The reason this run should not be reported as done, or undefined.
 *
 * Zero tool calls is only a failure when the caller says the task required them: a diagnostic
 * or research task legitimately answers with prose alone, and inventing a failure there would
 * be as bad as hiding a real one.
 */
export function verdictProblem(
  v: HarnessVerdict,
  opts: { requireTools?: boolean } = {},
): string | undefined {
  if (!v.completed) {
    return v.stopReason
      ? `${v.harness} ended on stopReason=${v.stopReason} after ${v.turns} turn(s)`
      : `${v.harness} never reported a completed turn`;
  }
  if (opts.requireTools && v.toolCalls === 0) {
    return `${v.harness} finished without calling a single tool (${v.turns} turn(s)) — it described work instead of doing it`;
  }
  return undefined;
}
