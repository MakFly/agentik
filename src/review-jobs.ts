import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { openSessionsDb } from "./sessions.ts";
import { secretProblem } from "./memory-store.ts";
import { maskLines } from "./tool-results.ts";
import { boundTranscript, type ReviewOutcome } from "./reviewer.ts";

/** A short lease makes an interrupted detached runner recoverable without a daemon. */
export const REVIEW_JOB_LEASE_MS = 120_000;

export type ReviewJobStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface ReviewJob {
  id: string;
  sessionId: number;
  goal: string;
  workspace: string;
  profile: string;
  backend?: string;
  transcript: string;
  maxIterations?: number;
  stepTimeoutS?: number;
  status: ReviewJobStatus;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
  outcome?: StoredReviewOutcome;
  error?: string;
}

/** The useful audit result, deliberately excluding model tool traces and transcript contents. */
export type StoredReviewOutcome = Pick<ReviewOutcome,
  "iterations" | "memoryOps" | "userOps" | "projectOps" | "skillOps" | "incidentOps" | "refused" | "consolidationFailures" | "stoppedBecause" | "summary">;

export interface ClaimedReviewJob extends ReviewJob {
  leaseToken: string;
}

interface Row {
  id: string;
  session_id: number;
  goal: string;
  workspace: string;
  profile: string;
  backend: string | null;
  transcript: string;
  max_iterations: number | null;
  step_timeout_s: number | null;
  status: ReviewJobStatus;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_expires_at: string | null;
  lease_token: string | null;
  outcome: string | null;
  error: string | null;
}

function init(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS review_jobs (
    id TEXT PRIMARY KEY,
    session_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    workspace TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT '',
    backend TEXT,
    transcript TEXT NOT NULL,
    max_iterations INTEGER,
    step_timeout_s INTEGER,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    lease_expires_at TEXT,
    lease_token TEXT,
    outcome TEXT,
    error TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS review_jobs_queue ON review_jobs(status, created_at)");
}

async function withDb<T>(home: string, fn: (db: Database) => T): Promise<T> {
  const db = await openSessionsDb(home);
  try {
    // A detached runner and the foreground command can meet here. Give the short transaction a
    // moment rather than reporting a false failure due to SQLite's default immediate BUSY.
    db.run("PRAGMA busy_timeout = 5000");
    init(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function id(): string {
  return `review-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Keep the durable payload bounded and never copy a credential from a transient transcript. */
export function snapshotTranscript(transcript: string): string {
  const bounded = boundTranscript(transcript);
  const secret = secretProblem(bounded);
  // A private-key block spans lines; redact the whole payload rather than leaving its body behind.
  return secret ? `[BLOCKED: ${secret}]` : maskLines(bounded);
}

function textForDisk(text: string): string {
  const secret = secretProblem(text);
  return secret ? `[BLOCKED: ${secret}]` : maskLines(text).slice(0, 2000);
}

function fromRow(row: Row): ReviewJob {
  let outcome: StoredReviewOutcome | undefined;
  if (row.outcome) {
    try {
      outcome = JSON.parse(row.outcome) as StoredReviewOutcome;
    } catch {
      // A malformed audit field must not hide a recoverable job.
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    goal: row.goal,
    workspace: row.workspace,
    profile: row.profile,
    backend: row.backend ?? undefined,
    transcript: row.transcript,
    maxIterations: row.max_iterations ?? undefined,
    stepTimeoutS: row.step_timeout_s ?? undefined,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    outcome,
    error: row.error ?? undefined,
  };
}

export async function enqueueReviewJob(input: {
  sessionId: number;
  goal: string;
  workspace: string;
  profile?: string;
  backend?: string;
  transcript: string;
  maxIterations?: number;
  stepTimeoutS?: number;
}, opts: { home: string }): Promise<ReviewJob> {
  return withDb(opts.home, (db) => {
    const now = new Date().toISOString();
    const job: ReviewJob = {
      id: id(),
      sessionId: input.sessionId,
      goal: input.goal,
      workspace: input.workspace,
      profile: input.profile ?? "default",
      backend: input.backend,
      transcript: snapshotTranscript(input.transcript),
      maxIterations: input.maxIterations,
      stepTimeoutS: input.stepTimeoutS,
      status: "queued",
      attempts: 0,
      createdAt: now,
    };
    db.run(
      `INSERT INTO review_jobs (id, session_id, goal, workspace, profile, backend, transcript, max_iterations, step_timeout_s, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
      [job.id, job.sessionId, job.goal, job.workspace, job.profile, job.backend ?? null, job.transcript, job.maxIterations ?? null, job.stepTimeoutS ?? null, job.createdAt],
    );
    return job;
  });
}

export async function listReviewJobs(opts: { home: string; limit?: number }): Promise<ReviewJob[]> {
  return withDb(opts.home, (db) => {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const rows = db.query<Row, [number]>("SELECT * FROM review_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map(fromRow);
  });
}

export async function getReviewJob(id: string, opts: { home: string }): Promise<ReviewJob | undefined> {
  return withDb(opts.home, (db) => {
    const row = db.query<Row, [string]>("SELECT * FROM review_jobs WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  });
}

/**
 * Claim exactly one job for this home. The active-lease check serializes reviews because their
 * memory/seal writes are cross-file read-modify-write operations, not a transactional API.
 */
export async function claimReviewJob(opts: { home: string; id?: string; retry?: boolean; now?: number }): Promise<ClaimedReviewJob | undefined> {
  return withDb(opts.home, (db) => {
    const now = opts.now ?? Date.now();
    const nowIso = iso(now);
    const lease = iso(now + REVIEW_JOB_LEASE_MS);
    const token = randomBytes(16).toString("hex");
    db.run("BEGIN IMMEDIATE");
    try {
      const active = db.query<Row, [string]>(
        "SELECT * FROM review_jobs WHERE status = 'running' AND lease_expires_at > ? LIMIT 1",
      ).get(nowIso);
      if (active) {
        db.run("COMMIT");
        return undefined;
      }
      const condition = opts.retry
        ? "(status = 'queued' OR status = 'failed' OR status = 'partial' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))"
        : "(status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))";
      const row = opts.id
        ? db.query<Row, [string, string]>(`SELECT * FROM review_jobs WHERE id = ? AND ${condition}`).get(opts.id, nowIso)
        : db.query<Row, [string]>(`SELECT * FROM review_jobs WHERE ${condition} ORDER BY created_at ASC LIMIT 1`).get(nowIso);
      if (!row) {
        db.run("COMMIT");
        return undefined;
      }
      db.run(
        "UPDATE review_jobs SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), finished_at = NULL, lease_expires_at = ?, lease_token = ?, error = NULL WHERE id = ?",
        [nowIso, lease, token, row.id],
      );
      const claimed = db.query<Row, [string]>("SELECT * FROM review_jobs WHERE id = ?").get(row.id)!;
      db.run("COMMIT");
      return { ...fromRow(claimed), leaseToken: token };
    } catch (err) {
      try { db.run("ROLLBACK"); } catch { /* no transaction left */ }
      throw err;
    }
  });
}

export async function renewReviewJob(id: string, leaseToken: string, opts: { home: string; now?: number }): Promise<boolean> {
  return withDb(opts.home, (db) => {
    const now = opts.now ?? Date.now();
    const res = db.run(
      "UPDATE review_jobs SET lease_expires_at = ? WHERE id = ? AND status = 'running' AND lease_token = ?",
      [iso(now + REVIEW_JOB_LEASE_MS), id, leaseToken],
    );
    return res.changes === 1;
  });
}

export async function finishReviewJob(
  id: string,
  leaseToken: string,
  result: { status: "completed" | "partial" | "failed"; outcome?: StoredReviewOutcome; error?: string },
  opts: { home: string; now?: number },
): Promise<boolean> {
  return withDb(opts.home, (db) => {
    const res = db.run(
      "UPDATE review_jobs SET status = ?, finished_at = ?, lease_expires_at = NULL, outcome = ?, error = ? WHERE id = ? AND status = 'running' AND lease_token = ?",
      [result.status, iso(opts.now ?? Date.now()), result.outcome ? JSON.stringify(result.outcome) : null, result.error ? textForDisk(result.error) : null, id, leaseToken],
    );
    return res.changes === 1;
  });
}

export function storedOutcome(outcome: ReviewOutcome): StoredReviewOutcome {
  return {
    iterations: outcome.iterations,
    memoryOps: outcome.memoryOps,
    userOps: outcome.userOps,
    projectOps: outcome.projectOps,
    skillOps: outcome.skillOps,
    incidentOps: outcome.incidentOps,
    refused: outcome.refused,
    consolidationFailures: outcome.consolidationFailures,
    stoppedBecause: outcome.stoppedBecause,
    summary: textForDisk(outcome.summary),
  };
}

export function formatReviewJob(job: ReviewJob): string {
  const summary = job.outcome
    ? ` — ${job.outcome.stoppedBecause}; memory ${job.outcome.memoryOps}, project ${job.outcome.projectOps}, skills ${job.outcome.skillOps}`
    : job.error ? ` — ${job.error.split("\n", 1)[0]}` : "";
  return `${job.id}  ${job.status.padEnd(9)} attempts=${job.attempts}  session #${job.sessionId}  ${job.goal.replace(/\s+/g, " ").slice(0, 72)}${summary}`;
}
