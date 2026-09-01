import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { readHot } from "./memory.ts";
import { memorySnapshot } from "./memory-store.ts";
import { formatSessionHit, searchSessions } from "./sessions.ts";

/**
 * The block `/ak` reads at session open: who the user is, durable facts, an index of skills
 * (name + short description, body loaded on demand) and the sessions related to the goal.
 */

export interface SkillIndexEntry {
  name: string;
  description: string;
  pinned: boolean;
}

/** Descriptions longer than this are cut to 57 chars + "…" in the index. */
export const SKILL_DESCRIPTION_MAX = 60;

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
}): Promise<string> {
  const home = agentikHome(opts.home);
  await readHot({ home }); // runs the legacy migration once before the snapshots are taken
  const [user, memory, skills] = await Promise.all([
    memorySnapshot("user", home),
    memorySnapshot("memory", home),
    skillIndex({ home }),
  ]);
  const goal = opts.goal?.trim();
  const sessions = goal ? await searchSessions(goal, { home, workspace: opts.workspace, limit: 6 }) : [];

  // Snapshots are frozen here, once; the caller decides when to take a new one.
  const out: string[] = [];
  out.push(user.header);
  out.push(user.body);
  out.push("");
  out.push(memory.header);
  out.push(memory.body);
  out.push("");
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
  return `${out.join("\n")}\n`;
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
