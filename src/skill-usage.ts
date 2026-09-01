import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * `<home>/skills/.usage.json` — one record per skill: how often its body was loaded, how
 * often it was patched, who created it, and when it was last touched. This is the only
 * signal the curator has: a skill nobody loads for 30 days goes `stale`, for 90 days it is
 * archived — unless a human created it or pinned it.
 */
export type SkillUsageKind = "view" | "patch" | "create";
export type SkillState = "active" | "stale" | "archived";
export type SkillCreator = "reviewer" | "human";

export interface SkillUsageEntry {
  views: number;
  patches: number;
  createdBy?: SkillCreator;
  createdAt?: string;
  lastUsedAt?: string;
  /** Set by the curator. Absent means active. */
  state?: SkillState;
}

export type SkillUsage = Record<string, SkillUsageEntry>;

export async function readSkillUsage(opts?: { home?: string }): Promise<SkillUsage> {
  const path = memoryPaths(agentikHome(opts?.home)).skillUsage;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: SkillUsage = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      out[name] = {
        views: typeof e.views === "number" ? e.views : 0,
        patches: typeof e.patches === "number" ? e.patches : 0,
        createdBy: e.createdBy === "human" || e.createdBy === "reviewer" ? e.createdBy : undefined,
        createdAt: typeof e.createdAt === "string" ? e.createdAt : undefined,
        lastUsedAt: typeof e.lastUsedAt === "string" ? e.lastUsedAt : undefined,
        state: e.state === "stale" || e.state === "archived" || e.state === "active" ? e.state : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeSkillUsage(usage: SkillUsage, opts?: { home?: string }): Promise<void> {
  const path = memoryPaths(agentikHome(opts?.home)).skillUsage;
  await mkdir(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

/**
 * Count one use. A view or a patch bumps its counter and `lastUsedAt`; a create records who
 * made the skill and when. Any use brings a `stale` skill back to `active` — the curator
 * only ever marks, it does not decide what the reviewer or the human just did.
 */
export async function recordSkillUsage(
  name: string,
  kind: SkillUsageKind,
  opts?: { home?: string; createdBy?: SkillCreator; now?: Date },
): Promise<SkillUsageEntry> {
  const usage = await readSkillUsage(opts);
  const at = (opts?.now ?? new Date()).toISOString();
  const entry: SkillUsageEntry = usage[name] ?? { views: 0, patches: 0 };
  if (kind === "view") entry.views += 1;
  else if (kind === "patch") entry.patches += 1;
  else {
    entry.createdBy = opts?.createdBy ?? "reviewer";
    entry.createdAt = at;
  }
  entry.lastUsedAt = at;
  entry.state = "active";
  usage[name] = entry;
  await writeSkillUsage(usage, opts);
  return entry;
}

/** One-line summary for `agentik skills list`. */
export function describeUsage(entry: SkillUsageEntry | undefined): string {
  if (!entry) return "active, never used";
  const parts = [entry.state ?? "active", `views ${entry.views}`, `patches ${entry.patches}`];
  if (entry.createdBy) parts.push(`by ${entry.createdBy}`);
  if (entry.lastUsedAt) parts.push(`last ${entry.lastUsedAt.slice(0, 10)}`);
  return parts.join(", ");
}
