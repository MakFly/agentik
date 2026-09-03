import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentikHome } from "./home.ts";
import { memoryContentProblem } from "./memory-store.ts";
import type { ArtifactSnapshot } from "./artifacts.ts";
import type { RunReport } from "./types.ts";

/**
 * Every `agentik run` leaves a file: `<home>/runs/<runId>.json`, whatever its status. Before
 * this, a run that ended `awaiting_approval` or stalled left nothing but a terminal scrollback;
 * the next command could not say what was planned, what ran, or which approval was pending.
 * Every string leaf goes through the memory scan: a token that landed in a tool output is
 * `[BLOCKED: …]` on disk, never the raw value.
 */

export const RUNS_DIR = "runs";
/**
 * Drafts live in a SUBDIRECTORY of `runs/`, not next to the final files: `listRuns` reads
 * `readdir(runs)` and keeps what ends in `.json`, so a directory named `partial` is invisible to it
 * — and therefore to `readRun`, `runs ls`, `runs show` and `runs resume`, which all go through it.
 * A draft can never be mistaken for a finished run by an existing reader, and no reader had to
 * learn a new rule for that to hold.
 */
export const RUNS_PARTIAL_DIR = "partial";

export interface RunRecord {
  id: string;
  at: string;
  goal: string;
  workspace: string;
  profile: string;
  status: string;
  exitCode: number;
  backend: string;
  workers: number;
  durationMs: number;
  report: RunReport;
  /** The deliverables as they were when the run ended: `runs resume` refuses if they moved since. */
  artifactSnapshot?: ArtifactSnapshot[];
  /**
   * Ownership of the workspace's dirty files travels next to that snapshot, but INSIDE
   * `report.ownership` (`RunOwnership`: the `gitDirty` witness at the start of the run, the one at
   * the end, and the ours / contaminated / foreign split). It is produced by `runLoop`, so it
   * belongs to the report the loop returns rather than to a field the CLI would have to fill; the
   * run file carries it either way, `agentik runs show` prints it through `formatReport`, and
   * `--json` exposes it at `report.ownership`. Its two reserves are stated in
   * `src/artifacts.ts`: no witness outside a git repository, and an ambiguous witness when two
   * runs share one directory.
   */
  /** The run this one resumed (approvals replayed by call hash). */
  resumedFrom?: string;
}

export interface RunSummary {
  id: string;
  at: string;
  goal: string;
  workspace: string;
  status: string;
  exitCode: number;
  durationMs: number;
  path: string;
}

/** `20260902T091530Z-a1b2c3`: sortable by time, unique enough for one home. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function runsDir(home?: string): string {
  return join(agentikHome(home), RUNS_DIR);
}

export function runsPartialDir(home?: string): string {
  return join(runsDir(home), RUNS_PARTIAL_DIR);
}

/**
 * A run id as it goes into a path. `newRunId` produces `20260902T091530Z-a1b2c3`, but `writeRun`
 * has always accepted a caller-supplied id, so the guard is the same shape as `code-index.ts`'s
 * `SLUG_RE`: a name, never a path. `..`, `/`, `\` and a leading dot are refused.
 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Deep copy with every string leaf scanned; a leaf that reads as a secret/injection is replaced. */
export function maskLeaves<T>(value: T): T {
  if (typeof value === "string") {
    const problem = memoryContentProblem(value);
    return (problem ? `[BLOCKED: ${problem}]` : value) as T;
  }
  if (Array.isArray(value)) return value.map(maskLeaves) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskLeaves(v);
    return out as T;
  }
  return value;
}

export async function writeRun(
  input: Omit<RunRecord, "id" | "at"> & { id?: string; at?: string },
  opts?: { home?: string },
): Promise<{ id: string; path: string }> {
  const id = input.id ?? newRunId();
  const at = input.at ?? new Date().toISOString();
  const dir = runsDir(opts?.home);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const record: RunRecord = maskLeaves({ ...input, id, at });
  await writeFile(path, JSON.stringify(record, null, 2), "utf8");
  // The run ended and its file landed: the draft has nothing left to say. Best effort, after the
  // final write — a draft that survives is garbage, a final file that never lands is data loss.
  await discardRunDraft(id, { home: opts?.home });
  return { id, path };
}

export async function listRuns(opts?: { home?: string; limit?: number; workspace?: string }): Promise<RunSummary[]> {
  const dir = runsDir(opts?.home);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const name of names) {
    if (opts?.limit !== undefined && out.length >= opts.limit) break;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), "utf8")) as RunRecord;
      if (opts?.workspace && rec.workspace !== opts.workspace) continue;
      out.push({ id: rec.id, at: rec.at, goal: rec.goal, workspace: rec.workspace, status: rec.status, exitCode: rec.exitCode, durationMs: rec.durationMs, path: join(dir, name) });
    } catch {
      /* a half-written or foreign file is skipped, not fatal */
    }
  }
  return out;
}

/** By exact id or unique prefix; `undefined` when none, an array when ambiguous. */
export async function readRun(idOrPrefix: string, opts?: { home?: string }): Promise<RunRecord | RunSummary[] | undefined> {
  const all = await listRuns({ home: opts?.home });
  const exact = all.find((r) => r.id === idOrPrefix);
  const matches = exact ? [exact] : all.filter((r) => r.id.startsWith(idOrPrefix));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return matches;
  return JSON.parse(await readFile(matches[0].path, "utf8")) as RunRecord;
}

export function formatRunLine(r: RunSummary): string {
  const secs = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`;
  return `${r.id}  ${r.at.slice(0, 16).replace("T", " ")}  ${r.status.padEnd(17)} exit=${r.exitCode}  ${secs.padStart(7)}  ${r.goal.replace(/\s+/g, " ").slice(0, 60)}`;
}

/* ------------------------------------------------------------------------------------------- *
 * Progressive persistence — a run that is killed still leaves a trace
 *
 * `writeRun` runs AFTER `runLoop` returns. A Ctrl-C, an OOM kill or a crashed backend therefore
 * left NOTHING: no run file, no session, no incident, no way to say what had been planned, what
 * had run, or what it had cost. The draft is that trace: written once the id exists, updated at
 * the phases the conductor already observes (plan produced, tasks done, synthesis), replaced by
 * the final file at the end.
 *
 * Four properties, each of them load-bearing:
 *  - INVISIBLE TO THE EXISTING READERS: `runs/partial/<id>.json`, and `listRuns` only keeps the
 *    `*.json` entries of `runs/` itself. `runs ls`, `runs show` and `runs resume` cannot resume,
 *    replay or count a run that never finished. The record also carries `partial: true`, so even a
 *    reader that got there by another path knows what it holds.
 *  - SAME MASKING as the final file: `maskLeaves`, the very same call, so a token that reached a
 *    tool output is `[BLOCKED: …]` on disk in the draft too. There is no cheaper path to the disk.
 *  - NEVER FATAL: every write is caught. A draft that cannot be written is at most ONE stderr line
 *    per (home, run) — it is called repeatedly, so warning every time would bury the run's output —
 *    and the run goes on, exactly as a failed `writeRun` is one line and an unchanged exit code.
 *  - ATOMIC: tmp + rename, so a process killed mid-write leaves the previous draft intact rather
 *    than half a JSON document. The tmp name is fixed (`<id>.json.tmp`), so a killed write leaves
 *    one file, not one per attempt, and `removeRun` / `gcRuns` sweep it.
 * ------------------------------------------------------------------------------------------- */

/** Where a run was when the draft was written; free-form on purpose, the loop names its own steps. */
export type RunPhase = "started" | "planned" | "acting" | "synthesizing" | "reporting" | (string & {});

export interface RunDraft {
  id: string;
  /** When the run started (the same value the final record will carry). */
  at: string;
  /** When this draft was last written. */
  updatedAt: string;
  phase: RunPhase;
  goal: string;
  workspace: string;
  profile?: string;
  backend?: string;
  workers?: number;
  status?: string;
  durationMs?: number;
  /** As much of the report as exists at that phase; a draft is partial by definition. */
  report?: Partial<RunReport>;
  resumedFrom?: string;
  /** Always true on disk: a draft says so about itself. */
  partial: true;
}

export type RunDraftInput = Omit<RunDraft, "at" | "updatedAt" | "partial"> & { at?: string };

/** One warning per (home, run): the draft is written at every phase, the stderr line is not. */
const draftWarnings = new Set<string>();

/** Tests call this between homes; the process-wide set would otherwise silence the second one. */
export function resetRunDraftWarnings(): void {
  draftWarnings.clear();
}

/**
 * Write (or overwrite) the draft of a run in flight. Never throws: returns `undefined` when the
 * draft could not be written, having said so once on stderr (or through `onError`).
 */
export async function writeRunDraft(
  input: RunDraftInput,
  opts?: { home?: string; now?: Date; onError?: (err: unknown) => void },
): Promise<{ id: string; path: string } | undefined> {
  const id = input.id;
  try {
    if (!RUN_ID_RE.test(id)) throw new Error(`invalid run id: ${id}`);
    const dir = runsPartialDir(opts?.home);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.json`);
    const tmp = `${path}.tmp`;
    const draft: RunDraft = maskLeaves({
      ...input,
      id,
      at: input.at ?? new Date().toISOString(),
      updatedAt: (opts?.now ?? new Date()).toISOString(),
      partial: true as const,
    });
    await writeFile(tmp, JSON.stringify(draft, null, 2), "utf8");
    await rename(tmp, path);
    return { id, path };
  } catch (err) {
    const key = `${opts?.home ?? ""}:${id}`;
    if (!draftWarnings.has(key)) {
      draftWarnings.add(key);
      const report = opts?.onError ?? ((e: unknown) => console.error(`agentik: could not write the run draft: ${e instanceof Error ? e.message : String(e)}`));
      try {
        report(err);
      } catch {
        /* even the warning is not allowed to kill the run */
      }
    }
    return undefined;
  }
}

/** Remove the draft of `id` (and a tmp left by a killed write). Never throws; true if it deleted something. */
export async function discardRunDraft(id: string, opts?: { home?: string }): Promise<boolean> {
  let gone = false;
  try {
    if (!RUN_ID_RE.test(id)) return false;
    const path = join(runsPartialDir(opts?.home), `${id}.json`);
    for (const p of [path, `${path}.tmp`]) {
      try {
        await unlink(p);
        gone = true;
      } catch {
        /* absent is the normal case */
      }
    }
  } catch {
    /* a home that cannot even be resolved is not a reason to fail a finished run */
  }
  return gone;
}

/** The drafts of this home, newest first. Unreadable files are skipped, exactly as `listRuns` does. */
export async function listRunDrafts(opts?: { home?: string; limit?: number; workspace?: string }): Promise<RunDraft[]> {
  const dir = runsPartialDir(opts?.home);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
  const out: RunDraft[] = [];
  for (const name of names) {
    if (opts?.limit !== undefined && out.length >= opts.limit) break;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), "utf8")) as RunDraft;
      if (opts?.workspace && rec.workspace !== opts.workspace) continue;
      out.push(rec);
    } catch {
      /* a draft killed mid-write, or a foreign file */
    }
  }
  return out;
}

/** By exact id or unique prefix, like `readRun`; an array when ambiguous. */
export async function readRunDraft(idOrPrefix: string, opts?: { home?: string }): Promise<RunDraft | RunDraft[] | undefined> {
  const all = await listRunDrafts({ home: opts?.home });
  const exact = all.find((d) => d.id === idOrPrefix);
  if (exact) return exact;
  const matches = all.filter((d) => d.id.startsWith(idOrPrefix));
  if (matches.length === 0) return undefined;
  return matches.length === 1 ? matches[0] : matches;
}

export function formatRunDraftLine(d: RunDraft): string {
  const age = d.updatedAt.slice(0, 16).replace("T", " ");
  return `${d.id}  ${age}  ${`partial/${d.phase}`.padEnd(17)} ${d.status ? `status=${d.status}  ` : ""}${d.goal.replace(/\s+/g, " ").slice(0, 60)}`;
}

/* ------------------------------------------------------------------------------------------- *
 * Cleanup — `removeRun` / `gcRuns`, the shape `code-index.ts` already uses for its indexes
 *
 * A run file is a cache of what happened, not a record anyone signed: its content comes back into
 * prompts through the session search, it grows with every run, and nothing ever expired it. Same
 * form as `removeIndex` / `gcIndexes`: a listing that never hides a file it could not read, a
 * removal that is a NAME and not a path, a garbage collection with a dry-run mode that never
 * touches an entry it did not understand.
 * ------------------------------------------------------------------------------------------- */

export const RUNS_GC_KEEP_DAYS = 30;

/**
 * `gcRuns` deletes the ONE file an entry is about, never the pair `removeRun` sweeps: a draft
 * collected because its run finished must leave the final file standing, and a run file collected
 * on age must not silently take a draft of the same id with it.
 */
async function unlinkEntry(e: RunEntry): Promise<void> {
  try {
    await unlink(e.path);
    if (e.kind === "draft") await unlink(`${e.path}.tmp`).catch(() => {});
  } catch {
    /* already gone */
  }
}

export interface RunEntry {
  id: string;
  path: string;
  kind: "run" | "draft";
  bytes: number;
  /** The run's own timestamp (`at`, or `updatedAt` for a draft); the file's mtime when unreadable. */
  at: string;
  goal?: string;
  workspace?: string;
  status?: string;
  exitCode?: number;
  /** Why this entry could not be read; such an entry is listed, never garbage-collected. */
  problem?: string;
  /** Filled by `gcRuns` on the entries it removed (or would remove). */
  reason?: string;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * Every run file AND every draft of this home, newest first, WITH the ones that could not be
 * parsed (`problem`) — `listRuns` drops those silently, which is right for a reader and wrong for
 * a collector: an unreadable file is exactly the one a human must be told about, never the one a
 * garbage collector may delete on a guess.
 */
export async function listRunEntries(opts?: { home?: string; workspace?: string }): Promise<RunEntry[]> {
  const out: RunEntry[] = [];
  const dirs: { dir: string; kind: "run" | "draft" }[] = [
    { dir: runsDir(opts?.home), kind: "run" },
    { dir: runsPartialDir(opts?.home), kind: "draft" },
  ];
  for (const { dir, kind } of dirs) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const entry: RunEntry = { id: name.slice(0, -".json".length), path, kind, bytes: fileBytes(path), at: fileMtime(path) };
      try {
        const rec = JSON.parse(await readFile(path, "utf8")) as RunRecord & RunDraft;
        entry.id = rec.id ?? entry.id;
        entry.at = (kind === "draft" ? rec.updatedAt ?? rec.at : rec.at) ?? entry.at;
        entry.goal = rec.goal;
        entry.workspace = rec.workspace;
        entry.status = rec.status;
        entry.exitCode = rec.exitCode;
      } catch (err) {
        entry.problem = `unreadable run file: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (opts?.workspace && entry.workspace !== opts.workspace) continue;
      out.push(entry);
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Delete one run: its file, its draft, and a tmp left by a killed draft write. The target is a
 * NAME (`{ id }`), checked against `RUN_ID_RE`, never a caller-supplied path. Returns the paths
 * deleted; an id that matches nothing is an error, as `removeIndex` does for an unknown slug.
 */
export async function removeRun(home: string | undefined, target: { id: string }): Promise<string[]> {
  const id = target.id;
  if (!RUN_ID_RE.test(id)) throw new Error(`invalid run id: ${id}`);
  const draft = join(runsPartialDir(home), `${id}.json`);
  const paths = [join(runsDir(home), `${id}.json`), draft, `${draft}.tmp`];
  const deleted: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    await unlink(p);
    deleted.push(p);
  }
  if (!deleted.length) throw new Error(`no run named ${id}`);
  return deleted;
}

/**
 * Drop the runs older than `keepDays`, plus the drafts superseded by their own final file (a
 * crash between the two leaves one). `keepLast` keeps the N newest whatever their age — the
 * prudence `gcIndexes` gets from `rootExists`: the answer to "and my last run?" must never be
 * "expired". An entry with a `problem` is reported, never removed. `dryRun` deletes nothing and
 * returns exactly the same lists.
 */
export async function gcRuns(
  home: string | undefined,
  opts: { dryRun?: boolean; keepDays?: number; keepLast?: number; workspace?: string; now?: Date } = {},
): Promise<{ removed: RunEntry[]; kept: RunEntry[]; problems: RunEntry[] }> {
  const days = opts.keepDays ?? RUNS_GC_KEEP_DAYS;
  const now = (opts.now ?? new Date()).getTime();
  const entries = await listRunEntries({ home, workspace: opts.workspace });
  const finalIds = new Set(entries.filter((e) => e.kind === "run").map((e) => e.id));
  const removed: RunEntry[] = [];
  const kept: RunEntry[] = [];
  const problems: RunEntry[] = [];
  let seen = 0;
  for (const e of entries) {
    if (e.problem) {
      problems.push(e);
      continue;
    }
    if (e.kind === "run") seen += 1;
    if (e.kind === "draft" && finalIds.has(e.id)) {
      removed.push({ ...e, reason: "superseded by the final run file" });
      // The DRAFT only: `removeRun` sweeps the pair, and the final file is the thing to keep here.
      if (!opts.dryRun) await unlinkEntry(e);
      continue;
    }
    if (opts.keepLast !== undefined && e.kind === "run" && seen <= opts.keepLast) {
      kept.push(e);
      continue;
    }
    const ageDays = (now - Date.parse(e.at)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays <= days) {
      kept.push(e);
      continue;
    }
    removed.push({ ...e, reason: `older than ${days}d (${Math.floor(ageDays)}d)` });
    if (!opts.dryRun) await unlinkEntry(e);
  }
  return { removed, kept, problems };
}

/** One line per entry for a future `agentik runs gc/rm`, in the spirit of `formatIndexEntry`. */
export function formatRunEntry(e: RunEntry): string {
  const kb = `${Math.round(e.bytes / 1024)}k`;
  const when = e.at.slice(0, 16).replace("T", " ");
  if (e.problem) return `${e.id} · ${e.kind} · ${kb} · ${e.problem}`;
  return `${e.id} · ${e.kind} · ${kb} · ${when} · ${e.status ?? "?"}${e.reason ? ` · ${e.reason}` : ""} · ${(e.goal ?? "").replace(/\s+/g, " ").slice(0, 50)}`;
}
