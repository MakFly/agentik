import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * Sessions are the searchable memory. One row per run: goal, workspace, profile, status,
 * verdict (JSON), artifacts (JSON array), one-line summary. Two FTS5 indexes over
 * (goal, summary, artifacts) stay in sync with `sessions` through triggers:
 *   - sessions_fts     unicode61 remove_diacritics 2  -> "clôturer" == "cloturer"
 *   - sessions_fts_tri trigram                        -> "migrat" finds "migration", "drawr" finds "drawer"
 * This replaces the WARM `notes.sqlite`: a note that does not fit HOT is not a durable fact,
 * it belongs to the session that produced it.
 */

export interface SessionInput {
  goal: string;
  workspace?: string;
  profile?: string;
  status: string;
  verdict?: unknown;
  artifacts?: string[];
  summary?: string;
}

export interface SessionRecord {
  id: number;
  goal: string;
  workspace: string;
  profile: string;
  status: string;
  verdict: unknown | null;
  artifacts: string[];
  summary: string;
  createdAt: string;
}

export interface SessionHit extends SessionRecord {
  /** > 1 for a token hit (bm25), 0..1 for a trigram-only (fuzzy) hit. */
  score: number;
}

export interface SearchOptions {
  home?: string;
  workspace?: string;
  all?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 6;
/** Fraction of a token's trigrams that must appear in the row for a fuzzy hit to count. */
const TRIGRAM_MIN_FRACTION = 0.6;

interface Row {
  id: number;
  goal: string;
  workspace: string;
  profile: string;
  status: string;
  verdict: string | null;
  artifacts: string;
  summary: string;
  created_at: string;
}

export async function recordSession(
  input: SessionInput,
  opts?: { home?: string },
): Promise<SessionRecord> {
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  const db = await openSessions(home);
  try {
    return insertSession(db, input);
  } finally {
    db.close();
  }
}

export async function searchSessions(query: string, opts?: SearchOptions): Promise<SessionHit[]> {
  const home = agentikHome(opts?.home);
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const tokens = tokenize(query);
  if (!tokens.length || limit <= 0) return [];
  await migrateLegacyMemory({ home });
  if (!existsSync(memoryPaths(home).sessionsDb)) return [];
  const db = await openSessions(home);
  try {
    const scores = new Map<number, number>();
    const rows = new Map<number, Row>();
    const byId = db.query<Row, [number]>("SELECT * FROM sessions WHERE id = ?");
    const rowFor = (id: number): Row | null => {
      const row = rows.get(id) ?? byId.get(id);
      if (row) rows.set(id, row);
      return row;
    };
    const take = (id: number, score: number) => {
      if (!rowFor(id)) return;
      scores.set(id, Math.max(scores.get(id) ?? 0, score));
    };

    // 1. Token hits, diacritics folded. bm25 rank is negative (lower = better).
    const tokenMatch = tokens.map(ftsPhrase).join(" OR ");
    for (const r of ftsQuery(db, "sessions_fts", tokenMatch, 100)) take(r.rowid, 1 + Math.max(0, -r.rank));

    // 2. Fuzzy hits: OR of the query's trigrams, then verified per token in JS so a single
    //    shared trigram ("raw") does not count as a match.
    const fuzzyTokens = tokens.map((t) => fold(t)).filter((t) => t.length >= 3).slice(0, 12);
    const trigrams = [...new Set(fuzzyTokens.flatMap(trigramsOf))];
    if (trigrams.length) {
      const triMatch = trigrams.map(ftsPhrase).join(" OR ");
      for (const r of ftsQuery(db, "sessions_fts_tri", triMatch, 100)) {
        const row = rowFor(r.rowid);
        if (!row) continue;
        const text = fold(`${row.goal} ${row.summary} ${row.artifacts}`);
        let best = 0;
        for (const tok of fuzzyTokens) {
          const tris = trigramsOf(tok);
          if (!tris.length) continue;
          const hit = tris.filter((t) => text.includes(t)).length / tris.length;
          if (hit > best) best = hit;
        }
        if (best >= TRIGRAM_MIN_FRACTION) take(r.rowid, best);
      }
    }

    const wantWorkspace = opts?.workspace && !opts.all ? resolve(opts.workspace) : undefined;
    return [...scores.entries()]
      .map(([id, score]) => ({ ...toRecord(rows.get(id)!), score }))
      // A session of unknown workspace ("" — migrated from the old stores) is never hidden by
      // the filter; only sessions that belong to another workspace are.
      .filter((h) => !wantWorkspace || h.workspace === "" || h.workspace === wantWorkspace)
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .slice(0, limit);
  } finally {
    db.close();
  }
}

/** `[2026-09-01] <goal> — <summary>` */
export function formatSessionHit(hit: Pick<SessionRecord, "createdAt" | "goal" | "summary">): string {
  return `[${hit.createdAt.slice(0, 10)}] ${hit.goal} — ${hit.summary}`;
}

export async function getSession(id: number, opts?: { home?: string }): Promise<SessionRecord | null> {
  if (!Number.isFinite(id)) return null;
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  if (!existsSync(memoryPaths(home).sessionsDb)) return null;
  const db = await openSessions(home);
  try {
    const row = db.query<Row, [number]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  } finally {
    db.close();
  }
}

/** Most recent session for a workspace (unknown-workspace rows count), else the most recent. */
export async function latestSession(opts?: { home?: string; workspace?: string }): Promise<SessionRecord | null> {
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  if (!existsSync(memoryPaths(home).sessionsDb)) return null;
  const db = await openSessions(home);
  try {
    const ws = opts?.workspace ? resolve(opts.workspace) : "";
    const row = ws
      ? db
          .query<Row, [string]>(
            "SELECT * FROM sessions WHERE workspace = ? OR workspace = '' ORDER BY created_at DESC, id DESC LIMIT 1",
          )
          .get(ws)
      : db.query<Row, []>("SELECT * FROM sessions ORDER BY created_at DESC, id DESC LIMIT 1").get();
    return row ? toRecord(row) : null;
  } finally {
    db.close();
  }
}

export async function listSessions(opts?: { home?: string; limit?: number }): Promise<SessionRecord[]> {
  const home = agentikHome(opts?.home);
  await migrateLegacyMemory({ home });
  if (!existsSync(memoryPaths(home).sessionsDb)) return [];
  const db = await openSessions(home);
  try {
    return db
      .query<Row, [number]>("SELECT * FROM sessions ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(opts?.limit ?? 20)
      .map(toRecord);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Migration of the two legacy stores: `(session)` lines in HOT and kind='session' rows in
// notes.sqlite. Idempotent (marker + duplicate check), HOT is backed up before it is rewritten,
// notes.sqlite is left on disk. This is what frees a HOT saturated at 2200/2200.
// ---------------------------------------------------------------------------------------------

export interface MigrationResult {
  ran: boolean;
  fromHot: number;
  fromNotes: number;
  backup?: string;
}

const LEGACY_LINE = /^- \(session\) (.*)$/;

/**
 * Move any `- (session) …` lines still sitting in MEMORY.md into sessions.sqlite and rewrite
 * HOT without them. Returns how many were moved (0 = file untouched, no backup taken).
 */
export async function sweepLegacySessionLines(home: string): Promise<number> {
  const paths = memoryPaths(home);
  if (!existsSync(paths.hot)) return 0;
  const body = await readFile(paths.hot, "utf8");
  const kept: string[] = [];
  const moved: SessionInput[] = [];
  for (const line of body.split("\n")) {
    const m = LEGACY_LINE.exec(line);
    if (m) moved.push(parseLegacySession(m[1]));
    else kept.push(line);
  }
  if (moved.length === 0) return 0;
  const stamp = new Date().toISOString();
  const db = await openSessions(home);
  try {
    const exists = db.query<{ id: number }, [string, string, string]>(
      "SELECT id FROM sessions WHERE workspace = '' AND goal = ? AND status = ? AND artifacts = ?",
    );
    for (const s of moved) {
      const artifacts = JSON.stringify(s.artifacts ?? []);
      if (exists.get(s.goal, s.status, artifacts)) continue;
      insertSession(db, { ...s, workspace: "", profile: "" }, stamp);
    }
  } finally {
    db.close();
  }
  await copyFile(paths.hot, `${paths.hot}.bak.${stamp.replace(/[:.]/g, "-")}`);
  // Drop the blank lines the removed entries leave behind, keep the § structure intact.
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+§/g, "\n§");
  await writeFile(paths.hot, cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`, "utf8");
  return moved.length;
}

export async function migrateLegacyMemory(opts?: { home?: string }): Promise<MigrationResult> {
  const home = agentikHome(opts?.home);
  const paths = memoryPaths(home);
  const none: MigrationResult = { ran: false, fromHot: 0, fromNotes: 0 };
  if (existsSync(paths.migratedMarker)) {
    // The one-shot import is done, but a client running older code can still append
    // `- (session)` lines to HOT afterwards. Sweep them out on every open; it is a no-op
    // when there is nothing to sweep.
    const swept = await sweepLegacySessionLines(home);
    return swept ? { ran: true, fromHot: swept, fromNotes: 0 } : none;
  }
  const hasHot = existsSync(paths.hot);
  const hasNotes = existsSync(paths.db);
  if (!hasHot && !hasNotes) return none;

  const imported: Array<SessionInput & { createdAt: string; source: "hot" | "notes" }> = [];
  let hotKept: string[] = [];
  let hotHadSessions = false;
  if (hasHot) {
    const [body, info] = await Promise.all([readFile(paths.hot, "utf8"), stat(paths.hot)]);
    const stamp = info.mtime.toISOString();
    for (const line of body.split("\n")) {
      const m = LEGACY_LINE.exec(line);
      if (!m) {
        hotKept.push(line);
        continue;
      }
      hotHadSessions = true;
      imported.push({ ...parseLegacySession(m[1]), createdAt: stamp, source: "hot" });
    }
  }
  if (hasNotes) {
    try {
      const notes = new Database(paths.db, { readonly: true });
      try {
        const rows = notes
          .query<{ body: string; created_at: string }, []>(
            "SELECT body, created_at FROM notes WHERE kind = 'session' ORDER BY rowid",
          )
          .all();
        for (const r of rows) {
          imported.push({
            ...parseLegacySession(r.body),
            createdAt: r.created_at || new Date().toISOString(),
            source: "notes",
          });
        }
      } finally {
        notes.close();
      }
    } catch {
      /* not a notes store — nothing to import from it */
    }
  }

  let fromHot = 0;
  let fromNotes = 0;
  if (imported.length) {
    const db = await openSessions(home);
    try {
      const exists = db.query<{ id: number }, [string, string, string]>(
        "SELECT id FROM sessions WHERE workspace = '' AND goal = ? AND status = ? AND artifacts = ?",
      );
      const seen = new Set<string>();
      db.run("BEGIN");
      try {
        for (const s of imported) {
          const artifacts = JSON.stringify(s.artifacts ?? []);
          const key = `${s.goal}\u0000${s.status}\u0000${artifacts}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (exists.get(s.goal, s.status, artifacts)) continue;
          insertSession(db, { ...s, workspace: "", profile: "" }, s.createdAt);
          if (s.source === "hot") fromHot++;
          else fromNotes++;
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
    } finally {
      db.close();
    }
  }

  let backup: string | undefined;
  if (hasHot && hotHadSessions) {
    backup = `${paths.hot}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(paths.hot, backup);
    while (hotKept.length && !hotKept[hotKept.length - 1].trim()) hotKept.pop();
    if (!hotKept.length || hotKept.every((l, i) => (i === 0 ? l.trim() === "# MEMORY" : !l.trim()))) {
      hotKept = ["# MEMORY"];
    }
    await writeFile(paths.hot, `${hotKept.join("\n")}\n`, "utf8");
  }

  await mkdir(paths.memoryDir, { recursive: true });
  await writeFile(
    paths.migratedMarker,
    `${JSON.stringify({ at: new Date().toISOString(), fromHot, fromNotes, backup: backup ?? null })}\n`,
    "utf8",
  );
  return { ran: true, fromHot, fromNotes, backup };
}

/** `session: <goal> [<status>] artifacts=<a,b|none>` -> SessionInput. Tolerates missing parts. */
export function parseLegacySession(text: string): SessionInput {
  let body = text.trim().replace(/^session:\s*/, "");
  let status = "unknown";
  let artifacts: string[] = [];
  const art = /\s+artifacts=(.*)$/.exec(body);
  if (art) {
    artifacts = art[1] === "none" ? [] : art[1].split(",").map((a) => a.trim()).filter(Boolean);
    body = body.slice(0, art.index);
  }
  const st = /\s*\[([a-z_]+)\]\s*$/i.exec(body);
  if (st) {
    status = st[1];
    body = body.slice(0, st.index);
  }
  return {
    goal: body.trim(),
    status,
    artifacts,
    summary: `${status} — artifacts: ${artifacts.join(", ") || "none"}`,
  };
}

// ---------------------------------------------------------------------------------------------

async function openSessions(home: string): Promise<Database> {
  await mkdir(home, { recursive: true });
  const db = new Database(memoryPaths(home).sessionsDb, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    goal TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    verdict TEXT,
    artifacts TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace, created_at)");
  for (const [name, tokenizer] of [
    ["sessions_fts", "unicode61 remove_diacritics 2"],
    ["sessions_fts_tri", "trigram"],
  ] as const) {
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(goal, summary, artifacts, content='sessions', content_rowid='id', tokenize='${tokenizer}')`,
    );
    db.run(`CREATE TRIGGER IF NOT EXISTS ${name}_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO ${name}(rowid, goal, summary, artifacts) VALUES (new.id, new.goal, new.summary, new.artifacts);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS ${name}_ad AFTER DELETE ON sessions BEGIN
      INSERT INTO ${name}(${name}, rowid, goal, summary, artifacts) VALUES ('delete', old.id, old.goal, old.summary, old.artifacts);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS ${name}_au AFTER UPDATE ON sessions BEGIN
      INSERT INTO ${name}(${name}, rowid, goal, summary, artifacts) VALUES ('delete', old.id, old.goal, old.summary, old.artifacts);
      INSERT INTO ${name}(rowid, goal, summary, artifacts) VALUES (new.id, new.goal, new.summary, new.artifacts);
    END`);
  }
  return db;
}

function insertSession(db: Database, input: SessionInput, createdAt?: string): SessionRecord {
  const artifacts = input.artifacts ?? [];
  const row = {
    goal: input.goal.replace(/\s+/g, " ").trim(),
    workspace: input.workspace ? resolve(input.workspace) : "",
    profile: input.profile ?? "",
    status: input.status,
    verdict: input.verdict === undefined || input.verdict === null ? null : JSON.stringify(input.verdict),
    artifacts: JSON.stringify(artifacts),
    summary: (input.summary ?? "").replace(/\s+/g, " ").trim(),
    created_at: createdAt ?? new Date().toISOString(),
  };
  const res = db.run(
    "INSERT INTO sessions (goal, workspace, profile, status, verdict, artifacts, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [row.goal, row.workspace, row.profile, row.status, row.verdict, row.artifacts, row.summary, row.created_at],
  );
  return toRecord({ id: Number(res.lastInsertRowid), ...row });
}

function toRecord(r: Row): SessionRecord {
  let verdict: unknown = null;
  let artifacts: string[] = [];
  try {
    verdict = r.verdict ? JSON.parse(r.verdict) : null;
  } catch {
    verdict = r.verdict;
  }
  try {
    const parsed = JSON.parse(r.artifacts);
    artifacts = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    artifacts = [];
  }
  return {
    id: r.id,
    goal: r.goal,
    workspace: r.workspace,
    profile: r.profile,
    status: r.status,
    verdict,
    artifacts,
    summary: r.summary,
    createdAt: r.created_at,
  };
}

function ftsQuery(
  db: Database,
  table: "sessions_fts" | "sessions_fts_tri",
  match: string,
  limit: number,
): Array<{ rowid: number; rank: number }> {
  try {
    return db
      .query<{ rowid: number; rank: number }, [string, number]>(
        `SELECT rowid, rank FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit);
  } catch {
    // Every token is escaped, so this is an FTS5 edge case. A search that cannot run returns
    // nothing rather than crashing the caller.
    return [];
  }
}

/** Whitespace tokens with FTS5 syntax stripped: quotes, `*`, `^` become plain text. */
function tokenize(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/["*^]/g, "").trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 24);
}

/** Every token is a quoted phrase, so AND/OR/NOT/NEAR and punctuation are matched literally. */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function trigramsOf(token: string): string[] {
  const chars = [...token];
  const out: string[] = [];
  for (let i = 0; i + 3 <= chars.length; i++) out.push(chars.slice(i, i + 3).join(""));
  return out;
}

/** Lowercase, diacritics stripped — mirrors what the unicode61 index sees. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
