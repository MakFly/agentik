import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { readPinnedSkills } from "./skill-factory.ts";
import { readSkillUsage, writeSkillUsage, type SkillState, type SkillUsage } from "./skill-usage.ts";

/**
 * The curator: what keeps the skills store from silting up without ever losing anything.
 *
 * Every skill is `active`, `stale` (not loaded for `staleDays`) or `archived` (not loaded for
 * `archiveDays`, moved to `skills/.archive/<name>/`). Age is measured from the last recorded
 * use, else the creation time, else the SKILL.md mtime. Pinned skills and skills a human
 * created are never archived — at worst they are marked stale. Nothing is deleted, ever:
 * before a pass that changes anything, all of `skills/` goes into `skills/.snapshots/<iso>.tar.gz`,
 * a ledger records every action, and `--rollback <snapshot>` restores that exact state (after
 * taking one more snapshot of the state it is about to replace).
 *
 * Modelled on Hermes's `agent/curator.py`: same states, same thresholds, same refusal to delete.
 */
export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_ARCHIVE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface CurateAction {
  name: string;
  from: SkillState;
  to: SkillState;
  reason: string;
}

export interface CurateResult {
  dryRun: boolean;
  actions: CurateAction[];
  stale: number;
  archived: number;
  /** Skills examined and left as they were (including ones brought back to active). */
  untouched: number;
  /** Relative to the home, e.g. `skills/.snapshots/2026-09-01T10-00-00.000Z.tar.gz`. */
  snapshot?: string;
}

export interface CurationLedgerEntry {
  at: string;
  snapshot: string;
  actions: Array<{ name: string; from: SkillState; to: SkillState }>;
  /** Present on a rollback entry: the snapshot that was restored. */
  restored?: string;
}

/** One SKILL.md write (src/skill-write.ts): who, what, which file, where the previous version went. */
export interface SkillWriteLedgerEntry {
  at: string;
  actor: "reviewer" | "human" | "approval" | "migration";
  action: string;
  name: string;
  backup?: string;
}

export type LedgerEntry = CurationLedgerEntry | SkillWriteLedgerEntry;

export function isCurationEntry(e: LedgerEntry): e is CurationLedgerEntry {
  return "snapshot" in e;
}

export interface CurateOptions {
  home?: string;
  dryRun?: boolean;
  staleDays?: number;
  archiveDays?: number;
  now?: Date;
}

async function skillNames(skillsDir: string): Promise<string[]> {
  try {
    const ents = await readdir(skillsDir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(skillsDir, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function lastUseOf(name: string, usage: SkillUsage, skillsDir: string, now: Date): Promise<{ at: Date; source: string }> {
  const entry = usage[name];
  if (entry?.lastUsedAt && !Number.isNaN(Date.parse(entry.lastUsedAt))) return { at: new Date(entry.lastUsedAt), source: "last use" };
  if (entry?.createdAt && !Number.isNaN(Date.parse(entry.createdAt))) return { at: new Date(entry.createdAt), source: "creation" };
  try {
    const st = await stat(join(skillsDir, name, "SKILL.md"));
    return { at: st.mtime, source: "file mtime" };
  } catch {
    return { at: now, source: "unknown" };
  }
}

/** Decide, without touching anything. */
export async function planCuration(opts?: CurateOptions): Promise<CurateAction[]> {
  const home = agentikHome(opts?.home);
  const paths = memoryPaths(home);
  const now = opts?.now ?? new Date();
  const staleDays = opts?.staleDays ?? DEFAULT_STALE_DAYS;
  const archiveDays = opts?.archiveDays ?? DEFAULT_ARCHIVE_DAYS;
  const [usage, pinned, names] = await Promise.all([
    readSkillUsage({ home }),
    readPinnedSkills(paths.skills),
    skillNames(paths.skills),
  ]);
  const pinnedSet = new Set(pinned);
  const actions: CurateAction[] = [];
  for (const name of names) {
    const entry = usage[name];
    const last = await lastUseOf(name, usage, paths.skills, now);
    const ageDays = Math.floor((now.getTime() - last.at.getTime()) / DAY_MS);
    const protectedBy = pinnedSet.has(name) ? "pinned" : entry?.createdBy === "human" ? "created by a human" : undefined;
    const current: SkillState = entry?.state === "stale" ? "stale" : "active";
    let target: SkillState = "active";
    if (ageDays > archiveDays && !protectedBy) target = "archived";
    else if (ageDays > staleDays) target = "stale";
    if (target === current) continue;
    const why =
      target === "active"
        ? `used ${ageDays}d ago`
        : `${ageDays}d since ${last.source}${protectedBy && ageDays > archiveDays ? `, ${protectedBy}: never archived` : ""}`;
    actions.push({ name, from: current, to: target, reason: why });
  }
  return actions;
}

function snapshotName(now: Date): string {
  return `${now.toISOString().replace(/:/g, "-")}.tar.gz`;
}

async function runTar(args: string[]): Promise<void> {
  const proc = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(`tar ${args[0]} failed (exit ${exit}): ${stderr.trim()}`);
}

/** `skills/` as a tar.gz under `skills/.snapshots/`, minus the snapshots and the ledger themselves. */
export async function snapshotSkills(opts?: { home?: string; now?: Date }): Promise<{ path: string; relative: string }> {
  const home = agentikHome(opts?.home);
  const paths = memoryPaths(home);
  await mkdir(paths.skills, { recursive: true });
  await mkdir(paths.skillSnapshots, { recursive: true });
  let path = join(paths.skillSnapshots, snapshotName(opts?.now ?? new Date()));
  // Two passes within the same millisecond would collide; a suffix keeps every snapshot.
  for (let n = 1; existsSync(path); n++) path = path.replace(/(\.\d+)?\.tar\.gz$/, `.${n}.tar.gz`);
  await runTar([
    "-czf",
    path,
    "-C",
    paths.skills,
    "--exclude=./.snapshots",
    "--exclude=./.snapshots/*",
    "--exclude=./.curator-ledger.json",
    ".",
  ]);
  return { path, relative: relative(home, path) };
}

export async function readLedger(opts?: { home?: string }): Promise<LedgerEntry[]> {
  const path = memoryPaths(agentikHome(opts?.home)).curatorLedger;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendLedger(entry: LedgerEntry, home: string): Promise<void> {
  const path = memoryPaths(home).curatorLedger;
  const ledger = await readLedger({ home });
  ledger.push(entry);
  await mkdir(memoryPaths(home).skills, { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

/**
 * One curation pass. Idempotent: a second pass right after the first finds nothing to do and
 * takes no snapshot. `dryRun` reports the plan and touches nothing.
 */
export async function curateSkills(opts?: CurateOptions): Promise<CurateResult> {
  const home = agentikHome(opts?.home);
  const paths = memoryPaths(home);
  const now = opts?.now ?? new Date();
  const actions = await planCuration({ ...opts, home, now });
  const total = (await skillNames(paths.skills)).length;
  const result: CurateResult = {
    dryRun: Boolean(opts?.dryRun),
    actions,
    stale: actions.filter((a) => a.to === "stale").length,
    archived: actions.filter((a) => a.to === "archived").length,
    untouched: total - actions.length,
  };
  if (opts?.dryRun || actions.length === 0) return result;

  const snap = await snapshotSkills({ home, now });
  result.snapshot = snap.relative;
  const usage = await readSkillUsage({ home });
  const archiveDir = join(paths.skills, ".archive");
  for (const a of actions) {
    const entry = usage[a.name] ?? { views: 0, patches: 0 };
    if (a.to === "archived") {
      await mkdir(archiveDir, { recursive: true });
      const dest = join(archiveDir, a.name);
      // An older archived copy is moved aside, not overwritten: the curator never deletes.
      if (existsSync(dest)) await rename(dest, `${dest}.replaced-${now.toISOString().replace(/:/g, "-")}`);
      await rename(join(paths.skills, a.name), dest);
    }
    entry.state = a.to;
    usage[a.name] = entry;
  }
  await writeSkillUsage(usage, { home });
  await appendLedger(
    { at: now.toISOString(), snapshot: snap.relative, actions: actions.map(({ name, from, to }) => ({ name, from, to })) },
    home,
  );
  return result;
}

/** Accepts an absolute path, a home-relative path, or a bare file name under `.snapshots/`. */
export function resolveSnapshot(spec: string, home?: string): string {
  const paths = memoryPaths(agentikHome(home));
  if (isAbsolute(spec)) return spec;
  if (spec.includes("/")) return resolve(paths.root, spec);
  return join(paths.skillSnapshots, spec);
}

/**
 * Restore `skills/` from a snapshot. The state being replaced is snapshotted first, so a
 * rollback is itself reversible. Snapshots and the ledger survive the restore.
 */
export async function rollbackSkills(
  spec: string,
  opts?: { home?: string; now?: Date },
): Promise<{ restored: string; safetySnapshot: string } | { error: string }> {
  const home = agentikHome(opts?.home);
  const paths = memoryPaths(home);
  const now = opts?.now ?? new Date();
  const snapshot = resolveSnapshot(spec, home);
  if (!snapshot.endsWith(".tar.gz") || !existsSync(snapshot)) return { error: `no such snapshot: ${spec}` };
  const safety = await snapshotSkills({ home, now });
  if (resolve(safety.path) === resolve(snapshot)) return { error: "refusing to roll back onto the snapshot just taken" };
  const keep = new Set([basename(paths.skillSnapshots), basename(paths.curatorLedger)]);
  for (const name of await readdir(paths.skills)) {
    if (keep.has(name)) continue;
    await rm(join(paths.skills, name), { recursive: true, force: true });
  }
  await runTar(["-xzf", snapshot, "-C", paths.skills]);
  const restored = isAbsolute(spec) ? relative(home, snapshot) : relative(home, snapshot);
  await appendLedger({ at: now.toISOString(), snapshot: safety.relative, actions: [], restored }, home);
  return { restored, safetySnapshot: safety.relative };
}

export function formatCurateResult(r: CurateResult): string {
  const head = `curate${r.dryRun ? " (dry-run)" : ""}: ${r.stale} stale, ${r.archived} archived, ${r.untouched} untouched`;
  const tail = r.dryRun
    ? " — nothing changed, no snapshot taken"
    : r.snapshot
      ? ` — snapshot ${r.snapshot}`
      : " — nothing to do, no snapshot taken";
  const lines = [head + tail];
  for (const a of r.actions) lines.push(`  - ${a.name}: ${a.from} -> ${a.to} (${a.reason})`);
  return lines.join("\n");
}
