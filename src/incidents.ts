import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { resolveWorkspaceRoot, workspaceKeys } from "./workspace.ts";
import { memoryContentProblem } from "./memory-store.ts";
import { openSessionsDb } from "./sessions.ts";

/**
 * The incident log: every failure agentik sees (a spawn that exits non-zero, a harvest the
 * conductor declares failed, a stalled task, a backend switch) lands here, in the same
 * sessions.sqlite as the session history. Murphy's law is the design input: a failure that
 * is not written down happens again, and one seen twice is not transient.
 *
 * Same key on the same workspace and harness while unresolved -> `seen` grows instead of a
 * new row. The key is a failure CLASS (`incidentKey` = `symptomClass` then `normalizeSymptom`),
 * never the payload the CLI printed: see `symptomClass` for the bug that cost the whole loop.
 * Secrets are masked at write time with the memory-store scan; the raw token is never stored.
 * Two FTS5 indexes (unicode61 + trigram) over goal/symptom/cause/fix, kept in sync by triggers,
 * exactly like sessions.
 */

export interface IncidentInput {
  goal: string;
  workspace?: string;
  profile?: string;
  harness?: string;
  backend?: string;
  exitCode?: number;
  stopReason?: string;
  errors?: string[];
  symptom: string;
  cause?: string;
  fix?: string;
}

export interface IncidentRecord {
  id: number;
  goal: string;
  workspace: string;
  profile: string;
  harness: string;
  backend: string;
  exitCode: number | null;
  stopReason: string;
  errors: string[];
  symptom: string;
  cause: string;
  fix: string;
  seen: number;
  firstAt: string;
  lastAt: string;
  resolvedAt: string | null;
}

export interface IncidentHit extends IncidentRecord {
  /** > 1 for a token hit (bm25), 0..1 for a trigram-only (fuzzy) hit. */
  score: number;
}

export interface IncidentSearchOptions {
  home?: string;
  workspace?: string;
  harness?: string;
  limit?: number;
  /** Default true: a resolved incident is history, not a warning. */
  unresolvedOnly?: boolean;
  /** Default 1. Context uses 2: one occurrence is noise, two is a pattern. */
  minSeen?: number;
}

export interface IncidentListOptions {
  home?: string;
  workspace?: string;
  /** ISO timestamp: only incidents last seen at or after it. */
  since?: string;
  includeResolved?: boolean;
  limit?: number;
}

const DEFAULT_SEARCH_LIMIT = 3;
const MAX_ERRORS = 20;
const SYMPTOM_KEY_MAX = 200;
/** A failure CLASS is a headline, not a payload: what a human would put in a bug title. */
export const SYMPTOM_CLASS_MAX = 120;
const TRIGRAM_MIN_FRACTION = 0.6;

interface Row {
  id: number;
  goal: string;
  workspace: string;
  profile: string;
  harness: string;
  backend: string;
  exit_code: number | null;
  stop_reason: string;
  errors: string;
  symptom: string;
  cause: string;
  fix: string;
  seen: number;
  first_at: string;
  last_at: string;
  resolved_at: string | null;
}

/**
 * Everything that changes between two occurrences of the SAME failure and carries no meaning:
 * an ISO timestamp, a UUID (claude prints a `session_id` in every error object), a long hex run
 * (a git sha, a request id), a mixed letters+digits identifier, then any digit run. Order
 * matters: the timestamp and the UUID must be eaten before their own digits are.
 */
const VOLATILE: ReadonlyArray<readonly [RegExp, string]> = [
  // 2026-09-03T10:11:12.345Z / 2026-09-03 10:11:12+02:00 / 2026-09-03
  [/\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?/g, "<ts>"],
  // 20260903T101112Z — the run id's own stamp
  [/\d{8}t\d{6}z/g, "<ts>"],
  // a run id is `<stamp>-<6 hex>`: once the stamp is folded, the nonce is what is left
  [/<ts>-[0-9a-f]{4,12}\b/g, "<ts>-<id>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>"],
  // a hex run of 8+ that really mixes letters and digits: a sha, a request id — never an English word
  [/\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/g, "<id>"],
  // an opaque identifier: 12+ chars mixing letters and digits, no dash (a model name keeps its shape)
  [/\b(?=[a-z0-9_]*[0-9])(?=[a-z0-9_]*[a-z])[a-z0-9_]{12,}\b/g, "<id>"],
  [/\d+/g, "#"],
];

/** Lowercase, whitespace collapsed, volatile runs folded, cut at 200. Not the key on its own. */
export function normalizeSymptom(symptom: string): string {
  let out = symptom.toLowerCase().replace(/\s+/g, " ").trim();
  for (const [re, to] of VOLATILE) out = out.replace(re, to);
  return out.slice(0, SYMPTOM_KEY_MAX);
}

/** A structured payload starts here: `{"…`, `{ "…`, `[{…`. `[BLOCKED: …]` is not one. */
const PAYLOAD_START = /[{]\s*["'{]|\[\s*\{/;

/**
 * The failure CLASS of a symptom: the short headline, without the payload that follows it.
 *
 * Why this exists: for a claude worker that dies, the symptom the CLI hands us is
 * `stalled worker_a@claude-sonnet: exit: claude -p failed (1): {"type":"result","session_id":
 * "6f3a…", …}` — 400 characters of JSON whose first field is a fresh UUID. Keyed on that blob,
 * the SAME failure opened a new row every time (`seen 1×` forever), and `agentik context` only
 * shows KNOWN FAILURES from `seen >= 2`: the learning loop was structurally mute.
 *
 * What identifies a recurring failure is what a human would write in a bug title — who failed and
 * how (`stalled worker_a@claude-sonnet: exit: claude -p failed (1)`) — not the payload, which is
 * evidence. The payload is not thrown away: `recordIncident` stores it in `errors`, which are
 * unioned across occurrences, so every distinct blob of the last 20 occurrences stays readable.
 */
export function symptomClass(symptom: string): string {
  const one = symptom.replace(/\s+/g, " ").trim();
  const payload = one.match(PAYLOAD_START);
  let head = payload && payload.index !== undefined ? one.slice(0, payload.index) : one;
  head = head.replace(/[\s:;,\-–—>|(]+$/, "").trim();
  if (!head) head = one.slice(0, SYMPTOM_CLASS_MAX).trim();
  if (head.length <= SYMPTOM_CLASS_MAX) return head;
  const cut = head.slice(0, SYMPTOM_CLASS_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SYMPTOM_CLASS_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s:;,\-–—>|(]+$/, "")}…`;
}

/**
 * The dedup key: the class, normalized. Applied to the STORED symptom as well as to the incoming
 * one, so a row written before this existed (a full blob in `symptom`) still absorbs the next
 * occurrence instead of opening yet another `seen 1×` line.
 */
export function incidentKey(symptom: string): string {
  return normalizeSymptom(symptomClass(symptom));
}

/** What memory-store refuses to write is masked here, at write time. The disk never sees a token. */
export function maskIncidentText(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const problem = memoryContentProblem(one);
  return problem ? `[BLOCKED: ${problem}]` : one;
}

function maskErrors(errors: string[] | undefined): string[] {
  const out: string[] = [];
  for (const e of errors ?? []) {
    const masked = maskIncidentText(String(e));
    if (masked && !out.includes(masked)) out.push(masked);
  }
  return out.slice(-MAX_ERRORS);
}

export async function recordIncident(input: IncidentInput, opts?: { home?: string }): Promise<IncidentRecord> {
  const home = agentikHome(opts?.home);
  const db = await openIncidents(home);
  try {
    const now = new Date().toISOString();
    // Keyed on the repository root: the same failure in two worktrees is one incident (seen+1).
    const workspace = input.workspace ? resolveWorkspaceRoot(resolve(input.workspace)) : "";
    const harness = input.harness ?? "";
    const full = maskIncidentText(input.symptom);
    if (!full) throw new Error("incident: a symptom is required");
    // The row carries the CLASS; the payload the caller handed us is evidence and goes to the
    // errors, which are unioned occurrence after occurrence (last 20 kept).
    const symptom = symptomClass(full);
    const key = incidentKey(symptom);
    const errors = maskErrors(symptom === full ? input.errors : [...(input.errors ?? []), full]);

    // Read-modify-write: without a transaction two processes both read "no open row" and both
    // insert, which is the same failure counted twice as `seen 1×`. BEGIN IMMEDIATE takes the
    // write lock up front (busy_timeout 5000 in openSessionsDb) — the repository's lock idiom.
    db.run("BEGIN IMMEDIATE");
    try {
      const open = db
        .query<Row, [string, string]>(
          "SELECT * FROM incidents WHERE workspace = ? AND harness = ? AND resolved_at IS NULL ORDER BY last_at DESC, id DESC",
        )
        .all(workspace, harness)
        .find((r) => incidentKey(r.symptom) === key);
      let id: number;
      if (open) {
        const merged = maskErrors([...parseErrors(open.errors), ...errors]);
        db.run("UPDATE incidents SET seen = seen + 1, last_at = ?, errors = ? WHERE id = ?", [
          now,
          JSON.stringify(merged),
          open.id,
        ]);
        id = open.id;
      } else {
        const res = db.run(
          `INSERT INTO incidents (goal, workspace, profile, harness, backend, exit_code, stop_reason, errors, symptom, cause, fix, seen, first_at, last_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          [
            maskIncidentText(input.goal.replace(/\s+/g, " ").trim()),
            workspace,
            input.profile ?? "",
            harness,
            input.backend ?? "",
            typeof input.exitCode === "number" && Number.isFinite(input.exitCode) ? input.exitCode : null,
            input.stopReason ?? "",
            JSON.stringify(errors),
            symptom,
            input.cause ? maskIncidentText(input.cause) : "",
            input.fix ? maskIncidentText(input.fix) : "",
            now,
            now,
          ],
        );
        id = Number(res.lastInsertRowid);
      }
      const row = db.query<Row, [number]>("SELECT * FROM incidents WHERE id = ?").get(id)!;
      db.run("COMMIT");
      return toRecord(row);
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        // Nothing to roll back (BEGIN itself failed): the original error is the one that matters.
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

export async function getIncident(id: number, opts?: { home?: string }): Promise<IncidentRecord | null> {
  if (!Number.isFinite(id)) return null;
  const home = agentikHome(opts?.home);
  if (!existsSync(memoryPaths(home).sessionsDb)) return null;
  const db = await openIncidents(home);
  try {
    const row = db.query<Row, [number]>("SELECT * FROM incidents WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  } finally {
    db.close();
  }
}

export async function searchIncidents(query: string, opts?: IncidentSearchOptions): Promise<IncidentHit[]> {
  const home = agentikHome(opts?.home);
  const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT;
  const tokens = tokenize(query);
  if (!tokens.length || limit <= 0) return [];
  if (!existsSync(memoryPaths(home).sessionsDb)) return [];
  const unresolvedOnly = opts?.unresolvedOnly ?? true;
  const minSeen = opts?.minSeen ?? 1;
  const db = await openIncidents(home);
  try {
    const scores = new Map<number, number>();
    const rows = new Map<number, Row>();
    const byId = db.query<Row, [number]>("SELECT * FROM incidents WHERE id = ?");
    const rowFor = (id: number): Row | null => {
      const row = rows.get(id) ?? byId.get(id);
      if (row) rows.set(id, row);
      return row;
    };
    const take = (id: number, score: number) => {
      if (!rowFor(id)) return;
      scores.set(id, Math.max(scores.get(id) ?? 0, score));
    };

    const tokenMatch = tokens.map(ftsPhrase).join(" OR ");
    for (const r of ftsQuery(db, "incidents_fts", tokenMatch, 100)) take(r.rowid, 1 + Math.max(0, -r.rank));

    const fuzzyTokens = tokens.map((t) => fold(t)).filter((t) => t.length >= 3).slice(0, 12);
    const trigrams = [...new Set(fuzzyTokens.flatMap(trigramsOf))];
    if (trigrams.length) {
      const triMatch = trigrams.map(ftsPhrase).join(" OR ");
      for (const r of ftsQuery(db, "incidents_fts_tri", triMatch, 100)) {
        const row = rowFor(r.rowid);
        if (!row) continue;
        const text = fold(`${row.goal} ${row.symptom} ${row.cause} ${row.fix}`);
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

    const wantWorkspace = opts?.workspace ? new Set(workspaceKeys(opts.workspace)) : undefined;
    return [...scores.entries()]
      .map(([id, score]) => ({ ...toRecord(rows.get(id)!), score }))
      // An incident of unknown workspace ("") is never hidden by the filter.
      .filter((h) => !wantWorkspace || h.workspace === "" || wantWorkspace.has(h.workspace))
      .filter((h) => !opts?.harness || h.harness === opts.harness)
      .filter((h) => !unresolvedOnly || h.resolvedAt === null)
      .filter((h) => h.seen >= minSeen)
      // A token hit outranks a fuzzy one; among equals the most repeated, then the most recent.
      .sort(
        (a, b) =>
          Number(b.score > 1) - Number(a.score > 1) ||
          b.seen - a.seen ||
          b.lastAt.localeCompare(a.lastAt) ||
          b.score - a.score ||
          b.id - a.id,
      )
      .slice(0, limit);
  } finally {
    db.close();
  }
}

export async function listIncidents(opts?: IncidentListOptions): Promise<IncidentRecord[]> {
  const home = agentikHome(opts?.home);
  if (!existsSync(memoryPaths(home).sessionsDb)) return [];
  const db = await openIncidents(home);
  try {
    const wantWorkspace = opts?.workspace ? new Set(workspaceKeys(opts.workspace)) : undefined;
    const since = opts?.since ?? "";
    return db
      .query<Row, []>("SELECT * FROM incidents ORDER BY last_at DESC, id DESC")
      .all()
      .map(toRecord)
      .filter((r) => !wantWorkspace || r.workspace === "" || wantWorkspace.has(r.workspace))
      .filter((r) => opts?.includeResolved || r.resolvedAt === null)
      .filter((r) => !since || r.lastAt >= since)
      .slice(0, opts?.limit ?? 200);
  } finally {
    db.close();
  }
}

export async function resolveIncident(id: number, fix: string, opts?: { home?: string }): Promise<IncidentRecord | null> {
  return updateIncident(id, { fix: maskIncidentText(fix), resolved_at: new Date().toISOString() }, opts);
}

export async function classifyIncident(id: number, cause: string, opts?: { home?: string }): Promise<IncidentRecord | null> {
  return updateIncident(id, { cause: maskIncidentText(cause) }, opts);
}

/** Fold `from` into `into`: seen is summed, first_at is the earliest, errors are unioned, `from` is deleted. */
export async function mergeIncidents(intoId: number, fromId: number, opts?: { home?: string }): Promise<IncidentRecord | null> {
  if (!Number.isFinite(intoId) || !Number.isFinite(fromId) || intoId === fromId) return null;
  const home = agentikHome(opts?.home);
  if (!existsSync(memoryPaths(home).sessionsDb)) return null;
  const db = await openIncidents(home);
  try {
    const byId = db.query<Row, [number]>("SELECT * FROM incidents WHERE id = ?");
    const into = byId.get(intoId);
    const from = byId.get(fromId);
    if (!into || !from) return null;
    const errors = maskErrors([...parseErrors(into.errors), ...parseErrors(from.errors)]);
    db.run("BEGIN");
    try {
      db.run(
        "UPDATE incidents SET seen = ?, first_at = ?, last_at = ?, errors = ?, cause = ?, fix = ? WHERE id = ?",
        [
          into.seen + from.seen,
          into.first_at < from.first_at ? into.first_at : from.first_at,
          into.last_at > from.last_at ? into.last_at : from.last_at,
          JSON.stringify(errors),
          into.cause || from.cause,
          into.fix || from.fix,
          intoId,
        ],
      );
      db.run("DELETE FROM incidents WHERE id = ?", [fromId]);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    return toRecord(byId.get(intoId)!);
  } finally {
    db.close();
  }
}

/**
 * `⚠ codex@opencodex · adapter_eof on --output-schema · seen 4× · last 2026-09-01 · fix: …`
 * `@backend` is omitted when the backend is empty or just repeats the harness; `fix:` when empty.
 */
export function formatIncidentHit(rec: Pick<IncidentRecord, "harness" | "backend" | "symptom" | "seen" | "lastAt" | "fix">): string {
  const who = rec.harness
    ? rec.backend && rec.backend !== rec.harness
      ? `${rec.harness}@${rec.backend}`
      : rec.harness
    : rec.backend;
  const parts = [who, rec.symptom, `seen ${rec.seen}×`, `last ${rec.lastAt.slice(0, 10)}`];
  if (rec.fix) parts.push(`fix: ${rec.fix}`);
  return `⚠ ${parts.filter(Boolean).join(" · ")}`;
}

/** `#3 · codex@opencodex · adapter_eof … · seen 4× · 2026-08-30→2026-09-01 · fix: …` — the postmortem list line. */
export function formatIncidentLine(rec: IncidentRecord): string {
  const who = rec.harness
    ? rec.backend && rec.backend !== rec.harness
      ? `${rec.harness}@${rec.backend}`
      : rec.harness
    : rec.backend;
  const parts = [`#${rec.id}`, who, rec.symptom, `seen ${rec.seen}×`, `${rec.firstAt.slice(0, 10)}→${rec.lastAt.slice(0, 10)}`];
  if (rec.fix) parts.push(`fix: ${rec.fix}`);
  if (rec.resolvedAt) parts.push("resolved");
  return parts.filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------------------------

async function updateIncident(
  id: number,
  fields: Partial<Pick<Row, "cause" | "fix" | "resolved_at">>,
  opts?: { home?: string },
): Promise<IncidentRecord | null> {
  if (!Number.isFinite(id)) return null;
  const home = agentikHome(opts?.home);
  if (!existsSync(memoryPaths(home).sessionsDb)) return null;
  const db = await openIncidents(home);
  try {
    const byId = db.query<Row, [number]>("SELECT * FROM incidents WHERE id = ?");
    if (!byId.get(id)) return null;
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    if (keys.length) {
      db.run(`UPDATE incidents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [
        ...keys.map((k) => fields[k] ?? null),
        id,
      ]);
    }
    return toRecord(byId.get(id)!);
  } finally {
    db.close();
  }
}

async function openIncidents(home: string): Promise<Database> {
  const db = await openSessionsDb(home);
  db.run(`CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY,
    goal TEXT NOT NULL DEFAULT '',
    workspace TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '',
    harness TEXT NOT NULL DEFAULT '',
    backend TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    stop_reason TEXT NOT NULL DEFAULT '',
    errors TEXT NOT NULL DEFAULT '[]',
    symptom TEXT NOT NULL,
    cause TEXT NOT NULL DEFAULT '',
    fix TEXT NOT NULL DEFAULT '',
    seen INTEGER NOT NULL DEFAULT 1,
    first_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    resolved_at TEXT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS incidents_open ON incidents(workspace, harness, resolved_at, last_at)");
  for (const [name, tokenizer] of [
    ["incidents_fts", "unicode61 remove_diacritics 2"],
    ["incidents_fts_tri", "trigram"],
  ] as const) {
    const existed = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(name)?.n ?? 0;
    db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(goal, symptom, cause, fix, content='incidents', content_rowid='id', tokenize='${tokenizer}')`,
    );
    // An index created over an already-populated table starts empty: rebuild it once.
    if (!existed) db.run(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
    db.run(`CREATE TRIGGER IF NOT EXISTS ${name}_ai AFTER INSERT ON incidents BEGIN
      INSERT INTO ${name}(rowid, goal, symptom, cause, fix) VALUES (new.id, new.goal, new.symptom, new.cause, new.fix);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS ${name}_ad AFTER DELETE ON incidents BEGIN
      INSERT INTO ${name}(${name}, rowid, goal, symptom, cause, fix) VALUES ('delete', old.id, old.goal, old.symptom, old.cause, old.fix);
    END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS ${name}_au AFTER UPDATE ON incidents BEGIN
      INSERT INTO ${name}(${name}, rowid, goal, symptom, cause, fix) VALUES ('delete', old.id, old.goal, old.symptom, old.cause, old.fix);
      INSERT INTO ${name}(rowid, goal, symptom, cause, fix) VALUES (new.id, new.goal, new.symptom, new.cause, new.fix);
    END`);
  }
  return db;
}

function parseErrors(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toRecord(r: Row): IncidentRecord {
  return {
    id: r.id,
    goal: r.goal,
    workspace: r.workspace,
    profile: r.profile,
    harness: r.harness,
    backend: r.backend,
    exitCode: r.exit_code,
    stopReason: r.stop_reason,
    errors: parseErrors(r.errors),
    symptom: r.symptom,
    cause: r.cause,
    fix: r.fix,
    seen: r.seen,
    firstAt: r.first_at,
    lastAt: r.last_at,
    resolvedAt: r.resolved_at,
  };
}

function ftsQuery(
  db: Database,
  table: "incidents_fts" | "incidents_fts_tri",
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
    return [];
  }
}

function tokenize(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/["*^]/g, "").trim())
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 24);
}

function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function trigramsOf(token: string): string[] {
  const chars = [...token];
  const out: string[] = [];
  for (let i = 0; i + 3 <= chars.length; i++) out.push(chars.slice(i, i + 3).join(""));
  return out;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
