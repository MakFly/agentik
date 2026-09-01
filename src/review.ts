import { agentikHome } from "./home.ts";
import { recall, retainNote } from "./memory.ts";
import type { RunReport } from "./types.ts";

export interface ReviewResult {
  memoryLayer: "hot" | "warm" | "rejected";
}

export function keywordsFromGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .join(" ");
}

/** Hermes-style session open: pull HOT + FTS hits before work. Never ask. */
export async function recallBeforeRun(opts: {
  goal: string;
  home?: string;
}): Promise<string[]> {
  const words = keywordsFromGoal(opts.goal).split(/\s+/).filter(Boolean);
  const queries = words.length ? [words.join(" "), ...words] : [opts.goal];
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const query of queries) {
    for (const h of await recall(query, { home: opts.home, limit: 6 })) {
      if (seen.has(h)) continue;
      seen.add(h);
      hits.push(h);
      if (hits.length >= 6) return hits;
    }
  }
  return hits;
}

/**
 * Turn finalizer. Retains a session note and nothing else.
 *
 * It used to also write a skill whenever a run had 2+ artifacts or 5+ tool calls, named after
 * the goal. Code cannot know what class of work a run belongs to, so every run became its own
 * skill — 28 of them in a day, linked into three harnesses. Skill creation is a judgment call
 * and belongs to the model-driven review (`agentik review`), not to this function.
 */
export async function reviewAfterRun(opts: {
  goal: string;
  report: Pick<RunReport, "status" | "executedTools" | "artifacts">;
  home?: string;
}): Promise<ReviewResult> {
  const home = agentikHome(opts.home);
  const session = `session: ${opts.goal} [${opts.report.status}] artifacts=${opts.report.artifacts.join(",") || "none"}`;
  const mem = await retainNote(session, { home, kind: "session" });
  return { memoryLayer: mem.layer };
}
