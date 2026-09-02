import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readConfig } from "./config.ts";
import { agentikHome, memoryPaths, projectMemoryPath } from "./home.ts";
import { detectInjection } from "./injection.ts";
import { logMemoryOp, type MemoryOpActor } from "./memory-log.ts";
import { newPendingId, stagePending, type PendingMemoryOp } from "./pending.ts";

/**
 * The always-loaded memory files, written by a model through the `memory` tool.
 *
 * MEMORY.md (target `memory`) holds GLOBAL durable facts — true in every project: tool
 * behaviours, CLI quirks, cross-repo lessons. USER.md (target `user`) holds who the user is
 * (preferences, corrections, style). `memory/projects/<slug>/MEMORY.md` (target `project`)
 * holds what is true of ONE workspace only — conventions, paths, test commands — and is never
 * loaded into another workspace's context. All three are capped in characters, and the cap is
 * not a limit that overflows somewhere else: an `add` that would exceed it fails and tells the
 * caller to consolidate first, in the same turn. That single rule is what keeps the file worth
 * loading — Hermes's memory_tool works the same way.
 *
 * Entries are separated by `\n§\n` (section sign), may span lines, and are exact-deduplicated.
 * The same masking / dedup / cap / consolidation logic serves every target; only the path differs.
 */
export type MemoryTarget = "memory" | "user" | "project";

export const MEMORY_CAP = 2200;
export const USER_CAP = 1375;
export const PROJECT_CAP = 2200;
export const CAPS: Record<MemoryTarget, number> = { memory: MEMORY_CAP, user: USER_CAP, project: PROJECT_CAP };

/** `workspace` is required for target `project` (its file is per workspace) and ignored otherwise. */
export interface MemoryStoreOpts {
  home?: string;
  workspace?: string;
  /** Who writes (journal): the reviewer's tool, the human's pen, an approval, a migration. Default reviewer. */
  by?: MemoryOpActor;
  /** The session this write belongs to, when known (journal). */
  sessionId?: number;
}

/** Journal a batch after the file is written; a broken journal is one stderr line, never a failed write. */
async function journal(target: MemoryTarget, ops: MemoryOperation[], opts: MemoryStoreOpts | undefined, workspace: string | undefined): Promise<void> {
  const mask = (text: string | undefined) => {
    if (!text) return undefined;
    const problem = memoryContentProblem(text);
    return problem ? `[BLOCKED: ${problem}]` : text;
  };
  for (const op of ops) {
    try {
      await logMemoryOp(
        {
          target,
          workspace: workspace ? resolve(workspace) : undefined,
          op: op.action,
          before: mask(op.action === "add" ? undefined : op.old),
          after: mask(op.action === "remove" ? undefined : op.action === "add" ? op.content : op.new),
          sessionId: opts?.sessionId,
          by: opts?.by ?? "reviewer",
        },
        { home: opts?.home },
      );
    } catch (err) {
      console.error(`agentik: could not journal the memory write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const PROJECT_NEEDS_WORKSPACE = "project memory needs a workspace";

/** The file's human name in messages. */
export function memoryFileLabel(target: MemoryTarget): string {
  return target === "memory" ? "MEMORY.md" : target === "user" ? "USER.md" : "project MEMORY.md";
}
export const ENTRY_SEPARATOR = "\n§\n";

/** Consolidation attempts a single review gets before it is told to stop retrying. */
export const MAX_CONSOLIDATION_FAILURES = 3;

export interface MemoryUsage {
  used: number;
  cap: number;
  percent: number;
}

export interface MemoryOpResult {
  ok: boolean;
  target: MemoryTarget;
  action: "add" | "replace" | "remove" | "batch";
  message: string;
  usage: MemoryUsage;
  /** Included on a cap refusal so the caller can pick what to replace or remove. */
  entries?: string[];
  /** The write was refused by the safety scan. */
  blocked?: string;
  /** The add would have exceeded the cap. */
  overCap?: boolean;
  /** `memory.writeApproval` is on: nothing was written, the batch waits under this id. */
  staged?: string;
}

export interface MemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  old?: string;
  new?: string;
}

// ------------------------------------------------------------------------------------------
// Safety: nothing that looks like a credential, and nothing that reads as an instruction to a
// future agent, gets written — and anything already on disk that trips the scan is masked at
// load time rather than silently trusted.
// ------------------------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ id: string; re: RegExp }> = [
  // Anthropic: `sk-ant-api03-…`, `sk-ant-…` — the body is base64url, so `-` and `_` are part
  // of the run; checked before the openai shape, which would stop at the first `-`.
  { id: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  // OpenAI / Stripe and any other `sk-<label>-<20+>` shape: an unknown label is not a reason
  // to accept the token. Current OpenAI project keys mix `_` and `-` inside the body
  // (`sk-proj-…T3BlbkFJ…`), so the body admits them and there is no trailing \b (it cannot sit
  // between an alnum and `_`).
  { id: "openai_or_stripe_key", re: /\b[sp]k[-_](?:[A-Za-z0-9]{1,16}[-_])?[A-Za-z0-9_-]{20,}/ },
  { id: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i },
  {
    id: "hardcoded_secret",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|bearer|authorization)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}/i,
  },
];

/** The reason a text must not be stored, or undefined. */
export function memoryContentProblem(text: string): string | undefined {
  for (const { id, re } of SECRET_PATTERNS) {
    if (re.test(text)) return `looks like a secret (${id})`;
  }
  const finding = detectInjection(text, "inter_agent", "memory");
  if (finding.detected && (finding.severity === "high" || finding.severity === "medium")) {
    return `reads as a prompt injection (${finding.ruleIds.join(",")})`;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------
// File format
// ------------------------------------------------------------------------------------------

function pathFor(target: MemoryTarget, home?: string, workspace?: string): { file: string; dir: string } {
  const paths = memoryPaths(agentikHome(home));
  if (target === "project") {
    if (!workspace) throw new Error(PROJECT_NEEDS_WORKSPACE);
    const file = projectMemoryPath(paths.root, workspace);
    return { file, dir: dirname(file) };
  }
  return { file: target === "memory" ? paths.hot : paths.user, dir: paths.memoryDir };
}

/** Absolute path of the file behind a target (throws for `project` without a workspace). */
export function memoryFilePath(target: MemoryTarget, opts?: MemoryStoreOpts): string {
  return pathFor(target, opts?.home, opts?.workspace).file;
}

/**
 * Parse a memory file. Accepts the `§`-separated form and, for files written before this
 * store existed, one `- (kind) text` line per entry under a `# MEMORY` header.
 */
export function parseEntries(body: string): string[] {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  if (text.includes("§")) {
    return text.split(/\n?§\n?/).map((e) => e.trim()).filter(Boolean);
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.map((l) => l.replace(/^- (?:\((?:fact|lesson|session)\) )?/, "").trim()).filter(Boolean);
}

export function usageOf(entries: string[], target: MemoryTarget): MemoryUsage {
  const used = entries.join(ENTRY_SEPARATOR).length;
  const cap = CAPS[target];
  return { used, cap, percent: Math.round((used / cap) * 100) };
}

export async function readEntries(target: MemoryTarget, home?: string, opts?: { workspace?: string }): Promise<string[]> {
  const { file } = pathFor(target, home, opts?.workspace);
  try {
    return parseEntries(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function writeEntries(target: MemoryTarget, entries: string[], home?: string, workspace?: string): Promise<void> {
  const { file, dir } = pathFor(target, home, workspace);
  await mkdir(dir, { recursive: true });
  if (target === "project" && workspace) {
    // A human browsing memory/projects/ can tell which checkout a slug belongs to.
    await writeFile(join(dir, ".workspace"), `${resolve(workspace)}\n`, "utf8");
  }
  await writeFile(file, entries.length ? `${entries.join(ENTRY_SEPARATOR)}\n` : "", "utf8");
}

// ------------------------------------------------------------------------------------------
// Operations
// ------------------------------------------------------------------------------------------

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Exact entry, else the single entry containing the text. Ambiguity is an error, not a guess. */
function locate(entries: string[], needle: string): { index: number } | { error: string } {
  const n = normalize(needle);
  const exact = entries.findIndex((e) => normalize(e) === n);
  if (exact >= 0) return { index: exact };
  const partial = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => normalize(e).includes(n));
  if (partial.length === 1) return { index: partial[0].i };
  if (partial.length === 0) return { error: `no entry matches "${needle.slice(0, 60)}"` };
  return { error: `"${needle.slice(0, 60)}" matches ${partial.length} entries — quote one exactly` };
}

function overCapMessage(target: MemoryTarget, usage: MemoryUsage, attempted: number): string {
  return (
    `${memoryFileLabel(target)} at ${usage.used}/${usage.cap} chars; ` +
    `adding ${attempted} chars would exceed the cap. Consolidate now: use 'replace' to merge ` +
    `related entries or 'remove' to drop stale ones, then retry this add — all in this turn.`
  );
}

function applyOps(
  target: MemoryTarget,
  entries: string[],
  ops: MemoryOperation[],
): { entries: string[]; notes: string[] } | { error: string; blocked?: string } {
  const next = [...entries];
  const notes: string[] = [];
  for (const op of ops) {
    if (op.action === "add") {
      const content = normalize(op.content ?? "");
      if (!content) return { error: "add: content is required" };
      const problem = memoryContentProblem(content);
      if (problem) return { error: `add refused: ${problem}`, blocked: problem };
      if (next.some((e) => normalize(e) === content)) {
        notes.push("no duplicate added");
        continue;
      }
      next.push(content);
      notes.push(`added (${content.length} chars)`);
    } else if (op.action === "replace") {
      const replacement = normalize(op.new ?? "");
      if (!op.old || !replacement) return { error: "replace: old and new are required" };
      const problem = memoryContentProblem(replacement);
      if (problem) return { error: `replace refused: ${problem}`, blocked: problem };
      const at = locate(next, op.old);
      if ("error" in at) return { error: `replace: ${at.error}` };
      next[at.index] = replacement;
      notes.push("replaced");
    } else if (op.action === "remove") {
      if (!op.old) return { error: "remove: old is required" };
      const at = locate(next, op.old);
      if ("error" in at) return { error: `remove: ${at.error}` };
      next.splice(at.index, 1);
      notes.push("removed");
    } else {
      return { error: `unknown action ${String((op as { action: string }).action)}` };
    }
  }
  return { entries: next, notes };
}

export function previewOps(ops: MemoryOperation[]): string {
  const cut = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return ops
    .map((op) => {
      if (op.action === "add") return `add "${cut(op.content)}"`;
      if (op.action === "replace") return `replace "${cut(op.old)}" -> "${cut(op.new)}"`;
      return `remove "${cut(op.old)}"`;
    })
    .join("; ");
}

/**
 * Apply one or more operations atomically. The cap is checked on the *result*, so a remove +
 * add in one batch is the intended way to make room. Nothing is written on any error.
 *
 * This is the single write path for MEMORY.md, USER.md and the project files — the reviewer's `memory` tool,
 * `retainNote`, and the CLI all end here — which is why write approval is enforced here and
 * nowhere else. With `memory.writeApproval` on, a batch that *would* apply cleanly (content
 * scan, targets found, under the cap) is staged and reported as a success: the reviewer
 * decided, the human applies. `bypassApproval` is for `agentik memory approve`, which
 * replays a staged batch through the same validation against the file as it is now.
 */
export async function memoryApply(
  target: MemoryTarget,
  ops: MemoryOperation[],
  opts?: MemoryStoreOpts & { bypassApproval?: boolean },
): Promise<MemoryOpResult> {
  const action = ops.length === 1 ? ops[0].action : "batch";
  const workspace = target === "project" ? opts?.workspace : undefined;
  const before = await readEntries(target, opts?.home, { workspace });
  const usageBefore = usageOf(before, target);
  if (ops.length === 0) {
    return { ok: false, target, action, message: "no operations", usage: usageBefore };
  }
  const applied = applyOps(target, before, ops);
  if ("error" in applied) {
    return {
      ok: false,
      target,
      action,
      message: applied.error,
      usage: usageBefore,
      blocked: applied.blocked,
    };
  }
  const usageAfter = usageOf(applied.entries, target);
  if (usageAfter.used > usageAfter.cap) {
    return {
      ok: false,
      target,
      action,
      overCap: true,
      message: overCapMessage(target, usageBefore, usageAfter.used - usageBefore.used),
      usage: usageBefore,
      entries: before,
    };
  }
  if (!opts?.bypassApproval && (await readConfig({ home: opts?.home })).memory.writeApproval) {
    const now = new Date();
    const entry: PendingMemoryOp = {
      id: newPendingId(now),
      target,
      ops,
      at: now.toISOString(),
      preview: previewOps(ops),
      ...(workspace ? { workspace: resolve(workspace) } : {}),
    };
    await stagePending("memory", entry, { home: opts?.home });
    return {
      ok: true,
      target,
      action,
      message: `staged for approval (#${entry.id}) — run \`agentik memory approve ${entry.id}\``,
      usage: usageBefore,
      staged: entry.id,
    };
  }
  await writeEntries(target, applied.entries, opts?.home, workspace);
  await journal(target, ops, opts, workspace);
  return {
    ok: true,
    target,
    action,
    message: applied.notes.join("; "),
    usage: usageAfter,
  };
}

export const memoryAdd = (target: MemoryTarget, content: string, opts?: MemoryStoreOpts) =>
  memoryApply(target, [{ action: "add", content }], opts);
export const memoryReplace = (target: MemoryTarget, old: string, next: string, opts?: MemoryStoreOpts) =>
  memoryApply(target, [{ action: "replace", old, new: next }], opts);
export const memoryRemove = (target: MemoryTarget, old: string, opts?: MemoryStoreOpts) =>
  memoryApply(target, [{ action: "remove", old }], opts);

export type RemoveEntryResult =
  | { ok: true; removed: string; backup: string; usage: MemoryUsage }
  | { ok: false; message: string; candidates: string[] };

/**
 * The human's pen: `agentik memory remove`. Matches one entry by exact text, else by unique
 * prefix; zero or several matches is a refusal that names the candidates. No approval queue
 * (the human IS the approver), but a `<file>.bak.<ts>` copy is taken first, like the legacy
 * sweep does.
 */
export async function memoryRemoveEntry(
  target: MemoryTarget,
  needle: string,
  opts?: MemoryStoreOpts,
): Promise<RemoveEntryResult> {
  const workspace = target === "project" ? opts?.workspace : undefined;
  const { file } = pathFor(target, opts?.home, workspace);
  const entries = await readEntries(target, opts?.home, { workspace });
  const n = normalize(needle);
  const exact = n ? entries.filter((e) => normalize(e) === n) : [];
  const matches = exact.length ? exact : n ? entries.filter((e) => normalize(e).startsWith(n)) : [];
  const shown = needle.replace(/\s+/g, " ").trim().slice(0, 60);
  if (matches.length === 0) return { ok: false, message: `no entry matches "${shown}"`, candidates: [] };
  if (matches.length > 1) {
    return { ok: false, message: `"${shown}" matches ${matches.length} entries — quote one exactly`, candidates: matches };
  }
  const stamp = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let backup = stamp;
  for (let n = 2; existsSync(backup); n++) backup = `${stamp}-${n}`; // two removals in the same ms keep both states
  await copyFile(file, backup);
  const res = await memoryApply(target, [{ action: "remove", old: matches[0] }], { ...opts, by: opts?.by ?? "human", bypassApproval: true });
  if (!res.ok) return { ok: false, message: res.message, candidates: [] };
  return { ok: true, removed: matches[0], backup, usage: res.usage };
}

// ------------------------------------------------------------------------------------------
// Snapshot: what goes into a prompt. Frozen at the moment it is taken; the caller decides when.
// ------------------------------------------------------------------------------------------

export interface MemorySnapshot {
  target: MemoryTarget;
  header: string;
  body: string;
  usage: MemoryUsage;
  /** Entries masked at load because they trip the scan. Kept on disk for inspection. */
  blockedCount: number;
}

export async function memorySnapshot(target: MemoryTarget, home?: string, opts?: { workspace?: string }): Promise<MemorySnapshot> {
  const entries = await readEntries(target, home, { workspace: opts?.workspace });
  const usage = usageOf(entries, target);
  let blockedCount = 0;
  const shown = entries.map((e) => {
    const problem = memoryContentProblem(e);
    if (!problem) return e;
    blockedCount += 1;
    return `[BLOCKED: ${problem}]`;
  });
  const title =
    target === "memory"
      ? "MEMORY (durable facts)"
      : target === "user"
        ? "USER PROFILE (who the user is)"
        : "PROJECT MEMORY (this workspace)";
  const header = `${title} [${Math.min(100, usage.percent)}% — ${usage.used}/${usage.cap} chars]`;
  return { target, header, body: shown.length ? shown.join("\n§\n") : "(empty)", usage, blockedCount };
}
