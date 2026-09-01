import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { memoryAdd, MEMORY_CAP, readEntries } from "../src/memory-store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { runReview } from "../src/reviewer.ts";
import { executeTool, newReviewState } from "../src/tools.ts";
import { makeWorkspace } from "./helpers.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";

/** A reviewer that follows a script: one reply per iteration, then stops. */
class ScriptedReviewer implements Backend {
  readonly id = "scripted";
  seen: CompleteRequest[] = [];
  constructor(private readonly script: WorkerMessage[]) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    return this.script[this.seen.length - 1] ?? { text: "nothing more", toolCalls: [] };
  }
}

describe("memory tools are reviewer-only", () => {
  test("a worker proposing `memory` is blocked by the gate, whatever its allowlist says", () => {
    const orch = new Orchestrator();
    orch.submitGoal("learn things");
    const gate = orch.proposeTool(
      { id: "x", tool: "memory", args: { action: "add", content: "sneaky" }, proposedBy: "worker_a" },
      [],
      ["memory"],
    );
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("reviewer_only");
  });

  test("executeTool refuses memory/skill_manage without the reviewer role and a home", async () => {
    const ws = await makeWorkspace("tool-gate-");
    const r = await executeTool({ id: "x", tool: "memory", args: { action: "add", content: "sneaky" }, proposedBy: "worker_a" }, { workspace: ws, agentikHome: ws });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("reviewer-only");
    const r2 = await executeTool({ id: "y", tool: "skill_manage", args: { action: "view", name: "csv-export" }, proposedBy: "reviewer" }, { workspace: ws });
    expect(r2.ok).toBe(false);
  });

  test("skill_manage: read before write, one create per review, class-level names only", async () => {
    const ws = await makeWorkspace("tool-skill-");
    const state = newReviewState(1);
    const host = { workspace: ws, agentikHome: ws, reviewState: state };
    const body = "## When to use\nDrawer swipe bugs.\n## Procedure\n1. Read mobile-drawer-shell.\n## Pitfalls\nGhost clicks.\n## Verification\nbun test.";
    const noView = await executeTool({ id: "1", tool: "skill_manage", args: { action: "create", name: "pwa-drawer-swipe", description: "Drawer swipe rules.", body }, proposedBy: "reviewer" }, host);
    expect(noView.ok).toBe(false);
    expect(noView.output).toContain("read before write");
    await executeTool({ id: "2", tool: "skill_manage", args: { action: "view", name: "pwa-drawer-swipe" }, proposedBy: "reviewer" }, host);
    const created = await executeTool({ id: "3", tool: "skill_manage", args: { action: "create", name: "pwa-drawer-swipe", description: "Drawer swipe rules.", body }, proposedBy: "reviewer" }, host);
    expect(created.ok).toBe(true);
    expect(existsSync(join(ws, "skills/pwa-drawer-swipe/SKILL.md"))).toBe(true);
    await executeTool({ id: "4", tool: "skill_manage", args: { action: "view", name: "csv-export" }, proposedBy: "reviewer" }, host);
    const second = await executeTool({ id: "5", tool: "skill_manage", args: { action: "create", name: "csv-export", description: "CSV.", body }, proposedBy: "reviewer" }, host);
    expect(second.ok).toBe(false);
    expect(second.output).toContain("at most 1 skill");
    const bad = await executeTool({ id: "6", tool: "skill_manage", args: { action: "view", name: "fix-drawer-today" }, proposedBy: "reviewer" }, host);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("session_prefix");
    const patched = await executeTool({ id: "7", tool: "skill_manage", args: { action: "patch", name: "pwa-drawer-swipe", old_string: "Ghost clicks.", new_string: "Ghost clicks within 450ms." }, proposedBy: "reviewer" }, host);
    expect(patched.ok).toBe(true);
    expect(await readFile(join(ws, "skills/pwa-drawer-swipe/SKILL.md"), "utf8")).toContain("450ms");
  });
});

describe("runReview: bounded, judged, honest about what it did", () => {
  test("a review that writes one fact and one user preference, then stops", async () => {
    const home = await makeWorkspace("review-home-");
    const backend = new ScriptedReviewer([
      {
        text: "one durable fact, one explicit correction",
        toolCalls: [
          { tool: "memory", args: { target: "memory", action: "add", content: "openhermesbot-web runs unit tests with make test-unit; typecheck is make typecheck." } },
          { tool: "memory", args: { target: "user", action: "add", content: "Kev writes in French and wants proof by command output, never by narration." } },
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runReview({ goal: "fix the drawer", transcript: "user: en français stp, et prouve avec la sortie des commandes", workspace: "/tmp", home, backend });
    expect(out.memoryOps).toBe(1);
    expect(out.userOps).toBe(1);
    expect(out.iterations).toBe(2);
    expect(out.stoppedBecause).toBe("no_more_tool_calls");
    expect(await readEntries("user", home)).toHaveLength(1);
    // The reviewer saw the snapshots and the transcript as DATA.
    const origins = backend.seen[0].envelopes.map((e) => e.origin);
    expect(origins).toEqual(expect.arrayContaining(["memory:snapshot", "user:snapshot", "skills:index", "run:transcript"]));
  });

  test("over the cap: the reviewer is told to consolidate, and gives up after 3 failures", async () => {
    const home = await makeWorkspace("review-cap-");
    await memoryAdd("memory", "z".repeat(MEMORY_CAP - 5), { home });
    const stubborn = { tool: "memory", args: { target: "memory", action: "add", content: "will never fit here" } };
    const backend = new ScriptedReviewer([
      { text: "try", toolCalls: [stubborn] },
      { text: "try", toolCalls: [stubborn] },
      { text: "try", toolCalls: [stubborn] },
      { text: "try", toolCalls: [stubborn] },
    ]);
    const out = await runReview({ goal: "g", transcript: "t", workspace: "/tmp", home, backend });
    expect(out.consolidationFailures).toBe(3);
    expect(out.stoppedBecause).toBe("consolidation_gave_up");
    expect(out.iterations).toBe(3);
    // The refusal fed back carries the consolidation instruction.
    const fed = backend.seen[1].envelopes.map((e) => e.body).join("\n");
    expect(fed).toContain("Consolidate now");
  });

  test("a reviewer that consolidates: remove + add in one batch succeeds", async () => {
    const home = await makeWorkspace("review-consol-");
    await memoryAdd("memory", "z".repeat(MEMORY_CAP - 5), { home });
    const backend = new ScriptedReviewer([
      { text: "consolidate", toolCalls: [{ tool: "memory", args: { target: "memory", operations: [{ action: "remove", old: "zzzz" }, { action: "add", content: "Short replacement fact." }] } }] },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runReview({ goal: "g", transcript: "t", workspace: "/tmp", home, backend });
    expect(out.memoryOps).toBe(1);
    expect(await readEntries("memory", home)).toEqual(["Short replacement fact."]);
  });

  test("non-review tools are refused, iterations are capped, backend errors end the review", async () => {
    const home = await makeWorkspace("review-bounds-");
    const chatty = { text: "again", toolCalls: [{ tool: "write_file", args: { path: "x", content: "y" } }] };
    const backend = new ScriptedReviewer(Array(20).fill(chatty));
    const out = await runReview({ goal: "g", transcript: "t", workspace: "/tmp", home, backend, maxIterations: 4 });
    expect(out.iterations).toBe(4);
    expect(out.stoppedBecause).toBe("max_iterations");
    expect(out.refused).toBe(4);
    expect(existsSync(join("/tmp", "x"))).toBe(false);

    const dead: Backend = { id: "dead", async complete() { throw new Error("gone"); } };
    const out2 = await runReview({ goal: "g", transcript: "t", workspace: "/tmp", home, backend: dead });
    expect(out2.stoppedBecause).toBe("backend_error");
  });
});

describe("agentik review / harvest --transcript (CLI)", () => {
  test("review with --backend mock runs, writes nothing, exits 0", async () => {
    const home = await makeWorkspace("cli-review-");
    const ws = await makeWorkspace("cli-review-ws-");
    await Bun.write(join(ws, "transcript.md"), "user: nothing notable");
    const code = await main(["review", "audit thing", "--transcript", join(ws, "transcript.md"), "--workspace", ws, "--agentik-home", home, "--backend", "mock"]);
    expect(code).toBe(0);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(false);
  });

  test("review with nothing to review exits 2; harvest --transcript chains into the review", async () => {
    const home = await makeWorkspace("cli-review2-");
    const ws = await makeWorkspace("cli-review2-ws-");
    expect(await main(["review", "g", "--workspace", ws, "--agentik-home", home, "--backend", "mock"])).toBe(2);
    await Bun.write(join(ws, "t.md"), "notes");
    const code = await main(["harvest", "did a thing", "--workspace", ws, "--agentik-home", home, "--transcript", join(ws, "t.md"), "--backend", "mock"]);
    expect(code).toBe(0);
    // A session was recorded, so a bare review now has something to look at.
    expect(await main(["review", "--workspace", ws, "--agentik-home", home, "--backend", "mock"])).toBe(0);
  });
});
