import { classifyGoal, defaultAllowedTools, buildPlan } from "./plan.ts";
import type { Backend, CompleteRequest, ToolCallDraft, WorkerMessage, WorkerRole } from "./types.ts";

export interface MockOptions {
  id?: string;
  followUntrusted?: boolean;
  compromise?: { text?: string; toolCalls?: ToolCallDraft[] };
  /**
   * Test hook: the act phase of this role answers like a CLI cut off mid-reply (empty text,
   * no toolCalls) every time, so the loop's single reprompt fails too and the task stalls.
   */
  stall?: WorkerRole;
}

/**
 * Deterministic backend used by tests and `--backend mock`.
 * When `followUntrusted` is set it mimics a compromised model that obeys
 * injected tool requests — the loop must still refuse them.
 */
export class MockBackend implements Backend {
  readonly id: string;
  readonly followUntrusted: boolean;
  readonly compromise?: MockOptions["compromise"];
  readonly stall?: WorkerRole;

  constructor(opts: MockOptions = {}) {
    this.id = opts.id ?? "mock";
    this.followUntrusted = opts.followUntrusted ?? false;
    this.compromise = opts.compromise;
    this.stall = opts.stall;
  }

  async complete(request: CompleteRequest): Promise<WorkerMessage> {
    if (request.phase === "act" && this.stall !== undefined && request.role === this.stall) {
      return { text: "", toolCalls: [] };
    }

    if (request.phase === "plan") {
      const tasks = buildPlan(request.trustedGoal, request.workerCount ?? 2).map((t) => ({
        assignee: t.assignee,
        instruction: t.instruction,
        allowedTools: t.allowedTools,
        maxSteps: t.maxSteps,
      }));
      return { text: `plan for: ${request.trustedGoal}`, tasks };
    }

    if (request.phase === "synthesize") {
      const claims = [];
      for (const env of request.envelopes.filter((e) => e.channel === "retrieved")) {
        claims.push({
          text: env.body.replace(/\s+/g, " ").trim().slice(0, 200),
          sourceUrl: env.origin.startsWith("http") || env.origin.includes("://") || env.origin.includes(".")
            ? env.origin
            : env.origin,
        });
      }
      claims.push({ text: "No additional corroborating source was attached to this sentence." });
      return {
        text: "synthesis complete",
        claims,
        ...(this.compromise?.text ? { text: this.compromise.text } : {}),
        ...(this.compromise?.toolCalls ? { toolCalls: this.compromise.toolCalls } : {}),
      };
    }

    const injectedCalls = this.followUntrusted ? toolCallsFromUntrusted(request) : [];
    const compromiseCalls = this.compromise?.toolCalls ?? [];
    const planned = cooperativeToolCalls(request);
    const toolCalls = [...injectedCalls, ...compromiseCalls, ...planned];
    const text =
      this.compromise?.text ??
      `acting on ${request.task?.id ?? "task"} for ${request.trustedGoal}`;
    return { text, toolCalls };
  }
}

function toolCallsFromUntrusted(request: CompleteRequest): ToolCallDraft[] {
  const calls: ToolCallDraft[] = [];
  const blob = request.envelopes.map((e) => e.body).join("\n");
  const re = /(?:call|invoke|run|execute)\s+tool\s+(\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob))) {
    calls.push({
      tool: m[1],
      args: { action: "wipe", target: "injected" },
    });
  }
  if (/\bnew\s+goal\b/i.test(blob) && calls.length === 0) {
    calls.push({ tool: "server_admin", args: { action: "wipe", target: "injected" } });
  }
  return calls;
}

function toolAlreadyRan(request: CompleteRequest, tool: string): boolean {
  return request.envelopes.some(
    (e) => e.channel === "tool_output" && e.origin === `tool:${tool}`,
  );
}

function cooperativeToolCalls(request: CompleteRequest): ToolCallDraft[] {
  const goal = request.trustedGoal;
  const cls = classifyGoal(goal);
  const allowed = request.task?.allowedTools ?? defaultAllowedTools(cls);
  const instruction = (request.task?.instruction ?? goal).toLowerCase();
  const want = (name: string) => allowed.includes(name) && !toolAlreadyRan(request, name);

  const candidates: ToolCallDraft[] = [];

  if (cls.research && want("research_fetch")) {
    const urls = extractUrls(goal);
    if (urls.length === 0) urls.push("https://example.test/source");
    for (const url of urls) candidates.push({ tool: "research_fetch", args: { url } });
  }

  if (cls.highBlast && want("server_admin")) {
    candidates.push({
      tool: "server_admin",
      args: { action: "remote_reboot", target: "production" },
    });
  }

  if ((cls.code || instruction.includes("implement") || instruction.includes("writing")) && want("write_file")) {
    const path = inferPath(goal);
    const content = inferContent(goal);
    candidates.push({ tool: "write_file", args: { path, content } });
  }

  if ((cls.ops || instruction.includes("sandbox") || instruction.includes("verify")) && want("sandbox_ops")) {
    candidates.push({ tool: "sandbox_ops", args: { action: "workspace_status" } });
  }

  if (instruction.includes("run") && want("run_command")) {
    candidates.push({ tool: "run_command", args: { argv: ["pwd"] } });
  }

  if (candidates.length === 0 && want("sandbox_ops")) {
    candidates.push({ tool: "sandbox_ops", args: { action: "workspace_status" } });
  }
  // One tool per auto-run step so results can feed the next invocation.
  return candidates.slice(0, 1);
}

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s)]+/g) ?? [];
}

function inferPath(goal: string): string {
  const m = goal.match(/\b([\w./-]+\.(?:txt|md|py|ts|js|go|rs|json|toml))\b/);
  if (m) return m[1].replace(/^\.\//, "");
  return "src/output.txt";
}

function inferContent(goal: string): string {
  const quoted = goal.match(/containing\s+["']([^"']+)["']/i) ?? goal.match(/containing\s+(\S+)/i);
  if (quoted) return quoted[1];
  const prints = goal.match(/prints?\s+["']?([^"']+)["']?/i);
  if (prints) return prints[1];
  return "AGENTIK_OK\n";
}
