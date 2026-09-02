import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendLedger } from "./curator.ts";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * The one place a SKILL.md is written. Every write — by the reviewer, a human, an approval or a
 * migration — first copies the current file to `skills/.backups/<name>/SKILL.md.bak.<ts>` and
 * then appends `{at, actor, action, name, backup}` to the curator ledger, so a bad patch is
 * one `agentik skills undo <name>` away and the ledger says who did what. The backup lives
 * outside the skill's own folder because that folder may be symlinked into the harness homes.
 */

export type SkillWriteActor = "reviewer" | "human" | "approval" | "migration";

export interface SkillWriteOptions {
  home?: string;
  actor: SkillWriteActor;
  /** create | patch | update | approve | undo | upsert */
  action: string;
}

export function skillBackupsDir(name: string, home?: string): string {
  return join(memoryPaths(agentikHome(home)).skills, ".backups", name);
}

/** `<dir>/SKILL.md.bak.<ts>`, `-2`, `-3`… on collision (same second). */
async function backupPath(dir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = join(dir, `SKILL.md.bak.${stamp}`);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `SKILL.md.bak.${stamp}-${n}`);
  return candidate;
}

export async function writeSkillFile(name: string, content: string, opts: SkillWriteOptions): Promise<{ path: string; backup?: string }> {
  const home = agentikHome(opts.home);
  const dir = join(memoryPaths(home).skills, name);
  const path = join(dir, "SKILL.md");
  let backup: string | undefined;
  if (existsSync(path)) {
    const bdir = skillBackupsDir(name, home);
    await mkdir(bdir, { recursive: true });
    backup = await backupPath(bdir);
    await copyFile(path, backup);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, content, "utf8");
  try {
    await appendLedger({ at: new Date().toISOString(), actor: opts.actor, action: opts.action, name, ...(backup ? { backup } : {}) }, home);
  } catch (err) {
    console.error(`agentik: could not append the skill ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { path, backup };
}

/** Backups of a skill, newest first. */
export async function listSkillBackups(name: string, home?: string): Promise<string[]> {
  const dir = skillBackupsDir(name, home);
  try {
    return (await readdir(dir)).filter((n) => n.startsWith("SKILL.md.bak.")).sort().reverse().map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Restore the newest backup. The current file is backed up first, so an undo is itself undoable
 * (the ledger entry says `undo`, the backup of the undone version is the newest afterwards).
 */
export async function undoSkillWrite(name: string, opts?: { home?: string }): Promise<{ ok: true; restored: string; path: string } | { ok: false; error: string }> {
  const backups = await listSkillBackups(name, opts?.home);
  if (backups.length === 0) return { ok: false, error: `no backup for ${name} (nothing was ever overwritten)` };
  const restored = backups[0];
  const content = await readFile(restored, "utf8");
  const { path } = await writeSkillFile(name, content, { home: opts?.home, actor: "human", action: "undo" });
  return { ok: true, restored, path };
}
