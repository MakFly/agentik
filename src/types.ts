export const MAX_SUBAGENTS = 5;
export const SUBAGENT_ROLES = [
  "worker_a",
  "worker_b",
  "worker_c",
  "worker_d",
  "worker_e",
] as const;
export type WorkerRole = (typeof SUBAGENT_ROLES)[number];
/** `reviewer` is the background review fork — the only role allowed to write memory or skills. */
export type Role = "orchestrator" | "reviewer" | WorkerRole;

/** Auto-run steps per bounded task. Four was never enough for real work. */
export const DEFAULT_MAX_STEPS = 8;

/**
 * A task summary the synthesizer (and a dependent task) reads: prose is capped, never the whole log.
 *
 * It lives here, in a leaf module, because BOTH ends need it: `loop.ts` truncates the last text to
 * it, and `backends.ts` tells the worker the budget in the act prompt — measured live, the final
 * tool-less invocation of a task spent 34-42s writing 4k output tokens of which more than half was
 * cut here and paid for anyway. `loop.ts` re-exports it, so no existing import moves.
 */
export const TASK_SUMMARY_MAX = 2000;

/**
 * Longest instruction a plan may give a task. Here, in the same leaf, for the same reason: the
 * validator (`plan-schema.ts`, which re-exports it) enforces it and the planner prompt
 * (`backends.ts`) announces it, and `backends.ts` cannot import `plan-schema.ts` — that would close
 * the cycle backends → plan-schema → tools → backends.
 */
export const INSTRUCTION_MAX = 2000;

export function clampSubagentCount(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.min(MAX_SUBAGENTS, Math.max(1, Math.floor(n)));
}

export function isWorkerRole(value: string): value is WorkerRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(value);
}

/** Four on-property names per slot. Still 5 spawn slots, not 20. */
export const FRANCHISE_LABELS = {
  fifthElement: "Fifth Element",
  starWars: "Star Wars",
  matrix: "Matrix",
  bttf: "Retour vers le futur",
} as const;

export const CREW_NAMES = {
  worker_a: {
    job: "implement",
    fifthElement: "Korben",
    starWars: "Luke",
    matrix: "Neo",
    bttf: "Marty",
  },
  worker_b: {
    job: "verify",
    fifthElement: "Leeloo",
    starWars: "Leia",
    matrix: "Trinity",
    bttf: "Doc",
  },
  worker_c: {
    job: "debug",
    fifthElement: "Cornelius",
    starWars: "Han",
    matrix: "Morpheus",
    bttf: "Biff",
  },
  worker_d: {
    job: "research",
    fifthElement: "Ruby Rhod",
    starWars: "Yoda",
    matrix: "Oracle",
    bttf: "George",
  },
  worker_e: {
    job: "ops",
    fifthElement: "Zorg",
    starWars: "Vader",
    matrix: "Agent Smith",
    bttf: "Lorraine",
  },
} as const;

function crewAliasMap(): Record<string, WorkerRole> {
  const aliases: Record<string, WorkerRole> = {
    worker_a: "worker_a",
    a: "worker_a",
    "1": "worker_a",
    worker_1: "worker_a",
    "agentik-worker-a": "worker_a",
    worker_b: "worker_b",
    b: "worker_b",
    "2": "worker_b",
    worker_2: "worker_b",
    "agentik-worker-b": "worker_b",
    worker_c: "worker_c",
    c: "worker_c",
    "3": "worker_c",
    worker_3: "worker_c",
    "agentik-worker-c": "worker_c",
    worker_d: "worker_d",
    d: "worker_d",
    "4": "worker_d",
    worker_4: "worker_d",
    "agentik-worker-d": "worker_d",
    worker_e: "worker_e",
    e: "worker_e",
    "5": "worker_e",
    worker_5: "worker_e",
    "agentik-worker-e": "worker_e",
  };
  for (const role of SUBAGENT_ROLES) {
    const n = CREW_NAMES[role];
    for (const raw of [n.fifthElement, n.starWars, n.matrix, n.bttf]) {
      aliases[raw.toLowerCase()] = role;
    }
  }
  return aliases;
}

const CREW_ALIASES = crewAliasMap();

/** Strict: a name that is not a worker or a crew alias is undefined, never worker_a. */
export function resolveWorkerRole(value: string): WorkerRole | undefined {
  return CREW_ALIASES[value.trim().toLowerCase()];
}

export function normalizeWorkerRole(value: string): WorkerRole {
  const v = value.trim().toLowerCase();
  return CREW_ALIASES[v] ?? "worker_a";
}
export type TrustTier = "trusted" | "untrusted";
export type BlastRadius = "low" | "medium" | "high";
export type Channel = "user_input" | "retrieved" | "tool_output" | "inter_agent";
export type Phase = "plan" | "act" | "synthesize";
export type RunStatus =
  | "idle"
  | "planning"
  | "planned"
  | "delegating"
  | "acting"
  | "awaiting_approval"
  | "synthesizing"
  | "completed"
  | "blocked"
  | "overridden"
  | "rejected";

export interface Goal {
  id: string;
  text: string;
  submittedBy: "orchestrator";
  createdAt: string;
}

/** What proves a task done, beyond "the worker stopped proposing tools". */
export interface TaskAcceptance {
  /** Workspace paths that must be created, modified or deleted by the task. */
  expectArtifacts?: string[];
  /** The task must have executed at least one tool. */
  requireTools?: boolean;
  /** A medium command run by the orchestrator after the task; exit 0 = accepted. */
  command?: string;
}

export interface BoundedTask {
  id: string;
  assignee: WorkerRole;
  instruction: string;
  allowedTools: string[];
  maxSteps: number;
  /** Task ids that must be done first. */
  dependsOn?: string[];
  acceptance?: TaskAcceptance;
}

export interface Envelope {
  trust: TrustTier;
  origin: string;
  nonce: string;
  body: string;
  channel: Channel;
  injection?: InjectionFinding;
  /** The body is head + pointer + tail of a larger tool output spilled to disk. */
  truncated?: boolean;
}

export interface InjectionFinding {
  detected: boolean;
  severity: "none" | "low" | "medium" | "high";
  ruleIds: string[];
  excerpts: string[];
  channel: Channel;
  origin: string;
}

export interface ToolSpec {
  name: string;
  blastRadius: BlastRadius;
  description: string;
}

export interface ToolCallDraft {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  proposedBy: Role;
  taskId?: string;
}

/** A run_command output rewritten by a shaper (src/shape.ts): which one, and how many chars it saved. */
export interface ShapedInfo {
  shaper: string;
  savedChars: number;
}

export interface ExecutedTool {
  tool: string;
  args: Record<string, unknown>;
  artifact?: string;
  /** Inline output (head + pointer + tail when spilled; the shaped text when a shaper applied). */
  output: string;
  /** Workspace-relative file holding the full raw output, when it exceeded the inline cap or was shaped. */
  outputPath?: string;
  shaped?: ShapedInfo;
}

export interface BlockedTool {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  /** What the worker sees inline (the shaped text when `shaped` is set). */
  output: string;
  artifact?: string;
  /** The unshaped output (exit line + stdout + stderr), only when a shaper applied. */
  raw?: string;
  shaped?: ShapedInfo;
}

export interface ClaimDraft {
  text: string;
  sourceUrl?: string | null;
}

export interface Claim {
  text: string;
  source?: { url: string; retrievedAt: string };
  verified: boolean;
}

export interface ApprovalRequest {
  id: string;
  toolCall: ToolCall;
  reason: string;
}

export interface OrchestratorDecision {
  type: "approve" | "reject" | "override";
  approvalId?: string;
  overrideAction?: "stop" | "redirect";
  redirectGoal?: string;
}

export interface GateResult {
  allowed: boolean;
  pendingApproval: boolean;
  reason?: string;
  approval?: ApprovalRequest;
  findings: InjectionFinding[];
}

export interface RetrievedSource {
  url: string;
  retrievedAt: string;
  envelope: Envelope;
}

export interface WorkerInvocation {
  role: WorkerRole;
  phase: Phase;
  backend: string;
  taskId?: string;
  /** Wall clock of this model call. */
  durationMs?: number;
  /** What the CLI reported for this call, when it did. */
  usage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number; costUsd?: number; turns: number; durationMs?: number };
  /**
   * Model and reasoning effort this call really ran with (`src/routing.ts`). `backend` is the slot's
   * id and no longer implies the model — claude plans with opus and works with sonnet under both
   * `claude-sonnet` and `claude-opus` — so a run report that says `worker_a (claude-sonnet) plan`
   * would be unreadable without this.
   */
  routing?: { model?: string; effort?: string };
}

/** A bounded task that ran out of usable answers instead of finishing. */
export interface StalledTask {
  taskId: string;
  assignee: WorkerRole;
  backend: string;
  reason: string;
}

/** A worker whose backend died mid-run and was handed to another one. */
export interface BackendSwitch {
  role: WorkerRole;
  from: string;
  to: string;
  reason: string;
}

export interface OrchEvent {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

/** One tool call of a task, as evidence: what ran, whether it worked, how long, where the full output is. */
export interface TaskCallEvidence {
  callId: string;
  tool: string;
  ok: boolean;
  artifact?: string;
  durationMs: number;
  outputPath?: string;
  shaped?: ShapedInfo;
}

export interface TaskAcceptanceResult {
  ok: boolean;
  problems: string[];
  command?: { cmd: string; ok: boolean; output: string };
}

/**
 * What one bounded task actually did. `done` = the worker finished (empty toolCalls or maxSteps)
 * and the acceptance, if any, passed; `stalled` = no usable answer; `blocked` = a dependency did
 * not finish, or every call waits for an approval; `failed` = the acceptance said no.
 */
export interface TaskResult {
  taskId: string;
  assignee: WorkerRole;
  backend: string;
  /**
   * `refused`: the task was allowed to mutate the workspace, the worker answered, and nothing
   * moved on disk. A polite "I did not do it" is a failure, not a delivery — the trigger is
   * structural (mutation declared, mutation nil), never a keyword in the prose.
   */
  status: "done" | "stalled" | "blocked" | "failed" | "refused";
  reason?: string;
  /** The worker's last prose, ≤ 2000 chars. */
  summary: string;
  artifacts: string[];
  claims: Claim[];
  evidence: {
    steps: number;
    executed: number;
    blocked: number;
    calls: TaskCallEvidence[];
    acceptance?: TaskAcceptanceResult;
  };
  pendingApprovalIds: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface RunReport {
  status: RunStatus;
  goal: Goal | null;
  originalGoalText: string;
  workersInvoked: WorkerInvocation[];
  tasks: BoundedTask[];
  executedTools: ExecutedTool[];
  blockedTools: BlockedTool[];
  stalledTasks: StalledTask[];
  backendSwitches: BackendSwitch[];
  pendingApprovals: ApprovalRequest[];
  findings: InjectionFinding[];
  claims: Claim[];
  sources: RetrievedSource[];
  artifacts: string[];
  synthesis: string;
  events: OrchEvent[];
  /** Where the plan came from: the model, the model after one PLAN_REJECTED reprompt, the regex planner, or a resumed run. */
  planSource: "model" | "model_repaired" | "fallback" | "resumed";
  /**
   * The code index this run refreshed — or built on first use — at start. Absent when the
   * workspace has none and none was built (`reason`: disabled | depth | too_big | failed).
   */
  codeIndex?: { files: number; chunks: number; changed: number; built: boolean; ms: number; reason?: string };
  /** Why the model plan(s) were rejected, when they were. */
  planProblems: string[];
  /** One structured result per planned task, in plan order. */
  taskResults: TaskResult[];
  /** Tokens / cost over every model invocation of the run (undefined when nothing was reported). */
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd?: number; invocations: number; callsWithoutUsage: number };
  /** run_command outputs rewritten by a shaper over the whole run (acceptance commands included). */
  shaping?: { calls: number; savedChars: number };
  /** Wall clock of the whole run. */
  durationMs: number;
}

export interface GoalClass {
  code: boolean;
  ops: boolean;
  research: boolean;
  highBlast: boolean;
}

export interface WorkerMessage {
  text: string;
  tasks?: Array<{
    id?: string;
    assignee: WorkerRole;
    instruction: string;
    allowedTools?: string[];
    maxSteps?: number;
    dependsOn?: string[];
    acceptance?: TaskAcceptance;
  }>;
  toolCalls?: ToolCallDraft[];
  claims?: ClaimDraft[];
  newGoal?: string;
  /** Filled by live backends from the CLI's own output; never by the model. */
  usage?: WorkerInvocation["usage"];
  /** Filled by live backends from the argv they built; never by the model. */
  routing?: WorkerInvocation["routing"];
}

/** The review's bounded task: same shape as a worker task, assignee `reviewer`. */
export interface ReviewTask {
  id: "review";
  assignee: "reviewer";
  instruction: string;
  allowedTools: string[];
  maxSteps: number;
}

export interface CompleteRequest {
  /** A worker role, or `reviewer` for the background review (no backend branches on it). */
  role: WorkerRole | "reviewer";
  phase: Phase;
  trustedGoal: string;
  task?: BoundedTask | ReviewTask;
  envelopes: Envelope[];
  system: string;
  workspace?: string;
  step?: number;
  maxSteps?: number;
  workerCount?: number;
}

export interface Backend {
  readonly id: string;
  complete(request: CompleteRequest): Promise<WorkerMessage>;
}

export type FetchImpl = (url: string) => Promise<{ url: string; body: string }>;
