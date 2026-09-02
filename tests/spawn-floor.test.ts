import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeFloorSettings, foreignWorkerArgs } from "../src/backends.ts";
import { denyFloorPrompt, HIGH_BLAST_DENY_RULES } from "../src/command-policy.ts";
import { listIncidents } from "../src/incidents.ts";
import { consumeVerdictLine, floorViolations, newVerdict } from "../src/verdict.ts";
import { makeWorkspace } from "./helpers.ts";

describe("foreignWorkerArgs carries the high-blast floor", () => {
  test("claude: --settings permissions.deny with every rule glob; Agent still disallowed", () => {
    const { args } = foreignWorkerArgs("claude", "task", "/proj");
    const i = args.indexOf("--settings");
    expect(i).toBeGreaterThan(0);
    const settings = JSON.parse(args[i + 1]) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain("Bash(rm -rf *)");
    expect(settings.permissions.deny).toContain("Bash(git push --force *)");
    expect(settings.permissions.deny).toContain("Bash(agentik spawn *)");
    expect(settings.permissions.deny.length).toBe(HIGH_BLAST_DENY_RULES.flatMap((r) => r.globs).length);
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Agent");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[i + 1]).toBe(claudeFloorSettings());
  });

  test("grok: repeated --deny Bash(…) pairs", () => {
    const { args } = foreignWorkerArgs("grok", "task", "/proj");
    const denies = args.filter((_, k) => args[k - 1] === "--deny");
    expect(denies).toContain("Bash(rm -rf *)");
    expect(denies.length).toBe(HIGH_BLAST_DENY_RULES.flatMap((r) => r.globs).length);
    expect(args).toContain("--yolo");
  });

  test("codex: no flag exists — the floor is a trusted line in front of the prompt", () => {
    const { args } = foreignWorkerArgs("codex", "the task", "/proj");
    const prompt = args[args.length - 1];
    expect(prompt.startsWith(denyFloorPrompt())).toBe(true);
    expect(prompt.endsWith("the task")).toBe(true);
    expect(args.some((a) => a.includes("--deny"))).toBe(false);
  });

  test("--allow-high-blast strips the floor on all three", () => {
    const o = { allowHighBlast: true };
    expect(foreignWorkerArgs("claude", "t", "/p", [], o).args).not.toContain("--settings");
    expect(foreignWorkerArgs("grok", "t", "/p", [], o).args).not.toContain("--deny");
    const codex = foreignWorkerArgs("codex", "the task", "/p", [], o).args;
    expect(codex[codex.length - 1]).toBe("the task");
  });
});

describe("verdict: commands the harness ran, and the floor after the fact", () => {
  test("claude Bash tool_use is a command; a permission_denials entry is not a violation", () => {
    const v = newVerdict("claude");
    consumeVerdictLine(v, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git push --force origin main" } }] } }));
    consumeVerdictLine(v, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }] } }));
    consumeVerdictLine(v, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }] } }));
    expect(v.commands).toEqual(["git push --force origin main", "bun test"]);
    expect(floorViolations(v)).toEqual([{ command: "git push --force origin main", rules: ["git_push_force"] }]);
    consumeVerdictLine(v, JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "ok", permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }] }));
    expect(v.denied).toEqual(["git push --force origin main"]);
    expect(floorViolations(v)).toEqual([]);
    expect(v.eventCount).toBe(4);
  });

  test("codex command_execution and grok run_terminal_command are commands; every match is a violation", () => {
    const c = newVerdict("codex");
    consumeVerdictLine(c, JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "sudo rm -rf /tmp/x" } }));
    consumeVerdictLine(c, JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: ["ls", "-la"] } }));
    expect(c.commands).toEqual(["sudo rm -rf /tmp/x", "ls -la"]);
    expect(floorViolations(c).map((x) => x.rules)).toEqual([["rm_rf", "sudo"]]);
    const g = newVerdict("grok");
    consumeVerdictLine(g, JSON.stringify({ type: "tool_call", toolName: "run_terminal_command", rawInput: { command: "terraform destroy" } }));
    consumeVerdictLine(g, JSON.stringify({ type: "tool_call", toolName: "write", rawInput: { path: "a", content: "rm -rf /" } }));
    expect(g.commands).toEqual(["terraform destroy"]);
    expect(floorViolations(g)).toHaveLength(1);
    // grok's own denial (seen live on grok 1.0.13) is the floor working, not a violation.
    consumeVerdictLine(g, JSON.stringify({ type: "tool_result", toolName: "run_terminal_command", result: 'Tool `run_terminal_command` was not executed: Denied by permission policy: deny rule on bash matching "terraform destroy*"' }));
    expect(g.denied).toEqual(["terraform destroy"]);
    expect(floorViolations(g)).toHaveLength(0);
    consumeVerdictLine(g, JSON.stringify({ type: "tool_call", toolName: "run_terminal_command", rawInput: { command: "git push --force origin main" } }));
    consumeVerdictLine(g, JSON.stringify({ type: "text", data: "Tool `run_terminal_command` was not executed: Denied by permission policy: deny rule on bash matching \"git push --force *\"" }));
    expect(floorViolations(g)).toHaveLength(0);
  });
});

/**
 * A `claude` that logs in, advertises deny rules in --help (unless `noDeny`), dumps its argv,
 * and then replays the given stream lines. `exitCode` / `stderrLine` simulate a CLI that
 * refuses its argv.
 */
async function fakeClaude(dir: string, opts: { argvFile: string; lines?: string[]; noDeny?: boolean; exitCode?: number; stderrLine?: string }): Promise<void> {
  await mkdir(dir, { recursive: true });
  const lines = opts.lines ?? [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}',
    '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"done"}',
  ];
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "--help" ]; then ${opts.noDeny ? "echo '  --model <model>'" : "echo '  --disallowedTools <tools...>  deny'; echo '  --settings <file-or-json>'"}; exit 0; fi`,
    `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`,
    `printf '%s\\n' "$@" > '${opts.argvFile}'`,
    ...(opts.stderrLine ? [`echo '${opts.stderrLine}' >&2`] : []),
    ...(opts.exitCode ? [`exit ${opts.exitCode}`] : []),
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
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, AGENTIK_HOME: undefined },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe("agentik spawn: the floor is installed, detected, never silently dropped", () => {
  const base = (home: string, ws: string) => ["spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "30"];

  test("claude receives --settings with the deny list; --allow-high-blast removes it and says so", async () => {
    const home = await makeWorkspace("floor-home-");
    const ws = await makeWorkspace("floor-ws-");
    const bin = join(home, "bin");
    const argvFile = join(home, "argv.txt");
    await fakeClaude(bin, { argvFile });
    const withFloor = await spawnCli([...base(home, ws), "do the thing"], bin);
    expect(withFloor.code).toBe(0);
    const argv = (await readFile(argvFile, "utf8")).split("\n");
    const i = argv.indexOf("--settings");
    expect(i).toBeGreaterThan(0);
    expect(JSON.parse(argv[i + 1]).permissions.deny).toContain("Bash(rm -rf *)");
    expect(withFloor.stderr).not.toContain("floor DISABLED");

    const without = await spawnCli([...base(home, ws), "--allow-high-blast", "do the thing"], bin);
    expect(without.code).toBe(0);
    expect(without.stderr).toContain("floor DISABLED");
    expect((await readFile(argvFile, "utf8")).split("\n")).not.toContain("--settings");
  });

  test("a high-blast command in the stream is a FLOOR VIOLATION incident; the exit code stays 0", async () => {
    const home = await makeWorkspace("floor-viol-home-");
    const ws = await makeWorkspace("floor-viol-ws-");
    const bin = join(home, "bin");
    await fakeClaude(bin, {
      argvFile: join(home, "argv.txt"),
      lines: [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git push --force origin main"}}]}}',
        '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"pushed"}',
      ],
    });
    const res = await spawnCli([...base(home, ws), "push it"], bin);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("FLOOR VIOLATION");
    expect(res.stderr).toContain("git_push_force");
    const incidents = await listIncidents({ home, workspace: ws });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].symptom).toContain("despite the floor: git_push_force");
    expect(incidents[0].errors.some((e) => e.includes("ran: git push --force"))).toBe(true);
  });

  test("a command the harness itself denied is not a violation", async () => {
    const home = await makeWorkspace("floor-denied-home-");
    const ws = await makeWorkspace("floor-denied-ws-");
    const bin = join(home, "bin");
    await fakeClaude(bin, {
      argvFile: join(home, "argv.txt"),
      lines: [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"rm -rf build"}}]}}',
        '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"could not","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"rm -rf build"}}]}',
      ],
    });
    const res = await spawnCli([...base(home, ws), "clean"], bin);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("denied by the floor — rm -rf build");
    expect(res.stderr).not.toContain("FLOOR VIOLATION");
    expect(await listIncidents({ home, workspace: ws })).toHaveLength(0);
  });

  test("a CLI that rejects the deny flags at argv is named as such (exit 1, incident)", async () => {
    const home = await makeWorkspace("floor-argv-home-");
    const ws = await makeWorkspace("floor-argv-ws-");
    const bin = join(home, "bin");
    await fakeClaude(bin, { argvFile: join(home, "argv.txt"), exitCode: 1, stderrLine: "error: unknown option --settings" });
    const res = await spawnCli([...base(home, ws), "x"], bin);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("rejected the deny rules (argv)");
    const incidents = await listIncidents({ home, workspace: ws });
    expect(incidents[0].symptom).toContain("rejected the deny rules (argv)");
  });

  test("a claude whose --help has no deny flag is refused (exit 2) unless --allow-high-blast", async () => {
    const home = await makeWorkspace("floor-nodeny-home-");
    const ws = await makeWorkspace("floor-nodeny-ws-");
    const bin = join(home, "bin");
    await fakeClaude(bin, { argvFile: join(home, "argv.txt"), noDeny: true });
    const refused = await spawnCli([...base(home, ws), "x"], bin);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("does not advertise deny rules");
    expect(refused.stderr).toContain("--allow-high-blast");
    expect(await listIncidents({ home, workspace: ws })).toHaveLength(0);
    const allowed = await spawnCli([...base(home, ws), "--allow-high-blast", "x"], bin);
    expect(allowed.code).toBe(0);
  });
});
