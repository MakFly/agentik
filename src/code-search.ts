import type { Database } from "bun:sqlite";
import { splitIdent } from "./code-chunker.ts";
import { hasIndex, indexKey, indexStats, openIndex, readWorkspaceFile, refreshIndex, type IndexStats } from "./code-index.ts";
import { agentikHome } from "./home.ts";
import { secretProblem } from "./memory-store.ts";
import { fold, ftsPhrase, tokenize, trigramsOf } from "./sessions.ts";

/**
 * Search over the local code index. The index only produces candidates (BM25 on identifiers,
 * AND of trigrams for substrings, literal runs of a regex); the live file on disk is what gets
 * verified and quoted, so a result is never staler than the workspace. Every quoted line goes
 * through the secret scan. Regex patterns come from workers (untrusted): bounded in length,
 * shape, candidate count and wall clock.
 */

export const SEARCH_K_DEFAULT = 20;
export const SEARCH_K_MAX = 50;
export const SEARCH_QUERY_MAX = 200;
export const REGEX_BUDGET_MS = 1500;
export const REGEX_CANDIDATE_MAX = 300;
export const NO_LITERAL_FILE_CAP = 500;
export const SNIPPET_LINE_MAX = 160;
export const LINES_PER_RANGE = 3;
export const RANGES_PER_FILE = 5;
export const FORMAT_MAX_CHARS = 6000;
export const FORMAT_MAX_HITS = 40;
const LEXICAL_CHUNK_LIMIT = 200;
const SUBSTRING_FILE_LIMIT = 300;

export interface SearchQuery {
  query: string;
  regex?: boolean;
  pathGlob?: string;
  k?: number;
  offset?: number;
  budgetMs?: number;
}

export interface LineHit {
  n: number;
  text: string;
}

export interface RangeHit {
  start: number;
  end: number;
  symbol: string;
  kind: string;
  lines: LineHit[];
}

export interface FileHit {
  path: string;
  score: number;
  ranges: RangeHit[];
}

export interface SearchResult {
  hits: FileHit[];
  total: number;
  offset: number;
  k: number;
  truncated: boolean;
  note?: string;
  ms: number;
}

/** The seam a future backend (Meilisearch, embeddings) implements; the CLI and the tool see only this. */
export interface SearchIndex {
  refresh(opts?: { rebuild?: boolean }): Promise<IndexStats>;
  search(q: SearchQuery): Promise<SearchResult>;
  stats(): IndexStats | undefined;
}

export function sqliteSearchIndex(home: string | undefined, workspace: string): SearchIndex {
  return {
    refresh: (opts) => refreshIndex(home, workspace, opts),
    search: (q) => searchCode(home, workspace, q),
    stats: () => indexStats(home, workspace),
  };
}

// ---------------------------------------------------------------------------------------------
// Regex bounds
// ---------------------------------------------------------------------------------------------

/** Why a pattern must not run, or undefined. */
export function regexProblem(pattern: string): string | undefined {
  if (!pattern.trim()) return "empty regex";
  if (pattern.length > SEARCH_QUERY_MAX) return `regex longer than ${SEARCH_QUERY_MAX} chars`;
  if (/\\[1-9]|\\k</.test(pattern)) return "backreferences are not allowed";
  if (/\(\?<[=!]/.test(pattern)) return "lookbehind is not allowed";
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return "nested quantifiers are not allowed";
  try {
    new RegExp(pattern, "u");
  } catch (err) {
    return `invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

/**
 * Literal runs every match must contain (top-level only, none when a top-level alternation
 * exists), longest first. Used to pick trigram candidates; the regex itself verifies.
 */
export function literalRuns(pattern: string): string[] {
  const runs: string[] = [];
  let cur = "";
  let depth = 0;
  let topAlternation = false;
  const flush = () => {
    if (cur.length >= 3 && depth === 0) runs.push(cur);
    cur = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1] ?? "";
      i++;
      if (/[dDwWsSbBntrfvpPuxc0-9]/.test(next)) flush();
      else if (depth === 0) cur += next;
      continue;
    }
    if (ch === "[") {
      flush();
      const close = pattern.indexOf("]", i + 1);
      i = close < 0 ? pattern.length : close;
      continue;
    }
    if (ch === "(") {
      flush();
      depth++;
      continue;
    }
    if (ch === ")") {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "|") {
      flush();
      if (depth === 0) topAlternation = true;
      continue;
    }
    if (ch === "?" || ch === "*" || ch === "{") {
      // The previous atom is optional or repeated: it is not part of a guaranteed run.
      cur = cur.slice(0, -1);
      flush();
      if (ch === "{") {
        const close = pattern.indexOf("}", i + 1);
        i = close < 0 ? pattern.length : close;
      }
      continue;
    }
    if (ch === "+") {
      flush();
      continue;
    }
    if (ch === "^" || ch === "$" || ch === ".") {
      flush();
      continue;
    }
    if (depth === 0) cur += ch;
  }
  flush();
  if (topAlternation) return [];
  return runs.sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------------------------

/** FTS5 trigram query for a term: every trigram required (detail=none forbids phrases). */
export function trigramMatch(term: string): string | undefined {
  const tris = [...new Set(trigramsOf(fold(term)))];
  if (tris.length === 0) return undefined;
  return tris.map(ftsPhrase).join(" AND ");
}

/** Reciprocal rank fusion over ranked id lists. */
export function fuseRRF(lists: number[][], k = 60): Map<number, number> {
  const score = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return score;
}

/** A path filter a worker may pass: relative, no `..`, bounded. */
export function pathGlobProblem(glob: string | undefined): string | undefined {
  if (glob === undefined) return undefined;
  if (glob.length === 0 || glob.length > 200) return "path glob must be 1..200 chars";
  if (glob.startsWith("/") || /^[a-zA-Z]:/.test(glob)) return "path glob must be relative";
  if (glob.split("/").includes("..")) return "path glob must not contain ..";
  return undefined;
}

interface FileRow {
  id: number;
  path: string;
  lines: number;
}

interface ChunkRow {
  id: number;
  file_id: number;
  start: number;
  end: number;
  symbol: string;
  kind: string;
}

class FileCache {
  private cache = new Map<string, string[] | undefined>();
  constructor(private root: string) {}
  async lines(path: string): Promise<string[] | undefined> {
    if (this.cache.has(path)) return this.cache.get(path);
    const bytes = await readWorkspaceFile(this.root, path);
    const lines = bytes ? new TextDecoder().decode(bytes).split("\n") : undefined;
    this.cache.set(path, lines);
    return lines;
  }
}

export async function searchCode(home: string | undefined, workspace: string, q: SearchQuery): Promise<SearchResult> {
  const t0 = Date.now();
  const h = agentikHome(home);
  const { root } = indexKey(workspace);
  if (!hasIndex(h, workspace)) throw new Error(`no code index for ${root} — run: agentik index --workspace ${root}`);
  const query = q.query.trim();
  if (!query) throw new Error("empty query");
  if (query.length > SEARCH_QUERY_MAX) throw new Error(`query longer than ${SEARCH_QUERY_MAX} chars`);
  const globProblem = pathGlobProblem(q.pathGlob);
  if (globProblem) throw new Error(globProblem);
  const k = Math.min(SEARCH_K_MAX, Math.max(1, Math.floor(q.k ?? SEARCH_K_DEFAULT)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const budgetMs = q.budgetMs ?? REGEX_BUDGET_MS;
  const db = openIndex(h, root)!;
  try {
    const glob = q.pathGlob ? new Bun.Glob(q.pathGlob) : undefined;
    const files = new Map<number, FileRow>();
    for (const r of db.query<FileRow, []>("SELECT id, path, lines FROM code_files ORDER BY path").all()) {
      if (!glob || glob.match(r.path)) files.set(r.id, r);
    }
    const cache = new FileCache(root);
    const evidence = new Map<number, Set<number>>(); // file id → matching line numbers (1-based)
    const lexicalChunks = new Map<number, ChunkRow[]>(); // file id → chunks that matched by identifier
    const lists: number[][] = [];
    let truncated = false;
    let note: string | undefined;
    const terms: string[] = [];

    const addEvidence = (fileId: number, n: number) => {
      let set = evidence.get(fileId);
      if (!set) evidence.set(fileId, (set = new Set()));
      set.add(n);
    };

    if (q.regex) {
      const problem = regexProblem(query);
      if (problem) throw new Error(problem);
      const re = new RegExp(query, "u");
      const runs = literalRuns(query);
      let candidates: number[];
      if (runs.length) {
        const match = trigramMatch(runs[0]);
        candidates = match ? triCandidates(db, match, REGEX_CANDIDATE_MAX).filter((id) => files.has(id)) : [];
      } else {
        candidates = [...files.keys()].slice(0, NO_LITERAL_FILE_CAP);
        if (files.size > NO_LITERAL_FILE_CAP) {
          note = `regex has no literal of 3+ chars: only the first ${NO_LITERAL_FILE_CAP} files were scanned (narrow with a path glob)`;
          truncated = true;
        }
      }
      const ranked: Array<{ id: number; n: number }> = [];
      const deadline = t0 + budgetMs;
      for (const id of candidates) {
        if (Date.now() > deadline) {
          truncated = true;
          note = `regex budget of ${budgetMs} ms exhausted after ${ranked.length} matching files`;
          break;
        }
        const lines = await cache.lines(files.get(id)!.path);
        if (!lines) continue;
        let n = 0;
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            addEvidence(id, i + 1);
            n++;
          }
        }
        if (n) ranked.push({ id, n });
      }
      ranked.sort((a, b) => b.n - a.n || a.id - b.id);
      lists.push(ranked.map((r) => r.id));
      terms.push(...runs);
    } else {
      const tokens = tokenize(query).slice(0, 8);
      terms.push(...tokens);
      const expanded = new Set<string>();
      for (const t of tokens) {
        expanded.add(t);
        for (const part of splitIdent(t)) if (part.length >= 2) expanded.add(part);
      }
      // 1. identifiers (BM25, symbol weighs 3×, path 0.5×)
      if (expanded.size) {
        const match = [...expanded].map(ftsPhrase).join(" OR ");
        const rows = ftsRows(db, match, LEXICAL_CHUNK_LIMIT);
        if (rows.length) {
          const chunks = chunksById(db, rows.map((r) => r.rowid));
          const order: number[] = [];
          for (const r of rows) {
            const c = chunks.get(r.rowid);
            if (!c || !files.has(c.file_id)) continue;
            if (!lexicalChunks.has(c.file_id)) {
              lexicalChunks.set(c.file_id, []);
              order.push(c.file_id);
            }
            const list = lexicalChunks.get(c.file_id)!;
            if (list.length < RANGES_PER_FILE) list.push(c);
          }
          lists.push(order);
        }
      }
      // 2. exact substrings (trigram candidates, verified on the live file)
      const subRanked = new Map<number, number>();
      for (const t of tokens) {
        const folded = fold(t);
        if ([...folded].length < 3) continue;
        const match = trigramMatch(t);
        if (!match) continue;
        for (const id of triCandidates(db, match, SUBSTRING_FILE_LIMIT)) {
          const f = files.get(id);
          if (!f) continue;
          const lines = await cache.lines(f.path);
          if (!lines) continue;
          let n = 0;
          for (let i = 0; i < lines.length; i++) {
            if (fold(lines[i]).includes(folded)) {
              addEvidence(id, i + 1);
              n++;
            }
          }
          if (n) subRanked.set(id, (subRanked.get(id) ?? 0) + n);
        }
      }
      if (subRanked.size) lists.push([...subRanked.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((e) => e[0]));
    }

    const fused = fuseRRF(lists);
    const foldedTerms = terms.map(fold).filter((t) => t.length > 0);
    for (const [id, base] of fused) {
      const f = files.get(id)!;
      let bonus = 0;
      const p = fold(f.path);
      if (foldedTerms.some((t) => p.includes(t))) bonus += 0.05;
      const syms = lexicalChunks.get(id);
      if (syms?.some((c) => c.symbol && foldedTerms.includes(fold(c.symbol)))) bonus += 0.1;
      fused.set(id, base + bonus);
    }
    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1] || files.get(a[0])!.path.localeCompare(files.get(b[0])!.path));
    const page = sorted.slice(offset, offset + k);
    const hits: FileHit[] = [];
    for (const [id, score] of page) {
      const f = files.get(id)!;
      const lines = await cache.lines(f.path);
      if (!lines) continue; // vanished since indexing: silently dropped
      hits.push({ path: f.path, score, ranges: await rangesFor(db, id, f.path, lines, evidence.get(id), lexicalChunks.get(id), foldedTerms) });
    }
    return { hits, total: sorted.length, offset, k, truncated, note, ms: Date.now() - t0 };
  } finally {
    db.close();
  }
}

function ftsRows(db: Database, match: string, limit: number): Array<{ rowid: number; rank: number }> {
  try {
    return db
      .query<{ rowid: number; rank: number }, [string, number]>(
        "SELECT rowid, bm25(chunks_fts, 1.0, 3.0, 0.5) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(match, limit);
  } catch {
    return [];
  }
}

function triCandidates(db: Database, match: string, limit: number): number[] {
  try {
    return db
      .query<{ rowid: number }, [string, number]>("SELECT rowid FROM files_tri WHERE files_tri MATCH ? LIMIT ?")
      .all(match, limit)
      .map((r) => r.rowid);
  } catch {
    return [];
  }
}

function chunksById(db: Database, ids: number[]): Map<number, ChunkRow> {
  const out = new Map<number, ChunkRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const rows = db
      .query<ChunkRow, number[]>(`SELECT id, file_id, start, end, symbol, kind FROM code_chunks WHERE id IN (${batch.map(() => "?").join(",")})`)
      .all(...batch);
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

async function rangesFor(
  db: Database,
  fileId: number,
  path: string,
  lines: string[],
  evidence: Set<number> | undefined,
  lexical: ChunkRow[] | undefined,
  terms: string[],
): Promise<RangeHit[]> {
  const chunks = db
    .query<ChunkRow, [number]>("SELECT id, file_id, start, end, symbol, kind FROM code_chunks WHERE file_id = ? ORDER BY start")
    .all(fileId);
  const chunkOf = (n: number): ChunkRow | undefined => chunks.find((c) => n >= c.start && n <= c.end);
  const byChunk = new Map<number, { chunk: ChunkRow; lines: Set<number> }>();
  const put = (c: ChunkRow, n: number) => {
    let e = byChunk.get(c.id);
    if (!e) byChunk.set(c.id, (e = { chunk: c, lines: new Set() }));
    e.lines.add(n);
  };
  for (const n of evidence ?? []) {
    const c = chunkOf(n) ?? { id: -n, file_id: fileId, start: n, end: n, symbol: "", kind: "" };
    put(c, n);
  }
  for (const c of lexical ?? []) {
    if (byChunk.has(c.id)) continue;
    // Quote the lines of the chunk that mention a term; else its first line.
    const found: number[] = [];
    for (let n = c.start; n <= Math.min(c.end, lines.length) && found.length < LINES_PER_RANGE; n++) {
      const l = fold(lines[n - 1] ?? "");
      if (terms.some((t) => l.includes(t))) found.push(n);
    }
    if (!found.length) found.push(c.start);
    for (const n of found) put(c, n);
  }
  void path;
  return [...byChunk.values()]
    .sort((a, b) => a.chunk.start - b.chunk.start)
    .slice(0, RANGES_PER_FILE)
    .map(({ chunk, lines: ns }) => ({
      start: chunk.start,
      end: chunk.end,
      symbol: chunk.symbol,
      kind: chunk.kind,
      lines: [...ns]
        .sort((a, b) => a - b)
        .slice(0, LINES_PER_RANGE)
        .map((n) => ({ n, text: snippet(lines[n - 1] ?? "") })),
    }));
}

/** One quoted line: secret-scanned, whitespace-trimmed, cut at SNIPPET_LINE_MAX. */
export function snippet(line: string): string {
  const problem = secretProblem(line);
  if (problem) return `[BLOCKED: ${problem}]`;
  const one = line.replace(/\t/g, "  ").trimEnd();
  const chars = [...one];
  return chars.length > SNIPPET_LINE_MAX ? `${chars.slice(0, SNIPPET_LINE_MAX - 1).join("")}…` : one;
}

/**
 * rtk-style rendering: grouped by file, `Lstart-end symbol` per range, `n: text` per line,
 * bounded in files and chars, with a paging footer.
 */
export function formatSearch(res: SearchResult, opts: { maxChars?: number; maxHits?: number } = {}): string {
  const maxChars = opts.maxChars ?? FORMAT_MAX_CHARS;
  const maxHits = opts.maxHits ?? FORMAT_MAX_HITS;
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  for (const f of res.hits) {
    if (shown >= maxHits) break;
    const block = [f.path];
    for (const r of f.ranges) {
      block.push(`  L${r.start}-${r.end}${r.symbol ? ` ${r.symbol}` : ""}`);
      for (const l of r.lines) block.push(`    ${l.n}: ${l.text}`);
    }
    const text = block.join("\n");
    if (used + text.length + 1 > maxChars) {
      out.push(`…[${res.hits.length - shown} more files in this page]`);
      break;
    }
    out.push(text);
    used += text.length + 1;
    shown++;
  }
  if (!res.hits.length) out.push("no hits");
  const next = res.offset + res.hits.length;
  const footer = `[${res.total} files, offset ${res.offset}, ${next < res.total ? `next offset ${next}` : "end"}${res.truncated ? ", truncated" : ""}]`;
  out.push(res.note ? `${footer} note: ${res.note}` : footer);
  return `${out.join("\n")}\n`;
}
