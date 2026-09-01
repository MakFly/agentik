import { describe, expect, test } from "bun:test";
import {
  consumeVerdictLine,
  newVerdict,
  summarizeVerdict,
  verdictArgs,
  verdictProblem,
  type HarnessVerdict,
} from "../src/verdict.ts";
import type { HarnessName } from "../src/availability.ts";

function fold(harness: HarnessName, lines: unknown[]): HarnessVerdict {
  const v = newVerdict(harness);
  for (const l of lines) consumeVerdictLine(v, JSON.stringify(l));
  return v;
}

describe("verdict flags", () => {
  test("each harness gets its own NDJSON stream flag", () => {
    expect(verdictArgs("grok")).toEqual(["--output-format", "streaming-json"]);
    expect(verdictArgs("claude")).toEqual(["--output-format", "stream-json", "--verbose"]);
    expect(verdictArgs("codex")).toEqual(["--json"]);
  });
});

describe("grok streaming-json", () => {
  // Event shapes captured from a real `grok -p --output-format streaming-json` run.
  test("a real turn with tool calls completes", () => {
    const v = fold("grok", [
      { type: "available_commands", tools: [], commands: [] },
      { type: "thought", data: "thinking" },
      { type: "tool_call", toolCallId: "c1", toolName: "read_file", rawInput: { path: "a.ts" } },
      { type: "tool_call_update", toolCallId: "c1", status: "completed" },
      { type: "text", data: "done." },
      { type: "end", stopReason: "end_turn", num_turns: 7 },
    ]);
    expect(v.completed).toBe(true);
    expect(v.turns).toBe(7);
    expect(v.toolCalls).toBe(1);
    expect(v.toolNames).toEqual(["read_file"]);
    expect(v.text).toBe("done.");
    expect(verdictProblem(v, { requireTools: true })).toBeUndefined();
  });

  test("a narrated plan with no tool call is caught when the task required tools", () => {
    const v = fold("grok", [
      { type: "text", data: "I will now write the migration." },
      { type: "end", stopReason: "end_turn", num_turns: 2 },
    ]);
    expect(v.completed).toBe(true);
    expect(v.toolCalls).toBe(0);
    // Exit code alone said 0 here. This is the whole point of reading the stream.
    expect(verdictProblem(v, { requireTools: true })).toMatch(/without calling a single tool/);
    // ...but a diagnostic task legitimately answers with prose only.
    expect(verdictProblem(v, {})).toBeUndefined();
  });

  test("a cut-short stop reason is a failure whatever the exit code", () => {
    for (const stopReason of ["max_turns", "max_turn_requests", "refusal", "cancelled"]) {
      const v = fold("grok", [{ type: "end", stopReason, num_turns: 24 }]);
      expect(v.completed).toBe(false);
      expect(verdictProblem(v, {})).toContain(stopReason);
    }
  });

  test("error and max_turns_reached events are recorded", () => {
    const v = fold("grok", [
      { type: "max_turns_reached" },
      { type: "error", message: "Couldn't start session" },
      { type: "end", stopReason: "end_turn", num_turns: 1 },
    ]);
    expect(v.errors).toEqual(["max turns reached", "Couldn't start session"]);
  });
});

describe("claude stream-json", () => {
  test("tool_use blocks count and the result line carries the verdict", () => {
    const v = fold("claude", [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Editing." },
            { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } },
          ],
        },
      },
      { type: "result", subtype: "success", is_error: false, num_turns: 4, stop_reason: "end_turn", result: "ok" },
    ]);
    expect(v.completed).toBe(true);
    expect(v.toolCalls).toBe(1);
    expect(v.turns).toBe(4);
    expect(v.text).toBe("ok");
  });

  test("is_error or a non-success subtype does not pass as done", () => {
    const v = fold("claude", [
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 30, result: "hit the cap" },
    ]);
    expect(v.completed).toBe(false);
    expect(v.errors).toContain("hit the cap");
    expect(verdictProblem(v, {})).toContain("error_max_turns");
  });

  test("permission denials are surfaced", () => {
    const v = fold("claude", [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        permission_denials: [{ tool: "Bash" }],
      },
    ]);
    expect(v.completed).toBe(true);
    expect(v.errors[0]).toContain("permission denial");
  });

  test("an error event before a successful result is recorded without changing completion", () => {
    const v = fold("claude", [
      { type: "system", subtype: "init" },
      { type: "error", error: { message: "MCP server notion failed to start" } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "ok" },
    ]);
    expect(v.errors).toEqual(["MCP server notion failed to start"]);
    expect(v.completed).toBe(true);
    expect(verdictProblem(v, {})).toBeUndefined();
  });

  test("an error event followed by an is_error result yields both lines and no completion", () => {
    const v = fold("claude", [
      { type: "error", message: "rate limited" },
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, result: "API Error: 529" },
    ]);
    expect(v.errors).toEqual(["rate limited", "API Error: 529"]);
    expect(v.completed).toBe(false);
  });

  test("error message precedence: error.message, then message, then error as a string", () => {
    expect(fold("claude", [{ type: "error", error: { message: "nested" }, message: "flat" }]).errors).toEqual(["nested"]);
    expect(fold("claude", [{ type: "error", message: "flat", error: "plain" }]).errors).toEqual(["flat"]);
    expect(fold("claude", [{ type: "error", error: "plain" }]).errors).toEqual(["plain"]);
  });

  test("system/error events are recorded; a failed tool_result is the worker's problem, not a harness error", () => {
    const v = fold("claude", [
      { type: "system", subtype: "error", message: "hook failed" },
      { type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "ENOENT" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 1 },
    ]);
    expect(v.errors).toEqual(["hook failed"]);
    expect(v.completed).toBe(true);
  });

  test("a malformed error event with no message falls back to its JSON, cut at 200 chars", () => {
    const v = fold("claude", [{ type: "error", detail: "x".repeat(500) }]);
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]!.length).toBeLessThanOrEqual(200);
    expect(v.errors[0]!.startsWith('{"type":"error"')).toBe(true);
    // No result line: still not completed, the error event alone decides nothing.
    expect(v.completed).toBe(false);

    const short = fold("claude", [{ type: "error" }]);
    expect(short.errors).toEqual(['{"type":"error"}']);
  });

  test("a long error message is cut at 200 chars", () => {
    const v = fold("claude", [{ type: "error", message: "m".repeat(300) }]);
    expect(v.errors[0]).toBe("m".repeat(200));
  });

  test("unknown claude event types are still ignored, even with an error field", () => {
    const v = fold("claude", [
      { type: "system", subtype: "init" },
      { type: "system", subtype: "compact_boundary" },
      { type: "some_future_event", error: "not an error event" },
      { type: "rate_limit_event", rate_limit_info: {} },
      { type: "result", subtype: "success", is_error: false, num_turns: 1 },
    ]);
    expect(v.errors).toEqual([]);
    expect(v.completed).toBe(true);
  });
});

describe("codex exec --json", () => {
  test("turn.completed is the authority, and work items count as tools", () => {
    const v = fold("codex", [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "command_execution", command: "bun test" } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts" }] } },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: {} },
    ]);
    expect(v.completed).toBe(true);
    expect(v.turns).toBe(1);
    expect(v.toolCalls).toBe(2);
    expect(v.text).toBe("done");
  });

  test("a benign error item does not fail a completed turn", () => {
    // A real trivial codex run emits an `error` item and still succeeds.
    const v = fold("codex", [
      { type: "item.completed", item: { type: "error", message: "benign" } },
      { type: "turn.completed", usage: {} },
    ]);
    expect(v.errors).toEqual(["benign"]);
    expect(v.completed).toBe(true);
    expect(verdictProblem(v, {})).toBeUndefined();
  });

  test("a stream with no completed turn is not a success", () => {
    const v = fold("codex", [{ type: "thread.started" }, { type: "turn.started" }]);
    expect(v.completed).toBe(false);
    expect(verdictProblem(v, {})).toMatch(/never reported a completed turn/);
  });
});

describe("robustness", () => {
  test("unknown event types and non-JSON lines are ignored, never read as failure", () => {
    const v = newVerdict("grok");
    consumeVerdictLine(v, "not json at all");
    consumeVerdictLine(v, "");
    consumeVerdictLine(v, JSON.stringify({ type: "some_future_event", data: 1 }));
    consumeVerdictLine(v, JSON.stringify({ type: "end", stopReason: "end_turn", num_turns: 3 }));
    expect(v.completed).toBe(true);
    expect(v.errors).toEqual([]);
  });

  test("summarizeVerdict is readable at a glance", () => {
    const v = fold("grok", [{ type: "end", stopReason: "end_turn", num_turns: 5 }]);
    expect(summarizeVerdict(v)).toBe("completed · stop=end_turn · turns=5 · tools=0");
  });
});
