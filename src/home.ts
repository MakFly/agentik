import { createHash } from "node:crypto";
import { resolveWorkspaceRoot } from "./workspace.ts";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Profile home. `default` is `~/.agentik` itself (backwards compatible); any other name lives
 * under `~/.agentik/profiles/<name>`. Resolution order: explicit argument, then AGENTIK_PROFILE,
 * then `default`. A name that could escape the profiles directory is refused.
 */
export function resolveProfileHome(profile?: string): string {
  const name = (profile ?? process.env.AGENTIK_PROFILE ?? "").trim() || "default";
  const base = join(homedir(), ".agentik");
  if (name === "default") return base;
  if (!PROFILE_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`invalid profile name "${name}" (allowed: ${PROFILE_NAME.source})`);
  }
  return join(base, "profiles", name);
}

/** `override` (usually --agentik-home) > AGENTIK_HOME > profile (--profile / AGENTIK_PROFILE / default). */
export function agentikHome(override?: string, profile?: string): string {
  return override || process.env.AGENTIK_HOME || resolveProfileHome(profile);
}

export function memoryPaths(home: string) {
  return {
    root: home,
    memoryDir: join(home, "memory"),
    hot: join(home, "memory", "MEMORY.md"),
    user: join(home, "memory", "USER.md"),
    /** One MEMORY.md per workspace, under `<slug>/` (see projectMemoryPath). */
    projectDir: join(home, "memory", "projects"),
    /** Legacy WARM store (read-only now; kept on disk after migration). */
    db: join(home, "memory", "notes.sqlite"),
    /** Searchable session log: one row per run, FTS5 unicode61 + trigram. */
    sessionsDb: join(home, "sessions.sqlite"),
    migratedMarker: join(home, "memory", ".migrated-v1"),
    pendingSkills: join(home, "pending", "skills"),
    /** Staged writes awaiting `agentik memory approve` (config memory.writeApproval). */
    pendingMemoryOps: join(home, "pending", "memory"),
    /** Staged skill_manage patch/create awaiting `agentik skills approve` (skills.writeApproval). */
    pendingSkillOps: join(home, "pending", "skills-ops"),
    skills: join(home, "skills"),
    /** Per-skill usage counters the curator reads: views, patches, who created it, last use. */
    skillUsage: join(home, "skills", ".usage.json"),
    skillSnapshots: join(home, "skills", ".snapshots"),
    curatorLedger: join(home, "skills", ".curator-ledger.json"),
    config: join(home, "config.json"),
  };
}

/**
 * Project memory directory name for a workspace: readable AND collision-free. The basename is
 * lowercased and sanitized (`[^a-z0-9._-]` → `-`), then joined with the first 10 hex chars of
 * sha256 of the absolute path, e.g. `agentik-3f2a9c1b7e`. Two checkouts with the same basename
 * never share a file; the `.workspace` file next to it holds the full path for humans.
 */
export function projectSlug(workspace: string): string {
  return legacyProjectSlug(resolveWorkspaceRoot(resolve(workspace)));
}

/** The slug formula on a path as given (no root resolution): what pre-C4 files were named after. */
export function legacyProjectSlug(path: string): string {
  const abs = resolve(path);
  const base = basename(abs).toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "root";
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

export function projectMemoryPath(home: string, workspace: string): string {
  return join(memoryPaths(home).projectDir, projectSlug(workspace), "MEMORY.md");
}
