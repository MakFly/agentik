import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { chunkFile, detectLang, extractImports } from "./code-chunker.ts";
import { currentDepth } from "./depth.ts";
import { agentikHome, legacyProjectSlug, memoryPaths } from "./home.ts";
import { secretProblem } from "./memory-store.ts";

/**
 * The local code index: one sqlite file per checkout under `<home>/index/<slug>.sqlite`, a
 * CACHE of the workspace (never a trust source, never sealed) that holds NO source text:
 *
 *   code_files   path, git blob sha (dirty files hashed the same way, so a commit re-indexes
 *                nothing), size, lines, lang
 *   code_chunks  line ranges + the symbol a chunk declares + the identifiers it mentions
 *   chunks_fts   FTS5 unicode61 over (idents, symbol, path)         → BM25 on words
 *   files_tri    FTS5 trigram, contentless, detail=none, over the secret-masked file body
 *                → substring / regex CANDIDATES; the live file on disk is what gets verified
 *   code_edges   resolved imports (ts/js/py), for the repo map
 *
 * Freshness follows Cursor's model: `git ls-files -s` is the committed base, `git status` the
 * overlay of dirty files; only files whose sha moved are re-read. A directory that is not a git
 * checkout is walked (cap 20k files, stat-based pseudo sha). Two worktrees have two trees, so
 * they have two indexes (unlike project memory, which follows the main checkout).
 */

export const INDEX_SCHEMA_VERSION = 1;
export const INDEX_FILE_MAX_BYTES = 1_000_000;
export const INDEX_WALK_MAX_FILES = 20_000;
export const INDEX_COMMIT_EVERY = 500;
/** Auto-build (first use by the conductor) only under this many indexable files; `agentik index` has no cap. */
export const AUTO_INDEX_MAX_FILES = 5000;
export const AUTO_INDEX_ENV = "AGENTIK_INDEX_AUTO";
export const AUTO_INDEX_MAX_FILES_ENV = "AGENTIK_INDEX_MAX_FILES";
/** Ignore files read in this order, union of their globs (gitignore-like, no negation). */
export const IGNORE_FILES = [".agentikignore", ".cursorignore", ".aiignore"] as const;
/** Directories never indexed, in git mode too: `.agentik/` is usually untracked but not ignored. */
export const ALWAYS_SKIP_DIRS = new Set([".git", ".agentik", ".tmp", "node_modules", "dist", "build", ".next", "target", "vendor", "coverage"]);
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?)$/i;
const NOISE_NAME = /(\.lock|-lock\.json|\.min\.[a-z0-9]+)$/i;
const AVG_LINE_MAX = 500;

export interface IndexStats {
  root: string;
  slug: string;
  path: string;
  mode: "git" | "walk";
  files: number;
  chunks: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  ms: number;
  /** When the file was created or rebuilt. */
  builtAt: string;
  /** When it was last refreshed (every refresh; what `gc` reads). */
  refreshedAt: string;
  /** This refresh created the file (first build or --rebuild). */
  built: boolean;
  /** The ignore files that were found and read. */
  ignoreFiles: string[];
  /** Files git reported dirty (modified / untracked) at this refresh. */
  dirty: number;
}

export interface RefreshOptions {
  rebuild?: boolean;
  /** Called every `progressEvery` files during the write phase, and once at the end. */
  onProgress?: (done: number, total: number) => void;
  progressEvery?: number;
}

export interface IndexKey {
  root: string;
  slug: string;
}

function git(args: string[], cwd: string): string | undefined {
  try {
    const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (res.exitCode !== 0) return undefined;
    return res.stdout.toString();
  } catch {
    return undefined;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The checkout a workspace indexes: the git toplevel when the workspace IS one (real path), else
 * the directory itself (a subdirectory of a repo indexes only what is under it; a test workspace
 * under `<repo>/.tmp/` stays its own project).
 */
export function indexKey(workspace: string): IndexKey {
  const abs = resolve(workspace);
  const top = git(["rev-parse", "--show-toplevel"], abs)?.trim();
  const root = top && real(top) === real(abs) ? real(abs) : abs;
  return { root, slug: legacyProjectSlug(root) };
}

export function indexPaths(home: string, root: string): { dir: string; db: string; workspaceFile: string; slug: string } {
  const slug = legacyProjectSlug(root);
  const dir = memoryPaths(home).indexDir;
  return { dir, db: join(dir, `${slug}.sqlite`), workspaceFile: join(dir, `${slug}.workspace`), slug };
}

export function hasIndex(home: string | undefined, workspace: string): boolean {
  const h = agentikHome(home);
  const { root } = indexKey(workspace);
  const p = indexPaths(h, root);
  if (!existsSync(p.db) || !existsSync(p.workspaceFile)) return false;
  try {
    return readFileSync(p.workspaceFile, "utf8").trim() === root;
  } catch {
    return false;
  }
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS code_files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    sha TEXT NOT NULL,
    size INTEGER NOT NULL,
    lines INTEGER NOT NULL,
    lang TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS code_chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES code_files(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    symbol TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    exported INTEGER NOT NULL DEFAULT 0,
    idents TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS code_chunks_file ON code_chunks(file_id, start)",
  "CREATE INDEX IF NOT EXISTS code_chunks_symbol ON code_chunks(symbol) WHERE exported = 1",
  "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(idents, symbol, path, tokenize='unicode61 remove_diacritics 2')",
  "CREATE VIRTUAL TABLE IF NOT EXISTS files_tri USING fts5(text, content='', contentless_delete=1, detail='none', tokenize='trigram')",
  "CREATE TABLE IF NOT EXISTS code_edges (from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, PRIMARY KEY (from_id, to_id))",
];
const TABLES = ["code_edges", "files_tri", "chunks_fts", "code_chunks", "code_files", "meta"];

/** Set once, when the file is created or rebuilt (WAL and synchronous are persistent). */
function applyPragmas(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA temp_store = MEMORY");
}

function metaGet(db: Database, key: string): string | undefined {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
}

function metaSet(db: Database, key: string, value: string): void {
  db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

/**
 * Open (or create) the index of `root`. A schema version bump drops and recreates the tables;
 * an index whose recorded root is another directory is refused.
 */
export function openIndex(home: string, root: string, opts: { create?: boolean } = {}): Database | undefined {
  const p = indexPaths(home, root);
  if (!opts.create && !existsSync(p.db)) return undefined;
  if (opts.create) mkdirSync(p.dir, { recursive: true });
  const db = new Database(p.db, { create: Boolean(opts.create), readwrite: true });
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  const hasMeta = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'meta'").get()?.n ?? 0;
  if (hasMeta) {
    const version = Number(metaGet(db, "schema_version") ?? 0);
    const recorded = metaGet(db, "root");
    if (recorded && recorded !== root) {
      db.close();
      throw new Error(`index ${p.db} belongs to ${recorded}, not ${root}`);
    }
    if (version === INDEX_SCHEMA_VERSION && recorded === root) return db; // healthy: no write on open
    if (version !== INDEX_SCHEMA_VERSION) for (const t of TABLES) db.run(`DROP TABLE IF EXISTS ${t}`);
  }
  applyPragmas(db);
  for (const stmt of SCHEMA) db.run(stmt);
  metaSet(db, "schema_version", String(INDEX_SCHEMA_VERSION));
  metaSet(db, "root", root);
  if (!existsSync(p.workspaceFile)) writeFileSync(p.workspaceFile, `${root}\n`);
  return db;
}

/** git's own blob id, so a dirty file and its committed version agree once committed. */
export function blobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export interface Listing {
  mode: "git" | "walk";
  /** path → sha (undefined: dirty, hash it on read). */
  files: Map<string, string | undefined>;
  dirty: Set<string>;
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

/** Every file of the workspace with its committed sha, plus the dirty overlay from git status. */
export async function listFiles(root: string): Promise<Listing> {
  const top = git(["rev-parse", "--show-toplevel"], root)?.trim();
  if (!top) return walk(root);
  // A directory git ignores (a test workspace under <repo>/.tmp/) has no git view: walk it.
  if (git(["check-ignore", "-q", "."], root) !== undefined) return walk(root);
  const ls = git(["ls-files", "-s", "-z"], root);
  if (ls === undefined) return walk(root);
  const files = new Map<string, string | undefined>();
  for (const rec of splitZ(ls)) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(" ");
    if (mode === "120000" || mode === "160000" || stage !== "0") continue;
    files.set(rec.slice(tab + 1), sha);
  }
  const dirty = new Set<string>();
  const prefix = relative(real(top), real(root));
  const toLocal = (p: string): string | undefined => {
    if (!prefix) return p;
    return p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : undefined;
  };
  const st = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", "."], root) ?? "";
  const recs = splitZ(st);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const x = rec[0];
    const y = rec[1];
    const local = toLocal(rec.slice(3));
    if (x === "R" || x === "C") {
      const orig = toLocal(recs[++i] ?? "");
      if (orig) files.delete(orig);
    }
    if (!local) continue;
    if (x === "D" || y === "D") {
      files.delete(local);
      continue;
    }
    if (x === "!") continue;
    files.set(local, undefined);
    dirty.add(local);
  }
  return { mode: "git", files, dirty };
}

async function walk(root: string): Promise<Listing> {
  const files = new Map<string, string | undefined>();
  const glob = new Bun.Glob("**/*");
  let n = 0;
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false, dot: true })) {
    if (rel.split("/").some((seg) => ALWAYS_SKIP_DIRS.has(seg))) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    files.set(rel, `walk:${st.size}:${Math.floor(st.mtimeMs)}`);
    if (++n >= INDEX_WALK_MAX_FILES) break;
  }
  return { mode: "walk", files, dirty: new Set() };
}

export interface IgnoreMatcher {
  (path: string): boolean;
  /** The ignore files that existed and were read. */
  files?: string[];
}

/** `.agentikignore` + `.cursorignore` + `.aiignore`: one glob per line (gitignore-like, no negation), `#` comments; union. */
export async function loadIgnore(root: string): Promise<IgnoreMatcher> {
  const globs: Bun.Glob[] = [];
  const files: string[] = [];
  for (const name of IGNORE_FILES) {
    let text: string;
    try {
      text = await readFile(join(root, name), "utf8");
    } catch {
      continue;
    }
    files.push(name);
    addIgnoreGlobs(globs, text);
  }
  const matcher: IgnoreMatcher = (path) => globs.some((g) => g.match(path));
  matcher.files = files;
  return matcher;
}

function addIgnoreGlobs(globs: Bun.Glob[], text: string): void {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const pat = line.endsWith("/") ? `${line}**` : line;
    globs.push(new Bun.Glob(pat));
    if (!pat.includes("/")) globs.push(new Bun.Glob(`**/${pat}`));
    else if (!pat.startsWith("**/") && !pat.startsWith("/")) globs.push(new Bun.Glob(`**/${pat}`));
  }
}

/** Why a path is not indexed, or undefined. `bytes` enables the binary / minified checks. */
export function shouldSkip(path: string, ignore: IgnoreMatcher, bytes?: Uint8Array): string | undefined {
  const segs = path.split("/");
  if (segs.slice(0, -1).some((s) => ALWAYS_SKIP_DIRS.has(s))) return "always-skipped directory";
  const name = basename(path);
  if (SECRET_NAME.test(name)) return "secret-looking file name";
  if (NOISE_NAME.test(name)) return "lock or minified file";
  if (ignore(path)) return "ignore file";
  if (bytes) {
    if (bytes.byteLength > INDEX_FILE_MAX_BYTES) return "larger than 1 MB";
    const head = bytes.subarray(0, 8192);
    for (let i = 0; i < head.length; i++) if (head[i] === 0) return "binary";
  }
  return undefined;
}

/** The file body the trigram index sees: every secret-looking line blanked. */
export function maskSecretLines(text: string): string {
  return text
    .split("\n")
    .map((l) => (secretProblem(l) ? "" : l))
    .join("\n");
}

interface StoredFile {
  id: number;
  sha: string;
}

/**
 * Bring the index of `workspace` up to date: files whose sha moved are re-read and re-chunked,
 * vanished files are dropped, everything else is untouched. `rebuild` starts from an empty file.
 */
const refreshLocks = new Map<string, Promise<unknown>>();

export async function refreshIndex(
  home: string | undefined,
  workspace: string,
  opts: RefreshOptions = {},
): Promise<IndexStats> {
  const h = agentikHome(home);
  const { root, slug } = indexKey(workspace);
  const p = indexPaths(h, root);
  // One refresh at a time per index file inside this process; across processes the
  // busy_timeout does the waiting.
  const prev = refreshLocks.get(p.db) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => refreshNow(h, root, slug, p, opts));
  refreshLocks.set(p.db, run);
  try {
    return await run;
  } finally {
    if (refreshLocks.get(p.db) === run) refreshLocks.delete(p.db);
  }
}

async function refreshNow(
  h: string,
  root: string,
  slug: string,
  p: ReturnType<typeof indexPaths>,
  opts: RefreshOptions,
): Promise<IndexStats> {
  const t0 = Date.now();
  await mkdir(p.dir, { recursive: true });
  if (opts.rebuild) {
    for (const f of [p.db, `${p.db}-wal`, `${p.db}-shm`]) if (existsSync(f)) await unlink(f);
  }
  const db = openIndex(h, root, { create: true })!;
  try {
    const listing = await listFiles(root);
    const ignore = await loadIgnore(root);
    const readStored = (): Map<string, StoredFile> => {
      const out = new Map<string, StoredFile>();
      for (const r of db.query<{ id: number; path: string; sha: string }, []>("SELECT id, path, sha FROM code_files").all()) {
        out.set(r.path, { id: r.id, sha: r.sha });
      }
      return out;
    };
    // A first snapshot decides what to READ (phase 1, outside the lock); the write phase re-reads
    // the store under the lock, so a concurrent refresh in another process (a git hook, another
    // run) that landed in between is seen, not fought over UNIQUE(path).
    let stored = readStored();
    const fresh = stored.size === 0;
    const wanted = new Map<string, string | undefined>();
    let skipped = 0;
    for (const [path, sha] of listing.files) {
      if (shouldSkip(path, ignore)) {
        skipped++;
        continue;
      }
      wanted.set(path, sha);
    }
    const removed: string[] = [];
    for (const path of stored.keys()) if (!wanted.has(path)) removed.push(path);
    const candidates: string[] = [];
    for (const [path, sha] of wanted) {
      const old = stored.get(path);
      if (!old || sha === undefined || sha !== old.sha) candidates.push(path);
    }

    const delChunks = db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM code_chunks WHERE file_id = ?)");
    const delChunkRows = db.prepare("DELETE FROM code_chunks WHERE file_id = ?");
    const delTri = db.prepare("DELETE FROM files_tri WHERE rowid = ?");
    const delEdgesOut = db.prepare("DELETE FROM code_edges WHERE from_id = ?");
    const delEdgesAll = db.prepare("DELETE FROM code_edges WHERE from_id = ? OR to_id = ?");
    const delFile = db.prepare("DELETE FROM code_files WHERE id = ?");
    const insFile = db.query<{ id: number }, [string, string, number, number, string, number, string]>(
      "INSERT INTO code_files(path, sha, size, lines, lang, dirty, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const updFile = db.prepare("UPDATE code_files SET sha = ?, size = ?, lines = ?, lang = ?, dirty = ?, indexed_at = ? WHERE id = ?");
    const insChunk = db.query<{ id: number }, [number, string, number, number, string, string, number, string]>(
      "INSERT INTO code_chunks(file_id, path, start, end, symbol, kind, exported, idents) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const insFts = db.prepare("INSERT INTO chunks_fts(rowid, idents, symbol, path) VALUES (?, ?, ?, ?)");
    const insTri = db.prepare("INSERT INTO files_tri(rowid, text) VALUES (?, ?)");
    const insEdge = db.prepare("INSERT OR IGNORE INTO code_edges(from_id, to_id) VALUES (?, ?)");

    const now = new Date().toISOString();
    const known = new Set(wanted.keys());
    const importsOf = new Map<number, string[]>();
    let added = 0;
    let updated = 0;
    let pending = 0;
    // Phase 1 (async): read every candidate. Phase 2 (sync): one transaction with no await
    // inside, so a concurrent refresh in the same process can never deadlock on the lock.
    const reads = new Map<string, Uint8Array | undefined>();
    for (let i = 0; i < candidates.length; i += 64) {
      const batch = candidates.slice(i, i + 64);
      const bytes = await Promise.all(batch.map((path) => readWorkspaceFile(root, path)));
      batch.forEach((path, j) => reads.set(path, bytes[j]));
    }
    try {
      db.run("BEGIN IMMEDIATE");
    } catch (err) {
      throw indexBusy(err);
    }
    stored = readStored();
    removed.length = 0;
    for (const path of stored.keys()) if (!wanted.has(path)) removed.push(path);
    const progressEvery = Math.max(1, opts.progressEvery ?? 200);
    let done = 0;
    const total = candidates.length;
    const flush = () => {
      if (++pending >= INDEX_COMMIT_EVERY) {
        db.run("COMMIT");
        db.run("BEGIN IMMEDIATE");
        pending = 0;
      }
    };
    const dropStored = (path: string) => {
      const old = stored.get(path);
      if (!old) return;
      delChunks.run(old.id);
      delChunkRows.run(old.id);
      delTri.run(old.id);
      delEdgesAll.run(old.id, old.id);
      delFile.run(old.id);
      stored.delete(path);
    };
    try {
      for (const path of removed) {
        dropStored(path);
        flush();
      }
      for (const path of candidates) {
        const bytes = reads.get(path);
        const old = stored.get(path);
        if (!bytes) {
          dropStored(path);
          continue;
        }
        const why = shouldSkip(path, ignore, bytes);
        if (why) {
          skipped++;
          dropStored(path);
          continue;
        }
        const text = new TextDecoder().decode(bytes);
        const lineCount = text.split("\n").length;
        if (text.length / Math.max(1, lineCount) > AVG_LINE_MAX) {
          skipped++;
          dropStored(path);
          continue;
        }
        const sha = listing.mode === "git" ? (wanted.get(path) ?? blobSha(bytes)) : wanted.get(path)!;
        if (old && old.sha === sha) continue; // same content as indexed (dirty but unchanged, or another process got there first)
        const lang = detectLang(path);
        const dirty = listing.dirty.has(path) ? 1 : 0;
        let id: number;
        if (old) {
          delChunks.run(old.id);
          delChunkRows.run(old.id);
          delTri.run(old.id);
          delEdgesOut.run(old.id);
          updFile.run(sha, bytes.byteLength, lineCount, lang, dirty, now, old.id);
          id = old.id;
          updated++;
        } else {
          id = insFile.get(path, sha, bytes.byteLength, lineCount, lang, dirty, now)!.id;
          added++;
        }
        stored.set(path, { id, sha });
        for (const c of chunkFile(path, text, lang)) {
          const idents = c.idents.join(" ");
          const cid = insChunk.get(id, path, c.start, c.end, c.symbol, c.kind, c.exported ? 1 : 0, idents)!.id;
          insFts.run(cid, idents, c.symbol, path);
        }
        insTri.run(id, maskSecretLines(text));
        importsOf.set(id, extractImports(path, text, lang, known));
        if (++done % progressEvery === 0) opts.onProgress?.(done, total);
        flush();
      }
      opts.onProgress?.(total, total);
      // Edges of the files just indexed, against every known path (ids from the store).
      const idOf = new Map<string, number>();
      for (const [path, f] of stored) idOf.set(path, f.id);
      for (const [from, targets] of importsOf) {
        for (const t of targets) {
          const to = idOf.get(t);
          if (to !== undefined) insEdge.run(from, to);
        }
      }
      if (fresh || opts.rebuild) metaSet(db, "built_at", now);
      metaSet(db, "refreshed_at", now);
      metaSet(db, "mode", listing.mode);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    if (fresh || opts.rebuild) db.run("INSERT INTO files_tri(files_tri) VALUES ('optimize')");
    const counts = countRows(db);
    return {
      root,
      slug,
      path: p.db,
      mode: listing.mode,
      files: counts.files,
      chunks: counts.chunks,
      added,
      updated,
      removed: removed.length,
      skipped,
      ms: Date.now() - t0,
      builtAt: metaGet(db, "built_at") ?? now,
      refreshedAt: now,
      built: fresh || Boolean(opts.rebuild),
      ignoreFiles: ignore.files ?? [],
      dirty: listing.dirty.size,
    };
  } finally {
    db.close();
  }
}

/** The lock could not be taken within busy_timeout: another refresh holds the index. */
export const INDEX_BUSY = "another refresh holds the index (busy)";

function indexBusy(err: unknown): Error {
  const code = (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "SQLITE_BUSY" || /busy|locked/i.test(msg)) {
    const e = new Error(INDEX_BUSY);
    (e as { code?: string }).code = "AGENTIK_INDEX_BUSY";
    return e;
  }
  return err instanceof Error ? err : new Error(msg);
}

export function isIndexBusy(err: unknown): boolean {
  return (err as { code?: string })?.code === "AGENTIK_INDEX_BUSY";
}

function countRows(db: Database): { files: number; chunks: number } {
  return {
    files: db.query<{ n: number }, []>("SELECT count(*) AS n FROM code_files").get()?.n ?? 0,
    chunks: db.query<{ n: number }, []>("SELECT count(*) AS n FROM code_chunks").get()?.n ?? 0,
  };
}

/** The current state of an index without touching it, or undefined when there is none. */
export function indexStats(home: string | undefined, workspace: string): IndexStats | undefined {
  const h = agentikHome(home);
  const { root, slug } = indexKey(workspace);
  if (!hasIndex(h, workspace)) return undefined;
  const db = openIndex(h, root);
  if (!db) return undefined;
  try {
    const counts = countRows(db);
    return {
      root,
      slug,
      path: indexPaths(h, root).db,
      mode: (metaGet(db, "mode") as "git" | "walk") ?? "git",
      files: counts.files,
      chunks: counts.chunks,
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      ms: 0,
      builtAt: metaGet(db, "built_at") ?? "",
      refreshedAt: metaGet(db, "refreshed_at") ?? metaGet(db, "built_at") ?? "",
      built: false,
      ignoreFiles: [],
      dirty: 0,
    };
  } finally {
    db.close();
  }
}

/**
 * Read a workspace file for indexing or verification: inside the root, a regular file (no
 * symlink), at most INDEX_FILE_MAX_BYTES. Anything else is undefined.
 */
export async function readWorkspaceFile(root: string, rel: string): Promise<Uint8Array | undefined> {
  const full = resolve(root, rel);
  const relToRoot = relative(root, full);
  if (relToRoot.startsWith("..") || resolve(root, relToRoot) !== full) return undefined;
  try {
    const st = lstatSync(full);
    if (!st.isFile() || st.size > INDEX_FILE_MAX_BYTES) return undefined;
    return new Uint8Array(await readFile(full));
  } catch {
    return undefined;
  }
}

/** Human line for the CLI: `index: <slug> · 173 files · 612 chunks · +3 ~1 -0 · 0.4s · <path>`. */
export function formatIndexStats(s: IndexStats): string {
  const delta = `+${s.added} ~${s.updated} -${s.removed}`;
  return `index: ${s.slug} · ${s.mode} · ${s.files} files · ${s.chunks} chunks · ${delta}${s.skipped ? ` · ${s.skipped} skipped` : ""} · ${(s.ms / 1000).toFixed(1)}s · ${s.path}`;
}

// ---------------------------------------------------------------------------------------------
// Auto-build: the conductor builds, the worker reads
// ---------------------------------------------------------------------------------------------

/**
 * How many files an index of `root` would hold, without reading any of them: `git ls-files -c -o
 * --exclude-standard -z` streamed and stopped at `max + 1` (git status, which can take seconds on
 * a large checkout, is never run here); a walked directory is counted the same way, capped.
 */
export async function countIndexable(root: string, max: number): Promise<{ files: number; mode: "git" | "walk"; over: boolean }> {
  const ignore = await loadIgnore(root);
  const top = git(["rev-parse", "--show-toplevel"], root)?.trim();
  const gitMode = Boolean(top) && git(["check-ignore", "-q", "."], root) === undefined;
  let files = 0;
  if (gitMode) {
    const proc = Bun.spawn(["git", "ls-files", "-c", "-o", "--exclude-standard", "-z"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const decoder = new TextDecoder();
    let rest = "";
    let over = false;
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true });
      let nul = rest.indexOf("\0");
      while (nul >= 0) {
        const path = rest.slice(0, nul);
        rest = rest.slice(nul + 1);
        if (path && !shouldSkip(path, ignore)) files++;
        if (files > max) {
          over = true;
          break;
        }
        nul = rest.indexOf("\0");
      }
      if (over) break;
    }
    if (over) proc.kill();
    await proc.exited;
    return { files, mode: "git", over };
  }
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true, followSymlinks: false, dot: true })) {
    if (shouldSkip(rel, ignore)) continue;
    if (++files > max) return { files, mode: "walk", over: true };
    if (files >= INDEX_WALK_MAX_FILES) break;
  }
  return { files, mode: "walk", over: false };
}

export type EnsureReason = "disabled" | "depth" | "too_big" | "empty" | "failed";

export interface EnsureResult {
  stats?: IndexStats;
  /** This call created the index. */
  built: boolean;
  reason?: EnsureReason;
  /** Indexable files counted when the cap refused the build. */
  files?: number;
  ms: number;
}

export interface EnsureOptions {
  /** Build when absent (default: env AGENTIK_INDEX_AUTO !== "0"). */
  auto?: boolean;
  /** Default AUTO_INDEX_MAX_FILES, overridable with env AGENTIK_INDEX_MAX_FILES. */
  maxFiles?: number;
  /** Environment to read depth and the AGENTIK_INDEX_* variables from (tests). */
  env?: NodeJS.ProcessEnv;
  /** Where the "indexing …" and hint lines go (stderr in the CLI). */
  log?: (line: string) => void;
  onProgress?: (done: number, total: number) => void;
}

const hinted = new Set<string>();

/** Test hook: forget which (root, reason) hints were already printed in this process. */
export function resetIndexHints(): void {
  hinted.clear();
}

/**
 * The index of `workspace`, refreshed — or built on first use, à la Cursor, when the caller is
 * the conductor (depth 0), auto-build is not disabled, and the checkout is under the file cap.
 * Otherwise `reason` says why, and ONE hint per (root, reason) is logged in this process. A
 * failed build is one line too; the caller carries on without an index. Never throws.
 */
export async function ensureIndex(home: string | undefined, workspace: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const t0 = Date.now();
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const { root } = indexKey(workspace);
  const hint = (reason: EnsureReason, line: string) => {
    const key = `${root}:${reason}`;
    if (!hinted.has(key)) {
      hinted.add(key);
      log(line);
    }
  };
  if (hasIndex(home, workspace)) {
    try {
      const stats = await refreshIndex(home, workspace, { onProgress: opts.onProgress });
      return { stats, built: false, ms: Date.now() - t0 };
    } catch (err) {
      log(`agentik: code index not refreshed: ${err instanceof Error ? err.message : String(err)}`);
      return { built: false, reason: "failed", ms: Date.now() - t0 };
    }
  }
  const auto = opts.auto ?? env[AUTO_INDEX_ENV] !== "0";
  if (!auto) return { built: false, reason: "disabled", ms: Date.now() - t0 };
  if (currentDepth(env) >= 1) {
    hint("depth", `agentik: no code index for ${root} — a worker never builds one; the conductor runs: agentik index --workspace ${root}`);
    return { built: false, reason: "depth", ms: Date.now() - t0 };
  }
  const envMax = Number.parseInt(env[AUTO_INDEX_MAX_FILES_ENV] ?? "", 10);
  const maxFiles = opts.maxFiles ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : AUTO_INDEX_MAX_FILES);
  let count: Awaited<ReturnType<typeof countIndexable>>;
  try {
    count = await countIndexable(root, maxFiles);
  } catch (err) {
    log(`agentik: could not size ${root} for indexing: ${err instanceof Error ? err.message : String(err)}`);
    return { built: false, reason: "failed", ms: Date.now() - t0 };
  }
  if (count.files === 0) return { built: false, reason: "empty", files: 0, ms: Date.now() - t0 }; // nothing to index, nothing to say
  if (count.over) {
    hint("too_big", `agentik: no code index for ${root} (${count.files}+ files > ${maxFiles}) — run: agentik index --workspace ${root}, or ${AUTO_INDEX_ENV}=0 to silence`);
    return { built: false, reason: "too_big", files: count.files, ms: Date.now() - t0 };
  }
  log(`agentik: indexing ${root} (${count.files} files)…`);
  try {
    const stats = await refreshIndex(home, workspace, { onProgress: opts.onProgress });
    log(formatIndexStats(stats));
    return { stats, built: true, files: count.files, ms: Date.now() - t0 };
  } catch (err) {
    log(`agentik: code index not built: ${err instanceof Error ? err.message : String(err)}`);
    return { built: false, reason: "failed", files: count.files, ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Watch: a foreground polling loop (no daemon installed, no inotify)
// ---------------------------------------------------------------------------------------------

export const WATCH_INTERVAL_MS = 5000;
export const WATCH_INTERVAL_MIN_MS = 1000;

export interface WatchOptions {
  signal: AbortSignal;
  intervalMs?: number;
  log: (line: string) => void;
  /** Injected by tests: resolve at once. Default: a timer that the signal cancels. */
  sleep?: (ms: number) => Promise<void>;
  onTick?: (stats: IndexStats | undefined) => void;
}

/**
 * Refresh the index of `workspace` every `intervalMs` until the signal aborts; log only when
 * something changed. Polling `git status` is the detector (a recursive fs.watch costs one
 * inotify watch per directory and `node_modules` blows the limit); an edit to a clean tree
 * touches no `.git/` file, so there is no cheaper pre-check that is also correct. The effective
 * interval is max(interval, 3 × the last refresh), never under WATCH_INTERVAL_MIN_MS. The first
 * tick builds the index when there is none (the human asked, no cap).
 */
export async function watchIndex(home: string | undefined, workspace: string, opts: WatchOptions): Promise<{ ticks: number; changed: number }> {
  const interval = Math.max(WATCH_INTERVAL_MIN_MS, opts.intervalMs ?? WATCH_INTERVAL_MS);
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      }));
  let ticks = 0;
  let changed = 0;
  let lastMs = 0;
  while (!opts.signal.aborted) {
    ticks++;
    let stats: IndexStats | undefined;
    const t = Date.now();
    try {
      stats = await refreshIndex(home, workspace);
    } catch (err) {
      opts.log(`agentik index --watch: ${err instanceof Error ? err.message : String(err)}`);
    }
    lastMs = Date.now() - t;
    if (stats && (stats.built || stats.added + stats.updated + stats.removed > 0)) {
      changed++;
      opts.log(formatIndexStats(stats));
    }
    opts.onTick?.(stats);
    if (opts.signal.aborted) break;
    await sleep(Math.max(interval, 3 * lastMs));
  }
  return { ticks, changed };
}

// ---------------------------------------------------------------------------------------------
// Registry: every index of a home (read-only listing; rm / gc are the human's pen)
// ---------------------------------------------------------------------------------------------

export const INDEX_GC_UNUSED_DAYS = 90;

export interface IndexEntry {
  slug: string;
  db: string;
  workspaceFile: string;
  root?: string;
  rootExists: boolean;
  /** db + wal + shm on disk. */
  bytes: number;
  files?: number;
  chunks?: number;
  builtAt?: string;
  refreshedAt?: string;
  /** Why this entry could not be read; such an entry is never garbage-collected. */
  problem?: string;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Every `<slug>.workspace` of the home, opened READ-ONLY (never `openIndex`, which may rewrite a stale schema). */
export async function listIndexes(home?: string): Promise<IndexEntry[]> {
  const dir = memoryPaths(agentikHome(home)).indexDir;
  if (!existsSync(dir)) return [];
  const out: IndexEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".workspace")) continue;
    const slug = name.slice(0, -".workspace".length);
    const db = join(dir, `${slug}.sqlite`);
    const workspaceFile = join(dir, name);
    const entry: IndexEntry = { slug, db, workspaceFile, rootExists: false, bytes: sizeOf(db) + sizeOf(`${db}-wal`) + sizeOf(`${db}-shm`) };
    try {
      entry.root = readFileSync(workspaceFile, "utf8").trim() || undefined;
    } catch (err) {
      entry.problem = `unreadable .workspace: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (entry.root) entry.rootExists = existsSync(entry.root);
    if (!existsSync(db)) {
      entry.problem ??= "index file missing";
      out.push(entry);
      continue;
    }
    try {
      const ro = new Database(db, { readonly: true });
      try {
        const meta = new Map(ro.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
        entry.builtAt = meta.get("built_at");
        entry.refreshedAt = meta.get("refreshed_at") ?? meta.get("built_at");
        const c = countRows(ro);
        entry.files = c.files;
        entry.chunks = c.chunks;
      } finally {
        ro.close();
      }
    } catch (err) {
      entry.problem ??= `unreadable index: ${err instanceof Error ? err.message : String(err)}`;
    }
    out.push(entry);
  }
  return out;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Delete one index: `.workspace` first (so `hasIndex` turns false atomically for new openers),
 * then the db, its WAL and shm; a reader that already has the file open keeps its fd. Returns
 * the paths deleted; an unknown slug is an error.
 */
export async function removeIndex(home: string | undefined, target: { slug: string } | { workspace: string }): Promise<string[]> {
  const h = agentikHome(home);
  const slug = "slug" in target ? target.slug : indexPaths(h, indexKey(target.workspace).root).slug;
  if (!SLUG_RE.test(slug)) throw new Error(`invalid index name: ${slug}`);
  const dir = memoryPaths(h).indexDir;
  const db = join(dir, `${slug}.sqlite`);
  const paths = [join(dir, `${slug}.workspace`), db, `${db}-wal`, `${db}-shm`];
  const deleted: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    await unlink(p);
    deleted.push(p);
  }
  if (!deleted.length) throw new Error(`no index named ${slug}`);
  return deleted;
}

/** Drop the indexes whose root is gone or that were not refreshed for `unusedDays`; a problem entry is only reported. */
export async function gcIndexes(
  home: string | undefined,
  opts: { dryRun?: boolean; unusedDays?: number; now?: Date } = {},
): Promise<{ removed: IndexEntry[]; kept: IndexEntry[]; problems: IndexEntry[] }> {
  const days = opts.unusedDays ?? INDEX_GC_UNUSED_DAYS;
  const now = (opts.now ?? new Date()).getTime();
  const removed: IndexEntry[] = [];
  const kept: IndexEntry[] = [];
  const problems: IndexEntry[] = [];
  for (const e of await listIndexes(home)) {
    if (e.problem) {
      problems.push(e);
      continue;
    }
    const age = e.refreshedAt ? (now - Date.parse(e.refreshedAt)) / 86_400_000 : Number.POSITIVE_INFINITY;
    const stale = !e.rootExists || age > days;
    if (!stale) {
      kept.push(e);
      continue;
    }
    if (!opts.dryRun) await removeIndex(home, { slug: e.slug });
    removed.push(e);
  }
  return { removed, kept, problems };
}

/** One line per index for `agentik index ls`. */
export function formatIndexEntry(e: IndexEntry): string {
  const kb = `${Math.round(e.bytes / 1024)}k`;
  if (e.problem) return `${e.slug} · ${kb} · ${e.problem}${e.root ? ` · ${e.root}` : ""}`;
  const when = e.refreshedAt ? e.refreshedAt.slice(0, 16).replace("T", " ") : "?";
  return `${e.slug} · ${e.files} files · ${e.chunks} chunks · ${kb} · refreshed ${when} · ${e.root}${e.rootExists ? "" : " (missing)"}`;
}
