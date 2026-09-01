import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLoop } from "../src/loop.ts";
import { pair, makeWorkspace } from "./helpers.ts";

describe("development loop artifacts", () => {
  test("code-edit task writes a real file, not only a chat string", async () => {
    const workspace = await makeWorkspace("dev-code-");
    const report = await runLoop({
      goal: "Create hello.py that prints hello",
      workspace,
      ...pair(),
    });

    expect(report.status).toBe("completed");
    expect(report.executedTools.some((t) => t.tool === "write_file")).toBe(true);
    const file = join(workspace, "hello.py");
    expect(existsSync(file)).toBe(true);
    expect(await Bun.file(file).text()).toContain("hello");
    expect(report.synthesis.length).toBeGreaterThan(0);
  });

  test("sandbox admin/ops task writes an observable ops artifact and command result", async () => {
    const workspace = await makeWorkspace("dev-ops-");
    const report = await runLoop({
      goal: "Record sandbox workspace status ops",
      workspace,
      ...pair(),
    });

    expect(report.executedTools.some((t) => t.tool === "sandbox_ops")).toBe(true);
    expect(report.executedTools.some((t) => t.tool === "run_command")).toBe(true);
    const ops = join(workspace, ".agentik/ops-status.json");
    expect(existsSync(ops)).toBe(true);
    const json = await Bun.file(ops).json();
    expect(json.workspace).toBe(workspace);
    expect(typeof json.entryCount).toBe("number");
    expect(report.artifacts).toContain(".agentik/ops-status.json");
    const cmd = report.executedTools.find((t) => t.tool === "run_command");
    expect(cmd?.output).toContain("exit");
  });

  test("combined code + ops goal produces both artifacts in one 3-role run", async () => {
    const workspace = await makeWorkspace("dev-both-");
    const report = await runLoop({
      goal: "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      workspace,
      ...pair(),
    });

    expect(report.status).toBe("completed");
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(true);
    expect(existsSync(join(workspace, ".agentik/ops-status.json"))).toBe(true);
    expect(report.workersInvoked.some((w) => w.role === "worker_a")).toBe(true);
    expect(report.workersInvoked.some((w) => w.role === "worker_b")).toBe(true);
  });
});
