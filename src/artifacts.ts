import { stat } from "node:fs/promises";
import { resolveSafe } from "./tools.ts";
import type { RunOwnership } from "./types.ts";

/**
 * Deliverable-level proof that a run did something.
 *
 * The event stream says whether tools were called; it does not say whether the file the task
 * was about actually moved. A worker can read ten files, call a tool, and still leave the
 * deliverable untouched.
 */
export interface ArtifactSnapshot {
  /** As the caller wrote it, for the message. */
  path: string;
  exists: boolean;
  mtimeMs: number;
  size: number;
}

async function snapshotOne(workspace: string, rel: string): Promise<ArtifactSnapshot> {
  const full = resolveSafe(workspace, rel);
  try {
    const st = await stat(full);
    return { path: rel, exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { path: rel, exists: false, mtimeMs: 0, size: 0 };
  }
}

/** Throws when a path escapes the workspace — that is a caller error, not a run failure. */
export async function snapshotArtifacts(
  workspace: string,
  paths: string[],
): Promise<ArtifactSnapshot[]> {
  return Promise.all(paths.map((p) => snapshotOne(workspace, p)));
}

/**
 * Deletion counts as a change: a task may legitimately remove a file. Only "nothing about it
 * is different" means the deliverable was not produced.
 */
export function artifactChanged(before: ArtifactSnapshot, after: ArtifactSnapshot): boolean {
  return (
    before.exists !== after.exists ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size
  );
}

export async function untouchedArtifacts(
  workspace: string,
  before: ArtifactSnapshot[],
): Promise<string[]> {
  const after = await snapshotArtifacts(workspace, before.map((b) => b.path));
  return before.filter((b, i) => !artifactChanged(b, after[i])).map((b) => b.path);
}

/**
 * Third witness: what git says changed. `undefined` outside a repository (or when git is not
 * usable there) — the caller must treat "no witness" as "no evidence either way", never as proof.
 *
 * The stat witness (`artifactChanged`) is beaten by `touch`: mtime moves, content does not. The
 * porcelain entry set does not move for a `touch` on a tracked, unmodified file, so the delta
 * between a call before the work and a call after it is a CONTENT witness.
 *
 * `GIT_OPTIONAL_LOCKS=0` like `src/workspace.ts`: reading the state of a repository must never
 * take a lock a concurrent run (or the human's own shell) is waiting on.
 */
export function gitDirty(workspace: string): string[] | undefined {
  try {
    // `-- .` (like refreshIndex): the witness is about THIS workspace. Without the pathspec a run
    // in a subdirectory would see every dirty file of the whole checkout — including a neighbour
    // run's work, or the human's own edits — and read it as its own mutation.
    const res = Bun.spawnSync(["git", "status", "--porcelain", "-z", "--untracked-files=all", "--", "."], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (res.exitCode !== 0) return undefined;
    return res.stdout.toString().split("\0").filter((e) => e.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * True only when git was readable at both ends AND the entry set moved. No witness (a plain
 * directory, git unavailable) is `false`: absence of evidence, not evidence of absence.
 */
export function gitDirtyChanged(before: string[] | undefined, after: string[] | undefined): boolean {
  if (!before || !after) return false;
  if (before.length !== after.length) return true;
  const seen = new Set(before);
  return after.some((entry) => !seen.has(entry));
}

export function describeUntouched(paths: string[]): string {
  const list = paths.join(", ");
  return paths.length === 1
    ? `the expected artifact ${list} was not created or modified`
    : `${paths.length} expected artifacts were not created or modified: ${list}`;
}

export interface ArtifactDiff {
  /** Expected artifacts that changed (created, modified, deleted). */
  changed: string[];
  /** Expected artifacts that did not move. */
  untouched: string[];
  /** Paths the stream says were edited, relative to the workspace, that exist and moved after the run started. */
  touched: string[];
}

/**
 * What moved on disk, from two witnesses: the expected artifacts (before/after snapshot) and the
 * paths the harness stream reported editing (`extraPaths`), kept only when they are inside the
 * workspace and their mtime is at or after `startedAtMs`. A path that escapes the workspace is
 * ignored, not an error: the stream is data.
 */
export async function diffArtifacts(
  workspace: string,
  before: ArtifactSnapshot[],
  extraPaths: string[],
  startedAtMs: number,
): Promise<ArtifactDiff> {
  const after = await snapshotArtifacts(workspace, before.map((b) => b.path));
  const changed: string[] = [];
  const untouched: string[] = [];
  before.forEach((b, i) => (artifactChanged(b, after[i]) ? changed : untouched).push(b.path));
  const touched = new Set<string>();
  for (const raw of extraPaths) {
    let rel = raw;
    if (rel.startsWith(workspace + "/")) rel = rel.slice(workspace.length + 1);
    if (rel.startsWith("/")) continue;
    let full: string;
    try {
      full = resolveSafe(workspace, rel);
    } catch {
      continue;
    }
    try {
      const st = await stat(full);
      if (st.mtimeMs >= startedAtMs - 5) touched.add(rel);
    } catch {
      /* named but not on disk (deleted, or never written) */
    }
  }
  return { changed, untouched, touched: [...touched].sort() };
}

const LIST_CAP = 10;

function capList(paths: string[]): string {
  if (paths.length === 0) return "[]";
  const shown = paths.slice(0, LIST_CAP).join(", ");
  return paths.length > LIST_CAP ? `[${shown}, +${paths.length - LIST_CAP} more]` : `[${shown}]`;
}

/** One line: `changed: [a] / untouched: [b] / touched (per stream): [c]`, 10 per list. */
export function describeArtifactDiff(d: ArtifactDiff): string {
  return `changed: ${capList(d.changed)} / untouched: ${capList(d.untouched)} / touched (per stream): ${capList(d.touched)}`;
}

/**
 * Ownership: which dirty paths belong to THIS run.
 *
 * `gitDirty` was already taken twice per mutating task and immediately reduced to a boolean by
 * `gitDirtyChanged`; the paths themselves — the only thing that answers "is this mine?" — were
 * dropped. That is exactly what was missing the day the owner had to remove somebody else's
 * paragraph by hand before committing: nothing in the system could say which files a run had
 * produced, and file-level possession alone would have got it wrong, because the file in question
 * was BOTH edited by the run AND already carrying a third party's work.
 *
 * Hence three categories instead of two:
 *   - `ours`         dirty at the end, clean at the start → produced by this run, safe to stage.
 *   - `contaminated` dirty at the start AND touched by this run → two authors in one file. Never
 *                    `ours`: staging it commits somebody else's work. It is the incident's shape.
 *   - `foreign`      dirty at the start and no sign this run touched it → not ours, leave it.
 *
 * "Touched by this run" cannot come from git alone: a file that was already ` M` and is modified
 * again keeps the same porcelain entry. So the classifier takes a third input, `touched` — the
 * paths the run's own tools reported writing (`RunReport.artifacts`, a task's declared artifacts).
 * A status that CHANGED between the two witnesses (` M` → `M `, `??` → `A `) counts as touched
 * too. When neither signal fires the file stays `foreign`: the run has to earn a claim, not be
 * given one by default.
 *
 * TWO RESERVES, stated rather than hidden:
 *   1. `gitDirty` returns `undefined` outside a git repository (or when git is unusable there).
 *      `witness` is then `false`, every list is empty, and that is NOT a proof of innocence — it
 *      is the absence of evidence. A caller must never read empty lists as "the run touched
 *      nothing"; it means "nobody was watching".
 *   2. Two runs working in the SAME directory make the witness ambiguous by construction: the
 *      second run sees the first one's files as already dirty (`foreign`, or `contaminated` as
 *      soon as it edits them) and cannot tell them from the human's own work. Only two separate
 *      worktrees make the answer clean, which is the whole point of per-worktree isolation.
 */
export type { RunOwnership } from "./types.ts";

/**
 * `XY path` → `{status: "XY", path}`. With `-z` a rename is emitted as TWO entries, `R  new` then
 * a bare `old` with no status columns; the bare one is a path as it stands.
 */
function porcelainEntry(entry: string): { status?: string; path: string } {
  if (entry.length > 3 && entry[2] === " " && /^[ MADRCU?!]{2}$/.test(entry.slice(0, 2))) {
    return { status: entry.slice(0, 2), path: entry.slice(3) };
  }
  return { path: entry };
}

/**
 * A porcelain path is relative to the REPOSITORY root; a tool's artifact is relative to the
 * WORKSPACE, which may be a subdirectory. Rather than resolve one into the other (and guess wrong
 * on a symlinked or bind-mounted checkout), two paths match when they are equal or when one is the
 * tail of the other on a segment boundary. Over-matching here can only move a file from `ours` to
 * `contaminated` — the conservative direction.
 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith("/" + b) || b.endsWith("/" + a);
}

/**
 * Pure. Classifies the dirty paths of a run into `ours` / `contaminated` / `foreign`.
 * `touched` is the run's own claim of what it wrote (workspace-relative or absolute), used only to
 * promote an already-dirty file to `contaminated` — never to promote anything to `ours`.
 */
export function classifyOwnership(
  before: string[] | undefined,
  after: string[] | undefined,
  touched: string[] = [],
): RunOwnership {
  if (!before || !after) return { before, after, ours: [], contaminated: [], foreign: [], witness: false };
  const beforeByPath = new Map<string, string | undefined>();
  for (const entry of before) {
    const { status, path } = porcelainEntry(entry);
    beforeByPath.set(path, status);
  }
  const claimed = touched.map((t) => t.replace(/^\.\//, ""));
  const wasTouched = (path: string) => claimed.some((c) => samePath(path, c));
  const ours: string[] = [];
  const contaminated: string[] = [];
  const foreign: string[] = [];
  const seenAfter = new Set<string>();
  for (const entry of after) {
    const { status, path } = porcelainEntry(entry);
    seenAfter.add(path);
    if (!beforeByPath.has(path)) {
      ours.push(path);
      continue;
    }
    // Already dirty when the run started. The run only owns it if something says it wrote it:
    // its own claim, or a status that moved (` M` → `M `, `??` → `A `).
    const movedStatus = status !== beforeByPath.get(path);
    (movedStatus || wasTouched(path) ? contaminated : foreign).push(path);
  }
  // Dirty before, gone after: somebody committed, stashed or reverted it during the run. Ours only
  // if this run claims it; otherwise it stays a third party's business.
  for (const [path] of beforeByPath) {
    if (seenAfter.has(path)) continue;
    (wasTouched(path) ? contaminated : foreign).push(path);
  }
  return { before, after, ours: ours.sort(), contaminated: contaminated.sort(), foreign: foreign.sort(), witness: true };
}

/** One line for a report: `ours: [a] / contaminated: [b] / foreign: [c]`, 10 per list. */
export function describeOwnership(o: RunOwnership): string {
  if (!o.witness) return "no git witness (not a repository, or git unusable) — absence of evidence, not proof that nothing moved";
  return `ours: ${capList(o.ours)} / contaminated: ${capList(o.contaminated)} / foreign: ${capList(o.foreign)}`;
}
