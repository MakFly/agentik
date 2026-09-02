import { describe, expect, test } from "bun:test";
import { boundTranscript, reviewSystemPrompt, runReview, TRANSCRIPT_CAP } from "../src/reviewer.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

class ScriptedReviewer implements Backend {
  readonly id = "scripted";
  seen: CompleteRequest[] = [];
  constructor(private readonly script: WorkerMessage[]) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    return this.script[this.seen.length - 1] ?? { text: "nothing more", toolCalls: [] };
  }
}

describe("review bounds", () => {
  test("boundTranscript: short text untouched; long text keeps head 36k + tail 24k with a marker", () => {
    const short = "a".repeat(TRANSCRIPT_CAP);
    expect(boundTranscript(short)).toBe(short);
    const long = "H".repeat(50_000) + "M".repeat(50_000) + "T".repeat(50_000);
    const bounded = boundTranscript(long);
    expect(bounded.length).toBeLessThan(TRANSCRIPT_CAP + 100);
    expect(bounded.startsWith("H".repeat(36_000))).toBe(true);
    expect(bounded.endsWith("T".repeat(24_000))).toBe(true);
    expect(bounded).toContain(`…[truncated ${150_000 - 60_000} chars]…`);
    expect(bounded.slice(36_000, 36_000 + 40)).not.toContain("M".repeat(40));
  });

  test("runReview bounds the transcript once, before it is wrapped as DATA", async () => {
    const home = await makeWorkspace("rb-home-");
    const ws = await makeWorkspace("rb-ws-");
    const backend = new ScriptedReviewer([{ text: "nothing", toolCalls: [] }]);
    const transcript = "BEGIN " + "x".repeat(200_000) + " END";
    await runReview({ goal: "g", transcript, workspace: ws, home, backend });
    const env = backend.seen[0].envelopes.find((e) => e.origin === "run:transcript");
    expect(env).toBeDefined();
    expect(env!.body.length).toBeLessThan(TRANSCRIPT_CAP + 200);
    expect(env!.body).toContain("BEGIN");
    expect(env!.body).toContain(" END");
    expect(env!.body).toContain("…[truncated");
  });

  test("trace records every tool call in order, refused ones included", async () => {
    const home = await makeWorkspace("rb-trace-");
    const ws = await makeWorkspace("rb-trace-ws-");
    const backend = new ScriptedReviewer([
      {
        text: "remember",
        toolCalls: [
          { tool: "memory", args: { target: "memory", action: "add", content: "Bun runs the tests here, not jest." } },
          { tool: "write_file", args: { path: "x", content: "y" } },
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runReview({ goal: "g", transcript: "t", workspace: ws, home, backend });
    expect(out.trace.map((t) => [t.tool, t.ok])).toEqual([["memory", true], ["write_file", false]]);
    expect(out.trace[0].args).toMatchObject({ target: "memory", action: "add" });
    expect(out.trace[0].output).toContain("ok");
    expect(out.trace[1].output).toContain("not a review tool");
    expect(out.memoryOps).toBe(1);
    expect(out.refused).toBe(1);
  });

  test("guidance routes environment failures to the incident log, not memory", () => {
    const p = reviewSystemPrompt();
    expect(p).toContain('A missing binary, a credential that is not configured, "X does not work today"');
    expect(p).toContain("Transient or environment-dependent failures go to the incident log, not to memory");
  });
});
