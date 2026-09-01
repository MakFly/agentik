import { agentikHome } from "./home.ts";
import { recallHot } from "./memory.ts";
import { formatSessionHit, recordSession, searchSessions } from "./sessions.ts";
import type { RunReport, RunStatus } from "./types.ts";

export interface ReviewResult {
  sessionId: number;
  memoryLayer: "session";
}

export function keywordsFromGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .join(" ");
}

/**
 * Hermes-style session open: HOT lines that match the goal, then the top-6 related sessions
 * (workspace-filtered when a workspace is given). Never asks. Returns readable lines.
 */
export async function recallBeforeRun(opts: {
  goal: string;
  home?: string;
  workspace?: string;
}): Promise<string[]> {
  const words = keywordsFromGoal(opts.goal).split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const word of words) {
    for (const h of await recallHot(word, { home: opts.home, limit: 6 })) {
      if (seen.has(h)) continue;
      seen.add(h);
      hits.push(h);
      if (hits.length >= 6) break;
    }
    if (hits.length >= 6) break;
  }
  const sessions = await searchSessions(opts.goal, {
    home: opts.home,
    workspace: opts.workspace,
    limit: 6,
  });
  for (const s of sessions) {
    const line = formatSessionHit(s);
    if (seen.has(line)) continue;
    seen.add(line);
    hits.push(line);
  }
  return hits;
}

/** A run status, or what the conductor declares by hand: `agentik harvest --status failed|partial`. */
export type SessionStatus = RunStatus | "failed" | "partial";

export type ReviewReport = { status: SessionStatus } & Pick<RunReport, "executedTools" | "artifacts"> &
  Partial<Pick<RunReport, "stalledTasks" | "backendSwitches">>;

/** One useful line: status, artifacts, and stalled / backend switches when the report has them. */
export function summarizeRun(report: ReviewReport): string {
  const parts = [`${report.status} — artifacts: ${report.artifacts.join(", ") || "none"}`];
  if (report.stalledTasks?.length) parts.push(`stalled: ${report.stalledTasks.length}`);
  if (report.backendSwitches?.length) parts.push(`backend switches: ${report.backendSwitches.length}`);
  return parts.join(" — ");
}

/**
 * Turn finalizer. Records the run as a session and nothing else.
 *
 * It used to write a `(session)` line into HOT, which filled the 2200-char cap with run titles
 * and pushed the rest into a WARM store nobody searched. Sessions now live in sessions.sqlite,
 * searchable by workspace; HOT is for durable facts only. It never writes a skill either: skill
 * creation is a judgment call and belongs to the model-driven review (`agentik review`).
 */
export async function reviewAfterRun(opts: {
  goal: string;
  report: ReviewReport;
  home?: string;
  workspace?: string;
  profile?: string;
  verdict?: unknown;
}): Promise<ReviewResult> {
  const home = agentikHome(opts.home, opts.profile);
  const session = await recordSession(
    {
      goal: opts.goal,
      workspace: opts.workspace,
      profile: opts.profile ?? process.env.AGENTIK_PROFILE ?? "default",
      status: opts.report.status,
      verdict: opts.verdict,
      artifacts: opts.report.artifacts,
      summary: summarizeRun(opts.report),
    },
    { home },
  );
  return { sessionId: session.id, memoryLayer: "session" };
}
