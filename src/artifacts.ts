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

export function describeUntouched(paths: string[]): string {
  const list = paths.join(", ");
  return paths.length === 1
    ? `the expected artifact ${list} was not created or modified`
    : `${paths.length} expected artifacts were not created or modified: ${list}`;
}
