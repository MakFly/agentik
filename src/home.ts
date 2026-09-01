import { homedir } from "node:os";
import { join } from "node:path";

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
    /** Legacy WARM store (read-only now; kept on disk after migration). */
    db: join(home, "memory", "notes.sqlite"),
    /** Searchable session log: one row per run, FTS5 unicode61 + trigram. */
    sessionsDb: join(home, "sessions.sqlite"),
    migratedMarker: join(home, "memory", ".migrated-v1"),
    pendingSkills: join(home, "pending", "skills"),
    skills: join(home, "skills"),
  };
}
