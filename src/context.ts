import { readdir, readFile } from "node:fs/promises";
import { CODE_MAP_BUDGET, repoMap } from "./repo-map.ts";
import { join } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { readHot } from "./memory.ts";
import { memorySnapshot } from "./memory-store.ts";
import { formatSessionHit, searchSessions } from "./sessions.ts";
import { formatIncidentHit, searchIncidents } from "./incidents.ts";

/**
 * The block `/ak` reads at session open: who the user is, durable facts (global, then this
 * workspace's project memory when it has any), an index of skills (name + short description,
 * body loaded on demand) and the sessions related to the goal.
 */

export interface SkillIndexEntry {
  name: string;
  description: string;
  pinned: boolean;
}

/** Descriptions longer than this are cut to 57 chars + "…" in the index. */
export const SKILL_DESCRIPTION_MAX = 60;

/**
 * KNOWN FAILURES: at most 3 lines — a warning, not a report. The symptom is what gets cut, so
 * `seen N×`, `last` and `fix:` (the parts the conductor acts on) always survive on the line.
 */
export const KNOWN_FAILURES_MAX = 3;
export const KNOWN_FAILURE_SYMPTOM_MAX = 60;

export async function skillIndex(opts?: { home?: string }): Promise<SkillIndexEntry[]> {
  const paths = memoryPaths(agentikHome(opts?.home));
  let names: string[] = [];
  try {
    const ents = await readdir(paths.skills, { withFileTypes: true });
    names = ents.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const pinned = new Set(await readPinned(join(paths.skills, ".pinned")));
  const entries: SkillIndexEntry[] = [];
  for (const name of names) {
    let body: string;
    try {
      body = await readFile(join(paths.skills, name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fm = frontmatter(body);
    entries.push({
      name: fm.name || name,
      description: fm.description || "",
      pinned: pinned.has(name),
    });
  }
  return entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

export function truncateDescription(text: string, max = SKILL_DESCRIPTION_MAX): string {
  const one = text.replace(/\s+/g, " ").trim();
  if ([...one].length <= max) return one;
  return `${[...one].slice(0, max - 3).join("").trimEnd()}…`;
}

export async function buildContext(opts: {
  home?: string;
  workspace?: string;
  goal?: string;
  /** Append the CODE MAP of the workspace (default true; spawn renders it as its own envelope). */
  code?: boolean;
}): Promise<string> {
  const home = agentikHome(opts.home);
  await readHot({ home }); // runs the legacy migration once before the snapshots are taken
  const [user, memory, skills, project] = await Promise.all([
    memorySnapshot("user", home),
    memorySnapshot("memory", home),
    skillIndex({ home }),
    opts.workspace ? memorySnapshot("project", home, { workspace: opts.workspace }) : Promise.resolve(undefined),
  ]);
  const goal = opts.goal?.trim();
  const sessions = goal ? await searchSessions(goal, { home, workspace: opts.workspace, limit: 6 }) : [];
  // Murphy: a failure seen twice on this workspace and never resolved is the first thing to
  // know. Seen once is noise and stays in the log (agentik postmortem).
  const failures = goal
    ? await searchIncidents(goal, { home, workspace: opts.workspace, minSeen: 2, unresolvedOnly: true, limit: KNOWN_FAILURES_MAX })
    : [];

  // Snapshots are frozen here, once; the caller decides when to take a new one.
  const out: string[] = [];
  out.push(user.header);
  out.push(user.body);
  out.push("");
  out.push(memory.header);
  out.push(memory.body);
  out.push("");
  // PROJECT MEMORY is this workspace's file only, and only when it says something: no header
  // for a workspace that has none (most do not), and never another workspace's entries.
  if (project && project.usage.used > 0) {
    out.push(project.header);
    out.push(project.body);
    out.push("");
  }
  out.push("SKILLS (load a body only when relevant)");
  if (skills.length) {
    for (const s of skills) out.push(`- ${s.name}: ${truncateDescription(s.description) || "(no description)"}`);
  } else {
    out.push("(none)");
  }
  out.push("");
  out.push("RELATED SESSIONS (workspace-filtered, top 6)");
  if (!goal) out.push("(pass a goal to search)");
  else if (!sessions.length) out.push("(none)");
  else for (const s of sessions) out.push(`- ${formatSessionHit(s)}`);
  if (failures.length) {
    out.push("");
    out.push("KNOWN FAILURES (unresolved, seen ≥2, this workspace)");
    for (const f of failures) {
      out.push(`- #${f.id} ${formatIncidentHit({ ...f, symptom: truncateDescription(f.symptom, KNOWN_FAILURE_SYMPTOM_MAX) })}`);
    }
  }
  const map = opts.code !== false && opts.workspace ? await codeMapSection(home, opts.workspace, goal) : undefined;
  if (map) {
    out.push("");
    out.push(map.trimEnd());
  }
  return `${out.join("\n")}\n`;
}

/** The repo map block, or undefined when the workspace has no index (a failure is one stderr line). */
export async function codeMapSection(home: string, workspace: string, goal: string | undefined, budget = CODE_MAP_BUDGET): Promise<string | undefined> {
  try {
    return await repoMap(home, workspace, { goal, budgetChars: budget });
  } catch (err) {
    console.error(`agentik context: code map unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** `name:` and `description:` from a YAML frontmatter; folded (`>`) / literal (`|`) blocks are joined. */
export function frontmatter(body: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  let key: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (key) out[key] = buf.join(" ").replace(/\s+/g, " ").trim();
    key = undefined;
    buf = [];
  };
  for (const line of lines) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      flush();
      key = kv[1];
      const v = kv[2].trim();
      buf = v === ">" || v === "|" || v === ">-" || v === "|-" ? [] : [v.replace(/^["']|["']$/g, "")];
    } else if (key && /^\s+\S/.test(line)) {
      buf.push(line.trim());
    }
  }
  flush();
  return { name: out.name, description: out.description };
}

async function readPinned(path: string): Promise<string[]> {
  try {
    const body = await readFile(path, "utf8");
    return body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}
