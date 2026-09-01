import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLoop } from "../src/loop.ts";
import { buildPlan } from "../src/plan.ts";
import { pair, makeWorkspace } from "./helpers.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";

class SpinBackend implements Backend {
  readonly id: string;
  constructor(id = "spin") {
    this.id = id;
  }
  async complete(request: CompleteRequest): Promise<WorkerMessage> {
    if (request.phase === "plan") {
      const tasks = buildPlan(request.trustedGoal).map((t) => ({
        assignee: t.assignee,
        instruction: t.instruction,
        allowedTools: t.allowedTools,
        maxSteps: t.maxSteps,
      }));
      return { text: "plan", tasks };
    }
    if (request.phase === "synthesize") return { text: "done" };
    const allowed = request.task?.allowedTools ?? [];
    let tool = "sandbox_ops";
    let args: Record<string, unknown> = { action: "workspace_status" };
    if (allowed.includes("write_file")) {
      tool = "write_file";
      args = { path: "src/spin.txt", content: `step-${request.step}` };
    } else if (allowed.includes("sandbox_ops")) {
      tool = "sandbox_ops";
    } else if (allowed.includes("run_command")) {
      tool = "run_command";
      args = { argv: ["pwd"] };
    }
    return { text: `spin ${request.step}`, toolCalls: [{ tool, args }] };
  }
}

describe("auto-run inner loop", () => {
  test("re-invokes a worker after tool results and stops when it returns no toolCalls", async () => {
    const workspace = await makeWorkspace("autorun-stop-");
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      workspace,
      ...pair(),
    });

    const aActs = report.workersInvoked.filter((w) => w.role === "worker_a" && w.phase === "act");
    const bActs = report.workersInvoked.filter((w) => w.role === "worker_b" && w.phase === "act");
    expect(aActs.length).toBeGreaterThanOrEqual(2);
    expect(bActs.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(true);
    expect(existsSync(join(workspace, ".agentik/ops-status.json"))).toBe(true);
    expect(report.status).toBe("completed");
  });

  test("caps auto-run at maxSteps even if the worker keeps proposing tools", async () => {
    const workspace = await makeWorkspace("autorun-cap-");
    const report = await runLoop({
      goal: "Create src/spin.txt containing SPIN and record sandbox workspace status",
      workspace,
      workerA: new SpinBackend("spin-a"),
      workerB: new SpinBackend("spin-b"),
      maxSteps: 3,
    });

    const aActs = report.workersInvoked.filter((w) => w.role === "worker_a" && w.phase === "act");
    const bActs = report.workersInvoked.filter((w) => w.role === "worker_b" && w.phase === "act");
    expect(aActs.length).toBe(3);
    expect(bActs.length).toBe(3);
    expect(report.executedTools.length).toBeGreaterThan(0);
    expect(report.executedTools.length).toBeLessThanOrEqual(6);
  });

  test("session autoApproveHighBlast releases high-blast on every auto-run step", async () => {
    const workspace = await makeWorkspace("autorun-yolo-");
    const report = await runLoop({
      goal: "server_admin remote reboot of the production hypervisor",
      workspace,
      ...pair(),
      autoApproveHighBlast: true,
    });
    expect(report.executedTools.some((t) => t.tool === "server_admin")).toBe(true);
    expect(existsSync(join(workspace, ".agentik/admin-action.json"))).toBe(true);
    expect(report.status).toBe("completed");
  });
});
