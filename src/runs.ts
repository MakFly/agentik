import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
