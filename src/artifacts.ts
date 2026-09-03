import { stat } from "node:fs/promises";
import { resolveSafe } from "./tools.ts";

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
