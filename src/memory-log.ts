import { agentikHome } from "./home.ts";
import { openSessionsDb } from "./sessions.ts";

/**
 * Journal of every memory write: who changed what, in which file, before and after. The
 * reviewer, the human (`retain`, `remove`), an approval and a migration all go through
 * `memoryApply` / `memoryRemoveEntry`, which call `logMemoryOp` after the file is written.
 * Table `memory_ops` in sessions.sqlite (same store as sessions and incidents). Never read by
 * `context.ts` or `reviewer.ts`: the log is for the human, not for the prompt.
 */

export type MemoryOpKind = "add" | "replace" | "remove" | "reseal" | "migrate";
export type MemoryOpActor = "reviewer" | "human" | "approval" | "migration";

export interface MemoryOpInput {
  target: string;
  workspace?: string;
  op: MemoryOpKind;
  before?: string;
  after?: string;
  sessionId?: number;
  by: MemoryOpActor;
}

export interface MemoryOpRecord extends MemoryOpInput {
  id: number;
  ts: string;
}

interface Row {
  id: number;
  ts: string;
  target: string;
  workspace: string;
  op: string;
  before: string;
  after: string;
  session_id: number | null;
  by: string;
}

async function openLog(home: string) {
  const db = await openSessionsDb(home);
  db.run(`CREATE TABLE IF NOT EXISTS memory_ops (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    target TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    op TEXT NOT NULL,
    before TEXT NOT NULL DEFAULT '',
    after TEXT NOT NULL DEFAULT '',
    session_id INTEGER NULL,
    by TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS memory_ops_target ON memory_ops(target, workspace, ts)");
  return db;
}

export async function logMemoryOp(input: MemoryOpInput, opts?: { home?: string }): Promise<MemoryOpRecord> {
  const home = agentikHome(opts?.home);
  const db = await openLog(home);
  try {
    const ts = new Date().toISOString();
    const res = db.run(
      "INSERT INTO memory_ops (ts, target, workspace, op, before, after, session_id, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [ts, input.target, input.workspace ?? "", input.op, input.before ?? "", input.after ?? "", input.sessionId ?? null, input.by],
    );
    return { ...input, id: Number(res.lastInsertRowid), ts };
  } finally {
    db.close();
  }
}

export async function listMemoryOps(opts?: { home?: string; target?: string; workspace?: string; limit?: number }): Promise<MemoryOpRecord[]> {
  const home = agentikHome(opts?.home);
  const db = await openLog(home);
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts?.target) {
      where.push("target = ?");
      params.push(opts.target);
    }
    if (opts?.workspace) {
      where.push("workspace = ?");
      params.push(opts.workspace);
    }
    params.push(opts?.limit ?? 50);
    const rows = db
      .query<Row, (string | number)[]>(`SELECT * FROM memory_ops${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...params);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      target: r.target,
      workspace: r.workspace || undefined,
      op: r.op as MemoryOpKind,
      before: r.before || undefined,
      after: r.after || undefined,
      sessionId: r.session_id ?? undefined,
      by: r.by as MemoryOpActor,
    }));
  } finally {
    db.close();
  }
}

const cut = (s: string | undefined, n = 70) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : "");

/** `#12 2026-09-02 09:15 memory add by reviewer: "…"` / `replace: "old" → "new"` */
export function formatMemoryOp(r: MemoryOpRecord): string {
  const when = r.ts.slice(0, 16).replace("T", " ");
  const ws = r.workspace ? ` (${r.workspace})` : "";
  const what =
    r.op === "add" ? `"${cut(r.after)}"`
    : r.op === "remove" ? `"${cut(r.before)}"`
    : r.op === "replace" ? `"${cut(r.before, 40)}" → "${cut(r.after, 40)}"`
    : r.op === "migrate" ? `"${cut(r.after)}"`
    : "";
  return `#${r.id} ${when} ${r.target}${ws} ${r.op} by ${r.by}${r.sessionId ? ` (session #${r.sessionId})` : ""}${what ? `: ${what}` : ""}`;
}
