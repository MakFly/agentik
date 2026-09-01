import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { memoryAdd, MEMORY_CAP, readEntries } from "../src/memory-store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { formatReviewOutcome, POSTMORTEM_GUIDANCE, reviewSystemPrompt, runReview, WORKSPACE_INSTRUCTIONS_CAP, workspaceInstructions } from "../src/reviewer.ts";
import { getIncident, listIncidents, recordIncident } from "../src/incidents.ts";
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

  test("the workspace's CLAUDE.md is DATA for the reviewer, right after the skills index; none → no envelope", async () => {
    const home = await makeWorkspace("review-claudemd-home-");
    const ws = await makeWorkspace("review-claudemd-ws-");
    await Bun.write(join(ws, "CLAUDE.md"), "# project\nTests: `bun test`. Typecheck: `bunx tsc --noEmit`.");
    const backend = new ScriptedReviewer([{ text: "nothing", toolCalls: [] }]);
    await runReview({ goal: "g", transcript: "t", workspace: ws, home, backend });
    const req = backend.seen[0];
    const origins = req.envelopes.map((e) => e.origin);
    expect(origins).toEqual(["memory:snapshot", "project:snapshot", "user:snapshot", "skills:index", "workspace:claude-md", "run:transcript"]);
    const env = req.envelopes.find((e) => e.origin === "workspace:claude-md")!;
    expect(env.body).toBe("# project\nTests: `bun test`. Typecheck: `bunx tsc --noEmit`.");
    expect(env.trust).toBe("untrusted");
    expect(env.channel).toBe("retrieved");
    // The guidance tells the reviewer not to copy it into memory.
    expect(req.system).toContain("A fact already stated in the workspace's CLAUDE.md (given as DATA) is not memory: do not add it, and remove an existing entry that merely repeats it when consolidating.");
    expect(reviewSystemPrompt()).toContain("A fact already stated in the workspace's CLAUDE.md (given as DATA) is not memory");

    const bare = await makeWorkspace("review-noclaudemd-ws-");
    const backend2 = new ScriptedReviewer([{ text: "nothing", toolCalls: [] }]);
    await runReview({ goal: "g", transcript: "t", workspace: bare, home, backend: backend2 });
    expect(backend2.seen[0].envelopes.map((e) => e.origin)).not.toContain("workspace:claude-md");
    expect(backend2.seen[0].envelopes.map((e) => e.origin)).toEqual(["memory:snapshot", "project:snapshot", "user:snapshot", "skills:index", "run:transcript"]);
  });

  test("the reviewer routes a repo fact to target project: it lands in the workspace's file, not MEMORY.md; the project snapshot is DATA", async () => {
    const home = await makeWorkspace("review-project-home-");
    const ws = await makeWorkspace("review-project-ws-");
    const other = await makeWorkspace("review-project-other-");
    await memoryAdd("project", "Only the other checkout uses make test.", { home, workspace: other });
    await memoryAdd("project", "Old: this checkout used jest.", { home, workspace: ws });
    const backend = new ScriptedReviewer([
      {
        text: "one repo fact, one global fact",
        toolCalls: [
          { tool: "memory", args: { target: "project", action: "replace", old: "used jest", new: "This checkout runs bun test; tests/harness.test.ts fails from a worktree." } },
          { tool: "memory", args: { target: "memory", action: "add", content: "claude -p rejects --dangerously-skip-permissions together with --restricted." } },
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runReview({ goal: "fix the tests", transcript: "t", workspace: ws, home, backend });
    expect(out.projectOps).toBe(1);
    expect(out.memoryOps).toBe(1);
    expect(out.userOps).toBe(0);
    expect(out.refused).toBe(0);
    expect(await readEntries("project", home, { workspace: ws })).toEqual(["This checkout runs bun test; tests/harness.test.ts fails from a worktree."]);
    expect(await readEntries("memory", home)).toEqual(["claude -p rejects --dangerously-skip-permissions together with --restricted."]);
    expect(await readEntries("project", home, { workspace: other })).toEqual(["Only the other checkout uses make test."]);
    expect(formatReviewOutcome(out)).toContain("memory 1, project 1, user 0");
    // The project snapshot is this workspace's, right after the global one, as DATA.
    const req = backend.seen[0];
    const origins = req.envelopes.map((e) => e.origin);
    expect(origins.slice(0, 3)).toEqual(["memory:snapshot", "project:snapshot", "user:snapshot"]);
    const env = req.envelopes.find((e) => e.origin === "project:snapshot")!;
    expect(env.trust).toBe("untrusted");
    expect(env.channel).toBe("retrieved");
    expect(env.body).toStartWith("PROJECT MEMORY (this workspace) [");
    expect(env.body).toContain("Old: this checkout used jest.");
    expect(env.body).not.toContain("make test");
    // The guidance routes by "would this be true in another repository?".
    expect(req.system).toContain('PROJECT MEMORY (target "project") — facts about THIS repository only');
    expect(req.system).toContain('Ask "would this be true in another repository?" — yes → memory, no → project.');
    expect(req.system).toContain('"target": "memory"|"user"|"project"');
    // A worker asking for target project is refused like any other memory write.
    const r = await executeTool({ id: "w", tool: "memory", args: { target: "project", action: "add", content: "sneaky" }, proposedBy: "worker_a" }, { workspace: ws, agentikHome: home });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("reviewer-only");
    expect(await readEntries("project", home, { workspace: ws })).toHaveLength(1);
  });

  test("a long CLAUDE.md is capped at 6000 chars with a truncation marker; a missing one reads as undefined", async () => {
    const home = await makeWorkspace("review-claudemd-long-home-");
    const ws = await makeWorkspace("review-claudemd-long-ws-");
    await Bun.write(join(ws, "CLAUDE.md"), "y".repeat(10000));
    const text = await workspaceInstructions(ws);
    expect(text).toBeDefined();
    expect(text!.length).toBeLessThanOrEqual(6100);
    expect(text!.length).toBeGreaterThanOrEqual(WORKSPACE_INSTRUCTIONS_CAP);
    expect(text!.endsWith("…[truncated]")).toBe(true);
    expect(text!.slice(0, WORKSPACE_INSTRUCTIONS_CAP)).toBe("y".repeat(WORKSPACE_INSTRUCTIONS_CAP));
    const backend = new ScriptedReviewer([{ text: "nothing", toolCalls: [] }]);
    await runReview({ goal: "g", transcript: "t", workspace: ws, home, backend });
    const env = backend.seen[0].envelopes.find((e) => e.origin === "workspace:claude-md")!;
    expect(env.body.length).toBeLessThanOrEqual(6100);
    expect(env.body).toEndWith("…[truncated]");
    // No CLAUDE.md, or a directory named CLAUDE.md: nothing, silently.
    expect(await workspaceInstructions(await makeWorkspace("review-claudemd-none-"))).toBeUndefined();
    expect(await workspaceInstructions(join(ws, "does-not-exist"))).toBeUndefined();
    const short = await makeWorkspace("review-claudemd-short-");
    await Bun.write(join(short, "CLAUDE.md"), "x".repeat(WORKSPACE_INSTRUCTIONS_CAP));
    expect(await workspaceInstructions(short)).toBe("x".repeat(WORKSPACE_INSTRUCTIONS_CAP));
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

describe("postmortem: the review answers why, and what prevents it", () => {
  test("incident classify + memory add: the incident gets its cause and memory the fact; the guidance is on only with an incident", async () => {
    const home = await makeWorkspace("postmortem-home-");
    const inc = await recordIncident(
      { goal: "wire codex into the crew", workspace: "/tmp/pm", harness: "codex", backend: "opencodex", exitCode: 1, stopReason: "turn.failed", errors: ["adapter_eof"], symptom: "codex never reported a completed turn" },
      { home },
    );
    await recordIncident({ goal: "wire codex into the crew", workspace: "/tmp/pm", harness: "codex", symptom: "codex never reported a completed turn" }, { home });
    const other = await recordIncident({ goal: "codex again elsewhere", workspace: "/tmp/pm", harness: "codex", symptom: "codex exited 1 with adapter_eof" }, { home });
    const backend = new ScriptedReviewer([
      {
        text: "seen twice, the cause is the proxy",
        toolCalls: [
          { tool: "incident", args: { action: "classify", id: inc.id, cause: "opencodex's responses adapter closes the stream on --output-schema (adapter_eof)" } },
          { tool: "memory", args: { target: "memory", action: "add", content: "Behind opencodex (127.0.0.1:10100) codex cannot take --output-schema; agentik learns it per routing." } },
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runReview({ goal: inc.goal, transcript: "incident transcript", workspace: "/tmp/pm", home, backend, incident: { ...inc, seen: 2 } });
    expect(out.incidentOps).toBe(1);
    expect(out.memoryOps).toBe(1);
    expect(out.refused).toBe(0);
    expect((await getIncident(inc.id, { home }))?.cause).toBe("opencodex's responses adapter closes the stream on --output-schema (adapter_eof)");
    expect((await getIncident(inc.id, { home }))?.resolvedAt).toBeNull();
    expect(await readEntries("memory", home)).toEqual(["Behind opencodex (127.0.0.1:10100) codex cannot take --output-schema; agentik learns it per routing."]);
    // Prompt: guidance present, incident + similar incidents as DATA envelopes.
    const req = backend.seen[0];
    expect(req.system).toContain(POSTMORTEM_GUIDANCE);
    expect(req.trustedGoal).toContain(`Postmortem of incident #${inc.id}`);
    const origins = req.envelopes.map((e) => e.origin);
    expect(origins).toContain("incident:current");
    expect(origins).toContain("incidents:similar");
    const current = req.envelopes.find((e) => e.origin === "incident:current")!;
    expect(current.body).toContain("symptom: codex never reported a completed turn");
    expect(current.body).toContain("adapter_eof");
    expect(current.channel).toBe("tool_output");
    const similar = req.envelopes.find((e) => e.origin === "incidents:similar")!;
    expect(similar.body).toContain(`#${other.id} `);
    expect(similar.body).not.toContain(`#${inc.id} `);
    // Without an incident: no postmortem guidance, and the memory guidance routes failures to the log.
    expect(reviewSystemPrompt()).not.toContain(POSTMORTEM_GUIDANCE);
    expect(reviewSystemPrompt()).toContain("go to the incident log, not to memory. A failure seen twice is not transient");
    expect(reviewSystemPrompt()).not.toContain("Do not record: environment-dependent failures");
    expect(reviewSystemPrompt({ postmortem: true })).toContain(POSTMORTEM_GUIDANCE);
    const plain = new ScriptedReviewer([{ text: "nothing", toolCalls: [] }]);
    await runReview({ goal: "g", transcript: "t", workspace: "/tmp/pm", home, backend: plain });
    expect(plain.seen[0].system).not.toContain(POSTMORTEM_GUIDANCE);
    expect(plain.seen[0].envelopes.map((e) => e.origin)).not.toContain("incident:current");
  });

  test("incident tool: reviewer-only (gate + executor), cause ≤120 chars, resolve, merge, unknown ids", async () => {
    const home = await makeWorkspace("postmortem-tool-");
    const a = await recordIncident({ goal: "g", harness: "grok", symptom: "grok ended on stopReason=max_turns" }, { home });
    const b = await recordIncident({ goal: "g", harness: "grok", symptom: "grok stopped: max_turns after 8 turns" }, { home });
    const orch = new Orchestrator();
    orch.submitGoal("learn things");
    const gate = orch.proposeTool({ id: "x", tool: "incident", args: { action: "classify", id: a.id, cause: "c" }, proposedBy: "worker_a" }, [], ["incident"]);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("reviewer_only");
    const worker = await executeTool({ id: "w", tool: "incident", args: { action: "classify", id: a.id, cause: "sneaky" }, proposedBy: "worker_a" }, { workspace: "/tmp", agentikHome: home });
    expect(worker.ok).toBe(false);
    expect(worker.output).toContain("reviewer-only");
    const noHome = await executeTool({ id: "h", tool: "incident", args: { action: "classify", id: a.id, cause: "sneaky" }, proposedBy: "reviewer" }, { workspace: "/tmp" });
    expect(noHome.ok).toBe(false);
    expect((await getIncident(a.id, { home }))?.cause).toBe("");
    const host = { workspace: "/tmp", agentikHome: home };
    const long = await executeTool({ id: "1", tool: "incident", args: { action: "classify", id: a.id, cause: "x".repeat(121) }, proposedBy: "reviewer" }, host);
    expect(long.ok).toBe(false);
    expect(long.output).toContain("max 120");
    const missing = await executeTool({ id: "2", tool: "incident", args: { action: "classify", id: 999, cause: "c" }, proposedBy: "reviewer" }, host);
    expect(missing.ok).toBe(false);
    const bad = await executeTool({ id: "3", tool: "incident", args: { action: "delete", id: a.id }, proposedBy: "reviewer" }, host);
    expect(bad.ok).toBe(false);
    const merged = await executeTool({ id: "4", tool: "incident", args: { action: "merge", into: a.id, from: b.id }, proposedBy: "reviewer" }, host);
    expect(merged.ok).toBe(true);
    expect(merged.output).toContain("seen 2×");
    expect(await getIncident(b.id, { home })).toBeNull();
    const resolved = await executeTool({ id: "5", tool: "incident", args: { action: "resolve", id: String(a.id), fix: "pass --max-turns 20 to grok" }, proposedBy: "reviewer" }, host);
    expect(resolved.ok).toBe(true);
    const rec = await getIncident(a.id, { home });
    expect(rec?.fix).toBe("pass --max-turns 20 to grok");
    expect(rec?.resolvedAt).not.toBeNull();
    expect(await listIncidents({ home })).toEqual([]);
  });

  test("agentik review --incident ID (CLI): runs the postmortem; exclusive with --transcript/--session; unknown id exits 2", async () => {
    const home = await makeWorkspace("postmortem-cli-");
    const ws = await makeWorkspace("postmortem-cli-ws-");
    const inc = await recordIncident({ goal: "deploy umami", workspace: ws, harness: "codex", symptom: "codex exited 1" }, { home });
    expect(await main(["review", "--incident", String(inc.id), "--agentik-home", home, "--backend", "mock"])).toBe(0);
    expect(await main(["review", "--incident", String(inc.id), "--transcript", "/tmp/nope.md", "--agentik-home", home, "--backend", "mock"])).toBe(2);
    expect(await main(["review", "--incident", String(inc.id), "--session", "1", "--agentik-home", home, "--backend", "mock"])).toBe(2);
    expect(await main(["review", "--incident", "42", "--agentik-home", home, "--backend", "mock"])).toBe(2);
    expect(await main(["review", "--incident", "abc", "--agentik-home", home, "--backend", "mock"])).toBe(2);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(false);
  });
});
