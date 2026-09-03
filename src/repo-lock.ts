import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

/**
 * The repository lock — and the fast-forward merge that is the reason it exists.
 *
 * THE BUG (measured on git 2.53.0, `tests/repo-lock.test.ts` reproduces it with real processes).
 * Three concurrent `git merge --ff-only` from ONE checkout:
 *
 *     1:128  fatal: Not possible to fast-forward, aborting.
 *     2:128  cannot lock ref 'HEAD': is at 0a7b3ab... but expected 1be7ff7...
 *            Updating 1be7ff7..2e89485   Fast-forward     <- the TREE was already updated
 *     3:0    Updating 1be7ff7..0a7b3ab   Fast-forward
 *
 * git updates the working tree and the index FIRST and the ref LAST, and it restores NOTHING when
 * the ref update loses the race. The loser leaves STAGED files from a branch that was never merged
 * in the main checkout: `git status --short` shows `A p2.txt` while `develop` does not contain it,
 * and the next commit carries them. `--ff-only` protects against divergence, not against a race.
 * This is the incident the owner lived through; neither git's documentation nor the editors' cover it.
 *
 * WHY THE SCOPE IS THE REPOSITORY, NOT THE HOME NOR THE WORKING DIRECTORY. The resource being
 * corrupted is the shared ref (`HEAD` of the main checkout) and the index that goes with it. Every
 * linked worktree of a repository shares them, and two agentik profiles (`--agentik-home`,
 * `--profile`) working on the same repository must still serialize — so the home is the wrong
 * anchor, and so is `process.cwd()`. The right anchor is what git itself calls the common dir:
 * `git rev-parse --path-format=absolute --git-common-dir`, which every worktree of a repository
 * resolves to the SAME path (`src/index-hooks.ts` already asks git the same kind of question for
 * `--git-path hooks`). The lock therefore lives at `<git-common-dir>/agentik-repo-lock.sqlite`,
 * next to the hooks, and is shared by construction.
 *
 * WHY NOT THE `flock` BINARY. `/usr/bin/flock` (util-linux 2.41.3) is on this machine and its
 * lock dies with the process, which is genuinely the property we want. It is not used, for four
 * reasons, in order of weight:
 *   1. A missing binary would fail OPEN. macOS ships no util-linux `flock`; the BSD one has a
 *      different interface. The fallback of "no flock, no lock" is silently the corruption this
 *      module exists to prevent — the one failure mode we cannot accept.
 *   2. `-w` takes no fraction: `flock -w 0.5` answers `flock: invalid timeout value: '0.5'`
 *      (measured). One second is the smallest wait AND the smallest test, and a caller that wants
 *      to fail fast cannot.
 *   3. Holding a `flock` across a TypeScript critical section means keeping a child alive to own
 *      the fd (`flock file sh -c 'echo ok; exec cat'`) and killing it on release: a second process
 *      tree, a shell, and an EOF protocol, to replace 40 lines.
 *   4. This repository already has ONE lock idiom — a row taken in `BEGIN IMMEDIATE`, used by
 *      `src/home-lock.ts`, `src/review-jobs.ts` and the sessions store. SQLite's writer lock is
 *      kernel-backed and gives the compare-and-swap a lock *file* does not have. Reusing it means
 *      one thing to reason about, not two.
 * The one property `flock` gives for free — release on death — is bought here the same way
 * `home-lock.ts` buys it: a short lease plus `kill(pid, 0)`, so a SIGKILLed holder is taken over
 * at once instead of after the TTL.
 *
 * WHY IT IS NOT `src/home-lock.ts`. Different resource, different scope, different lifetime. The
 * home lock serializes read-modify-write on the FILES of `~/.agentik` (MEMORY.md, SKILL.md, the
 * ledgers); its scope is the home and it is taken for milliseconds deep inside a call stack. This
 * lock serializes an operation on a REPOSITORY's ref and index; its scope is the git common dir
 * and it wraps a whole coarse operation. A single lock covering both would either serialize two
 * unrelated repositories through one home, or fail to serialize two homes over one repository.
 * ORDER, if a future caller ever needs both: take the REPO lock first, then the home lock — outer
 * to inner, coarse to fine, and never the other way round. Nothing takes both today.
 *
 * NEUTRAL WHEN ALONE, LEGIBLE WHEN NOT: an uncontended acquire is one SQLite transaction on a file
 * inside `.git/`; a busy lock is refused by name after `waitMs` (`RepoLockUnavailableError`) and
 * NOTHING is run. There is no unbounded wait anywhere in this module.
 *
 * WHAT IT DOES NOT PROTECT: a human's own `git merge` in a terminal, or any git client that does
 * not take this lock. The lock makes agentik's own concurrency safe; it cannot make git atomic.
 */

/** File name of the lock, inside the git common dir (`.git/` of the main checkout). */
export const REPO_LOCK_FILE = "agentik-repo-lock.sqlite";
/** One logical lock per repository; named so a second one could be added without a migration. */
export const REPO_LOCK_NAME = "repo";
/** Lease length. Longer than the home lock's: a merge of a large tree is slower than a file write. */
export const REPO_LOCK_TTL_MS = 60_000;
/** How long a caller waits for a busy repository before refusing. */
export const REPO_LOCK_WAIT_MS = 30_000;
const POLL_MS = 25;

const HOST = hostname();

export interface RepoLockRow {
  name: string;
  token: string;
  pid: number;
  host: string;
  acquiredAt: number;
  expiresAt: number;
}

export class RepoLockUnavailableError extends Error {
  readonly name = "RepoLockUnavailableError";
  constructor(
    readonly holder: RepoLockRow | undefined,
    readonly waitedMs: number,
    readonly lockFile: string,
  ) {
    const who = holder
      ? `pid ${holder.pid} on ${holder.host} since ${new Date(holder.acquiredAt).toISOString()}`
      : "another process";
    super(
      `the agentik repository lock is held by ${who}; waited ${(waitedMs / 1000).toFixed(1)}s and gave up — ` +
        `nothing was run. Let the other agentik process finish and retry; if no process holds it, ` +
        `delete ${lockFile} (it is a lock, not data).`,
    );
  }
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string; code: number } {
  try {
    // GIT_OPTIONAL_LOCKS=0 like `src/artifacts.ts` and `src/workspace.ts`: reading the state of a
    // repository must never take a lock a concurrent run is waiting on. Only reads come here.
    const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return { ok: res.exitCode === 0, out: res.stdout.toString().trim(), err: res.stderr.toString().trim(), code: res.exitCode ?? 1 };
  } catch (err) {
    return { ok: false, out: "", err: err instanceof Error ? err.message : String(err), code: 1 };
  }
}

/**
 * The directory every worktree of this repository shares (`.git` of the main checkout, or the
 * bare repository). `undefined` when the path is not a git checkout at all.
 */
export function gitCommonDir(workspace: string): string | undefined {
  const res = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspace);
  return res.ok && res.out !== "" ? res.out : undefined;
}

/** Where the lock of this repository lives, or why there is none. */
export function repoLockPath(workspace: string): { path: string } | { refused: string } {
  const common = gitCommonDir(workspace);
  if (!common) return { refused: `${workspace} is not a git checkout` };
  return { path: join(common, REPO_LOCK_FILE) };
}

interface Row {
  name: string;
  token: string;
  pid: number;
  host: string;
  acquired_at: number;
  expires_at: number;
}

function toRow(row: Row): RepoLockRow {
  return { name: row.name, token: row.token, pid: row.pid, host: row.host, acquiredAt: row.acquired_at, expiresAt: row.expires_at };
}

function open(lockFile: string): Database {
  mkdirSync(dirname(lockFile), { recursive: true });
  const db = new Database(lockFile, { create: true });
  // Two agentik processes meet here by construction; without this the loser of a race gets an
  // immediate SQLITE_BUSY instead of waiting the few ms the winner needs.
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`CREATE TABLE IF NOT EXISTS repo_locks (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    pid INTEGER NOT NULL,
    host TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  return db;
}

/** Is the recorded holder still running? Only answerable on the host that wrote the row. */
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

export interface RepoLockOptions {
  /** Lease length; the section renews it while it runs. */
  ttlMs?: number;
  /** How long to wait for a busy repository before throwing. */
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

async function acquire(lockFile: string, opts: RepoLockOptions | undefined): Promise<Lease> {
  const ttl = opts?.ttlMs ?? REPO_LOCK_TTL_MS;
  const waitMs = opts?.waitMs ?? REPO_LOCK_WAIT_MS;
  const pollMs = opts?.pollMs ?? POLL_MS;
  const now = opts?.now ?? Date.now;
  const token = randomBytes(16).toString("hex");
  const db = open(lockFile);
  const deadline = now() + waitMs;
  let holder: RepoLockRow | undefined;
  try {
    for (;;) {
      db.run("BEGIN IMMEDIATE");
      let taken = false;
      try {
        const row = db.query<Row, [string]>("SELECT * FROM repo_locks WHERE name = ?").get(REPO_LOCK_NAME);
        const at = now();
        // Free, expired, or abandoned by a dead process on this host: all three are ours to take,
        // and the third does not wait out the lease.
        if (!row || at >= row.expires_at || !holderAlive(row)) {
          db.run(
            `INSERT INTO repo_locks (name, token, pid, host, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET token = excluded.token, pid = excluded.pid, host = excluded.host,
               acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
            [REPO_LOCK_NAME, token, process.pid, HOST, at, at + ttl],
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
      if (now() >= deadline) throw new RepoLockUnavailableError(holder, waitMs, lockFile);
      await sleep(pollMs);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  const renew = setInterval(() => {
    try {
      const at = (opts?.now ?? Date.now)();
      db.run("UPDATE repo_locks SET expires_at = ? WHERE name = ? AND token = ?", [at + ttl, REPO_LOCK_NAME, token]);
    } catch {
      // A failed renewal is not fatal: release() reports a lost lease.
    }
  }, Math.max(50, Math.floor((opts?.ttlMs ?? REPO_LOCK_TTL_MS) / 3)));
  renew.unref?.();
  return { db, token, renew };
}

function release(lockFile: string, lease: Lease): void {
  clearInterval(lease.renew);
  try {
    const res = lease.db.run("DELETE FROM repo_locks WHERE name = ? AND token = ?", [REPO_LOCK_NAME, lease.token]);
    if (res.changes === 0) {
      console.error(`agentik: the repository lock (${lockFile}) expired while the work was running — it may have raced another agentik process`);
    }
  } catch (err) {
    console.error(`agentik: could not release the repository lock: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lease.db.close();
  }
}

// One promise chain per lock file inside this process, so in-process callers queue instead of
// polling SQLite against each other. Bounded: one entry per repository.
const chains = new Map<string, Promise<unknown>>();
// The lock files held by the current async context; re-entering one is a no-op.
const held = new AsyncLocalStorage<ReadonlySet<string>>();

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
 * Run `fn` while holding the lock of the repository `workspace` belongs to. Re-entrant within one
 * async context, serialized against every other caller in this process and in every other one.
 *
 * Throws `RepoLockUnavailableError` — and runs nothing — when the lock stays busy past `waitMs`.
 * Throws when `workspace` is not a git checkout: there is no repository to serialize on, and
 * pretending to lock would be worse than saying so.
 */
export function withRepoLock<T>(workspace: string, fn: () => Promise<T> | T, opts?: RepoLockOptions): Promise<T> {
  const found = repoLockPath(workspace);
  if ("refused" in found) return Promise.reject(new Error(`agentik repository lock: ${found.refused}`));
  const lockFile = found.path;
  const store = held.getStore();
  if (store?.has(lockFile)) return Promise.resolve().then(fn);
  return enqueue(lockFile, async () => {
    const lease = await acquire(lockFile, opts);
    const nested = new Set(store ?? []);
    nested.add(lockFile);
    try {
      return await held.run(nested, async () => fn());
    } finally {
      release(lockFile, lease);
    }
  });
}

/** True when the current async context already holds this repository's lock. */
export function holdsRepoLock(workspace: string): boolean {
  const found = repoLockPath(workspace);
  return "path" in found ? (held.getStore()?.has(found.path) ?? false) : false;
}

/** Every lease currently recorded for this repository, live or stale. Read-only: tests, diagnosis. */
export function listRepoLocks(workspace: string): RepoLockRow[] {
  const found = repoLockPath(workspace);
  if ("refused" in found) return [];
  const db = open(found.path);
  try {
    return db.query<Row, []>("SELECT * FROM repo_locks ORDER BY name").all().map(toRow);
  } finally {
    db.close();
  }
}

/** Test seam: record a lease as if another process held it. */
export function writeRepoLockRow(workspace: string, row: RepoLockRow): void {
  const found = repoLockPath(workspace);
  if ("refused" in found) throw new Error(`agentik repository lock: ${found.refused}`);
  const db = open(found.path);
  try {
    db.run(
      `INSERT INTO repo_locks (name, token, pid, host, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET token = excluded.token, pid = excluded.pid, host = excluded.host,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
      [row.name, row.token, row.pid, row.host, row.acquiredAt, row.expiresAt],
    );
  } finally {
    db.close();
  }
}

/** This host's name, as recorded in a lease (tests build rows that look local). */
export const REPO_LOCK_HOST = HOST;

// ---------------------------------------------------------------------------
// The fast-forward merge, the only operation that needs the lock today.
// ---------------------------------------------------------------------------

export interface FastForwardOptions extends RepoLockOptions {
  /** Any path inside the checkout that must move (the main checkout for a `--ff-only` merge). */
  workspace: string;
  /** What to fast-forward onto: a branch, a tag, a sha — whatever `git merge --ff-only` accepts. */
  ref: string;
}

export type FastForwardFailure =
  /** `workspace` is not a git checkout. */
  | "not_a_repo"
  /** Another process holds the repository lock; nothing was run. */
  | "locked"
  /** git refused the merge (diverged branch, conflicting local change, unknown ref…). */
  | "merge_failed"
  /** The working tree / index moved under us while the merge ran: someone else raced this repository. */
  | "raced";

export interface FastForwardResult {
  ok: boolean;
  /** Why it did not happen. Absent on success. */
  failure?: FastForwardFailure;
  /** One line, safe to print. */
  reason?: string;
  /** HEAD before and after (the same sha when the ref was already an ancestor). */
  from?: string;
  to?: string;
  /** True when git had nothing to do ("Already up to date"). */
  alreadyUpToDate?: boolean;
  /** `git status --porcelain` entries seen before / after the merge. */
  statusBefore?: string[];
  statusAfter?: string[];
  /** git's own output, trimmed, when it failed. */
  gitError?: string;
}

/**
 * The whole checkout, not `-- .`: a merge moves every path, so the witness must cover every path.
 * Raw, never trimmed — a porcelain entry starts with its two status columns, and ` M src/x.ts`
 * loses its meaning (and stops comparing equal to itself) the moment the leading space is cut.
 */
function porcelain(workspace: string): string[] | undefined {
  try {
    const res = Bun.spawnSync(["git", "status", "--porcelain", "-z", "--untracked-files=all"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (res.exitCode !== 0) return undefined;
    return res.stdout.toString().split("\0").filter((e) => e.length > 0);
  } catch {
    return undefined;
  }
}

function head(workspace: string): string | undefined {
  const res = git(["rev-parse", "HEAD"], workspace);
  return res.ok ? res.out : undefined;
}

/**
 * `git merge --ff-only <ref>` under the repository lock, with a witness on both sides.
 *
 * The lock removes the race between agentik processes. The witness catches what the lock cannot:
 * git's own non-atomicity, exercised by anything that does NOT take this lock (the human's shell,
 * an editor, a hook). `git status --porcelain` is read before and after; a merge that succeeded
 * leaves the dirty set exactly as it found it (the files it brings in are tracked and clean), so
 * ANY difference means the index moved under us — the exact shape of the incident, where the loser
 * of the ref race kept staged files from a branch that was never merged. That is reported as
 * `raced`, with the entries that appeared, instead of being left for the next `git commit`.
 *
 * Never throws: every expected failure is a result. There is no caller in the tree yet — this is
 * the primitive and its test.
 */
export async function fastForwardMerge(opts: FastForwardOptions): Promise<FastForwardResult> {
  const { workspace, ref } = opts;
  const found = repoLockPath(workspace);
  if ("refused" in found) return { ok: false, failure: "not_a_repo", reason: found.refused };
  try {
    return await withRepoLock(
      workspace,
      async () => {
        const statusBefore = porcelain(workspace);
        const from = head(workspace);
        const proc = Bun.spawn(["git", "merge", "--ff-only", ref], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        const statusAfter = porcelain(workspace);
        const to = head(workspace);
        const appeared = statusDelta(statusBefore, statusAfter);
        if (code !== 0) {
          // git refused. It normally refuses BEFORE touching anything, but the incident proves it
          // can also fail after updating the tree — so the delta is reported either way.
          return {
            ok: false,
            failure: appeared.length ? ("raced" as const) : ("merge_failed" as const),
            reason: appeared.length
              ? `git merge --ff-only ${ref} failed AND left the index changed (${appeared.join(", ")}): another process raced this repository — inspect before committing`
              : `git merge --ff-only ${ref} failed: ${gitProblem(err || out) || `exit ${code}`}`,
            from,
            to,
            statusBefore,
            statusAfter,
            gitError: (err || out).trim(),
          };
        }
        if (appeared.length) {
          return {
            ok: false,
            failure: "raced" as const,
            reason: `git merge --ff-only ${ref} reported success but the index moved during it (${appeared.join(", ")}): another process wrote this repository — inspect before committing`,
            from,
            to,
            statusBefore,
            statusAfter,
          };
        }
        return {
          ok: true,
          from,
          to,
          alreadyUpToDate: /already up to date/i.test(out),
          statusBefore,
          statusAfter,
        };
      },
      opts,
    );
  } catch (err) {
    if (err instanceof RepoLockUnavailableError) return { ok: false, failure: "locked", reason: err.message };
    return { ok: false, failure: "merge_failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Porcelain entries present after and not before. Both sides `undefined` (git unreadable) is NOT a
 * delta: absence of a witness is not evidence of a race, and refusing on it would make every
 * non-git path a failure.
 */
function statusDelta(before: string[] | undefined, after: string[] | undefined): string[] {
  if (!before || !after) return [];
  const seen = new Set(before);
  return after.filter((entry) => !seen.has(entry));
}

/**
 * git's real complaint, not its first line of advice: a refused fast-forward starts with four
 * `hint:` lines and says `fatal: Not possible to fast-forward, aborting.` at the end.
 */
function gitProblem(text: string): string {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error):/.test(l));
  const useful = fatal ?? lines.find((l) => !/^hint:/.test(l)) ?? lines[0] ?? "";
  return useful.slice(0, 200);
}
