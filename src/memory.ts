import { readFile } from "node:fs/promises";
import { agentikHome, memoryPaths } from "./home.ts";
import {
  MEMORY_CAP,
  memoryAdd,
  memoryContentProblem,
  memoryFileLabel,
  memoryFilePath,
  readEntries,
  USER_CAP as STORE_USER_CAP,
  type MemoryTarget,
} from "./memory-store.ts";
import { formatSessionHit, migrateLegacyMemory, searchSessions } from "./sessions.ts";

/** Hermes-like caps: always-loaded HOT notes stay small. */
export const HOT_CAP = MEMORY_CAP;
export const USER_CAP = STORE_USER_CAP;

export interface MemoryNote {
  kind: "fact" | "session" | "lesson";
  body: string;
  createdAt: string;
}

export interface RetainResult {
  /** `pending`: memory.writeApproval is on, the note waits in `pending/memory/` for approval. */
  layer: "hot" | "pending" | "rejected";
  path: string;
  reason?: string;
}

export function looksLikeSecret(text: string): boolean {
  return memoryContentProblem(text)?.startsWith("looks like a secret") ?? false;
}

/**
 * Write a durable fact through the store: one `§`-separated entry, exact-deduplicated,
 * scanned, and refused with the cap in the reason when it does not fit — the caller
 * consolidates (replace / remove) instead of the note silently landing somewhere nobody reads.
 * `target` defaults to the global MEMORY.md; `project` needs `workspace`. `kind` is kept for
 * the CLI's sake; the store does not label entries.
 */
export async function retainNote(
  body: string,
  opts?: { kind?: MemoryNote["kind"]; home?: string; target?: MemoryTarget; workspace?: string },
): Promise<RetainResult> {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return { layer: "rejected", path: "", reason: "empty note" };
  const home = agentikHome(opts?.home);
  const target = opts?.target ?? "memory";
  await migrateLegacyMemory({ home });
  const paths = memoryPaths(home);
  const file = memoryFilePath(target, { home, workspace: opts?.workspace });
  const res = await memoryAdd(target, text, { home, workspace: opts?.workspace });
  if (!res.ok) {
    return {
      layer: "rejected",
      path: res.blocked ? "secret" : file,
      reason: res.overCap
        ? `${memoryFileLabel(target)} at ${res.usage.used}/${res.usage.cap} chars — consolidate (replace/remove) before adding`
        : res.message,
    };
  }
  if (res.staged) {
    return { layer: "pending", path: `${paths.pendingMemoryOps}/${res.staged}.json`, reason: res.message };
  }
  return { layer: "hot", path: file };
}

/** HOT entries whose text contains the query (case-insensitive). */
export async function recallHot(query: string, opts?: { home?: string; limit?: number }): Promise<string[]> {
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  const q = query.toLowerCase();
  const entries = await readEntries("memory", home);
  return entries.filter((e) => e.toLowerCase().includes(q)).slice(0, opts?.limit ?? 8);
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
