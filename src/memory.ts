import { mkdir, readFile, writeFile } from "node:fs/promises";
import { agentikHome, memoryPaths } from "./home.ts";
import { formatSessionHit, migrateLegacyMemory, searchSessions } from "./sessions.ts";

/** Hermes-like caps: always-loaded HOT notes stay small. */
export const HOT_CAP = 2200;
export const USER_CAP = 1375;

const SECRET = /\b(api[_-]?key|secret|token|password|bearer)\b/i;

export interface MemoryNote {
  kind: "fact" | "session" | "lesson";
  body: string;
  createdAt: string;
}

export interface RetainResult {
  layer: "hot" | "rejected";
  path: string;
  reason?: string;
}

export function looksLikeSecret(text: string): boolean {
  return SECRET.test(text);
}

/**
 * Write a durable fact to HOT. Only HOT: there is no overflow store any more. A note that does
 * not fit is refused with the cap in the reason, so the caller consolidates (replace / remove)
 * instead of the note silently landing somewhere nobody reads.
 */
export async function retainNote(
  body: string,
  opts?: { kind?: MemoryNote["kind"]; home?: string },
): Promise<RetainResult> {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return { layer: "rejected", path: "", reason: "empty note" };
  if (looksLikeSecret(text)) return { layer: "rejected", path: "secret", reason: "looks like a secret" };
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  const paths = memoryPaths(home);
  await mkdir(paths.memoryDir, { recursive: true });
  const kind = opts?.kind ?? "fact";
  const line = `- (${kind}) ${text}`;
  const hot = await readOptional(paths.hot);
  const next = hot ? `${hot.trimEnd()}\n${line}\n` : `# MEMORY\n\n${line}\n`;
  if (next.length > HOT_CAP) {
    return {
      layer: "rejected",
      path: paths.hot,
      reason: `MEMORY.md at ${hot.length}/${HOT_CAP} chars — consolidate (replace/remove) before adding`,
    };
  }
  await writeFile(paths.hot, next, "utf8");
  return { layer: "hot", path: paths.hot };
}

/** HOT lines whose text contains the query (case-insensitive), `- ` prefix stripped. */
export async function recallHot(query: string, opts?: { home?: string; limit?: number }): Promise<string[]> {
  const hot = await readHot(opts);
  const q = query.toLowerCase();
  const hits: string[] = [];
  for (const line of hot.split("\n")) {
    if (!line.startsWith("- ")) continue;
    if (line.toLowerCase().includes(q)) hits.push(line.replace(/^- /, "").trim());
  }
  return hits.slice(0, opts?.limit ?? 8);
}

/** HOT matches first, then session hits (`[date] goal — summary`). */
export async function recall(
  query: string,
  opts?: { home?: string; limit?: number; workspace?: string; all?: boolean },
): Promise<string[]> {
  const limit = opts?.limit ?? 8;
  const hits = await recallHot(query, { home: opts?.home, limit });
  const sessions = await searchSessions(query, {
    home: opts?.home,
    workspace: opts?.workspace,
    all: opts?.all,
    limit,
  });
  for (const s of sessions) hits.push(formatSessionHit(s));
  return hits.slice(0, limit);
}

export async function readHot(opts?: { home?: string }): Promise<string> {
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  return readOptional(memoryPaths(home).hot);
}

export async function readUser(opts?: { home?: string }): Promise<string> {
  return readOptional(memoryPaths(agentikHome(opts?.home)).user);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
