import type { HarnessName } from "./availability.ts";
import { commandSegments, matchCommandRules } from "./command-policy.ts";

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
  /** Parsed stream events of any type (0 = the harness never spoke). */
  eventCount: number;
  /** What the worker did, in order: edits, test runs, everything else. The evidence reading lives here. */
  events: VerdictEvent[];
  /** Shell commands the harness proposed (claude Bash, grok run_terminal_command, codex command_execution). */
  commands: string[];
  /** Commands the harness itself denied (claude `permission_denials`). */
  denied: string[];
}

export type VerdictEventKind = "edit" | "test" | "other";

export interface VerdictEvent {
  kind: VerdictEventKind;
  /** ms since epoch, when the line was read. */
  at: number;
  /** Tool name and a short argument summary. */
  detail: string;
  /** Workspace paths an edit touched, when the input names them. */
  paths?: string[];
}

/** Tools that write files, per harness (names as the stream reports them). */
export const EDIT_TOOLS: Record<HarnessName, Set<string>> = {
  claude: new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]),
  grok: new Set(["write", "search_replace", "edit", "create_file", "apply_patch"]),
  codex: new Set(["file_change", "patch_apply"]),
};

/** First tokens that mean "a test suite / typecheck ran". `./scripts/test.sh` is `other` — documented limit. */
const TEST_HEADS: string[][] = [
  ["bun", "test"],
  ["bunx", "tsc"],
  ["tsc", "--noEmit"],
  ["npm", "test"],
  ["npm", "run", "test"],
  ["pnpm", "test"],
  ["pnpm", "run", "test"],
  ["yarn", "test"],
  ["pytest"],
  ["python", "-m", "pytest"],
  ["python3", "-m", "pytest"],
  ["cargo", "test"],
  ["go", "test"],
  ["vitest"],
  ["jest"],
  ["make", "test"],
  ["dotnet", "test"],
  ["mix", "test"],
  ["rspec"],
  ["phpunit"],
];
const EXEC_WRAPPERS = new Set(["npx", "bunx", "pnpx"]);

/**
 * Does this command line run a test suite or a typecheck? Every `&&`/`;`/`|` segment counts,
 * `cd x`, `VAR=x`, `npx|bunx|pnpm exec` are stripped; `echo bun test` is not a test.
 */
export function isTestCommand(command: string): boolean {
  for (const view of commandSegments(command)) {
    let toks = view.split(" ").filter(Boolean);
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
    if (toks[0] === "cd") continue;
    if (EXEC_WRAPPERS.has(toks[0]) && toks[1] !== "tsc") toks = toks.slice(1);
    if (toks[0] === "pnpm" && toks[1] === "exec") toks = toks.slice(2);
    while (toks.length && toks[0].startsWith("-") ) toks = toks.slice(1);
    for (const head of TEST_HEADS) {
      if (head.every((h, i) => toks[i] === h)) return true;
    }
  }
  return false;
}

export type Evidence = "fresh" | "stale" | "none";

/**
 * Did a test run after the last edit? `fresh`: yes. `stale`: edits came after the last test (n
 * of them). `none`: no test ran at all. The stream is the witness; a test the worker only
 * *described* is not in it.
 */
export function evidenceOf(v: HarnessVerdict): { evidence: Evidence; editsAfterLastTest: number; tests: number; edits: number } {
  let lastTest = -1;
  let edits = 0;
  let tests = 0;
  v.events.forEach((e, i) => {
    if (e.kind === "test") {
      tests += 1;
      lastTest = i;
    } else if (e.kind === "edit") edits += 1;
  });
  const editsAfterLastTest = v.events.filter((e, i) => e.kind === "edit" && i > lastTest).length;
  const evidence: Evidence = tests === 0 ? "none" : editsAfterLastTest > 0 ? "stale" : "fresh";
  return { evidence, editsAfterLastTest, tests, edits };
}

export function describeEvidence(v: HarnessVerdict): string {
  const e = evidenceOf(v);
  if (e.evidence === "stale") return `evidence=stale(${e.editsAfterLastTest} edit${e.editsAfterLastTest > 1 ? "s" : ""} after last test)`;
  return `evidence=${e.evidence}`;
}

export interface FloorViolation {
  command: string;
  rules: string[];
}

/**
 * High-blast commands the harness reports having run despite the floor: matched by the policy
 * and not in its own denial list. For codex, which has no deny flag, every match is a run.
 */
export function floorViolations(v: HarnessVerdict): FloorViolation[] {
  const out: FloorViolation[] = [];
  for (const command of v.commands) {
    if (v.denied.includes(command)) continue;
    const m = matchCommandRules(command);
    if (m.level !== "medium") out.push({ command, rules: m.rules });
  }
  return out;
}

/** Extra CLI args that switch a harness to its NDJSON event stream. */
export function verdictArgs(harness: HarnessName): string[] {
  if (harness === "grok") return ["--output-format", "streaming-json"];
  if (harness === "claude") return ["--output-format", "stream-json", "--verbose"];
  return ["--json"];
}

export function newVerdict(harness: HarnessName): HarnessVerdict {
  return { harness, completed: false, turns: 0, toolCalls: 0, toolNames: [], errors: [], text: "", eventCount: 0, events: [], commands: [], denied: [] };
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

function record(v: HarnessVerdict, name: string, detail: string, hooks?: RenderHooks, input?: unknown) {
  v.toolCalls += 1;
  v.toolNames.push(name);
  hooks?.onTool?.(name, detail);
  const cmd = commandOf(input);
  const kind: VerdictEventKind = EDIT_TOOLS[v.harness].has(name) ? "edit" : cmd && isTestCommand(cmd) ? "test" : "other";
  const paths = kind === "edit" ? pathsOf(input) : undefined;
  v.events.push({ kind, at: Date.now(), detail: `${name}${detail ? ` ${detail}` : ""}`, ...(paths?.length ? { paths } : {}) });
}

/** Paths an edit input names: `file_path`, `path`, `paths`, codex `changes[].path`. */
function pathsOf(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "path", "filePath", "target_file", "notebook_path"]) {
    if (typeof o[k] === "string") out.push(o[k] as string);
  }
  if (Array.isArray(o.paths)) for (const p of o.paths) if (typeof p === "string") out.push(p);
  if (Array.isArray(o.changes)) for (const c of o.changes) {
    const p = (c as Record<string, unknown>)?.path;
    if (typeof p === "string") out.push(p);
  }
  if (Array.isArray(o.edits)) for (const c of o.edits) {
    const p = (c as Record<string, unknown>)?.file_path ?? (c as Record<string, unknown>)?.path;
    if (typeof p === "string") out.push(p);
  }
  return [...new Set(out)];
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
  v.eventCount += 1;

  if (v.harness === "grok") {
    if (type === "text" && typeof obj.data === "string") {
      v.text += obj.data;
      hooks?.onText?.(obj.data);
    } else if (type === "tool_call") {
      const name = String(obj.toolName ?? obj.title ?? "tool");
      record(v, name, describeArgs(obj.rawInput), hooks, obj.rawInput);
      const cmd = commandOf(obj.rawInput);
      if (cmd && /terminal|bash|shell|command/i.test(name)) v.commands.push(cmd);
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
            record(v, String(p.name ?? "tool"), describeArgs(p.input), hooks, p.input);
            const cmd = commandOf(p.input);
            if (cmd && p.name === "Bash") v.commands.push(cmd);
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
        for (const d of denials) {
          const cmd = commandOf((d as Record<string, unknown>)?.tool_input);
          if (cmd) v.denied.push(cmd);
        }
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
      record(v, itemType, describeArgs(item?.command ?? item?.changes ?? item?.query), hooks, itemType === "command_execution" ? { command: item?.command } : item);
      if (itemType === "command_execution") {
        const cmd = typeof item?.command === "string" ? item.command : commandOf(item?.command);
        if (cmd) v.commands.push(cmd);
      }
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

/** The shell command inside a tool input, whatever the harness calls the field. */
function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (Array.isArray(input)) return input.every((x) => typeof x === "string") ? (input as string[]).join(" ").trim() || undefined : undefined;
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "commandLine", "command_line"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).join(" ");
  }
  return undefined;
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
    describeEvidence(v),
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
  opts: { requireTools?: boolean; requireEvidence?: boolean } = {},
): string | undefined {
  if (!v.completed) {
    return v.stopReason
      ? `${v.harness} ended on stopReason=${v.stopReason} after ${v.turns} turn(s)`
      : `${v.harness} never reported a completed turn`;
  }
  if (opts.requireTools && v.toolCalls === 0) {
    return `${v.harness} finished without calling a single tool (${v.turns} turn(s)) — it described work instead of doing it`;
  }
  if (opts.requireEvidence) {
    const e = evidenceOf(v);
    if (e.evidence !== "fresh") {
      return e.evidence === "none"
        ? `${v.harness} ran no test at all (${e.edits} edit(s)) — the result is unverified`
        : `${v.harness}: no test ran after the last edit (${e.editsAfterLastTest} edit(s) after the last test) — the result is unverified`;
    }
  }
  return undefined;
}
