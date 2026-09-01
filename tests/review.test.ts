import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { recallBeforeRun, reviewAfterRun } from "../src/review.ts";
import { recall } from "../src/memory.ts";
import { makeWorkspace } from "./helpers.ts";

describe("Hermes-style automatic reviewAfterRun", () => {
  test("retains a session note and never writes a skill, however big the run", async () => {
    const home = await makeWorkspace("review-auto-");
    const goal = "Create greet.txt and ops status";
    const report = {
      status: "completed" as const,
      executedTools: [
        { tool: "write_file", args: {}, output: "ok", artifact: "src/greet.txt" },
        { tool: "sandbox_ops", args: {}, output: "ok", artifact: ".agentik/ops-status.json" },
      ],
      artifacts: ["src/greet.txt", ".agentik/ops-status.json"],
    };
    const first = await reviewAfterRun({ goal, report, home });
    expect(first.memoryLayer).toBe("hot");
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(true);
    // This exact run used to produce skills/create-greet-txt-and-ops-status — a session title
    // as a skill name. Code no longer writes skills; the model-driven review does.
    expect(existsSync(join(home, "skills"))).toBe(false);
    expect(existsSync(join(home, "pending"))).toBe(false);
    const hits = await recall("greet", { home });
    expect(hits.some((h) => h.includes("greet.txt"))).toBe(true);
  });

  test("recallBeforeRun finds HOT notes without asking", async () => {
    const home = await makeWorkspace("review-recall-");
    await reviewAfterRun({
      goal: "this repo uses bun test not jest",
      report: { status: "completed", executedTools: [], artifacts: [] },
      home,
    });
    const hits = await recallBeforeRun({ goal: "bun test runner", home });
    expect(hits.some((h) => h.toLowerCase().includes("bun"))).toBe(true);
  });
});
