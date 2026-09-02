import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listIncidents } from "../src/incidents.ts";
import { consumeVerdictLine, describeEvidence, evidenceOf, isTestCommand, newVerdict, summarizeVerdict, verdictProblem, type HarnessVerdict } from "../src/verdict.ts";
import type { HarnessName } from "../src/availability.ts";
import { makeWorkspace } from "./helpers.ts";

function fold(harness: HarnessName, lines: unknown[]): HarnessVerdict {
  const v = newVerdict(harness);
  for (const l of lines) consumeVerdictLine(v, JSON.stringify(l));
  return v;
}
const claudeTool = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const claudeDone = { type: "result", subtype: "success", is_error: false, num_turns: 3, result: "done" };

describe("isTestCommand", () => {
  const yes = ["bun test", "bun test tests/x.test.ts", "bunx tsc --noEmit", "tsc --noEmit", "npm test", "npm run test", "pnpm test", "yarn test", "pytest -q", "python -m pytest", "cargo test", "go test ./...", "vitest run", "jest", "make test", "dotnet test", "cd packages/app && bun test", "CI=1 bun test", "npx vitest", "pnpm exec vitest", "bun run build && bun test", "bunx tsc --noEmit && bun test"];
  const no = ["echo bun test", "bun run build", "cat test.txt", "git status", "./scripts/test.sh", "grep test src/", "npm run lint", "bun test.ts"];
  for (const c of yes) test(`test: ${c}`, () => expect(isTestCommand(c)).toBe(true));
  for (const c of no) test(`not a test: ${c}`, () => expect(isTestCommand(c)).toBe(false));
});

describe("verdict events and evidence", () => {
  test("claude: edits, a test, then an edit → stale; test after → fresh; no test → none", () => {
    const v = fold("claude", [claudeTool("Write", { file_path: "src/a.ts", content: "x" }), claudeTool("Bash", { command: "bun test" }), claudeTool("Edit", { file_path: "src/b.ts" }), claudeDone]);
    expect(v.events.map((e) => e.kind)).toEqual(["edit", "test", "edit"]);
    expect(v.events[0].paths).toEqual(["src/a.ts"]);
    expect(evidenceOf(v)).toMatchObject({ evidence: "stale", editsAfterLastTest: 1, tests: 1, edits: 2 });
    expect(describeEvidence(v)).toBe("evidence=stale(1 edit after last test)");
    expect(summarizeVerdict(v)).toContain("evidence=stale(1 edit after last test)");
    consumeVerdictLine(v, JSON.stringify(claudeTool("Bash", { command: "bunx tsc --noEmit && bun test" })));
    expect(evidenceOf(v).evidence).toBe("fresh");
    const none = fold("claude", [claudeTool("Edit", { file_path: "x" }), claudeTool("Bash", { command: "echo bun test" }), claudeDone]);
    expect(evidenceOf(none).evidence).toBe("none");
    expect(none.events.map((e) => e.kind)).toEqual(["edit", "other"]);
  });

  test("grok and codex edit tools and commands are classified", () => {
    const g = fold("grok", [
      { type: "tool_call", toolName: "write", rawInput: { path: "a.py", content: "" } },
      { type: "tool_call", toolName: "run_terminal_command", rawInput: { command: "pytest -q" } },
      { type: "end", stopReason: "end_turn", num_turns: 2 },
    ]);
    expect(g.events.map((e) => e.kind)).toEqual(["edit", "test"]);
    const c = fold("codex", [
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/x.rs", kind: "update" }] } },
      { type: "item.completed", item: { type: "command_execution", command: "cargo test" } },
      { type: "turn.completed" },
    ]);
    expect(c.events.map((e) => e.kind)).toEqual(["edit", "test"]);
    expect(c.events[0].paths).toEqual(["src/x.rs"]);
    expect(evidenceOf(c).evidence).toBe("fresh");
  });

  test("verdictProblem with requireEvidence", () => {
    const stale = fold("claude", [claudeTool("Bash", { command: "bun test" }), claudeTool("Edit", { file_path: "x" }), claudeDone]);
    expect(verdictProblem(stale)).toBeUndefined();
    expect(verdictProblem(stale, { requireEvidence: true })).toContain("no test ran after the last edit");
    const none = fold("claude", [claudeTool("Edit", { file_path: "x" }), claudeDone]);
    expect(verdictProblem(none, { requireEvidence: true })).toContain("ran no test at all");
    const fresh = fold("claude", [claudeTool("Edit", { file_path: "x" }), claudeTool("Bash", { command: "bun test" }), claudeDone]);
    expect(verdictProblem(fresh, { requireEvidence: true })).toBeUndefined();
  });
});

async function fakeClaude(dir: string, lines: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "--help" ]; then echo '  --disallowedTools <tools...>  deny'; echo '  --settings <file-or-json>'; exit 0; fi`,
    `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`,
    ...lines.map((l) => `printf '%s\\n' '${l}'`),
    "exit 0",
    "",
  ].join("\n");
  await writeFile(join(dir, "claude"), script, "utf8");
  await chmod(join(dir, "claude"), 0o755);
}

async function spawnCli(argv: string[], fakeBin: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, AGENTIK_DEPTH: undefined },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe("agentik spawn --require-evidence", () => {
  test("edit without a test after it → 125, evidence in the incident; with a fresh test → 0", async () => {
    const home = await makeWorkspace("ev-home-");
    const ws = await makeWorkspace("ev-ws-");
    const bin = join(home, "bin");
    const edit = JSON.stringify(claudeTool("Write", { file_path: "b.txt", content: "OK" }));
    const test_ = JSON.stringify(claudeTool("Bash", { command: "bun test" }));
    await fakeClaude(bin, [edit, JSON.stringify(claudeDone)]);
    const base = ["spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "30"];
    const stale = await spawnCli([...base, "--require-evidence", "create b.txt"], bin);
    expect(stale.code).toBe(125);
    expect(stale.stderr).toContain("the result is unverified");
    expect(stale.stderr).toContain("evidence=none");
    const incidents = await listIncidents({ home, workspace: ws });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].errors[0]).toBe("evidence=none");
    // Without the flag the same run is a success (default off).
    expect((await spawnCli([...base, "create b.txt"], bin)).code).toBe(0);
    await fakeClaude(bin, [edit, test_, JSON.stringify(claudeDone)]);
    const fresh = await spawnCli([...base, "--require-evidence", "create b.txt"], bin);
    expect(fresh.code).toBe(0);
    expect(fresh.stderr).toContain("evidence=fresh");
  });
});
