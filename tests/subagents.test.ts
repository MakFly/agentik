import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLoop } from "../src/loop.ts";
import { buildPlan } from "../src/plan.ts";
import { main } from "../src/cli.ts";
import {
  MAX_SUBAGENTS,
  SUBAGENT_ROLES,
  clampSubagentCount,
  normalizeWorkerRole,
} from "../src/types.ts";
import { MockBackend } from "../src/mock-backend.ts";
import { crew, makeWorkspace, pair } from "./helpers.ts";

describe("up to 5 subagents", () => {
  test("default run still uses two subagents (worker_a + worker_b)", async () => {
    const workspace = await makeWorkspace("sub-default-");
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      workspace,
      ...pair(),
    });
    const roles = new Set(report.tasks.map((t) => t.assignee));
    expect(roles.has("worker_a")).toBe(true);
    expect(roles.has("worker_b")).toBe(true);
    expect(report.tasks.length).toBe(2);
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(true);
  });

  test("workerCount 5 assigns all five roles and invokes each", async () => {
    const workspace = await makeWorkspace("sub-five-");
    const team = crew(5);
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      workspace,
      workerA: team.workerA,
      workerB: team.workerB,
      workers: team.workers,
      workerCount: 5,
    });
    expect(report.tasks.length).toBe(5);
    expect(report.tasks.map((t) => t.assignee)).toEqual([...SUBAGENT_ROLES]);
    for (const role of SUBAGENT_ROLES) {
      expect(report.workersInvoked.some((w) => w.role === role)).toBe(true);
    }
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(true);
    expect(existsSync(join(workspace, ".agentik/ops-status.json"))).toBe(true);
  });

  test("a sixth backend is never invoked; count 6 clamps to 5", async () => {
    const workspace = await makeWorkspace("sub-cap-");
    const team = crew(5);
    const sixth = new MockBackend({ id: "mock-sixth" });
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK",
      workspace,
      workerA: team.workerA,
      workerB: team.workerB,
      workers: [...team.workers, sixth],
      workerCount: 6,
    });
    expect(clampSubagentCount(6)).toBe(MAX_SUBAGENTS);
    expect(report.tasks.length).toBe(5);
    expect(report.workersInvoked.every((w) => w.backend !== sixth.id)).toBe(true);
    expect(report.tasks.every((t) => SUBAGENT_ROLES.includes(t.assignee))).toBe(true);
  });

  test("buildPlan never returns more than MAX_SUBAGENTS tasks", () => {
    const tasks = buildPlan("Create foo.txt containing X and record sandbox workspace status", 99);
    expect(tasks.length).toBe(MAX_SUBAGENTS);
    expect(new Set(tasks.map((t) => t.assignee)).size).toBe(MAX_SUBAGENTS);
  });

  test("CLI --workers 5 drives five mock subagents", async () => {
    const workspace = await makeWorkspace("sub-cli-");
    const home = await makeWorkspace("sub-cli-home-");
    const code = await main([
      "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      "--workspace",
      workspace,
      "--backend",
      "mock",
      "--workers",
      "5",
      "--agentik-home",
      home,
    ]);
    // Exit 3, not 0: the fallback plan's task-3 ("re-run a non-destructive check") is allowed
    // run_command and mutates nothing, so it ends `refused` and the run is `blocked`. The five
    // subagents still ran and worker_a still produced the deliverable — that is what this test is
    // about. See "Proof of work" in CLAUDE.md for the read-only-check caveat.
    expect(code).toBe(3);
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(true);
  });

  test("normalizeWorkerRole maps worker_5 and aliases onto the capped roster", () => {
    expect(normalizeWorkerRole("worker_5")).toBe("worker_e");
    expect(normalizeWorkerRole("c")).toBe("worker_c");
    expect(normalizeWorkerRole("unknown")).toBe("worker_a");
  });
});
