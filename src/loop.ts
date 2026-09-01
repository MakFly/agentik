import { BackendError, systemPromptFor } from "./backends.ts";
import { Orchestrator } from "./orchestrator.ts";
import { buildPlan } from "./plan.ts";
import { normalizeClaims } from "./sources.ts";
import { executeTool } from "./tools.ts";
import { wrapUntrusted } from "./trust.ts";
import type {
  Backend,
  BackendSwitch,
  BoundedTask,
  Envelope,
  FetchImpl,
  OrchestratorDecision,
  RetrievedSource,
  RunReport,
  StalledTask,
  ToolCall,
  WorkerMessage,
  WorkerRole,
} from "./types.ts";
import {
  clampSubagentCount,
  DEFAULT_MAX_STEPS,
  MAX_SUBAGENTS,
  normalizeWorkerRole,
  SUBAGENT_ROLES,
} from "./types.ts";

export { DEFAULT_MAX_STEPS };

export interface LoopConfig {
  goal: string;
  workspace: string;
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
}

function workerPool(opts: LoopConfig): Backend[] {
  const extra = opts.workers ?? [];
  const pool = extra.length > 0 ? extra : [opts.workerA, opts.workerB];
  return pool.slice(0, MAX_SUBAGENTS);
}

export async function runLoop(opts: LoopConfig): Promise<RunReport> {
  const orch = new Orchestrator();
  const envelopes: Envelope[] = [];
  const sources: RetrievedSource[] = [];
  const executed: RunReport["executedTools"] = [];
  const blocked: RunReport["blockedTools"] = [];
  const artifacts: string[] = [];
  const workersInvoked: RunReport["workersInvoked"] = [];
  const stalled: StalledTask[] = [];
  const switches: BackendSwitch[] = [];
  const decisionQ = [...(opts.decisions ?? [])];
  let claimDrafts: RunReport["claims"] = [];
  let synthesis = "";

  const submitted = orch.submitGoal(opts.goal);
  if (!submitted.ok) {
    return report(orch, {
      workersInvoked,
      executed,
      blocked,
      artifacts,
      sources,
      stalled,
      switches,
      claims: [],
      synthesis: "goal rejected: prompt injection / goal hijack",
    });
  }

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
    task?: BoundedTask,
    extra?: { step?: number; maxSteps?: number; nudge?: string },
  ): Promise<WorkerMessage> => {
    workersInvoked.push({ role, phase, backend: backend.id, taskId: task?.id });
    return backend.complete({
      role,
      phase,
      trustedGoal: orch.goalText(),
      task,
      envelopes: envelopes.filter((e) => e.trust === "untrusted"),
      system: extra?.nudge
        ? `${systemPromptFor(role, workerCount)}\n${extra.nudge}`
        : systemPromptFor(role, workerCount),
      workspace: opts.workspace,
      step: extra?.step,
      maxSteps: extra?.maxSteps ?? task?.maxSteps,
      workerCount,
    });
  };

  const absorb = (msg: WorkerMessage, role: WorkerRole) => {
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
    envelopes.push(inter);
    orch.actorMayNotSetGoal(role, msg.newGoal);
    if (msg.claims) {
      claimDrafts = normalizeClaims(msg.claims, sources);
    }
  };

  /**
   * A backend failure is a value, not a rejection. Before this, one dead CLI (an expired
   * subscription, a timeout) took the whole run down with it — including the workers on a
   * perfectly healthy harness.
   */
  const invoke = async (
    role: WorkerRole,
    phase: "plan" | "act" | "synthesize",
    task?: BoundedTask,
    extra?: { step?: number; maxSteps?: number; nudge?: string },
  ): Promise<{ ok: true; msg: WorkerMessage } | { ok: false; reason: string; backend: string }> => {
    const backend = backendFor(role);
    try {
      const msg = await callBackend(backend, role, phase, task, extra);
      absorb(msg, role);
      return { ok: true, msg };
    } catch (err) {
      const reason = err instanceof BackendError ? `${err.kind}: ${err.message}` : String(err);
      dead.add(backend.id);
      const next = failoverFrom(backend);
      if (!next) return { ok: false, reason, backend: backend.id };
      switches.push({ role, from: backend.id, to: next.id, reason });
      assigned.set(role, next);
      try {
        const msg = await callBackend(next, role, phase, task, extra);
        absorb(msg, role);
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

  const host = {
    workspace: opts.workspace,
    fetchImpl: opts.fetchImpl,
    onRetrieved: (url: string, body: string) => {
      const env = wrapUntrusted(body, url, "retrieved");
      envelopes.push(env);
      if (env.injection) orch.recordFinding(env.injection);
      sources.push({ url, retrievedAt: new Date().toISOString(), envelope: env });
    },
  };

  /**
   * A refusal the worker never hears about is a refusal it will repeat. Blocked calls go back
   * into the untrusted context exactly like executed ones, so the next step can correct a bad
   * tool name instead of the task quietly ending.
   */
  const noteBlocked = (call: ToolCall, reason: string) => {
    blocked.push({ tool: call.tool, args: call.args, reason });
    const env = wrapUntrusted(
      `blocked: ${call.tool} — ${reason}`,
      `tool:${call.tool}`,
      "tool_output",
    );
    envelopes.push(env);
  };

  const handleMessageTools = async (msg: WorkerMessage, task: BoundedTask | undefined, role: WorkerRole) => {
    const context = envelopes.filter((e) => e.trust === "untrusted");
    for (const draft of msg.toolCalls ?? []) {
      if (orch.isStopped()) return;
      const call: ToolCall = {
        id: `${role}-${draft.tool}-${executed.length + blocked.length}`,
        tool: draft.tool,
        args: draft.args ?? {},
        proposedBy: role,
        taskId: task?.id,
      };
      const gate = orch.proposeTool(call, context, task?.allowedTools);
      if (gate.pendingApproval) {
        const decision = opts.autoApproveHighBlast
          ? { type: "approve" as const }
          : consumeApproval();
        if (decision) {
          const applied = orch.decide({ ...decision, approvalId: gate.approval?.id });
          if (decision.type === "approve" && applied.released) {
            await runTool(applied.released);
            continue;
          }
          noteBlocked(call, "approval_rejected");
          continue;
        }
        noteBlocked(call, gate.reason ?? "awaiting_approval");
        continue;
      }
      if (!gate.allowed) {
        noteBlocked(call, gate.reason ?? "blocked");
        continue;
      }
      await runTool(call);
    }
  };

  const runTool = async (call: ToolCall) => {
    let result;
    try {
      result = await executeTool(call, host);
    } catch (err) {
      noteBlocked(call, String(err));
      return;
    }
    const outEnv = wrapUntrusted(result.output, `tool:${call.tool}`, "tool_output");
    envelopes.push(outEnv);
    if (outEnv.injection) orch.recordFinding(outEnv.injection);
    if (result.ok) {
      executed.push({
        tool: call.tool,
        args: call.args,
        artifact: result.artifact,
        output: result.output,
      });
      if (result.artifact) artifacts.push(result.artifact);
    } else {
      blocked.push({ tool: call.tool, args: call.args, reason: result.output });
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
  ): Promise<{ msg?: WorkerMessage; failed?: string }> => {
    const first = await invoke(task.assignee, "act", task, { step, maxSteps: limit });
    if (!first.ok) return { failed: first.reason };
    if (readable(first.msg)) return { msg: first.msg };
    const retry = await invoke(task.assignee, "act", task, {
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

  // PLAN
  const planner = SUBAGENT_ROLES[0];
  const planRes = await invoke(planner, "plan");
  const planMsg: WorkerMessage = planRes.ok ? planRes.msg : { text: "" };
  if (!planRes.ok) {
    stalled.push({
      taskId: "plan",
      assignee: planner,
      backend: planRes.backend,
      reason: planRes.reason,
    });
  }
  const fallback = buildPlan(orch.goalText(), workerCount);
  let tasks: BoundedTask[] =
    planMsg.tasks && planMsg.tasks.length >= Math.min(2, workerCount)
      ? planMsg.tasks.slice(0, MAX_SUBAGENTS).map((t, i) => ({
          id: `task-${i + 1}`,
          assignee: normalizeWorkerRole(t.assignee),
          instruction: t.instruction,
          allowedTools: t.allowedTools ?? fallback[i]?.allowedTools ?? [],
          maxSteps: t.maxSteps ?? DEFAULT_MAX_STEPS,
        }))
      : fallback;

  tasks = tasks.slice(0, workerCount);
  if (tasks.length < workerCount) {
    tasks = fallback;
  }
  orch.delegate(tasks);

  if (consumeOverride() && orch.isStopped()) {
    return report(orch, {
      workersInvoked,
      executed,
      blocked,
      artifacts,
      sources,
      stalled,
      switches,
      claims: claimDrafts,
      synthesis: "overridden by orchestrator",
    });
  }

  // ACT: auto-run each bounded task until empty toolCalls, stall, or maxSteps.
  for (const task of orch.tasks) {
    if (orch.isStopped()) break;
    if (consumeOverride() && orch.isStopped()) break;
    const limit = Math.max(1, opts.maxSteps ?? task.maxSteps ?? DEFAULT_MAX_STEPS);
    let barren = 0;
    let stalledReason = "";
    for (let step = 1; step <= limit; step++) {
      if (orch.isStopped()) break;
      const res = await actStep(task, step, limit);
      if (res.failed || !res.msg) {
        stalledReason = res.failed ?? "no answer";
        break;
      }
      const calls = res.msg.toolCalls ?? [];
      if (calls.length === 0) break;
      const before = executed.length;
      await handleMessageTools(res.msg, task, task.assignee);
      if (executed.length === before) {
        // Everything it proposed was refused. Let it read the refusal and try once more
        // before we call the task finished.
        barren += 1;
        if (barren >= 2) break;
      } else {
        barren = 0;
      }
    }
    if (stalledReason) {
      stalled.push({
        taskId: task.id,
        assignee: task.assignee,
        backend: backendFor(task.assignee).id,
        reason: stalledReason,
      });
    }
  }

  if (orch.isStopped()) {
    return report(orch, {
      workersInvoked,
      executed,
      blocked,
      artifacts,
      sources,
      stalled,
      switches,
      claims: claimDrafts,
      synthesis: "overridden by orchestrator",
    });
  }

  // SYNTHESIZE (last assigned subagent)
  orch.beginSynthesize();
  const synthesizer = SUBAGENT_ROLES[Math.max(0, workerCount - 1)];
  const synthRes = await invoke(synthesizer, "synthesize");
  if (synthRes.ok) {
    synthesis = synthRes.msg.text;
    await handleMessageTools(synthRes.msg, undefined, synthesizer);
  } else {
    synthesis = `synthesis unavailable: ${synthRes.reason}`;
    stalled.push({
      taskId: "synthesize",
      assignee: synthesizer,
      backend: synthRes.backend,
      reason: synthRes.reason,
    });
  }
  if (claimDrafts.length === 0 && sources.length > 0) {
    claimDrafts = normalizeClaims(
      [
        ...sources.map((s) => ({ text: s.envelope.body.slice(0, 200), sourceUrl: s.url })),
        { text: "Model statement with no recorded origin." },
      ],
      sources,
    );
  }
  orch.complete();

  return report(orch, {
    workersInvoked,
    executed,
    blocked,
    artifacts,
    sources,
    stalled,
    switches,
    claims: claimDrafts,
    synthesis,
  });
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
      (w) => `  - ${w.role} (${w.backend}) ${w.phase}${w.taskId ? " " + w.taskId : ""}`,
    ),
    "tasks:",
    ...r.tasks.map((t) => `  - ${t.id} ${t.assignee} tools=${t.allowedTools.join(",")}`),
    "executed:",
    ...(r.executedTools.length
      ? r.executedTools.map((t) => `  - ${t.tool}${t.artifact ? " -> " + t.artifact : ""}`)
      : ["  - (none)"]),
    "blocked:",
    ...(r.blockedTools.length
      ? r.blockedTools.map((t) => `  - ${t.tool} (${t.reason})`)
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
          (c) => `  - ${c.verified ? "verified" : "unverified"} ${c.source?.url ?? "(no source)"} :: ${c.text.slice(0, 80)}`,
        )
      : ["  - (none)"]),
    `synthesis: ${r.synthesis.slice(0, 200)}`,
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
  };
}
