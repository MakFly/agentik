import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recallBeforeRun, reviewAfterRun } from "../src/review.ts";
import { recall } from "../src/memory.ts";
import { makeWorkspace } from "./helpers.ts";

describe("Hermes-style automatic reviewAfterRun", () => {
  test("always retains; ships a skill on a non-trivial completed run (no approve)", async () => {
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
    expect(first.skill?.action).toBe("created");
    expect(first.skill?.path).toContain("skills/create-greet-txt-and-ops-status/SKILL.md");
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(true);
    expect(existsSync(first.skill!.path)).toBe(true);
    expect(existsSync(join(home, "pending/skills/create-greet-txt-and-ops-status/SKILL.md"))).toBe(
      false,
    );
    const body = await readFile(first.skill!.path, "utf8");
    expect(body).toContain("write_file -> src/greet.txt");

    const second = await reviewAfterRun({ goal, report, home });
    expect(second.skill?.action).toBe("updated");
    const hits = await recall("greet", { home });
    expect(hits.some((h) => h.includes("greet.txt"))).toBe(true);
  });

  test("trivial run retains memory but does not ship a skill", async () => {
    const home = await makeWorkspace("review-trivial-");
    const r = await reviewAfterRun({
      goal: "rename a comment",
      report: {
        status: "completed",
        executedTools: [{ tool: "write_file", args: {}, output: "ok", artifact: "src/a.ts" }],
        artifacts: ["src/a.ts"],
      },
      home,
    });
    expect(r.memoryLayer).toBe("hot");
    expect(r.skill).toBeUndefined();
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
