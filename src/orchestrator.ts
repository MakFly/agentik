import { detectInjection, isGoalHijack } from "./injection.ts";
import { blastForCall, specFor } from "./tools.ts";
import { wrapTrusted } from "./trust.ts";
import type {
  ApprovalRequest,
  BoundedTask,
  Envelope,
  GateResult,
  Goal,
  InjectionFinding,
  OrchEvent,
  OrchestratorDecision,
  Role,
  RunStatus,
  ToolCall,
} from "./types.ts";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function resetIdsForTests(): void {
  seq = 0;
}

/**
 * Pure-enough orchestrator state machine.
 * High-blast tools are a state (awaiting_approval), not a prompt suggestion.
 * Only the human orchestrator can submit/replace a goal or approve high-blast.
 */
export class Orchestrator {
  status: RunStatus = "idle";
  goal: Goal | null = null;
  originalGoalText = "";
  tasks: BoundedTask[] = [];
  pendingApprovals: ApprovalRequest[] = [];
  findings: InjectionFinding[] = [];
  events: OrchEvent[] = [];
  blockedUntilApproval = new Set<string>();

  private emit(type: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ at: new Date().toISOString(), type, detail });
  }

  submitGoal(text: string): { ok: boolean; finding?: InjectionFinding } {
    this.originalGoalText = text;
    const finding = detectInjection(text, "user_input", "orchestrator");
    if (finding.detected) this.findings.push(finding);
    if (isGoalHijack(finding)) {
      this.status = "rejected";
      this.emit("goal_rejected_injection", { ruleIds: finding.ruleIds });
      return { ok: false, finding };
    }
    this.goal = {
      id: nextId("goal"),
      text,
      submittedBy: "orchestrator",
      createdAt: new Date().toISOString(),
    };
    this.status = "planning";
    this.emit("goal_submitted", { goalId: this.goal.id });
    return { ok: true, finding: finding.detected ? finding : undefined };
  }

  trustedGoalEnvelope(): Envelope {
    return wrapTrusted(this.goal?.text ?? "", "orchestrator");
  }

  recordFinding(finding: InjectionFinding): void {
    if (finding.detected) this.findings.push(finding);
  }

  delegate(tasks: BoundedTask[]): void {
    if (this.status === "rejected" || this.status === "overridden") return;
    this.tasks = tasks;
    this.status = "delegating";
    this.emit("delegated", {
      tasks: tasks.map((t) => ({
        id: t.id,
        assignee: t.assignee,
        allowedTools: t.allowedTools,
      })),
    });
    this.status = "acting";
  }

  proposeTool(
    call: ToolCall,
    context: Envelope[],
    allowedTools: string[] | undefined,
  ): GateResult {
    const findings: InjectionFinding[] = [];
    const argBlob = JSON.stringify(call.args);
    const argFinding = detectInjection(argBlob, "inter_agent", `tool-args:${call.tool}`);
    if (argFinding.detected) findings.push(argFinding);

    for (const env of context) {
      const f =
        env.injection ?? detectInjection(env.body, env.channel, env.origin);
      if (f.detected) findings.push(f);
    }

    for (const f of findings) this.recordFinding(f);

    const spec = specFor(call.tool);
    if (!spec) {
      this.emit("tool_blocked", { tool: call.tool, reason: "unknown_tool" });
      return { allowed: false, pendingApproval: false, reason: "unknown_tool", findings };
    }

    const injected = findings.some((f) => f.detected);
    const blast = blastForCall(call.tool, call.args);
    const high = blast === "high";

    if (injected && high) {
      this.emit("tool_blocked", { tool: call.tool, reason: "injection_high_blast" });
      return {
        allowed: false,
        pendingApproval: false,
        reason: "injection_high_blast",
        findings,
      };
    }

    if (injected && findings.some((f) => isGoalHijack(f))) {
      this.emit("tool_blocked", { tool: call.tool, reason: "injection_goal_hijack" });
      return {
        allowed: false,
        pendingApproval: false,
        reason: "injection_goal_hijack",
        findings,
      };
    }

    if (allowedTools && !allowedTools.includes(call.tool)) {
      this.emit("tool_blocked", { tool: call.tool, reason: "not_in_allowlist" });
      return {
        allowed: false,
        pendingApproval: false,
        reason: "not_in_allowlist",
        findings,
      };
    }

    if (high) {
      const approval: ApprovalRequest = {
        id: nextId("approval"),
        toolCall: call,
        reason: `high-blast-radius tool ${call.tool} requires orchestrator approval`,
      };
      this.pendingApprovals.push(approval);
      this.blockedUntilApproval.add(call.id);
      this.status = "awaiting_approval";
      this.emit("approval_pending", { approvalId: approval.id, tool: call.tool });
      return {
        allowed: false,
        pendingApproval: true,
        reason: "awaiting_approval",
        approval,
        findings,
      };
    }

    this.emit("tool_allowed", { tool: call.tool, blast });
    return { allowed: true, pendingApproval: false, findings };
  }

  decide(decision: OrchestratorDecision): {
    applied: boolean;
    released?: ToolCall;
  } {
    if (decision.type === "override") {
      if (decision.overrideAction === "redirect" && decision.redirectGoal) {
        const prev = this.goal?.text;
        this.goal = {
          id: nextId("goal"),
          text: decision.redirectGoal,
          submittedBy: "orchestrator",
          createdAt: new Date().toISOString(),
        };
        this.status = "planning";
        this.emit("overridden_redirect", { from: prev, to: this.goal.text });
        return { applied: true };
      }
      this.status = "overridden";
      this.emit("overridden_stop", {});
      return { applied: true };
    }

    const target =
      this.pendingApprovals.find((a) => a.id === decision.approvalId) ??
      this.pendingApprovals[0];
    if (!target) return { applied: false };

    if (decision.type === "reject") {
      this.pendingApprovals = this.pendingApprovals.filter((a) => a.id !== target.id);
      this.emit("approval_rejected", { approvalId: target.id, tool: target.toolCall.tool });
      if (this.pendingApprovals.length === 0 && this.status === "awaiting_approval") {
        this.status = "acting";
      }
      return { applied: true };
    }

    this.pendingApprovals = this.pendingApprovals.filter((a) => a.id !== target.id);
    this.blockedUntilApproval.delete(target.toolCall.id);
    this.emit("approval_granted", { approvalId: target.id, tool: target.toolCall.tool });
    if (this.status === "awaiting_approval") this.status = "acting";
    return { applied: true, released: target.toolCall };
  }

  beginSynthesize(): void {
    if (this.status === "overridden" || this.status === "rejected") return;
    this.status = "synthesizing";
  }

  complete(): void {
    if (this.status === "overridden" || this.status === "rejected") return;
    if (this.pendingApprovals.length > 0) {
      this.status = "awaiting_approval";
      return;
    }
    this.status = "completed";
    this.emit("completed", {});
  }

  isStopped(): boolean {
    return this.status === "overridden" || this.status === "rejected";
  }

  goalText(): string {
    return this.goal?.text ?? this.originalGoalText;
  }

  actorMayNotSetGoal(from: Role, attempted: string | undefined): void {
    if (!attempted) return;
    const finding = detectInjection(
      `new goal: ${attempted}`,
      "inter_agent",
      from,
    );
    finding.detected = true;
    if (!finding.ruleIds.includes("goal_hijack")) finding.ruleIds.push("goal_hijack");
    finding.severity = "high";
    this.recordFinding(finding);
    this.emit("worker_goal_mutation_ignored", { from, attempted });
  }
}
