import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { withHomeLock } from "./home-lock.ts";
import { memoryContentProblem } from "./memory-store.ts";
import { skillDescriptionProblem, skillNameProblem } from "./skill-factory.ts";
import { writeSkillFile } from "./skill-write.ts";
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

/**
 * A skill body is loaded into a prompt every time the skill is used: it is the same threat
 * surface as MEMORY.md, so it gets the same scan (secrets, injections) on every write and on
 * link. A refusal is not a write — "code never writes a skill" holds.
 */
export const skillTextProblem = memoryContentProblem;

export function skillFile(name: string, home?: string): string {
  return join(memoryPaths(agentikHome(home)).skills, name, "SKILL.md");
}

/**
 * The reviewer's `skill_manage patch`. "old_string matches exactly once" is a verdict about the
 * body as it was read, so the read, the verdict and the write are one critical section — under a
 * concurrent write the match count would be true of a file that no longer exists.
 */
export function applySkillPatch(
  name: string,
  args: { old_string?: unknown; new_string?: unknown },
  opts?: { home?: string; by?: SkillCreator },
): Promise<SkillOpResult> {
  return withHomeLock("skills", () => patchLocked(name, args, opts), { home: opts?.home });
}

async function patchLocked(
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
  const next = body.replace(oldStr, newStr);
  const problem = skillTextProblem(newStr) ?? skillTextProblem(next);
  if (problem) return { ok: false, output: `patch refused: ${problem}` };
  await writeSkillFile(name, next, { home: opts?.home, actor: opts?.by === "human" ? "human" : opts?.by === "reviewer" ? "reviewer" : "approval", action: "patch" });
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
  const tp = skillTextProblem(String(args.description ?? "")) ?? skillTextProblem(body);
  if (tp) return `create refused: ${tp}`;
  return undefined;
}

/** Same shape: "does not exist yet" is checked and then acted on, so both go under one lock. */
export function applySkillCreate(
  name: string,
  args: { description?: unknown; body?: unknown },
  opts?: { home?: string; by?: SkillCreator },
): Promise<SkillOpResult> {
  return withHomeLock("skills", () => createLocked(name, args, opts), { home: opts?.home });
}

async function createLocked(
  name: string,
  args: { description?: unknown; body?: unknown },
  opts?: { home?: string; by?: SkillCreator },
): Promise<SkillOpResult> {
  const problem = skillCreateProblem(name, args, opts?.home);
  if (problem) return { ok: false, output: problem };
  const description = String(args.description ?? "").trim();
  const body = String(args.body ?? "").trim();
  const np = skillNameProblem(name);
  if (np) return { ok: false, output: `create: invalid skill name "${name}": ${np}` };
  await writeSkillFile(name, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, { home: opts?.home, actor: opts?.by === "human" ? "human" : opts?.by === "reviewer" ? "reviewer" : "approval", action: "create" });
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
