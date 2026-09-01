import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { skillDescriptionProblem, upsertSkill } from "./skill-factory.ts";
import { recordSkillUsage, type SkillCreator } from "./skill-usage.ts";

/**
 * The two writes `skill_manage` can make, as plain functions, so that the reviewer's tool
 * and `agentik skills approve` run the very same code. Validation of the *arguments* lives
 * here; what only the review knows (read-before-write, the one-create budget) stays in the
 * tool, and is checked at staging time, not again at approval.
 */
export interface SkillOpResult {
  ok: boolean;
  output: string;
  artifact?: string;
}

export function skillFile(name: string, home?: string): string {
  return join(memoryPaths(agentikHome(home)).skills, name, "SKILL.md");
}

export async function applySkillPatch(
  name: string,
  args: { old_string?: unknown; new_string?: unknown },
  opts?: { home?: string; by?: SkillCreator },
): Promise<SkillOpResult> {
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  if (!oldStr) return { ok: false, output: "patch: old_string is required" };
  const file = skillFile(name, opts?.home);
  let body: string;
  try {
    body = await readFile(file, "utf8");
  } catch {
    return { ok: false, output: `patch: no skill named ${name}` };
  }
  const n = body.split(oldStr).length - 1;
  if (n !== 1) return { ok: false, output: `patch: old_string must match exactly once (matched ${n})` };
  await writeFile(file, body.replace(oldStr, newStr), "utf8");
  await recordSkillUsage(name, "patch", { home: opts?.home });
  return { ok: true, output: `patched ${name}`, artifact: `skills/${name}/SKILL.md` };
}

/** Argument checks for a create, without writing. Used at staging so a bad create fails early. */
export function skillCreateProblem(name: string, args: { description?: unknown; body?: unknown }, home?: string): string | undefined {
  if (existsSync(skillFile(name, home))) return `create: ${name} exists — patch it instead`;
  const dp = skillDescriptionProblem(String(args.description ?? ""));
  if (dp) return `create: ${dp}`;
  const body = String(args.body ?? "").trim();
  if (body.length < 80) return "create: body must be a real procedure (When to use / Procedure / Pitfalls / Verification), not a session log";
  if (body.length > 100_000) return "create: body over 100k chars";
  return undefined;
}

export async function applySkillCreate(
  name: string,
  args: { description?: unknown; body?: unknown },
  opts?: { home?: string; by?: SkillCreator },
): Promise<SkillOpResult> {
  const problem = skillCreateProblem(name, args, opts?.home);
  if (problem) return { ok: false, output: problem };
  const description = String(args.description ?? "").trim();
  const body = String(args.body ?? "").trim();
  await upsertSkill({ name, description, steps: [], home: opts?.home });
  await writeFile(skillFile(name, opts?.home), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, "utf8");
  await recordSkillUsage(name, "create", { home: opts?.home, createdBy: opts?.by ?? "reviewer" });
  return { ok: true, output: `created ${name}`, artifact: `skills/${name}/SKILL.md` };
}

/** Read a skill body and count the view. Undefined when there is no such skill. */
export async function viewSkill(name: string, opts?: { home?: string }): Promise<string | undefined> {
  let body: string;
  try {
    body = await readFile(skillFile(name, opts?.home), "utf8");
  } catch {
    return undefined;
  }
  await recordSkillUsage(name, "view", { home: opts?.home });
  return body;
}
