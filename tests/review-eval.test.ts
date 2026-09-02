import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { listEvalCases, runReviewEval, ScriptedReviewer } from "../src/review-eval.ts";
import type { WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

const CASES = join(import.meta.dir, "fixtures", "review-cases");

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: out.join("\n") };
  } finally {
    console.log = orig;
  }
}

describe("reviewer eval (scripted, deterministic)", () => {
  test("the eight cases exist and every script passes its own rules", async () => {
    const names = await listEvalCases(CASES);
    expect(names).toEqual(["cap-consolidation", "global-vs-project", "no-claude-md-duplicate", "one-create-per-review", "secret-refusal", "skill-class-name", "transient-failure-to-incident", "user-explicit-only"]);
    const r = await runReviewEval(CASES);
    for (const c of r.cases) expect({ name: c.name, failures: c.failures }).toEqual({ name: c.name, failures: [] });
    expect(r.ok).toBe(true);
    expect(r.cases.every((c) => !c.home.includes(".agentik"))).toBe(true);
  });

  test("a wrong script fails on the right rule", async () => {
    // global-vs-project with the levels swapped: the repo fact goes global, the tool fact goes project.
    const swapped: WorkerMessage[] = [
      { text: "wrong levels", toolCalls: [
        { tool: "memory", args: { target: "memory", action: "add", content: "Tests run with bun test; there is no jest in this repo." } },
        { tool: "memory", args: { target: "project", action: "add", content: "grok 1.0.13: the deny flag is --disallowed-tools." } },
      ] },
      { text: "done", toolCalls: [] },
    ];
    const r = await runReviewEval(CASES, { backend: new ScriptedReviewer(swapped), cases: ["global-vs-project"] });
    expect(r.ok).toBe(false);
    expect(r.cases[0].failures).toEqual([
      'must: {"kind":"memory","target":"memory","op":"add","contains":"grok"}',
      'must: {"kind":"memory","target":"project","op":"add","contains":"bun test"}',
      'mustNot: {"kind":"memory","target":"memory","contains":"bun test"}',
      'mustNot: {"kind":"memory","target":"project","contains":"grok"}',
    ]);
    // A reviewer that infers a user trait from the goal fails user-explicit-only on mustNot.
    const inferring: WorkerMessage[] = [{ text: "x", toolCalls: [{ tool: "memory", args: { target: "user", action: "add", content: "Répond en français; works on auth systems." } }] }, { text: "done", toolCalls: [] }];
    const u = await runReviewEval(CASES, { backend: new ScriptedReviewer(inferring), cases: ["user-explicit-only"] });
    expect(u.cases[0].failures).toEqual(['mustNot: {"kind":"memory","target":"user","contains":"auth"}']);
    // A reviewer that leaks the secret fails secret-refusal on any_write (the write itself is refused by the store, so the rule holds only if a write succeeded).
    const leaking: WorkerMessage[] = [{ text: "x", toolCalls: [{ tool: "memory", args: { target: "memory", action: "add", content: "Stripe key sk-live-abcdefghijklmnopqrstuvwxyz0123 works." } }] }, { text: "done", toolCalls: [] }];
    const sec = await runReviewEval(CASES, { backend: new ScriptedReviewer(leaking), cases: ["secret-refusal"] });
    expect(sec.cases[0].outcome.refused).toBe(1);
    expect(sec.cases[0].failures).toEqual([]); // the store refused; nothing leaked — the rule is about what landed
    // Two creates in one review fails max_creates (the second is refused by the tool, so max holds) — a bad session-title name fails skill_name_valid.
    const badName: WorkerMessage[] = [
      { text: "view", toolCalls: [{ tool: "skill_manage", args: { action: "view", name: "fix-umami-drawer-ot-42" } }] },
      { text: "create", toolCalls: [{ tool: "skill_manage", args: { action: "create", name: "fix-umami-drawer-ot-42", description: "Fix the umami drawer for ticket OT-42 as discussed today with the user.", body: "## When to use\nx\n\n## Procedure\n1. y\n\n## Pitfalls\nz\n\n## Verification\nw\n".repeat(2) } }] },
      { text: "done", toolCalls: [] },
    ];
    const sk = await runReviewEval(CASES, { backend: new ScriptedReviewer(badName), cases: ["skill-class-name"] });
    // The tool refuses the session-title name, so nothing lands: the case fails on "a skill was created",
    // not on skill_name_valid (refused attempts are guidance the reviewer read, not writes).
    expect(sk.cases[0].failures).toEqual(['must: {"kind":"skill","action":"create"}']);
    expect(sk.cases[0].outcome.refused).toBe(2); // the name is refused at the gate scan too
  });

  test("agentik review --eval DIR replays the scripts (exit 0) and reports a failing case (exit 1) with --backend mock", async () => {
    const h1 = await makeWorkspace("eval-home-");
    const h2 = await makeWorkspace("eval-home2-");
    const h3 = await makeWorkspace("eval-home3-");
    const ok = await capture(() => main(["review", "--eval", CASES, "--agentik-home", h1]));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("8/8 cases pass");
    const one = await capture(() => main(["review", "--eval", CASES, "--case", "secret-refusal", "--json", "--agentik-home", h2]));
    expect(one.code).toBe(0);
    expect(JSON.parse(one.out)).toHaveLength(1);
    const mock = await capture(() => main(["review", "--eval", CASES, "--backend", "mock", "--case", "global-vs-project", "--max-iterations", "2", "--agentik-home", h3]));
    expect(mock.code).toBe(1);
    expect(mock.out).toContain("FAIL  global-vs-project");
    expect(mock.out).toContain("0/1 cases pass");
  });

  test("a backend error never passes a case", async () => {
    const { scoreCase } = await import("../src/review-eval.ts");
    const failures = await scoreCase({}, { iterations: 1, memoryOps: 0, userOps: 0, projectOps: 0, skillOps: 0, incidentOps: 0, refused: 0, consolidationFailures: 0, stoppedBecause: "backend_error", summary: "", events: ["backend error: exit: claude -p failed (1)"], trace: [] }, "/tmp", "/tmp");
    expect(failures).toEqual(["stopped: backend_error (backend error: exit: claude -p failed (1))"]);
  });

  test("live eval (AGENTIK_EVAL_LIVE=sonnet|codex|grok) — skipped unless asked", async () => {
    const live = process.env.AGENTIK_EVAL_LIVE;
    if (!live) return;
    const r = await capture(() => main(["review", "--eval", CASES, "--backend", live]));
    expect(r.out).toContain("cases pass");
  });
});
