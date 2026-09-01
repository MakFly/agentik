import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLoop } from "../src/loop.ts";
import { pair, makeWorkspace } from "./helpers.ts";

describe("3-role loop (shipped runLoop)", () => {
  test("human goal invokes both AI workers with bounded tasks and writes an artifact", async () => {
    const workspace = await makeWorkspace("roles-happy-");
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      workspace,
      ...pair(),
    });

    const roles = new Set(report.workersInvoked.map((w) => w.role));
    expect(roles.has("worker_a")).toBe(true);
    expect(roles.has("worker_b")).toBe(true);
    expect(report.tasks.length).toBeGreaterThanOrEqual(2);
    expect(report.tasks.some((t) => t.assignee === "worker_a")).toBe(true);
    expect(report.tasks.some((t) => t.assignee === "worker_b")).toBe(true);
    for (const t of report.tasks) {
      expect(t.allowedTools.length).toBeGreaterThan(0);
      expect(t.instruction.length).toBeGreaterThan(0);
    }
    expect(report.status).toBe("completed");
    expect(report.goal?.submittedBy).toBe("orchestrator");
    const greet = join(workspace, "src/greet.txt");
    expect(existsSync(greet)).toBe(true);
    expect(await Bun.file(greet).text()).toContain("AGENTIK_OK");
  });

  test("withheld orchestrator approval blocks a high-blast-radius tool", async () => {
    const workspace = await makeWorkspace("roles-withhold-");
    const report = await runLoop({
      goal: "server_admin remote reboot of the production hypervisor",
      workspace,
      ...pair(),
    });

    expect(report.executedTools.some((t) => t.tool === "server_admin")).toBe(false);
    expect(existsSync(join(workspace, ".agentik/admin-action.json"))).toBe(false);
    expect(report.blockedTools.some((t) => t.tool === "server_admin")).toBe(true);
    expect(
      report.status === "awaiting_approval" ||
        report.pendingApprovals.length > 0 ||
        report.blockedTools.some((t) => t.reason === "awaiting_approval"),
    ).toBe(true);
  });

  test("explicit orchestrator approval releases the high-blast sandbox receipt", async () => {
    const workspace = await makeWorkspace("roles-approve-");
    const report = await runLoop({
      goal: "server_admin remote reboot of the production hypervisor",
      workspace,
      ...pair(),
      decisions: [{ type: "approve" }],
    });

    expect(report.executedTools.some((t) => t.tool === "server_admin")).toBe(true);
    expect(existsSync(join(workspace, ".agentik/admin-action.json"))).toBe(true);
    const receipt = await Bun.file(join(workspace, ".agentik/admin-action.json")).json();
    expect(receipt.simulated).toBe(true);
  });

  test("orchestrator override stops the run before further tools", async () => {
    const workspace = await makeWorkspace("roles-override-");
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      workspace,
      ...pair(),
      decisions: [{ type: "override", overrideAction: "stop" }],
    });

    expect(report.status).toBe("overridden");
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(false);
    expect(report.workersInvoked.some((w) => w.role === "worker_a" && w.phase === "plan")).toBe(
      true,
    );
  });

  test("orchestrator redirect replaces the goal from the human only", async () => {
    const workspace = await makeWorkspace("roles-redirect-");
    const report = await runLoop({
      goal: "Create src/old.txt containing OLD",
      workspace,
      ...pair(),
      decisions: [
        {
          type: "override",
          overrideAction: "redirect",
          redirectGoal: "Create src/new.txt containing NEW_OK",
        },
      ],
    });

    expect(report.originalGoalText).toBe("Create src/old.txt containing OLD");
    expect(report.goal?.text).toBe("Create src/new.txt containing NEW_OK");
    expect(report.goal?.submittedBy).toBe("orchestrator");
  });
});
