export const MAX_SUBAGENTS = 5;
export const SUBAGENT_ROLES = [
  "worker_a",
  "worker_b",
  "worker_c",
  "worker_d",
  "worker_e",
] as const;
export type WorkerRole = (typeof SUBAGENT_ROLES)[number];
export type Role = "orchestrator" | WorkerRole;

/** Auto-run steps per bounded task. Four was never enough for real work. */
export const DEFAULT_MAX_STEPS = 8;

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

export interface BoundedTask {
  id: string;
  assignee: WorkerRole;
  instruction: string;
  allowedTools: string[];
  maxSteps: number;
}

export interface Envelope {
  trust: TrustTier;
  origin: string;
  nonce: string;
  body: string;
  channel: Channel;
  injection?: InjectionFinding;
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

export interface ExecutedTool {
  tool: string;
  args: Record<string, unknown>;
  artifact?: string;
  output: string;
}

export interface BlockedTool {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
  artifact?: string;
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
    assignee: WorkerRole;
    instruction: string;
    allowedTools?: string[];
    maxSteps?: number;
  }>;
  toolCalls?: ToolCallDraft[];
  claims?: ClaimDraft[];
  newGoal?: string;
}

export interface CompleteRequest {
  role: WorkerRole;
  phase: Phase;
  trustedGoal: string;
  task?: BoundedTask;
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
