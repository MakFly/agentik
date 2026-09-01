import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { recallBeforeRun, reviewAfterRun, summarizeRun } from "../src/review.ts";
import { retainNote } from "../src/memory.ts";
import { searchSessions } from "../src/sessions.ts";
import { makeWorkspace } from "./helpers.ts";

describe("Hermes-style automatic reviewAfterRun", () => {
  test("records a session (not a HOT line) and never writes a skill, however big the run", async () => {
    const home = await makeWorkspace("review-auto-");
    const goal = "Create greet.txt and ops status";
    const report = {
      status: "completed" as const,
      executedTools: [
        { tool: "write_file", args: {}, output: "ok", artifact: "src/greet.txt" },
        { tool: "sandbox_ops", args: {}, output: "ok", artifact: ".agentik/ops-status.json" },
      ],
      artifacts: ["src/greet.txt", ".agentik/ops-status.json"],
      stalledTasks: [{ taskId: "t1", assignee: "worker_a", backend: "mock-a", reason: "empty", attempts: 2 } as never],
    };
    const first = await reviewAfterRun({ goal, report, home, workspace: "/tmp/ws-a", verdict: { tools: 2 } });
    expect(first.memoryLayer).toBe("session");
    expect(first.sessionId).toBeGreaterThan(0);
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(true);
    // HOT is for durable facts: a run does not write there any more.
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(false);
    // This exact run used to produce skills/create-greet-txt-and-ops-status — a session title
    // as a skill name. Code no longer writes skills; the model-driven review does.
    expect(existsSync(join(home, "skills"))).toBe(false);
    expect(existsSync(join(home, "pending"))).toBe(false);
    const hits = await searchSessions("greet", { home, workspace: "/tmp/ws-a" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      goal,
      status: "completed",
      workspace: "/tmp/ws-a",
      artifacts: ["src/greet.txt", ".agentik/ops-status.json"],
      verdict: { tools: 2 },
      summary: "completed — artifacts: src/greet.txt, .agentik/ops-status.json — stalled: 1",
    });
    expect(await searchSessions("greet", { home, workspace: "/tmp/other" })).toEqual([]);
  });

  test("summarizeRun is one useful line", () => {
    expect(summarizeRun({ status: "completed", executedTools: [], artifacts: [] })).toBe("completed — artifacts: none");
    expect(
      summarizeRun({
        status: "blocked",
        executedTools: [],
        artifacts: ["a"],
        backendSwitches: [{ from: "grok", to: "claude", reason: "died", taskId: "t" } as never],
      }),
    ).toBe("blocked — artifacts: a — backend switches: 1");
  });

  test("recallBeforeRun returns HOT facts and related sessions, workspace-filtered, without asking", async () => {
    const home = await makeWorkspace("review-recall-");
    await retainNote("this repo uses bun test not jest", { home });
    await reviewAfterRun({
      goal: "make the bun test runner discover Makefile targets",
      report: { status: "completed", executedTools: [], artifacts: ["Makefile"] },
      home,
      workspace: "/tmp/ws-a",
    });
    await reviewAfterRun({
      goal: "bun test flakiness elsewhere",
      report: { status: "completed", executedTools: [], artifacts: [] },
      home,
      workspace: "/tmp/ws-b",
    });
    const hits = await recallBeforeRun({ goal: "bun test runner", home, workspace: "/tmp/ws-a" });
    // HOT entries are bare facts now (no `(kind)` label): the store does not label entries.
    expect(hits[0]).toBe("this repo uses bun test not jest");
    expect(hits.some((h) => /^\[\d{4}-\d{2}-\d{2}\] make the bun test runner discover Makefile targets — completed/.test(h))).toBe(true);
    expect(hits.some((h) => h.includes("flakiness elsewhere"))).toBe(false);
    const all = await recallBeforeRun({ goal: "bun test runner", home });
    expect(all.some((h) => h.includes("flakiness elsewhere"))).toBe(true);
  });
});
