import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordIncident } from "./incidents.ts";
import { memoryApply, readEntries, type MemoryTarget } from "./memory-store.ts";
import { runReview, type ReviewOutcome } from "./reviewer.ts";
import { skillDescriptionProblem, skillNameProblem } from "./skill-factory.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "./types.ts";

/**
 * Evaluation of the reviewer: fixed cases (transcript + snapshot + expectations), the REAL
 * `runReview`, a temporary home and workspace per case, and rules scored against the tool trace
 * and the final files. `script.json` makes a case deterministic (a scripted reviewer) for
 * `bun test`; a live backend (`agentik review --eval DIR --backend sonnet`) measures the model.
 * Never touches `~/.agentik`.
 */

export interface EvalSnapshot {
  memory?: string[];
  user?: string[];
  project?: string[];
  claudeMd?: string;
  /** name → { description, body } */
  skills?: Record<string, { description: string; body: string }>;
  incidents?: Array<{ symptom: string; harness?: string; seen?: number; cause?: string }>;
}

export type EvalRule =
  | { kind: "memory"; target?: MemoryTarget; op?: "add" | "replace" | "remove"; contains?: string }
  | { kind: "file"; target: MemoryTarget; contains?: string; notContains?: string }
  | { kind: "skill"; action?: "view" | "patch" | "create"; name?: string; contains?: string }
  | { kind: "skill_name_valid" }
  | { kind: "view_before_create" }
  | { kind: "max_creates"; n: number }
  | { kind: "incident"; action?: "classify" | "resolve" | "merge"; contains?: string }
  | { kind: "any_write" };

export interface EvalExpected {
  must?: EvalRule[];
  mustNot?: EvalRule[];
  maxRefused?: number;
  stoppedNot?: ReviewOutcome["stoppedBecause"][];
}

export interface EvalCaseResult {
  name: string;
  ok: boolean;
  failures: string[];
  outcome: ReviewOutcome;
  home: string;
}

export interface EvalRunResult {
  ok: boolean;
  cases: EvalCaseResult[];
}

/** A backend that replays `script.json` (one WorkerMessage per iteration). */
export class ScriptedReviewer implements Backend {
  readonly id: string;
  seen: CompleteRequest[] = [];
  constructor(private readonly script: WorkerMessage[], id = "scripted") {
    this.id = id;
  }
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    return this.script[this.seen.length - 1] ?? { text: "nothing more", toolCalls: [] };
  }
}

export async function listEvalCases(dir: string): Promise<string[]> {
  const ents = await readdir(dir, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "transcript.md"))).map((e) => e.name).sort();
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Build the home and workspace a case describes. */
export async function materializeCase(caseDir: string): Promise<{ home: string; workspace: string; snapshot: EvalSnapshot }> {
  const snapshot = await readJson<EvalSnapshot>(join(caseDir, "snapshot.json"), {});
  const root = await mkdtemp(join(tmpdir(), "agentik-eval-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const seed = async (target: MemoryTarget, entries: string[] | undefined) => {
    for (const e of entries ?? []) await memoryApply(target, [{ action: "add", content: e }], { home, workspace, by: "migration", bypassApproval: true });
  };
  await seed("memory", snapshot.memory);
  await seed("user", snapshot.user);
  await seed("project", snapshot.project);
  if (snapshot.claudeMd !== undefined) await writeFile(join(workspace, "CLAUDE.md"), snapshot.claudeMd, "utf8");
  for (const [name, sk] of Object.entries(snapshot.skills ?? {})) {
    await mkdir(join(home, "skills", name), { recursive: true });
    await writeFile(join(home, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${sk.description}\n---\n\n${sk.body}\n`, "utf8");
  }
  for (const inc of snapshot.incidents ?? []) {
    const n = Math.max(1, inc.seen ?? 1);
    for (let i = 0; i < n; i++) await recordIncident({ goal: "eval", workspace, harness: inc.harness ?? "codex", symptom: inc.symptom, cause: inc.cause }, { home });
  }
  return { home, workspace, snapshot };
}

type Trace = ReviewOutcome["trace"];

function memoryOpsOf(t: Trace[number]): Array<{ action: string; content?: string; old?: string; new?: string; target: string }> {
  const target = String(t.args.target ?? "memory");
  if (Array.isArray(t.args.operations)) return (t.args.operations as Array<Record<string, unknown>>).map((o) => ({ action: String(o.action ?? "add"), content: o.content as string | undefined, old: o.old as string | undefined, new: o.new as string | undefined, target }));
  return [{ action: String(t.args.action ?? "add"), content: t.args.content as string | undefined, old: t.args.old as string | undefined, new: t.args.new as string | undefined, target }];
}

async function ruleHolds(rule: EvalRule, trace: Trace, home: string, workspace: string): Promise<boolean> {
  const okCalls = trace.filter((t) => t.ok);
  switch (rule.kind) {
    case "memory":
      return okCalls.some((t) => t.tool === "memory" && memoryOpsOf(t).some((op) => (!rule.target || op.target === rule.target) && (!rule.op || op.action === rule.op) && (!rule.contains || `${op.content ?? ""}\n${op.new ?? ""}\n${op.old ?? ""}`.includes(rule.contains))));
    case "file": {
      const text = (await readEntries(rule.target, home, { workspace })).join("\n");
      if (rule.contains !== undefined && !text.includes(rule.contains)) return false;
      if (rule.notContains !== undefined && text.includes(rule.notContains)) return false;
      return true;
    }
    case "skill":
      return okCalls.some((t) => t.tool === "skill_manage" && (!rule.action || t.args.action === rule.action) && (!rule.name || t.args.name === rule.name) && (!rule.contains || JSON.stringify(t.args).includes(rule.contains)));
    case "skill_name_valid":
      return trace.filter((t) => t.tool === "skill_manage" && t.args.action === "create").every((t) => !skillNameProblem(String(t.args.name ?? "")) && !skillDescriptionProblem(String(t.args.description ?? "")));
    case "view_before_create":
      return trace.every((t, i) => !(t.tool === "skill_manage" && t.args.action === "create") || trace.slice(0, i).some((v) => v.tool === "skill_manage" && v.args.action === "view" && v.args.name === t.args.name));
    case "max_creates":
      return okCalls.filter((t) => t.tool === "skill_manage" && t.args.action === "create").length <= rule.n;
    case "incident":
      return okCalls.some((t) => t.tool === "incident" && (!rule.action || t.args.action === rule.action) && (!rule.contains || JSON.stringify(t.args).includes(rule.contains)));
    case "any_write":
      return okCalls.some((t) => t.tool === "memory" || (t.tool === "skill_manage" && t.args.action !== "view") || t.tool === "incident");
  }
}

export function describeRule(rule: EvalRule): string {
  return JSON.stringify(rule);
}

export async function scoreCase(expected: EvalExpected, outcome: ReviewOutcome, home: string, workspace: string): Promise<string[]> {
  const failures: string[] = [];
  for (const r of expected.must ?? []) if (!(await ruleHolds(r, outcome.trace, home, workspace))) failures.push(`must: ${describeRule(r)}`);
  for (const r of expected.mustNot ?? []) if (await ruleHolds(r, outcome.trace, home, workspace)) failures.push(`mustNot: ${describeRule(r)}`);
  if (expected.maxRefused !== undefined && outcome.refused > expected.maxRefused) failures.push(`refused ${outcome.refused} > ${expected.maxRefused}`);
  for (const s of expected.stoppedNot ?? []) if (outcome.stoppedBecause === s) failures.push(`stopped: ${s}`);
  return failures;
}

export interface RunReviewEvalOptions {
  /** A live backend, or a factory giving one per case (the scripted variant reads script.json). */
  backend?: Backend;
  cases?: string[];
  maxIterations?: number;
}

export async function runReviewEval(dir: string, opts: RunReviewEvalOptions = {}): Promise<EvalRunResult> {
  const names = (await listEvalCases(dir)).filter((n) => !opts.cases?.length || opts.cases.includes(n));
  const results: EvalCaseResult[] = [];
  for (const name of names) {
    const caseDir = join(dir, name);
    const { home, workspace } = await materializeCase(caseDir);
    const transcript = await readFile(join(caseDir, "transcript.md"), "utf8");
    const expected = await readJson<EvalExpected>(join(caseDir, "expected.json"), {});
    let backend = opts.backend;
    if (!backend) {
      const script = await readJson<WorkerMessage[] | null>(join(caseDir, "script.json"), null);
      if (!script) {
        results.push({ name, ok: false, failures: ["no backend and no script.json"], outcome: emptyOutcome(), home });
        continue;
      }
      backend = new ScriptedReviewer(script);
    }
    const goal = transcript.match(/^goal:\s*(.+)$/m)?.[1]?.trim() ?? name;
    const outcome = await runReview({ goal, transcript, workspace, home, backend, maxIterations: opts.maxIterations });
    const failures = await scoreCase(expected, outcome, home, workspace);
    results.push({ name, ok: failures.length === 0, failures, outcome, home });
  }
  return { ok: results.every((r) => r.ok), cases: results };
}

function emptyOutcome(): ReviewOutcome {
  return { iterations: 0, memoryOps: 0, userOps: 0, projectOps: 0, skillOps: 0, incidentOps: 0, refused: 0, consolidationFailures: 0, stoppedBecause: "backend_error", summary: "", events: [], trace: [] };
}

export function formatEvalResult(r: EvalRunResult): string {
  const lines = r.cases.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(30)} iter=${c.outcome.iterations} mem=${c.outcome.memoryOps + c.outcome.projectOps + c.outcome.userOps} skills=${c.outcome.skillOps} inc=${c.outcome.incidentOps} refused=${c.outcome.refused} stop=${c.outcome.stoppedBecause}${c.failures.length ? `\n      ${c.failures.join("\n      ")}` : ""}`);
  lines.push(`${r.cases.filter((c) => c.ok).length}/${r.cases.length} cases pass`);
  return lines.join("\n");
}
