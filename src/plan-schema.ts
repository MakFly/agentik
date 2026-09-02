import { classifyCommand } from "./command-policy.ts";
import { detectInjection, isGoalHijack } from "./injection.ts";
import { REVIEWER_ONLY_TOOLS, TOOL_CATALOG } from "./tool-catalog.ts";
import { resolveSafe } from "./tools.ts";
import {
  clampSubagentCount,
  DEFAULT_MAX_STEPS,
  MAX_SUBAGENTS,
  resolveWorkerRole,
  type BoundedTask,
  type TaskAcceptance,
  type WorkerRole,
} from "./types.ts";

/**
 * The plan a model proposes is DATA until it passes this schema. Before it, a plan was taken on
 * faith: an unknown assignee silently became worker_a, a forbidden tool stayed in the allowlist
 * until the gate refused it at every step, and no task could depend on another. A rejected plan
 * gets exactly one reprompt (`PLAN_REJECTED: <problems>`); then the regex planner takes over.
 */

export const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const INSTRUCTION_MAX = 2000;
export const MAX_STEPS_CAP = 16;

export interface ValidatePlanOptions {
  workerCount: number;
  workspace: string;
  /** Tool names a task may list (default: the catalog minus reviewer-only tools). */
  catalog?: string[];
}

export type PlanValidation =
  | { ok: true; tasks: BoundedTask[] }
  | { ok: false; problems: string[] };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function validatePlan(raw: unknown, opts: ValidatePlanOptions): PlanValidation {
  const problems: string[] = [];
  const allowedCatalog = new Set(opts.catalog ?? TOOL_CATALOG.map((t) => t.name).filter((n) => !REVIEWER_ONLY_TOOLS.has(n)));
  const maxTasks = Math.min(MAX_SUBAGENTS, clampSubagentCount(opts.workerCount));
  if (!Array.isArray(raw)) return { ok: false, problems: ["tasks must be an array"] };
  if (raw.length === 0) return { ok: false, problems: ["tasks is empty: at least one task"] };
  if (raw.length > maxTasks) problems.push(`${raw.length} tasks for ${maxTasks} worker(s): at most ${maxTasks}`);

  const tasks: BoundedTask[] = [];
  const ids = new Set<string>();
  raw.slice(0, MAX_SUBAGENTS).forEach((item, i) => {
    const label = `task[${i}]`;
    if (!item || typeof item !== "object") {
      problems.push(`${label}: not an object`);
      return;
    }
    const t = item as Record<string, unknown>;
    const id = str(t.id)?.trim() || `task-${i + 1}`;
    if (!TASK_ID_RE.test(id)) problems.push(`${label}: id "${id}" must match ${TASK_ID_RE}`);
    else if (ids.has(id)) problems.push(`${label}: duplicate id "${id}"`);
    ids.add(id);

    const assigneeRaw = str(t.assignee) ?? "";
    const assignee = resolveWorkerRole(assigneeRaw);
    if (!assignee) problems.push(`${label} (${id}): assignee "${assigneeRaw}" is not a worker (worker_a…worker_e or a crew name)`);

    const instruction = (str(t.instruction) ?? "").trim();
    if (!instruction) problems.push(`${label} (${id}): instruction is empty`);
    else if (instruction.length > INSTRUCTION_MAX) problems.push(`${label} (${id}): instruction is ${instruction.length} chars, max ${INSTRUCTION_MAX}`);
    else {
      const finding = detectInjection(instruction, "inter_agent", `plan:${id}`);
      if (isGoalHijack(finding)) problems.push(`${label} (${id}): instruction reads as a goal hijack (${finding.ruleIds.join(",")})`);
    }

    let allowedTools: string[] = [];
    if (t.allowedTools !== undefined) {
      if (!Array.isArray(t.allowedTools)) problems.push(`${label} (${id}): allowedTools must be an array`);
      else {
        allowedTools = [...new Set((t.allowedTools as unknown[]).map(String))];
        for (const tool of allowedTools) {
          if (!allowedCatalog.has(tool)) {
            problems.push(REVIEWER_ONLY_TOOLS.has(tool) ? `${label} (${id}): tool "${tool}" is reviewer-only` : `${label} (${id}): unknown tool "${tool}"`);
          }
        }
      }
    }

    let maxSteps = DEFAULT_MAX_STEPS;
    if (t.maxSteps !== undefined) {
      const n = Number(t.maxSteps);
      if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS_CAP) problems.push(`${label} (${id}): maxSteps ${String(t.maxSteps)} must be an integer in 1..${MAX_STEPS_CAP}`);
      else maxSteps = n;
    }

    let dependsOn: string[] | undefined;
    if (t.dependsOn !== undefined) {
      if (!Array.isArray(t.dependsOn)) problems.push(`${label} (${id}): dependsOn must be an array of task ids`);
      else dependsOn = [...new Set((t.dependsOn as unknown[]).map(String))];
    }

    let acceptance: TaskAcceptance | undefined;
    if (t.acceptance !== undefined) {
      if (!t.acceptance || typeof t.acceptance !== "object") problems.push(`${label} (${id}): acceptance must be an object`);
      else {
        const a = t.acceptance as Record<string, unknown>;
        acceptance = {};
        if (a.expectArtifacts !== undefined) {
          if (!Array.isArray(a.expectArtifacts)) problems.push(`${label} (${id}): acceptance.expectArtifacts must be an array`);
          else {
            acceptance.expectArtifacts = [];
            for (const p of a.expectArtifacts as unknown[]) {
              try {
                resolveSafe(opts.workspace, String(p));
                acceptance.expectArtifacts.push(String(p));
              } catch {
                problems.push(`${label} (${id}): acceptance.expectArtifacts "${String(p)}" escapes the workspace`);
              }
            }
          }
        }
        if (a.requireTools !== undefined) {
          if (typeof a.requireTools !== "boolean") problems.push(`${label} (${id}): acceptance.requireTools must be a boolean`);
          else acceptance.requireTools = a.requireTools;
        }
        if (a.command !== undefined) {
          const cmd = str(a.command)?.trim() ?? "";
          if (!cmd) problems.push(`${label} (${id}): acceptance.command is empty`);
          else if (classifyCommand(cmd) !== "medium") problems.push(`${label} (${id}): acceptance.command "${cmd}" is ${classifyCommand(cmd)}: only a medium command may be an acceptance check`);
          else acceptance.command = cmd;
        }
      }
    }

    tasks.push({
      id,
      assignee: assignee ?? ("worker_a" as WorkerRole),
      instruction,
      allowedTools,
      maxSteps,
      ...(dependsOn ? { dependsOn } : {}),
      ...(acceptance ? { acceptance } : {}),
    });
  });

  // Dependencies: every id exists, and the graph is a DAG (Kahn).
  for (const t of tasks) {
    for (const d of t.dependsOn ?? []) {
      if (d === t.id) problems.push(`${t.id}: depends on itself`);
      else if (!ids.has(d)) problems.push(`${t.id}: dependsOn "${d}" is not a task id`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" → ")}`);

  return problems.length ? { ok: false, problems } : { ok: true, tasks };
}

/** Kahn's algorithm; returns the ids left over (the cycle members) or undefined. */
export function findCycle(tasks: Array<Pick<BoundedTask, "id" | "dependsOn">>): string[] | undefined {
  const ids = new Set(tasks.map((t) => t.id));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    out.set(t.id, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn ?? []) {
      if (!ids.has(d) || d === t.id) continue;
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      out.get(d)!.push(t.id);
    }
  }
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen += 1;
    for (const next of out.get(id) ?? []) {
      const n = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (seen === tasks.length) return undefined;
  return [...indeg.entries()].filter(([, n]) => n > 0).map(([id]) => id);
}

export type PlanSource = "model" | "model_repaired" | "fallback" | "resumed";

/** The plan as the human reads it before ACT. */
export function formatPlan(tasks: BoundedTask[], source: PlanSource, problems: string[] = []): string {
  const lines = [`plan (${source}):`];
  for (const t of tasks) {
    const bits = [`${t.id} → ${t.assignee}`, `tools=${t.allowedTools.join(",") || "(none)"}`, `steps≤${t.maxSteps}`];
    if (t.dependsOn?.length) bits.push(`after ${t.dependsOn.join(",")}`);
    const acc: string[] = [];
    if (t.acceptance?.expectArtifacts?.length) acc.push(`artifacts ${t.acceptance.expectArtifacts.join(",")}`);
    if (t.acceptance?.requireTools) acc.push("tools required");
    if (t.acceptance?.command) acc.push(`check "${t.acceptance.command}"`);
    if (acc.length) bits.push(`accept: ${acc.join("; ")}`);
    lines.push(`  - ${bits.join(" · ")}`);
    lines.push(`      ${t.instruction.replace(/\s+/g, " ").slice(0, 160)}${t.instruction.length > 160 ? "…" : ""}`);
  }
  if (problems.length) {
    lines.push("  plan problems (model plan rejected):");
    for (const p of problems.slice(0, 8)) lines.push(`    - ${p}`);
    if (problems.length > 8) lines.push(`    - +${problems.length - 8} more`);
  }
  return lines.join("\n");
}
