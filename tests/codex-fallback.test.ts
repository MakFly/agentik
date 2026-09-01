import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexBackend, type SpawnRunner } from "../src/backends.ts";
import {
  loadCodexCapabilities,
  looksLikeStructuredOutputFailure,
  saveCodexCapabilities,
  shouldTryStructuredOutput,
} from "../src/codex-capabilities.ts";
import { makeWorkspace } from "./helpers.ts";
import type { CompleteRequest } from "../src/types.ts";

const OK_STREAM = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"text\\":\\"done\\",\\"toolCalls\\":[]}"}}',
  '{"type":"turn.completed","usage":{}}',
].join("\n");

const ADAPTER_EOF_STREAM = [
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected before completion: Incomplete response returned, reason: adapter_eof)"}',
  '{"type":"turn.failed","error":{"message":"stream disconnected before completion: Incomplete response returned, reason: adapter_eof"}}',
].join("\n");

function request(workspace: string): CompleteRequest {
  return { role: "worker_a", phase: "act", trustedGoal: "g", envelopes: [], system: "s", workspace, workerCount: 1 };
}

/** Records every invocation; answers per whether --output-schema was passed. */
function fakeCodex(behaviour: { withSchema: "ok" | "adapter_eof"; withoutSchema: "ok" }) {
  const calls: string[][] = [];
  const runner: SpawnRunner = async (_cmd, args) => {
    calls.push(args);
    const structured = args.includes("--output-schema");
    if (structured && behaviour.withSchema === "adapter_eof") {
      return { stdout: ADAPTER_EOF_STREAM, stderr: "Reading additional input from stdin...", exitCode: 1, timedOut: false, signal: null };
    }
    return { stdout: OK_STREAM, stderr: "", exitCode: 0, timedOut: false, signal: null };
  };
  return { runner, calls };
}

describe("codex structured output is learned per routing, never assumed", () => {
  test("native codex: schema works, verdict 'ok' is remembered, schema kept on later calls", async () => {
    const home = await makeWorkspace("cx-native-");
    const ws = await makeWorkspace("cx-native-ws-");
    const fake = fakeCodex({ withSchema: "ok", withoutSchema: "ok" });
    const backend = new CodexBackend(1000, { runner: fake.runner, home });
    const msg = await backend.complete(request(ws));
    expect(msg.text).toBe("done");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toContain("--output-schema");
    const caps = await loadCodexCapabilities(home);
    expect(caps?.structuredOutput).toBe("ok");
    await backend.complete(request(ws));
    expect(fake.calls[1]).toContain("--output-schema");
  });

  test("behind opencodex: one adapter_eof, then fallback without schema, then the schema is skipped", async () => {
    const home = await makeWorkspace("cx-proxy-");
    const ws = await makeWorkspace("cx-proxy-ws-");
    const fake = fakeCodex({ withSchema: "adapter_eof", withoutSchema: "ok" });
    const backend = new CodexBackend(1000, { runner: fake.runner, home });
    const msg = await backend.complete(request(ws));
    expect(msg.text).toBe("done");
    // First call tried the schema, second call (fallback) did not.
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toContain("--output-schema");
    expect(fake.calls[1]).not.toContain("--output-schema");
    const caps = await loadCodexCapabilities(home);
    expect(caps?.structuredOutput).toBe("unsupported");
    expect(caps?.evidence).toContain("adapter_eof");
    // Learned: the next call goes straight to no-schema, one process only.
    await backend.complete(request(ws));
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]).not.toContain("--output-schema");
    expect(JSON.parse(await readFile(join(home, "codex-capabilities.json"), "utf8")).baseUrl).toBeDefined();
  });

  test("a changed base URL invalidates the learned verdict", async () => {
    const home = await makeWorkspace("cx-reroute-");
    await saveCodexCapabilities({ baseUrl: "http://127.0.0.1:10100/v1", structuredOutput: "unsupported", checkedAt: "x" }, home);
    expect(await shouldTryStructuredOutput({ home, baseUrl: "http://127.0.0.1:10100/v1" })).toBe(false);
    expect(await shouldTryStructuredOutput({ home, baseUrl: "https://api.openai.com/v1" })).toBe(true);
  });

  test("AGENTIK_CODEX_OUTPUT_SCHEMA=always|never overrides the learned verdict", async () => {
    const home = await makeWorkspace("cx-env-");
    await saveCodexCapabilities({ baseUrl: "u", structuredOutput: "unsupported", checkedAt: "x" }, home);
    expect(await shouldTryStructuredOutput({ home, baseUrl: "u", mode: "always" })).toBe(true);
    expect(await shouldTryStructuredOutput({ home, baseUrl: "u", mode: "never" })).toBe(false);
    expect(await shouldTryStructuredOutput({ home, baseUrl: "u", mode: "auto" })).toBe(false);
  });

  test("only the structured-output signature triggers the fallback; a timeout or auth error does not", () => {
    expect(looksLikeStructuredOutputFailure(ADAPTER_EOF_STREAM)).toBe(true);
    expect(looksLikeStructuredOutputFailure('{"type":"error","message":"not logged in"}')).toBe(false);
    expect(looksLikeStructuredOutputFailure("")).toBe(false);
  });
});
