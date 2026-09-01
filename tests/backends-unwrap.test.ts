import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeCliArgs,
  codexCliArgs,
  decodeClaudeStdout,
  decodeCodexStdout,
  decodeGrokStdout,
  grokCliArgs,
  parseWorkerMessage,
} from "../src/backends.ts";

const fixtures = join(import.meta.dir, "fixtures");

describe("CLI envelope unwrap (shipped decodeGrokStdout / decodeClaudeStdout)", () => {
  test("Grok envelope with nested worker JSON in text keeps toolCalls and tasks", () => {
    const stdout = readFileSync(join(fixtures, "grok-envelope-with-tools.json"), "utf8");
    const dropped = parseWorkerMessage(stdout);
    expect(dropped.toolCalls).toBeUndefined();

    const msg = decodeGrokStdout(stdout);
    expect(msg.toolCalls?.length).toBeGreaterThan(0);
    expect(msg.toolCalls?.[0].tool).toBe("write_file");
    expect(msg.toolCalls?.[0].args.path).toBe("src/greet.txt");
    expect(msg.tasks?.length).toBeGreaterThan(0);
    expect(msg.tasks?.[0].assignee).toBe("worker_a");
    expect(msg.text).toContain("implementing");
  });

  test("Grok envelope with text as nested object keeps toolCalls", () => {
    const envelope = {
      text: {
        text: "ops status",
        toolCalls: [{ tool: "sandbox_ops", args: { action: "workspace_status" } }],
      },
      stopReason: "end_turn",
      sessionId: "01a058e2-c96d-7e62-ba9f-786bfdaff924",
      usage: { input_tokens: 1 },
    };
    const msg = decodeGrokStdout(JSON.stringify(envelope));
    expect(msg.toolCalls?.[0].tool).toBe("sandbox_ops");
    expect(msg.toolCalls?.[0].args.action).toBe("workspace_status");
  });

  test("Claude { result: worker-json } envelope keeps toolCalls and tasks", () => {
    const stdout = readFileSync(join(fixtures, "claude-result-with-tools.json"), "utf8");
    const dropped = parseWorkerMessage(stdout);
    expect(dropped.toolCalls).toBeUndefined();

    const msg = decodeClaudeStdout(stdout);
    expect(msg.toolCalls?.length).toBeGreaterThan(0);
    expect(msg.toolCalls?.[0].tool).toBe("write_file");
    expect(msg.toolCalls?.[0].args.path).toBe("src/greet.txt");
    expect(msg.tasks?.[0].assignee).toBe("worker_a");
    expect(msg.text).toContain("implementing");
  });

  test("Grok CLI args use --yolo and deny native tools so they cannot bypass the gate", () => {
    const args = grokCliArgs("trusted goal", "/proj");
    expect(args[0]).toBe("--yolo");
    expect(args).toContain("--single");
    expect(args).toContain("--no-subagents");
    expect(args).toContain("--no-plan");
    expect(args).toContain("--disallowed-tools");
    expect(args).toContain("--disable-web-search");
    expect(args).toContain("--cwd");
    expect(args).toContain("--max-turns");

    // Grok matches its *internal* tool ids here, not Claude's capitalised names, and not the
    // ids in its own prose docs either: these come from the binary's `available_commands`
    // event (`run_terminal_command`, not `run_terminal_cmd`; `write`, not `write_file`).
    // Claude-style names silently matched nothing, so the deny list was a no-op.
    const deny = args[args.indexOf("--disallowed-tools") + 1].split(",");
    for (const id of ["run_terminal_command", "search_replace", "write", "read_file", "web_fetch", "web_search"]) {
      expect(deny).toContain(id);
    }
    expect(deny).not.toContain("run_terminal_cmd");
    expect(deny).not.toContain("write_file");
    // `Agent` is the one special entry grok also accepts (blocks subagent spawning).
    expect(deny).toContain("Agent");
    for (const claudeName of ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch"]) {
      expect(deny).not.toContain(claudeName);
    }
  });

  test("Claude CLI args match cla (skip-permissions, effort high) and still deny host tools", () => {
    const args = claudeCliArgs("trusted goal", "sonnet");
    expect(args).toContain("-p");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("--restricted");
  });

  test("Codex CLI args match cc (codex --yolo exec) and keep JSON schema", () => {
    const args = codexCliArgs("trusted goal", "/proj/.agentik/worker-schema.json", "/proj");
    expect(args[0]).toBe("exec");
    expect(args).toContain("--yolo");
    expect(args).toContain("--json");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--cd");
    expect(args[args.length - 1]).toBe("trusted goal");
  });

  test("Codex JSONL envelope keeps toolCalls", () => {
    const stdout = readFileSync(join(fixtures, "codex-jsonl-with-tools.jsonl"), "utf8");
    const dropped = parseWorkerMessage(stdout);
    expect(dropped.toolCalls).toBeUndefined();
    const msg = decodeCodexStdout(stdout);
    expect(msg.toolCalls?.[0].tool).toBe("write_file");
    expect(msg.toolCalls?.[0].args.path).toBe("src/greet.txt");
    expect(msg.tasks?.[0].assignee).toBe("worker_a");
  });
});
