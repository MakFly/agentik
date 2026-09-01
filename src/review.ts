import { join } from "node:path";
import { homedir } from "node:os";
import { agentikHome } from "./home.ts";
import { recall, retainNote } from "./memory.ts";
import { shouldDraftSkill, slugifySkillName, upsertSkill } from "./skill-factory.ts";
import type { RunReport } from "./types.ts";

export interface ReviewResult {
  memoryLayer: "hot" | "warm" | "rejected";
  skill?: { action: "created" | "updated"; name: string; path: string };
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

/** Hermes-style turn finalizer: always retain; auto-write/update skill on non-trivial runs. */
export async function reviewAfterRun(opts: {
  goal: string;
  report: Pick<RunReport, "status" | "executedTools" | "artifacts">;
  home?: string;
}): Promise<ReviewResult> {
  const home = agentikHome(opts.home);
  const session = `session: ${opts.goal} [${opts.report.status}] artifacts=${opts.report.artifacts.join(",") || "none"}`;
  const mem = await retainNote(session, { home, kind: "session" });
  const result: ReviewResult = { memoryLayer: mem.layer };
  if (!shouldDraftSkill(opts.report)) return result;

  const name = slugifySkillName(opts.goal);
  const steps = opts.report.executedTools.map(
    (t) => `${t.tool}${t.artifact ? " -> " + t.artifact : ""}`,
  );
  const shipped = await upsertSkill({
    name,
    goal: opts.goal,
    steps: steps.length ? steps : ["Completed the trusted goal."],
    artifacts: opts.report.artifacts,
    home,
    linkHarness: home === join(homedir(), ".agentik"),
  });
  result.skill = { action: shipped.action, name: shipped.name, path: shipped.path };
  return result;
}
