import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * The one cross-process lock of this repository.
 *
 * Everything agentik keeps in SQLite is already safe: SQLite serializes writers itself. What was
 * not safe is every store kept as a JSON or Markdown file — MEMORY.md, USER.md, the project files,
 * SKILL.md, `.usage.json`, `.curator-ledger.json`, `.pinned`. They are all written the same way:
 * read the whole file, change it in memory, write it all back. Two processes that read the same
 * state both write, and the second erases the first — with both reporting success. Measured on a
 * throwaway home: 8 simultaneous `agentik memory retain` left 3 entries, and the seal matched the
 * truncated file perfectly, so `memorySnapshot` reported `sealed` and the loss was invisible while
 * the `memory_ops` journal recorded all 8. `tests/concurrent-writes.test.ts` is that measurement.
 *
 * Why a SQLite lease rather than a lock file. A lock file needs a hand-rolled protocol for the one
 * case that matters — breaking the lock of a process that was killed — and every version of that
 * protocol has a race window, because POSIX gives no compare-and-swap on a path. SQLite gives one:
 * `BEGIN IMMEDIATE` on `<home>/locks.sqlite` is a real, kernel-backed writer lock, and this
 * repository already trusts it for the review-job lease (`src/review-jobs.ts`) and for the sessions
 * store. So the lock is a row: take it in a transaction, or find out who holds it.
 *
 * The five properties this has to have, and how each is met:
 *
 *   1. It serializes between PROCESSES. `src/memory-seal.ts` has a module-level promise chain,
 *      which orders the three snapshots of one `buildContext` and does nothing at all for the
 *      second agentik process. `BEGIN IMMEDIATE` is the file lock of the OS. The module chain here
 *      (`enqueue`) is kept as a *cheap front door*: N callers inside one process queue on a promise
 *      instead of N of them polling SQLite.
 *   2. Its scope is the HOME, not the workspace. Two sessions in two different repositories share
 *      `~/.agentik/memory/MEMORY.md`; they share nothing in their working directories. The lock db
 *      therefore lives in the home, and `--agentik-home` / `--profile` isolate it exactly as they
 *      isolate the files it protects.
 *   3. A killed holder does not block anyone. Two independent recoveries: the lease expires
 *      (`LOCK_TTL_MS`, renewed every third of it by an unref'd timer while the work runs), and —
 *      the fast path — a row whose host is this host and whose pid is gone (`kill(pid, 0)` →
 *      ESRCH) is taken over on the spot, without waiting for the lease at all.
 *   4. It fails legibly instead of corrupting. If the lock cannot be taken within `waitMs`, the
 *      write throws `LockUnavailableError` naming the holder and the lock file, and nothing is
 *      written. If the lease is stolen while the work runs (a machine suspended past the TTL), the
 *      release says so on stderr rather than pretending the write was serialized.
 *   5. It costs nothing when alone. Uncontended open + `BEGIN IMMEDIATE` + commit + release is
 *      ~0.25 ms on this machine, against the several ms the surrounding read-modify-write already
 *      spends on the filesystem.
 *
 * Deadlock: the locks are never nested in code (`memory` writes never touch `skills` and the other
 * way round), and re-entering the SAME lock from inside its own critical section is free — the
 * held set travels with the async context (`AsyncLocalStorage`), which is what lets
 * `memoryRemoveEntry` hold `memory` across its backup and its call to `memoryApply`. If a future
 * caller ever needs both, take them in the order they are declared in `HOME_LOCKS`.
 */

export const HOME_LOCKS = ["memory", "skills"] as const;
export type HomeLockName = (typeof HOME_LOCKS)[number];

/** How long a lease is valid without a renewal. Short: it is the worst case after a SIGKILL. */
export const LOCK_TTL_MS = 15_000;
/** How long a writer waits for a busy lock before refusing. */
export const LOCK_WAIT_MS = 10_000;
/** Renewal cadence while the critical section runs. */
const RENEW_EVERY_MS = Math.floor(LOCK_TTL_MS / 3);
const POLL_MS = 15;

const HOST = hostname();

export interface HomeLockRow {
  name: string;
  token: string;
  pid: number;
  host: string;
  acquiredAt: number;
  expiresAt: number;
}

export class LockUnavailableError extends Error {
  readonly name = "LockUnavailableError";
  constructor(
    readonly lock: string,
    readonly holder: HomeLockRow | undefined,
    readonly waitedMs: number,
    readonly lockFile: string,
  ) {
    const who = holder
      ? `pid ${holder.pid} on ${holder.host} since ${new Date(holder.acquiredAt).toISOString()}`
      : "another process";
    super(
      `the agentik "${lock}" home lock is held by ${who}; waited ${(waitedMs / 1000).toFixed(1)}s and gave up — ` +
        `nothing was written. Let the other agentik process finish and retry; if no process holds it, ` +
        `delete ${lockFile} (it is a lock, not data).`,
    );
  }
}

export function lockDbPath(home?: string): string {
  return memoryPaths(agentikHome(home)).locks;
}

function open(home: string): Database {
  mkdirSync(home, { recursive: true });
  const db = new Database(lockDbPath(home), { create: true });
  // Two agentik processes meet here by construction. Without this, the loser of a race gets an
  // immediate SQLITE_BUSY on `BEGIN IMMEDIATE` instead of waiting the few ms the winner needs.
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`CREATE TABLE IF NOT EXISTS home_locks (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    pid INTEGER NOT NULL,
    host TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  return db;
}

interface Row {
  name: string;
  token: string;
  pid: number;
  host: string;
  acquired_at: number;
  expires_at: number;
}

function toRow(row: Row): HomeLockRow {
  return { name: row.name, token: row.token, pid: row.pid, host: row.host, acquiredAt: row.acquired_at, expiresAt: row.expires_at };
}

/**
 * Is the recorded holder still running? Only answerable for a row written on this host; a lease
 * from another machine (a shared home over NFS) can only expire. EPERM means the pid exists and
 * belongs to another user — alive.
 */
function holderAlive(row: Row): boolean {
  if (row.host !== HOST) return true;
  try {
    process.kill(row.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HomeLockOptions {
  home?: string;
  /** Lease length; the work is expected to finish well inside it, and renews itself if not. */
  ttlMs?: number;
  /** How long to wait for a busy lock before throwing. */
  waitMs?: number;
  /** Test seam: the clock. */
  now?: () => number;
  /** Test seam: retry cadence. */
  pollMs?: number;
}

interface Lease {
  db: Database;
  token: string;
  renew: ReturnType<typeof setInterval>;
}

async function acquire(home: string, name: string, opts: HomeLockOptions | undefined): Promise<Lease> {
  const ttl = opts?.ttlMs ?? LOCK_TTL_MS;
  const waitMs = opts?.waitMs ?? LOCK_WAIT_MS;
  const pollMs = opts?.pollMs ?? POLL_MS;
  const now = opts?.now ?? Date.now;
  const token = randomBytes(16).toString("hex");
  const db = open(home);
  const deadline = now() + waitMs;
  let holder: HomeLockRow | undefined;
  try {
    for (;;) {
      db.run("BEGIN IMMEDIATE");
      let taken = false;
      try {
        const row = db.query<Row, [string]>("SELECT * FROM home_locks WHERE name = ?").get(name);
        const at = now();
        // Free, expired, or abandoned by a dead process on this host: all three are ours to take,
        // and the third does not wait for the lease.
        if (!row || at >= row.expires_at || !holderAlive(row)) {
          db.run(
            `INSERT INTO home_locks (name, token, pid, host, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET token = excluded.token, pid = excluded.pid, host = excluded.host,
               acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
            [name, token, process.pid, HOST, at, at + ttl],
          );
          taken = true;
        } else {
          holder = toRow(row);
        }
        db.run("COMMIT");
      } catch (err) {
        try {
          db.run("ROLLBACK");
        } catch {
          /* the transaction is already gone */
        }
        throw err;
      }
      if (taken) break;
      if (now() >= deadline) throw new LockUnavailableError(name, holder, waitMs, lockDbPath(home));
      await sleep(pollMs);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  // A long critical section (a migration, a consolidation) must not lose its lease to the TTL,
  // and the timer must never hold the CLI's event loop open on its own.
  const renew = setInterval(() => {
    try {
      const at = (opts?.now ?? Date.now)();
      db.run("UPDATE home_locks SET expires_at = ? WHERE name = ? AND token = ?", [at + ttl, name, token]);
    } catch {
      // A renewal that fails is not fatal: release() reports a lost lease.
    }
  }, Math.max(50, Math.min(RENEW_EVERY_MS, Math.floor(ttl / 3))));
  renew.unref?.();
  return { db, token, renew };
}

function release(name: string, lease: Lease): void {
  clearInterval(lease.renew);
  try {
    const res = lease.db.run("DELETE FROM home_locks WHERE name = ? AND token = ?", [name, lease.token]);
    if (res.changes === 0) {
      // Somebody took the lease over while we were working (a suspended machine, a debugger
      // paused past the TTL). Say it: the write may have overlapped another writer's.
      console.error(`agentik: the "${name}" home lock expired while the write was running — it may have raced another agentik process`);
    }
  } catch (err) {
    console.error(`agentik: could not release the "${name}" home lock: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lease.db.close();
  }
}

// One promise chain per (home, lock) inside this process, so concurrent in-process callers queue
// instead of polling SQLite against each other. Bounded: one entry per home per lock name.
const chains = new Map<string, Promise<unknown>>();
// The locks held by the current async context. Re-entering one of them is a no-op, which is what
// lets a locked function call another locked function without deadlocking.
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Run `fn` while holding the named home lock. Re-entrant within one async context; serialized
 * against every other caller, in this process and in every other one sharing the home.
 *
 * Throws `LockUnavailableError` (and runs nothing) when the lock stays busy past `waitMs`.
 */
export function withHomeLock<T>(name: HomeLockName, fn: () => Promise<T> | T, opts?: HomeLockOptions): Promise<T> {
  const home = agentikHome(opts?.home);
  const key = `${home} ${name}`;
  const held = heldLocks.getStore();
  if (held?.has(key)) return Promise.resolve().then(fn);
  return enqueue(key, async () => {
    const lease = await acquire(home, name, opts);
    const nested = new Set(held ?? []);
    nested.add(key);
    try {
      return await heldLocks.run(nested, async () => fn());
    } finally {
      release(name, lease);
    }
  });
}

/** True when the current async context already holds this lock (assertions, tests). */
export function holdsHomeLock(name: HomeLockName, home?: string): boolean {
  return heldLocks.getStore()?.has(`${agentikHome(home)} ${name}`) ?? false;
}

/** Every lease currently recorded, live or stale. Read-only: for tests and for diagnosing. */
export async function listHomeLocks(opts?: { home?: string }): Promise<HomeLockRow[]> {
  const home = agentikHome(opts?.home);
  const db = open(home);
  try {
    return db.query<Row, []>("SELECT * FROM home_locks ORDER BY name").all().map(toRow);
  } finally {
    db.close();
  }
}

/**
 * Test seam: record a lease as if another process held it. Used to prove that a dead holder is
 * taken over at once and that a live one is waited for.
 */
export async function writeHomeLockRow(row: HomeLockRow, opts?: { home?: string }): Promise<void> {
  const db = open(agentikHome(opts?.home));
  try {
    db.run(
      `INSERT INTO home_locks (name, token, pid, host, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET token = excluded.token, pid = excluded.pid, host = excluded.host,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
      [row.name, row.token, row.pid, row.host, row.acquiredAt, row.expiresAt],
    );
  } finally {
    db.close();
  }
}

/** This host's name, as recorded in a lease (tests build rows that look local). */
export const LOCK_HOST = HOST;
