import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { agentikHome, memoryPaths } from "./home.ts";

/** Hermes-like caps: always-loaded HOT notes stay small. */
export const HOT_CAP = 2200;
export const USER_CAP = 1375;

const SECRET = /\b(api[_-]?key|secret|token|password|bearer)\b/i;

export interface MemoryNote {
  kind: "fact" | "session" | "lesson";
  body: string;
  createdAt: string;
}

export function looksLikeSecret(text: string): boolean {
  return SECRET.test(text);
}

export async function retainNote(
  body: string,
  opts?: { kind?: MemoryNote["kind"]; home?: string },
): Promise<{ layer: "hot" | "warm" | "rejected"; path: string }> {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return { layer: "rejected", path: "" };
  if (looksLikeSecret(text)) return { layer: "rejected", path: "secret" };
  const paths = memoryPaths(agentikHome(opts?.home));
  await mkdir(paths.memoryDir, { recursive: true });
  const kind = opts?.kind ?? "fact";
  const line = `- (${kind}) ${text}`;
  const hot = await readOptional(paths.hot);
  if (hot.length + line.length + 1 <= HOT_CAP) {
    const next = hot ? `${hot.trimEnd()}\n${line}\n` : `# MEMORY\n\n${line}\n`;
    await writeFile(paths.hot, next, "utf8");
    return { layer: "hot", path: paths.hot };
  }
  const db = openNotes(paths.db);
  db.run("INSERT INTO notes (kind, body, created_at) VALUES (?, ?, ?)", [
    kind,
    text,
    new Date().toISOString(),
  ]);
  db.close();
  return { layer: "warm", path: paths.db };
}

export async function recall(query: string, opts?: { home?: string; limit?: number }): Promise<string[]> {
  const paths = memoryPaths(agentikHome(opts?.home));
  const hits: string[] = [];
  const hot = await readOptional(paths.hot);
  const q = query.toLowerCase();
  for (const line of hot.split("\n")) {
    if (line.toLowerCase().includes(q)) hits.push(line.replace(/^- /, "").trim());
  }
  try {
    const db = openNotes(paths.db);
    const rows = db
      .query("SELECT body FROM notes WHERE notes MATCH ? ORDER BY rowid DESC LIMIT ?")
      .all(query, opts?.limit ?? 8) as Array<{ body: string }>;
    for (const r of rows) hits.push(r.body);
    db.close();
  } catch {
    /* no db yet */
  }
  return hits.slice(0, opts?.limit ?? 8);
}

export async function readHot(opts?: { home?: string }): Promise<string> {
  const paths = memoryPaths(agentikHome(opts?.home));
  return readOptional(paths.hot);
}

function openNotes(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(kind, body, created_at, tokenize='porter')",
  );
  return db;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
