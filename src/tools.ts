import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgv } from "./argv.ts";
import { killManaged, spawnManaged } from "./backends.ts";
import { classifyCommand } from "./command-policy.ts";
import { readConfig } from "./config.ts";
import { classifyIncident, mergeIncidents, resolveIncident } from "./incidents.ts";
import { memoryApply, type MemoryOperation, type MemoryTarget } from "./memory-store.ts";
import { newPendingId, stagePending, type PendingSkillOp } from "./pending.ts";
import { applySkillCreate, applySkillPatch, skillCreateProblem, skillFile, viewSkill } from "./skill-ops.ts";
import { shapeOutput } from "./shape.ts";
import { skillNameProblem } from "./skill-factory.ts";
import { hasIndex, indexKey } from "./code-index.ts";
import { formatSearch, searchCode } from "./code-search.ts";
import { REVIEWER_ONLY_TOOLS, TOOL_CATALOG } from "./tool-catalog.ts";
import { wrapUntrusted } from "./trust.ts";
import type {
  BlastRadius,
  FetchImpl,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "./types.ts";

export { REVIEWER_ONLY_TOOLS, TOOL_CATALOG } from "./tool-catalog.ts";

/** A postmortem cause is a sentence, not a transcript. */
export const INCIDENT_CAUSE_MAX = 120;

/** `run_command` input as the policy sees it: an argv array, or the string the model sent. */
export function runCommandInput(args: Record<string, unknown>): string | string[] {
  if (Array.isArray(args.argv)) return (args.argv as unknown[]).map(String);
  const cmd = args.cmd ?? args.command;
  return typeof cmd === "string" ? cmd : "";
}

/** Wall-clock bound of one `run_command`, seconds. */
export const RUN_COMMAND_TIMEOUT_DEFAULT_S = 30;
export const RUN_COMMAND_TIMEOUT_MAX_S = 120;
/** Captured stdout/stderr cap per stream. */
export const RUN_COMMAND_CAPTURE_MAX = 2 * 1024 * 1024;

/** Env vars a workspace command never inherits. Suffix rules plus the well-known API keys. */
const SECRET_ENV = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)$|^(GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|NPM_TOKEN)$/i;

export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function specFor(name: string): ToolSpec | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

export function blastForCall(tool: string, args: Record<string, unknown>): BlastRadius {
  const spec = specFor(tool);
  const base = spec?.blastRadius ?? "high";
  if (tool === "run_command" && classifyCommand(runCommandInput(args)) !== "medium") return "high";
  return base;
}

export function resolveSafe(workspace: string, rel: string): string {
  const root = resolve(workspace);
  const full = resolve(root, rel);
  const relToRoot = relative(root, full);
  if (relToRoot.startsWith("..") || resolve(root, relToRoot) !== full) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return full;
}

/** Per-review state the skill tool needs: read-before-write and the one-create budget. */
export interface ReviewState {
  viewedSkills: Set<string>;
  skillsCreated: number;
  maxSkillCreates: number;
}

export interface ToolHost {
  workspace: string;
  fetchImpl?: FetchImpl;
  onRetrieved?: (url: string, body: string) => void;
  /** Home for memory/skills. Only set by the reviewer; its absence blocks the memory tools. */
  agentikHome?: string;
  reviewState?: ReviewState;
  /**
   * Call ids the gate released (an approval granted). Second lock for destructive executors:
   * even a call that reaches executeTool by mistake runs nothing unless its id is here.
   */
  approved?: Set<string>;
  /** The session under review, for the memory journal. */
  sessionId?: number;
  /** Home of the code index (`<home>/index/`); default profile when absent. */
  indexHome?: string;
  /** `--no-index`: search_code refuses with a readable reason instead of reading a stale index. */
  codeIndex?: boolean;
}

export function newReviewState(maxSkillCreates = 1): ReviewState {
  return { viewedSkills: new Set(), skillsCreated: 0, maxSkillCreates };
}

export async function executeTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  switch (call.tool) {
    case "read_file":
      return readFileTool(call, host);
    case "search_code":
      return searchCodeTool(call, host);
    case "write_file":
      return writeFileTool(call, host);
    case "run_command":
      return runCommandTool(call, host);
    case "sandbox_ops":
      return sandboxOpsTool(call, host);
    case "research_fetch":
      return researchFetchTool(call, host);
    case "server_admin":
      return serverAdminTool(call, host);
    case "memory":
      return memoryTool(call, host);
    case "skill_manage":
      return skillManageTool(call, host);
    case "incident":
      return incidentTool(call, host);
    case "fs_destructive":
      return fsDestructiveTool(call, host);
    case "credential_use":
      return {
        callId: call.id,
        ok: false,
        output: `${call.tool} is high-blast-radius and has no unattended executor; refused even after routing`,
      };
    default:
      return { callId: call.id, ok: false, output: `unknown tool ${call.tool}` };
  }
}

/**
 * `offset` / `limit` are characters: a spilled tool output (`.agentik/tool-results/<id>.txt`)
 * is paged with them, so a 50k test log is read in slices instead of re-entering the context
 * whole. Without them the file is returned entire (and spilled again by the loop if too big).
 */
async function readFileTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const rel = String(call.args.path ?? "");
  const full = resolveSafe(host.workspace, rel);
  let body: string;
  try {
    body = await readFile(full, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { callId: call.id, ok: false, output: code === "ENOENT" ? `read_file: ${rel} does not exist in the workspace` : `read_file: cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const offsetRaw = Number(call.args.offset ?? 0);
  const limitRaw = call.args.limit === undefined ? undefined : Number(call.args.limit);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(Math.floor(offsetRaw), body.length) : 0;
  const limit = limitRaw !== undefined && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
  const slice = limit === undefined ? body.slice(offset) : body.slice(offset, offset + limit);
  const paged = offset > 0 || (limit !== undefined && offset + limit < body.length);
  const output = paged
    ? `[${rel} chars ${offset}-${offset + slice.length} of ${body.length}${offset + slice.length < body.length ? `; next offset ${offset + slice.length}` : "; end"}]\n${slice}`
    : slice;
  const env = wrapUntrusted(output, `file:${rel}`, "retrieved");
  return {
    callId: call.id,
    ok: true,
    output: env.body,
    artifact: rel,
  };
}

/**
 * The code index as a tool: candidates from the index, verdict and quotes from the live files,
 * output grouped by file (≤6000 chars, so it is never spilled). An empty result is a success —
 * "no hits" is an answer, not a failing call. No index is a failure the worker can read: it
 * falls back to read_file / run_command, and the conductor runs `agentik index`.
 */
async function searchCodeTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  // `pattern` is what a model trained on grep tools sends first (seen live, three refusals in a
  // row); accepting the alias costs nothing and the refusal text names the real key.
  const query = String(call.args.query ?? call.args.pattern ?? "").trim();
  if (!query) return { callId: call.id, ok: false, output: "search_code: query is required ({\"query\": \"<identifiers or exact substring>\"})" };
  if (host.codeIndex === false) {
    return { callId: call.id, ok: false, output: "search_code: the code index is disabled for this run (--no-index); use read_file or run_command rg instead" };
  }
  const home = host.indexHome ?? host.agentikHome;
  if (!hasIndex(home, host.workspace)) {
    return { callId: call.id, ok: false, output: `search_code: no code index for ${indexKey(host.workspace).root} (the conductor builds one with: agentik index); use read_file or run_command rg instead` };
  }
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
  try {
    const res = await searchCode(home, host.workspace, {
      query,
      regex: Boolean(call.args.regex),
      pathGlob: pathGlobArg(call.args.path),
      k: num(call.args.k),
      offset: num(call.args.offset),
    });
    const env = wrapUntrusted(formatSearch(res), `tool:${call.tool}`, "retrieved");
    return { callId: call.id, ok: true, output: env.body };
  } catch (err) {
    return { callId: call.id, ok: false, output: `search_code: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** `.`, `./`, `` and `**` mean "everywhere": the model's way of saying no filter. */
function pathGlobArg(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().replace(/^\.\//, "");
  return s === "" || s === "." || s === "**" || s === "**/*" ? undefined : s;
}

async function writeFileTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const rel = String(call.args.path ?? "");
  const content = String(call.args.content ?? "");
  const full = resolveSafe(host.workspace, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return {
    callId: call.id,
    ok: true,
    output: `wrote ${rel} (${content.length} bytes)`,
    artifact: rel,
  };
}

async function runCommandTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const parsed = parseArgv(Array.isArray(call.args.argv) ? (call.args.argv as unknown[]).map(String) : typeof (call.args.cmd ?? call.args.command) === "string" ? String(call.args.cmd ?? call.args.command) : undefined);
  if (!parsed.ok) return { callId: call.id, ok: false, output: parsed.problem };
  const { argv } = parsed;
  const level = classifyCommand(argv);
  if (level !== "medium") {
    return {
      callId: call.id,
      ok: false,
      output: level === "hardline"
        ? "command is hardline (never executed, not even with --yolo)"
        : "command classified as high-blast-radius; not executed",
    };
  }
  const rawTimeout = Number(call.args.timeout_s ?? RUN_COMMAND_TIMEOUT_DEFAULT_S);
  const timeoutS = Number.isFinite(rawTimeout) ? Math.min(RUN_COMMAND_TIMEOUT_MAX_S, Math.max(1, Math.floor(rawTimeout))) : RUN_COMMAND_TIMEOUT_DEFAULT_S;
  let proc: Bun.ReadableSubprocess;
  try {
    proc = spawnManaged(argv[0], argv.slice(1), { cwd: host.workspace, stdout: "pipe", stderr: "pipe", env: scrubbedEnv() });
  } catch (err) {
    return { callId: call.id, ok: false, output: `cannot start ${argv[0]}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let timedOut = false;
  const term = setTimeout(() => {
    timedOut = true;
    killManaged(proc);
    setTimeout(() => killManaged(proc, "SIGKILL"), 2_000).unref?.();
  }, timeoutS * 1000);
  const [stdout, stderr, exit] = await Promise.all([
    readCapped(proc.stdout as ReadableStream<Uint8Array>, RUN_COMMAND_CAPTURE_MAX),
    readCapped(proc.stderr as ReadableStream<Uint8Array>, RUN_COMMAND_CAPTURE_MAX),
    proc.exited,
  ]);
  clearTimeout(term);
  const head = timedOut ? `timeout after ${timeoutS}s (killed)\nexit ${exit}` : `exit ${exit}`;
  const tail = stderr ? "\nstderr:\n" + stderr : "";
  const raw = `${head}\n${stdout}${tail}`;
  // Shaping (src/shape.ts) sees stdout only: the exit line stays first and stderr stays verbatim,
  // outside the shaper. Without a shaper the result is byte for byte what it always was.
  const shaped = shapeOutput(argv, stdout, stderr, timedOut ? null : exit);
  if (!shaped.shaper) {
    const env = wrapUntrusted(raw, `tool:run_command`, "tool_output");
    return { callId: call.id, ok: exit === 0 && !timedOut, output: env.body };
  }
  return {
    callId: call.id,
    ok: exit === 0 && !timedOut,
    output: `${head}\n${shaped.text}${tail}`,
    raw,
    shaped: { shaper: shaped.shaper, savedChars: shaped.savedChars },
  };
}

/** Drain a stream into a string, keeping at most `max` bytes; the rest is read and dropped. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let kept = 0;
  let dropped = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    if (kept >= max) {
      dropped += chunk.length;
      continue;
    }
    const take = Math.min(chunk.length, max - kept);
    text += decoder.decode(chunk.subarray(0, take), { stream: true });
    kept += take;
    dropped += chunk.length - take;
  }
  text += decoder.decode();
  return dropped > 0 ? `${text}\n…[${dropped} bytes dropped — capture cap ${max}]` : text;
}

async function sandboxOpsTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const action = String(call.args.action ?? "workspace_status");
  const dir = join(host.workspace, ".agentik");
  await mkdir(dir, { recursive: true });
  const entries = await listShallow(host.workspace);
  const st = await stat(host.workspace);
  const report = {
    action,
    workspace: host.workspace,
    generatedAt: new Date().toISOString(),
    dirMtimeMs: st.mtimeMs,
    entries: entries.slice(0, 50),
    entryCount: entries.length,
    note: "sandbox ops only; no remote host mutation",
  };
  const rel = ".agentik/ops-status.json";
  await writeFile(join(host.workspace, rel), JSON.stringify(report, null, 2), "utf8");
  return {
    callId: call.id,
    ok: true,
    output: `sandbox ops ${action}: ${entries.length} entries`,
    artifact: rel,
  };
}

async function researchFetchTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const url = String(call.args.url ?? "");
  if (!url) return { callId: call.id, ok: false, output: "missing url" };
  if (!host.fetchImpl) {
    return { callId: call.id, ok: false, output: "no fetch implementation bound" };
  }
  const page = await host.fetchImpl(url);
  host.onRetrieved?.(page.url, page.body);
  const env = wrapUntrusted(page.body, page.url, "retrieved");
  const flagged = env.injection?.detected ? " flagged_injection" : "";
  return {
    callId: call.id,
    ok: true,
    output: `retrieved ${page.url} (${page.body.length} bytes)${flagged}`,
    artifact: page.url,
  };
}

async function serverAdminTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  // Even when the orchestrator approved, this never talks to a real remote host.
  // It writes a sandbox receipt so the loop has an observable artifact.
  const dir = join(host.workspace, ".agentik");
  await mkdir(dir, { recursive: true });
  const rel = ".agentik/admin-action.json";
  const receipt = {
    approved: true,
    simulated: true,
    action: call.args.action ?? "unspecified",
    target: call.args.target ?? "sandbox",
    at: new Date().toISOString(),
    note: "No remote/server mutation was performed. High-blast tools stay local receipts.",
  };
  await writeFile(join(host.workspace, rel), JSON.stringify(receipt, null, 2), "utf8");
  return {
    callId: call.id,
    ok: true,
    output: "sandbox admin receipt written (no remote mutation)",
    artifact: rel,
  };
}

/** Never a target of fs_destructive, whatever the approval says. */
const FS_PROTECTED = [".git", ".agentik"];

function fsProblem(workspace: string, rel: string): string | undefined {
  const clean = rel.trim();
  if (!clean || clean === "." || clean === "/" || clean === "./") return "refuses the workspace root";
  let full: string;
  try {
    full = resolveSafe(workspace, clean);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const relToRoot = relative(resolve(workspace), full);
  const top = relToRoot.split(/[\\/]/)[0];
  if (FS_PROTECTED.includes(top)) return `${top}/ is protected`;
  return undefined;
}

/**
 * The one destructive executor, bounded: delete or move INSIDE the workspace, never the root,
 * `.git/` or `.agentik/`, never through a symlink that points outside, never over an existing
 * target. Double lock: the gate must have released this very call id (`host.approved`).
 */
async function fsDestructiveTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  if (!host.approved?.has(call.id)) {
    return { callId: call.id, ok: false, output: "fs_destructive: this call was not released by the gate (no approval on record for it); nothing done" };
  }
  const action = String(call.args.action ?? "");
  const rel = String(call.args.path ?? "");
  if (action !== "delete" && action !== "move") return { callId: call.id, ok: false, output: `fs_destructive: action must be delete or move (got "${action}")` };
  const problem = fsProblem(host.workspace, rel);
  if (problem) return { callId: call.id, ok: false, output: `fs_destructive ${action} refused: ${problem}` };
  const full = resolveSafe(host.workspace, rel);
  let st;
  try {
    st = await lstat(full);
  } catch {
    return { callId: call.id, ok: false, output: `fs_destructive ${action}: ${rel} does not exist` };
  }
  if (st.isSymbolicLink()) {
    const target = await realpath(full).catch(() => "");
    const root = await realpath(host.workspace).catch(() => resolve(host.workspace));
    if (!target || (target !== root && !target.startsWith(`${root}/`))) {
      return { callId: call.id, ok: false, output: `fs_destructive ${action} refused: ${rel} is a symlink pointing outside the workspace` };
    }
  }
  if (action === "delete") {
    await rm(full, { recursive: true, force: false });
    return { callId: call.id, ok: true, output: `deleted ${rel}`, artifact: rel };
  }
  const toRel = String(call.args.to ?? "");
  const toProblem = fsProblem(host.workspace, toRel);
  if (toProblem) return { callId: call.id, ok: false, output: `fs_destructive move refused (target): ${toProblem}` };
  const toFull = resolveSafe(host.workspace, toRel);
  if (await lstat(toFull).then(() => true, () => false)) {
    return { callId: call.id, ok: false, output: `fs_destructive move refused: ${toRel} exists (no overwrite)` };
  }
  await mkdir(dirname(toFull), { recursive: true });
  await rename(full, toFull);
  return { callId: call.id, ok: true, output: `moved ${rel} -> ${toRel}`, artifact: toRel };
}

function reviewerOnly(call: ToolCall, host: ToolHost): ToolResult | undefined {
  if (call.proposedBy !== "reviewer" || !host.agentikHome) {
    return {
      callId: call.id,
      ok: false,
      output: `${call.tool} is reviewer-only: workers and subagents never write memory or skills`,
    };
  }
  return undefined;
}

async function memoryTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const denied = reviewerOnly(call, host);
  if (denied) return denied;
  const target: MemoryTarget = call.args.target === "user" ? "user" : call.args.target === "project" ? "project" : "memory";
  const ops: MemoryOperation[] = Array.isArray(call.args.operations)
    ? (call.args.operations as MemoryOperation[])
    : [
        {
          action: String(call.args.action ?? "add") as MemoryOperation["action"],
          content: typeof call.args.content === "string" ? call.args.content : undefined,
          old: typeof call.args.old === "string" ? call.args.old : undefined,
          new: typeof call.args.new === "string" ? call.args.new : undefined,
        },
      ];
  // The project file is the host workspace's: the reviewer chooses the level, never the path.
  const res = await memoryApply(target, ops, { home: host.agentikHome, workspace: host.workspace, by: "reviewer", sessionId: host.sessionId });
  const lines = [`${res.ok ? "ok" : "refused"}: ${res.message}`, `usage: ${res.usage.used}/${res.usage.cap} chars`];
  if (res.overCap && res.entries) {
    lines.push("current entries:");
    for (const e of res.entries) lines.push(`  § ${e}`);
  }
  return { callId: call.id, ok: res.ok, output: lines.join("\n"), artifact: res.ok ? (target === "project" ? "project/MEMORY.md" : `${target}.md`) : undefined };
}

async function skillManageTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const denied = reviewerOnly(call, host);
  if (denied) return denied;
  const state = host.reviewState ?? newReviewState();
  const action = String(call.args.action ?? "view");
  const name = String(call.args.name ?? "").trim();
  const nameProblem = skillNameProblem(name);
  if (nameProblem) {
    return { callId: call.id, ok: false, output: `invalid skill name "${name}": ${nameProblem} — names are class-level (pwa-drawer-swipe), never session titles` };
  }
  const home = host.agentikHome;

  if (action === "view") {
    state.viewedSkills.add(name);
    const body = await viewSkill(name, { home });
    if (body === undefined) return { callId: call.id, ok: true, output: `(no skill named ${name} yet — you may create it)` };
    return { callId: call.id, ok: true, output: body };
  }
  if (!state.viewedSkills.has(name)) {
    return { callId: call.id, ok: false, output: `read before write: call skill_manage view "${name}" first` };
  }
  if (action !== "patch" && action !== "create") {
    return { callId: call.id, ok: false, output: `skill_manage: unknown action ${action}` };
  }
  // What only this review can check is checked here, at staging time; the approval replays
  // the write itself and re-validates its arguments against the store as it is then.
  let args: Record<string, unknown>;
  if (action === "patch") {
    if (!String(call.args.old_string ?? "")) return { callId: call.id, ok: false, output: "patch: old_string is required" };
    if (!existsSync(skillFile(name, home))) return { callId: call.id, ok: false, output: `patch: no skill named ${name}` };
    args = { old_string: String(call.args.old_string ?? ""), new_string: String(call.args.new_string ?? "") };
  } else {
    if (state.skillsCreated >= state.maxSkillCreates) {
      return { callId: call.id, ok: false, output: `create: this review may create at most ${state.maxSkillCreates} skill; patch an existing one instead` };
    }
    const problem = skillCreateProblem(name, call.args, home);
    if (problem) return { callId: call.id, ok: false, output: problem };
    args = { description: String(call.args.description ?? "").trim(), body: String(call.args.body ?? "").trim() };
  }
  if ((await readConfig({ home })).skills.writeApproval) {
    const now = new Date();
    const entry: PendingSkillOp = { id: newPendingId(now), action, name, args, at: now.toISOString() };
    await stagePending("skills", entry, { home });
    if (action === "create") state.skillsCreated += 1;
    return { callId: call.id, ok: true, output: `staged for approval (#${entry.id}) — run \`agentik skills approve ${entry.id}\`` };
  }
  const res = action === "patch"
    ? await applySkillPatch(name, args, { home, by: "reviewer" })
    : await applySkillCreate(name, args, { home, by: "reviewer" });
  if (res.ok && action === "create") state.skillsCreated += 1;
  return { callId: call.id, ok: res.ok, output: res.output, artifact: res.artifact };
}

/** The postmortem's pen: it writes cause and fix on the incident log, never the log itself. */
async function incidentTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const denied = reviewerOnly(call, host);
  if (denied) return denied;
  const home = host.agentikHome;
  const action = String(call.args.action ?? "");
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(String(v ?? "")));
  if (action === "classify" || action === "resolve") {
    const id = num(call.args.id);
    if (!Number.isInteger(id) || id <= 0) return { callId: call.id, ok: false, output: `incident ${action}: id is required` };
    const field = action === "classify" ? "cause" : "fix";
    const text = String(call.args[field] ?? "").replace(/\s+/g, " ").trim();
    if (!text) return { callId: call.id, ok: false, output: `incident ${action}: ${field} is required` };
    if ([...text].length > INCIDENT_CAUSE_MAX) {
      return { callId: call.id, ok: false, output: `incident ${action}: ${field} is ${[...text].length} chars, max ${INCIDENT_CAUSE_MAX} — name the root cause, do not retell the run` };
    }
    const rec = action === "classify" ? await classifyIncident(id, text, { home }) : await resolveIncident(id, text, { home });
    if (!rec) return { callId: call.id, ok: false, output: `incident ${action}: no incident #${id}` };
    return {
      callId: call.id,
      ok: true,
      output: action === "classify"
        ? `ok: incident #${rec.id} cause = ${rec.cause}`
        : `ok: incident #${rec.id} resolved — fix: ${rec.fix}`,
      artifact: `incident:${rec.id}`,
    };
  }
  if (action === "merge") {
    const into = num(call.args.into);
    const from = num(call.args.from);
    if (!Number.isInteger(into) || !Number.isInteger(from) || into <= 0 || from <= 0) {
      return { callId: call.id, ok: false, output: "incident merge: into and from ids are required" };
    }
    const rec = await mergeIncidents(into, from, { home });
    if (!rec) return { callId: call.id, ok: false, output: `incident merge: cannot merge #${from} into #${into} (missing, or the same id)` };
    return { callId: call.id, ok: true, output: `ok: incident #${from} merged into #${rec.id} (seen ${rec.seen}×)`, artifact: `incident:${rec.id}` };
  }
  return { callId: call.id, ok: false, output: `incident: unknown action "${action}" (classify | resolve | merge)` };
}

async function listShallow(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("*");
  const names: string[] = [];
  for await (const p of glob.scan({ cwd: dir, dot: true, onlyFiles: false })) {
    names.push(p);
  }
  return names.sort();
}

export function defaultFetchImpl(): FetchImpl {
  return async (url: string) => {
    const res = await fetch(url);
    const body = await res.text();
    return { url: res.url || url, body };
  };
}
