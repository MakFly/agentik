import { snapshotArtifacts, untouchedArtifacts } from "./artifacts.ts";
import { BackendError, systemPromptFor } from "./backends.ts";
import { ensureIndex } from "./code-index.ts";
import { repoMap } from "./repo-map.ts";
import { Orchestrator } from "./orchestrator.ts";
import { callHash, ToolGuard } from "./guardrails.ts";
import { buildPlan } from "./plan.ts";
import { formatPlan, validatePlan, type PlanSource } from "./plan-schema.ts";
import { runDag } from "./scheduler.ts";
import { normalizeClaims } from "./sources.ts";
import { workerToolNames } from "./tool-catalog.ts";
import { spillToolResult } from "./tool-results.ts";
import { addRunUsage, emptyRunUsage } from "./usage.ts";
import { executeTool } from "./tools.ts";
import { wrapUntrusted } from "./trust.ts";
import type {
  Backend,
  BackendSwitch,
  BoundedTask,
  Claim,
  Envelope,
  FetchImpl,
  OrchestratorDecision,
  RetrievedSource,
  RunReport,
  ShapedInfo,
  StalledTask,
  TaskResult,
  ToolCall,
  WorkerInvocation,
  WorkerMessage,
  WorkerRole,
} from "./types.ts";
import {
  clampSubagentCount,
  DEFAULT_MAX_STEPS,
  MAX_SUBAGENTS,
  SUBAGENT_ROLES,
  TASK_SUMMARY_MAX,
} from "./types.ts";

export { DEFAULT_MAX_STEPS };

/**
 * Re-exported from `types.ts` (a leaf): `backends.ts` names the same budget in the act prompt, and
 * `loop.ts` already imports `backends.ts` — owning the constant here would close an import cycle.
 */
export { TASK_SUMMARY_MAX };

export interface LoopConfig {
  goal: string;
  workspace: string;
  /** agentik home (code index, default profile when absent). */
  home?: string;
  /** Refresh the code index once and hand the planner a repo map (default true; no index → nothing). */
  codeIndex?: boolean;
  workerA: Backend;
  workerB: Backend;
  /** Extra subagents (worker_c..e). Combined pool is capped at MAX_SUBAGENTS. */
  workers?: Backend[];
  /** How many subagents to actually assign (1–5, default: pool length, min 2 if A+B). */
  workerCount?: number;
  decisions?: OrchestratorDecision[];
  fetchImpl?: FetchImpl;
  /** Cap per-task auto-run steps (default: the task's maxSteps). */
  maxSteps?: number;
  /** Session approval: every high-blast tool in this run is released (CLI --yolo). */
  autoApproveHighBlast?: boolean;
  /** Stop after the plan: no ACT, no synthesis; status `planned`. */
  planOnly?: boolean;
  /**
   * Tasks in flight at once (default: workerCount). One run per role at a time whatever the
   * value; see src/scheduler.ts for the concurrency model. Approval decisions are consumed in
   * order by the first task that asks (`decisions[]`), session approvals (--yolo) apply to all.
   */
  concurrency?: number;
  /** Called with the plan before ACT (the CLI prints it). */
  onPlan?: (text: string, tasks: BoundedTask[], source: PlanSource, problems: string[]) => void;
  /**
   * Resume (`agentik runs resume`): reuse this plan instead of planning, run only `onlyTaskIds`
   * (the others reuse `priorResults` as-is), and release a high-blast call whose
   * `callHash(tool, args)` is in `approvedCallHashes` — that exact call, once.
   */
  resume?: {
    tasks: BoundedTask[];
    onlyTaskIds: string[];
    priorResults: TaskResult[];
    approvedCallHashes: Set<string>;
  };
}

function workerPool(opts: LoopConfig): Backend[] {
  const extra = opts.workers ?? [];
  const pool = extra.length > 0 ? extra : [opts.workerA, opts.workerB];
  return pool.slice(0, MAX_SUBAGENTS);
}

/** Claims are merged on (text, url): a later synthesis adds to, never overwrites, an earlier one. */
export function mergeClaims(current: Claim[], incoming: Claim[]): Claim[] {
  const key = (c: Claim) => `${c.text}${c.source?.url ?? ""}`;
  const seen = new Set(current.map(key));
  const out = [...current];
  for (const c of incoming) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** The DATA a dependent task and the synthesizer get about a finished task. */
export function taskResultEnvelope(r: TaskResult): Envelope {
  return wrapUntrusted(
    JSON.stringify({ taskId: r.taskId, status: r.status, summary: r.summary, artifacts: r.artifacts, ...(r.reason ? { reason: r.reason } : {}) }),
    `task:${r.taskId}`,
    "inter_agent",
  );
}

export async function runLoop(opts: LoopConfig): Promise<RunReport> {
  const orch = new Orchestrator();
  /** Retrieved pages, run-wide: claims are checked against them. */
  const sources: RetrievedSource[] = [];
  const executed: RunReport["executedTools"] = [];
  const blocked: RunReport["blockedTools"] = [];
  const artifacts: string[] = [];
  const workersInvoked: RunReport["workersInvoked"] = [];
  const stalled: StalledTask[] = [];
  const switches: BackendSwitch[] = [];
  const taskResults: TaskResult[] = [];
  const decisionQ = [...(opts.decisions ?? [])];
  let claims: Claim[] = [];
  let synthesis = "";
  let planSource: PlanSource = "fallback";
  let planProblems: string[] = [];
  /** Monotone across the run: a call id is never reused, whatever task or phase made it. */
  let callSeq = 0;
  /** Call ids the gate released: the destructive executor's second lock. */
  const approved = new Set<string>();

  const runStarted = Date.now();
  const usage = emptyRunUsage();
  /** run_command outputs a shaper rewrote (worker calls and acceptance commands alike). */
  const shaping = { calls: 0, savedChars: 0 };
  const noteShaped = (shaped: ShapedInfo | undefined) => {
    if (!shaped) return;
    shaping.calls += 1;
    shaping.savedChars += shaped.savedChars;
  };
  // The code index is refreshed ONCE per run (never per search_code call), and built on first
  // use when this process is the conductor (depth 0) and the checkout is under the file cap;
  // otherwise one stderr hint and the run goes on without it (ensureIndex never throws).
  let codeIndex: RunReport["codeIndex"];
  // Auto-build needs an explicit home (the CLI always passes one): a library caller or a test
  // that omits it may refresh an existing index but never creates files in the default home.
  if (opts.codeIndex !== false) {
    const r = await ensureIndex(opts.home, opts.workspace, { auto: opts.home !== undefined ? undefined : false, log: (line) => console.error(line) });
    if (r.stats) codeIndex = { files: r.stats.files, chunks: r.stats.chunks, changed: r.stats.added + r.stats.updated + r.stats.removed, built: r.built, ms: r.ms };
    else if (r.reason && r.reason !== "disabled" && r.reason !== "empty") codeIndex = { files: r.files ?? 0, chunks: 0, changed: 0, built: false, ms: r.ms, reason: r.reason };
  }
  /**
   * Is `search_code` usable AT ALL this run? The flag is not the answer: `--no-index` is only one of
   * the ways the tool ends up refusing every call. A checkout over the auto-build cap (`too_big`), a
   * build that failed (`failed`), an empty or absent index — all of them leave the executor with
   * nothing to read, and a worker discovering that costs a round-trip per attempt (6 measured on one
   * run). So the verdict is taken AFTER ensureIndex, on chunks that really exist.
   *
   * Consequences: the tool is out of the planner's list, out of the fallback plan, and stripped from
   * a model plan that asks for it anyway — stripping, not rejecting: a plan is not wrong because it
   * hoped for an index, and a rejected plan costs a whole reprompt. A task left with no tool at all
   * would fail every acceptance, so `read_file` takes the empty slot.
   */
  const indexOn = opts.codeIndex !== false && (codeIndex?.chunks ?? 0) > 0;
  const planTools = workerToolNames().filter((n) => indexOn || n !== "search_code");
  const dropSearchCode = (t: BoundedTask): BoundedTask => {
    if (indexOn || !t.allowedTools.includes("search_code")) return t;
    const allowedTools = t.allowedTools.filter((n) => n !== "search_code");
    return { ...t, allowedTools: allowedTools.length ? allowedTools : ["read_file"] };
  };
  const bits = (synth: string): Parameters<typeof report>[1] => ({
    usage,
    shaping,
    codeIndex,
    durationMs: Date.now() - runStarted,
    workersInvoked,
    executed,
    blocked,
    artifacts,
    sources,
    stalled,
    switches,
    claims,
    synthesis: synth,
    planSource,
    planProblems,
    taskResults,
  });

  const submitted = orch.submitGoal(opts.goal);
  if (!submitted.ok) return report(orch, bits("goal rejected: prompt injection / goal hijack"));

  const pool = workerPool(opts);
  const workerCount = clampSubagentCount(opts.workerCount ?? pool.length);

  /** Backends that failed this run. A dead CLI is never handed more work. */
  const dead = new Set<string>();
  /** Role -> backend, mutable so a failover survives across steps. */
  const assigned = new Map<WorkerRole, Backend>();

  const defaultBackendFor = (role: WorkerRole) => {
    const idx = SUBAGENT_ROLES.indexOf(role);
    return pool[idx] ?? pool[0];
  };

  const backendFor = (role: WorkerRole): Backend => {
    const current = assigned.get(role) ?? defaultBackendFor(role);
    if (!dead.has(current.id)) return current;
    const alive = pool.find((b) => !dead.has(b.id));
    return alive ?? current;
  };

  /** Next live backend that is not the one that just failed. */
  const failoverFrom = (role: Backend): Backend | undefined =>
    pool.find((b) => b.id !== role.id && !dead.has(b.id));

  const callBackend = async (
    backend: Backend,
    role: WorkerRole,
    phase: "plan" | "act" | "synthesize",
    context: Envelope[],
    task?: BoundedTask,
    extra?: { step?: number; maxSteps?: number; nudge?: string },
  ): Promise<WorkerMessage> => {
    const invocation: RunReport["workersInvoked"][number] = { role, phase, backend: backend.id, taskId: task?.id };
    workersInvoked.push(invocation);
    const t0 = Date.now();
    try {
      const msg = await backend.complete({
        role,
        phase,
        trustedGoal: orch.goalText(),
        task,
        envelopes: context.filter((e) => e.trust === "untrusted"),
        system: extra?.nudge
          ? `${systemPromptFor(role, workerCount, { tools: planTools })}\n${extra.nudge}`
          : systemPromptFor(role, workerCount, { tools: planTools }),
        workspace: opts.workspace,
        step: extra?.step,
        maxSteps: extra?.maxSteps ?? task?.maxSteps,
        workerCount,
      });
      if (msg.usage) invocation.usage = msg.usage;
      // The model/effort the backend really used: `backend` is the slot id, the routing is the truth.
      if (msg.routing) invocation.routing = msg.routing;
      addRunUsage(usage, msg.usage);
      return msg;
    } finally {
      invocation.durationMs = Date.now() - t0;
    }
  };

  /** A worker's prose is inter-agent DATA: scanned, recorded, appended to ITS task's context. */
  const absorb = (msg: WorkerMessage, role: WorkerRole, context: Envelope[]) => {
    const inter = wrapUntrusted(msg.text, role, "inter_agent");
    orch.recordFinding(
      inter.injection ?? {
        detected: false,
        severity: "none",
        ruleIds: [],
        excerpts: [],
        channel: "inter_agent",
        origin: role,
      },
    );
    context.push(inter);
    orch.actorMayNotSetGoal(role, msg.newGoal);
    if (msg.claims) claims = mergeClaims(claims, normalizeClaims(msg.claims, sources));
  };

  /**
   * A backend failure is a value, not a rejection. Before this, one dead CLI (an expired
   * subscription, a timeout) took the whole run down with it — including the workers on a
   * perfectly healthy harness.
   */
  const invoke = async (
    role: WorkerRole,
    phase: "plan" | "act" | "synthesize",
    context: Envelope[],
    task?: BoundedTask,
    extra?: { step?: number; maxSteps?: number; nudge?: string },
  ): Promise<{ ok: true; msg: WorkerMessage } | { ok: false; reason: string; backend: string }> => {
    const backend = backendFor(role);
    try {
      const msg = await callBackend(backend, role, phase, context, task, extra);
      absorb(msg, role, context);
      return { ok: true, msg };
    } catch (err) {
      const reason = err instanceof BackendError ? `${err.kind}: ${err.message}` : String(err);
      dead.add(backend.id);
      const next = failoverFrom(backend);
      if (!next) return { ok: false, reason, backend: backend.id };
      switches.push({ role, from: backend.id, to: next.id, reason });
      assigned.set(role, next);
      try {
        const msg = await callBackend(next, role, phase, context, task, extra);
        absorb(msg, role, context);
        return { ok: true, msg };
      } catch (err2) {
        const reason2 =
          err2 instanceof BackendError ? `${err2.kind}: ${err2.message}` : String(err2);
        dead.add(next.id);
        return { ok: false, reason: `${reason} | failover ${next.id}: ${reason2}`, backend: next.id };
      }
    }
  };

  const consumeOverride = (): boolean => {
    const idx = decisionQ.findIndex((d) => d.type === "override");
    if (idx < 0) return false;
    const [d] = decisionQ.splice(idx, 1);
    orch.decide(d);
    return true;
  };

  const consumeApproval = (): OrchestratorDecision | undefined => {
    const idx = decisionQ.findIndex((d) => d.type === "approve" || d.type === "reject");
    if (idx < 0) return undefined;
    const [d] = decisionQ.splice(idx, 1);
    return d;
  };

  /**
   * A refusal the worker never hears about is a refusal it will repeat. Blocked calls go back
   * into the task's untrusted context exactly like executed ones, so the next step can correct
   * a bad tool name instead of the task quietly ending.
   */
  const noteBlocked = (call: ToolCall, reason: string, context: Envelope[], evidence: TaskResult["evidence"] | undefined) => {
    blocked.push({ tool: call.tool, args: call.args, reason });
    evidence?.calls.push({ callId: call.id, tool: call.tool, ok: false, durationMs: 0 });
    if (evidence) evidence.blocked += 1;
    context.push(wrapUntrusted(`blocked: ${call.tool} — ${reason}`, `tool:${call.tool}`, "tool_output"));
  };

  const runTool = async (call: ToolCall, context: Envelope[], evidence: TaskResult["evidence"] | undefined, taskArtifacts: string[], guard?: ToolGuard) => {
    const host = {
      workspace: opts.workspace,
      indexHome: opts.home,
      codeIndex: opts.codeIndex !== false,
      fetchImpl: opts.fetchImpl,
      approved,
      onRetrieved: (url: string, body: string) => {
        const env = wrapUntrusted(body, url, "retrieved");
        context.push(env);
        if (env.injection) orch.recordFinding(env.injection);
        sources.push({ url, retrievedAt: new Date().toISOString(), envelope: env });
      },
    };
    const started = Date.now();
    let result;
    try {
      result = await executeTool(call, host);
    } catch (err) {
      noteBlocked(call, String(err), context, evidence);
      guard?.after(call, false, String(err));
      return;
    }
    const durationMs = Date.now() - started;
    // The guard and the spill see the RAW output: shaping is a view for the model, never evidence.
    guard?.after(call, result.ok, result.raw ?? result.output);
    noteShaped(result.shaped);
    // Over the inline cap the full body goes to disk; the envelope keeps head + pointer + tail,
    // and the injection scan covers the whole body, not the visible part. A shaped output is
    // always written (force) so its "full output in <path>" line is true.
    const spilled = await spillToolResult(opts.workspace, call.id, result.raw ?? result.output, `tool:${call.tool}`, {
      inline: result.raw !== undefined ? result.output : undefined,
      force: result.shaped !== undefined,
      shaped: result.shaped,
    });
    const outEnv = wrapUntrusted(spilled.inline, `tool:${call.tool}`, "tool_output");
    if (spilled.injection.detected) outEnv.injection = spilled.injection;
    if (spilled.truncated) outEnv.truncated = true;
    context.push(outEnv);
    if (outEnv.injection?.detected) orch.recordFinding(outEnv.injection);
    evidence?.calls.push({
      callId: call.id,
      tool: call.tool,
      ok: result.ok,
      ...(result.artifact ? { artifact: result.artifact } : {}),
      durationMs,
      ...(spilled.outputPath ? { outputPath: spilled.outputPath } : {}),
      ...(result.shaped ? { shaped: result.shaped } : {}),
    });
    if (result.ok) {
      if (evidence) evidence.executed += 1;
      executed.push({
        tool: call.tool,
        args: call.args,
        artifact: result.artifact,
        output: spilled.inline,
        ...(spilled.outputPath ? { outputPath: spilled.outputPath } : {}),
        ...(result.shaped ? { shaped: result.shaped } : {}),
      });
      if (result.artifact) {
        artifacts.push(result.artifact);
        taskArtifacts.push(result.artifact);
      }
    } else {
      if (evidence) evidence.blocked += 1;
      blocked.push({ tool: call.tool, args: call.args, reason: spilled.inline });
    }
  };

  const handleMessageTools = async (
    msg: WorkerMessage,
    task: BoundedTask | undefined,
    role: WorkerRole,
    context: Envelope[],
    result: TaskResult | undefined,
    guard?: ToolGuard,
  ) => {
    const gateContext = context.filter((e) => e.trust === "untrusted");
    for (const draft of msg.toolCalls ?? []) {
      if (orch.isStopped()) return;
      callSeq += 1;
      const call: ToolCall = {
        id: `${role}-${draft.tool}-${callSeq}`,
        tool: draft.tool,
        args: draft.args ?? {},
        proposedBy: role,
        taskId: task?.id,
      };
      // Guardrails first: a call that already failed three times, or a loop with no progress, is
      // refused before the gate spends anything on it.
      const verdict = guard?.before(call) ?? {};
      if (verdict.block) {
        noteBlocked(call, verdict.block, context, result?.evidence);
        continue;
      }
      if (verdict.warn) context.push(wrapUntrusted(verdict.warn, "guardrails", "tool_output"));
      const gate = orch.proposeTool(call, gateContext, task?.allowedTools);
      if (gate.pendingApproval) {
        // A resumed run releases exactly the calls the human approved by hash, once each.
        const frozen = opts.resume?.approvedCallHashes;
        const h = callHash(call.tool, call.args);
        const decision = opts.autoApproveHighBlast
          ? { type: "approve" as const }
          : frozen?.has(h)
            ? (frozen.delete(h), { type: "approve" as const })
            : consumeApproval();
        if (decision) {
          const applied = orch.decide({ ...decision, approvalId: gate.approval?.id });
          if (decision.type === "approve" && applied.released) {
            approved.add(applied.released.id);
            await runTool(applied.released, context, result?.evidence, result?.artifacts ?? [], guard);
            continue;
          }
          noteBlocked(call, "approval_rejected", context, result?.evidence);
          guard?.after(call, false, "approval_rejected");
          continue;
        }
        if (gate.approval && result) result.pendingApprovalIds.push(gate.approval.id);
        noteBlocked(call, gate.reason ?? "awaiting_approval", context, result?.evidence);
        continue;
      }
      if (!gate.allowed) {
        noteBlocked(call, gate.reason ?? "blocked", context, result?.evidence);
        guard?.after(call, false, gate.reason ?? "blocked");
        continue;
      }
      await runTool(call, context, result?.evidence, result?.artifacts ?? [], guard);
    }
  };

  /** An answer we can act on: a tool call, a plan, or at minimum some prose. */
  const readable = (msg: WorkerMessage): boolean =>
    (msg.toolCalls?.length ?? 0) > 0 ||
    (msg.tasks?.length ?? 0) > 0 ||
    msg.text.trim().length > 0;

  const SCHEMA_NUDGE =
    "Your previous reply could not be read. Reply with ONE JSON object: { \"text\": string, \"toolCalls\": [{ \"tool\": string, \"args\": object }] }. Return an empty toolCalls array only if the task is genuinely finished.";

  /**
   * One act step, with a single reprompt when the answer is unreadable. An empty or truncated
   * stdout parses to `{ text: "" }` with no toolCalls, which used to be indistinguishable from
   * "the task is done" — so a CLI cut off mid-answer ended its task at step 1, silently.
   */
  const actStep = async (
    task: BoundedTask,
    step: number,
    limit: number,
    context: Envelope[],
  ): Promise<{ msg?: WorkerMessage; failed?: string }> => {
    const first = await invoke(task.assignee, "act", context, task, { step, maxSteps: limit });
    if (!first.ok) return { failed: first.reason };
    if (readable(first.msg)) return { msg: first.msg };
    const retry = await invoke(task.assignee, "act", context, task, {
      step,
      maxSteps: limit,
      nudge: SCHEMA_NUDGE,
    });
    if (!retry.ok) return { failed: retry.reason };
    if (!readable(retry.msg)) {
      return { failed: "worker returned no readable answer twice (empty text, no toolCalls)" };
    }
    return { msg: retry.msg };
  };

  /**
   * One bounded task, start to finish, with its own context: the goal, the results of the tasks
   * it depends on (as DATA), and only its own tool outputs and prose. No global heap: task e
   * does not re-read the 40k of tool output task a produced.
   */
  const runTask = async (task: BoundedTask, deps: TaskResult[]): Promise<TaskResult> => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const result: TaskResult = {
      taskId: task.id,
      assignee: task.assignee,
      backend: backendFor(task.assignee).id,
      status: "done",
      summary: "",
      artifacts: [],
      claims: [],
      evidence: { steps: 0, executed: 0, blocked: 0, calls: [] },
      pendingApprovalIds: [],
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
    };
    const context: Envelope[] = deps.map(taskResultEnvelope);
    const guard = new ToolGuard();
    const limit = Math.max(1, opts.maxSteps ?? task.maxSteps ?? DEFAULT_MAX_STEPS);
    let barren = 0;
    let stalledReason = "";
    let lastText = "";
    const before = task.acceptance?.expectArtifacts?.length
      ? await snapshotArtifacts(opts.workspace, task.acceptance.expectArtifacts).catch(() => [])
      : [];
    for (let step = 1; step <= limit; step++) {
      if (orch.isStopped()) break;
      result.evidence.steps = step;
      const res = await actStep(task, step, limit, context);
      if (res.failed || !res.msg) {
        stalledReason = res.failed ?? "no answer";
        break;
      }
      if (res.msg.text.trim()) lastText = res.msg.text.trim();
      const calls = res.msg.toolCalls ?? [];
      if (calls.length === 0) break;
      const executedBefore = result.evidence.executed;
      await handleMessageTools(res.msg, task, task.assignee, context, result, guard);
      if (result.evidence.executed === executedBefore) {
        // Everything it proposed was refused. Let it read the refusal and try once more
        // before we call the task finished.
        barren += 1;
        if (barren >= 2) break;
      } else {
        barren = 0;
      }
    }
    result.backend = backendFor(task.assignee).id;
    result.summary = lastText.slice(0, TASK_SUMMARY_MAX);
    result.claims = claims.filter((c) => !deps.some((d) => d.claims.includes(c)));
    if (stalledReason) {
      result.status = "stalled";
      result.reason = stalledReason;
      stalled.push({ taskId: task.id, assignee: task.assignee, backend: result.backend, reason: stalledReason });
    } else if (result.pendingApprovalIds.length > 0) {
      // A task that asked for an approval nobody gave is not done, whatever else it ran.
      result.status = "blocked";
      result.reason = `awaiting approval: ${result.pendingApprovalIds.join(", ")}`;
    } else if (task.acceptance) {
      // Acceptance: the plan said what "done" means; check it, do not take the worker's word.
      const failures: string[] = [];
      const acc: NonNullable<TaskResult["evidence"]["acceptance"]> = { ok: true, problems: [] };
      if (task.acceptance.requireTools && result.evidence.executed === 0) failures.push("no tool executed");
      if (before.length) {
        const untouched = await untouchedArtifacts(opts.workspace, before).catch(() => []);
        if (untouched.length) failures.push(`untouched: ${untouched.join(", ")}`);
      }
      if (task.acceptance.command) {
        callSeq += 1;
        const check: ToolCall = {
          id: `orchestrator-run_command-${callSeq}`,
          tool: "run_command",
          args: { cmd: task.acceptance.command, timeout_s: 120 },
          proposedBy: "orchestrator",
          taskId: task.id,
        };
        const t1 = Date.now();
        try {
          // executeTool → runCommandTool: the acceptance output is shaped like a worker's.
          const r = await executeTool(check, { workspace: opts.workspace, indexHome: opts.home });
          noteShaped(r.shaped);
          acc.command = { cmd: task.acceptance.command, ok: r.ok, output: r.output.slice(0, 500) };
          result.evidence.calls.push({ callId: check.id, tool: "run_command", ok: r.ok, durationMs: Date.now() - t1, ...(r.shaped ? { shaped: r.shaped } : {}) });
          if (!r.ok) failures.push(`check failed: ${task.acceptance.command}`);
        } catch (err) {
          failures.push(`check errored: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      acc.ok = failures.length === 0;
      acc.problems = failures;
      result.evidence.acceptance = acc;
      if (!acc.ok) {
        result.status = "failed";
        result.reason = `acceptance: ${failures.join("; ")}`;
      }
    }
    result.endedAt = new Date().toISOString();
    result.durationMs = Date.now() - t0;
    return result;
  };

  // PLAN (skipped on resume: the stored plan is the plan)
  const planner = SUBAGENT_ROLES[0];
  const planContext: Envelope[] = [];
  // The planner sees the repo map (paths + exported symbols, never a body line) as DATA. Task
  // contexts do NOT get code hits automatically: the gate rescans every untrusted envelope on
  // every call, and a workspace whose fixtures quote injections would block its own workers.
  if (codeIndex && !opts.resume) {
    const map = await repoMap(opts.home, opts.workspace, { goal: orch.goalText() });
    if (map) planContext.push(wrapUntrusted(map, "agentik:code", "retrieved"));
  }
  const planRes = opts.resume ? ({ ok: true, msg: { text: "resumed" } } as const) : await invoke(planner, "plan", planContext);
  const planMsg: WorkerMessage = planRes.ok ? planRes.msg : { text: "" };
  if (!planRes.ok) {
    stalled.push({ taskId: "plan", assignee: planner, backend: planRes.backend, reason: planRes.reason });
  }
  const fallback = buildPlan(orch.goalText(), workerCount, { codeIndex: indexOn });
  // The model's plan is DATA until it passes the schema. One reprompt names the problems; a second
  // bad plan hands over to the regex planner, and the report says so.
  let tasks: BoundedTask[] = fallback;
  const validateOpts = { workerCount, workspace: opts.workspace };
  const withDefaultTools = (t: BoundedTask, i: number): BoundedTask =>
    t.allowedTools.length ? t : { ...t, allowedTools: fallback[i]?.allowedTools ?? fallback[0]?.allowedTools ?? ["read_file"] };
  if (opts.resume) {
    tasks = opts.resume.tasks;
    planSource = "resumed";
  } else if (planRes.ok && planMsg.tasks) {
    const first = validatePlan(planMsg.tasks, validateOpts);
    if (first.ok) {
      tasks = first.tasks.map(withDefaultTools);
      planSource = "model";
    } else {
      planProblems = first.problems;
      const retry = await invoke(planner, "plan", planContext, undefined, { nudge: `PLAN_REJECTED: ${first.problems.join("; ")}. Reply with a corrected tasks[] only.` });
      const second = retry.ok && retry.msg.tasks ? validatePlan(retry.msg.tasks, validateOpts) : { ok: false as const, problems: [retry.ok ? "second plan had no tasks" : `planner unavailable: ${retry.reason}`] };
      if (second.ok) {
        tasks = second.tasks.map(withDefaultTools);
        planSource = "model_repaired";
      } else {
        planProblems = [...planProblems, ...second.problems.map((p) => `retry: ${p}`)];
        tasks = fallback;
        planSource = "fallback";
      }
    }
  }
  // One place for every plan source (model, repaired, fallback, resumed): a run without an index
  // never hands a worker a tool that can only be refused.
  tasks = tasks.map(dropSearchCode);
  orch.delegate(tasks);
  opts.onPlan?.(formatPlan(tasks, planSource, planProblems), tasks, planSource, planProblems);
  if (opts.planOnly) {
    orch.status = "planned";
    return report(orch, bits("plan only"));
  }

  if (consumeOverride() && orch.isStopped()) return report(orch, bits("overridden by orchestrator"));

  // ACT: the DAG scheduler runs independent tasks side by side (≤ concurrency, one per role); a
  // dependency that is not done blocks its dependants without a model call; a task waiting for
  // an approval blocks only its own dependants. Results come back in plan order.
  const syntheticResult = (task: BoundedTask, status: TaskResult["status"], reason: string): TaskResult => {
    const now = new Date().toISOString();
    return {
      taskId: task.id,
      assignee: task.assignee,
      backend: backendFor(task.assignee).id,
      status,
      reason,
      summary: "",
      artifacts: [],
      claims: [],
      evidence: { steps: 0, executed: 0, blocked: 0, calls: [] },
      pendingApprovalIds: [],
      startedAt: now,
      endedAt: now,
      durationMs: 0,
    };
  };
  const concurrency = Math.max(1, Math.min(MAX_SUBAGENTS, Math.floor(opts.concurrency ?? workerCount)));
  const prior = new Map((opts.resume?.priorResults ?? []).map((r) => [r.taskId, r]));
  const results = await runDag<BoundedTask, TaskResult>(orch.tasks, {
    concurrency,
    keyOf: (t) => t.assignee,
    run: (task, deps) => {
      // Resume: a task that is not being replayed keeps its stored result (its artifacts are on
      // disk, its summary is what the replayed tasks read as DATA).
      if (opts.resume && !opts.resume.onlyTaskIds.includes(task.id)) {
        const kept = prior.get(task.id);
        return Promise.resolve(kept ?? syntheticResult(task, "blocked", "not replayed and no stored result"));
      }
      return runTask(task, deps);
    },
    blocked: (task, missing) => syntheticResult(task, "blocked", `dependency not done: ${missing.join(", ")}`),
    shouldStop: () => orch.isStopped() || (consumeOverride() && orch.isStopped()),
    skipped: (task) => syntheticResult(task, "blocked", "run stopped before this task started"),
  });
  taskResults.push(...results);

  if (orch.isStopped()) return report(orch, bits("overridden by orchestrator"));

  // SYNTHESIZE (last assigned subagent): it reads the task results and the retrieved sources as
  // DATA, not the whole tool-output heap.
  orch.beginSynthesize();
  const synthesizer = SUBAGENT_ROLES[Math.max(0, workerCount - 1)];
  const synthContext: Envelope[] = [...taskResults.map(taskResultEnvelope), ...sources.map((s) => s.envelope)];
  const synthRes = await invoke(synthesizer, "synthesize", synthContext);
  if (synthRes.ok) {
    // The synthesis message's own toolCalls are NOT run: the final text is already written, so a
    // call made now cannot change it — it only costs a gate pass, an execution and a spill. The
    // synthesize prompt says so (`phaseDirective`), and the tools of every ACT step still run.
    synthesis = synthRes.msg.text;
  } else {
    synthesis = `synthesis unavailable: ${synthRes.reason}`;
    stalled.push({ taskId: "synthesize", assignee: synthesizer, backend: synthRes.backend, reason: synthRes.reason });
  }
  if (claims.length === 0 && sources.length > 0) {
    claims = normalizeClaims(
      [
        ...sources.map((s) => ({ text: s.envelope.body.slice(0, 200), sourceUrl: s.url })),
        { text: "Model statement with no recorded origin." },
      ],
      sources,
    );
  }
  orch.complete();

  return report(orch, bits(synthesis));
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * ` [opus/high]` after the backend id. Needed since the model follows the PHASE: the id of the slot
 * (`claude-sonnet`) no longer tells the reader which model planned the run.
 */
function formatRouting(r: WorkerInvocation["routing"]): string {
  if (!r || (!r.model && !r.effort)) return "";
  return ` [${[r.model, r.effort].filter(Boolean).join("/")}]`;
}

export function formatReport(r: RunReport): string {
  const lines = [
    "agentik 3-role run",
    // A stalled task outranks the orchestrator's own bookkeeping: something did not finish.
    `status: ${r.status}${r.stalledTasks.length ? " (STALLED)" : ""}`,
    `goal: ${r.goal?.text ?? "(none)"}`,
    `original_goal: ${r.originalGoalText}`,
    "workers:",
    ...r.workersInvoked.map(
      (w) => `  - ${w.role} (${w.backend}) ${w.phase}${w.taskId ? " " + w.taskId : ""}${formatRouting(w.routing)}${w.durationMs !== undefined ? ` ${fmtDuration(w.durationMs)}` : ""}${w.usage ? ` in=${w.usage.inputTokens} out=${w.usage.outputTokens}${w.usage.costUsd !== undefined ? ` $${w.usage.costUsd.toFixed(4)}` : ""}` : ""}`,
    ),
    `plan: ${r.planSource}${r.planProblems.length ? ` (${r.planProblems.length} problem(s) with the model plan)` : ""}`,
    "tasks:",
    ...r.tasks.map((t) => {
      const res = r.taskResults.find((x) => x.taskId === t.id);
      const acc = res?.evidence.acceptance;
      const bits = [
        `${t.id} ${t.assignee}`,
        `tools=${t.allowedTools.join(",")}`,
        ...(t.dependsOn?.length ? [`after=${t.dependsOn.join(",")}`] : []),
        ...(res ? [`${res.status}${res.reason ? ` (${res.reason})` : ""}`, fmtDuration(res.durationMs), `steps=${res.evidence.steps}`, `ran=${res.evidence.executed}`] : ["(not run)"]),
        ...(acc ? [`acceptance=${acc.ok ? "ok" : `FAILED: ${acc.problems.join("; ")}`}`] : []),
      ];
      return `  - ${bits.join(" · ")}`;
    }),
    "executed:",
    ...(r.executedTools.length
      ? r.executedTools.map((t) => `  - ${t.tool}${t.artifact ? " -> " + t.artifact : ""}${t.outputPath ? ` (full output: ${t.outputPath})` : ""}`)
      : ["  - (none)"]),
    "blocked:",
    ...(r.blockedTools.length
      ? r.blockedTools.map((t) => `  - ${t.tool} (${t.reason.split("\n")[0].slice(0, 160)})`)
      : ["  - (none)"]),
    ...(r.backendSwitches.length
      ? [
          "backend switches:",
          ...r.backendSwitches.map((b) => `  - ${b.role}: ${b.from} -> ${b.to} (${b.reason})`),
        ]
      : []),
    ...(r.stalledTasks.length
      ? [
          "STALLED (did not finish):",
          ...r.stalledTasks.map((t) => `  - ${t.taskId} ${t.assignee} (${t.backend}): ${t.reason}`),
        ]
      : []),
    "artifacts:",
    ...(r.artifacts.length ? r.artifacts.map((a) => `  - ${a}`) : ["  - (none)"]),
    "findings:",
    ...(r.findings.filter((f) => f.detected).length
      ? r.findings
          .filter((f) => f.detected)
          .map((f) => `  - ${f.severity} ${f.channel} ${f.origin} ${f.ruleIds.join(",")}`)
      : ["  - (none)"]),
    "claims:",
    ...(r.claims.length
      ? r.claims.map(
          (c) => `  - ${c.verified ? "verified" : "unverified"} ${c.source?.url ?? "(no source)"} :: ${String(c.text ?? "").slice(0, 80)}`,
        )
      : ["  - (none)"]),
    "synthesis:",
    ...(r.synthesis.trim() ? r.synthesis.trim().split("\n").map((l) => `  ${l}`) : ["  (none)"]),
  ];
  return lines.join("\n");
}

function report(
  orch: Orchestrator,
  bits: {
    workersInvoked: RunReport["workersInvoked"];
    executed: RunReport["executedTools"];
    blocked: RunReport["blockedTools"];
    artifacts: string[];
    sources: RetrievedSource[];
    stalled: StalledTask[];
    switches: BackendSwitch[];
    claims: RunReport["claims"];
    synthesis: string;
    planSource: RunReport["planSource"];
    planProblems: string[];
    taskResults: TaskResult[];
    usage: RunReport["usage"];
    shaping: NonNullable<RunReport["shaping"]>;
    codeIndex?: RunReport["codeIndex"];
    durationMs: number;
  },
): RunReport {
  return {
    status: orch.status,
    goal: orch.goal,
    originalGoalText: orch.originalGoalText,
    workersInvoked: bits.workersInvoked,
    tasks: orch.tasks,
    executedTools: bits.executed,
    blockedTools: bits.blocked,
    stalledTasks: bits.stalled,
    backendSwitches: bits.switches,
    pendingApprovals: orch.pendingApprovals,
    findings: orch.findings,
    claims: bits.claims,
    sources: bits.sources,
    artifacts: bits.artifacts,
    synthesis: bits.synthesis,
    events: orch.events,
    planSource: bits.planSource,
    planProblems: bits.planProblems,
    taskResults: bits.taskResults,
    usage: bits.usage && bits.usage.invocations + bits.usage.callsWithoutUsage > 0 ? bits.usage : undefined,
    shaping: { ...bits.shaping },
    ...(bits.codeIndex ? { codeIndex: bits.codeIndex } : {}),
    durationMs: bits.durationMs,
  };
}
