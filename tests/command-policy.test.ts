import { describe, expect, test } from "bun:test";
import { parseArgv, shellSplit } from "../src/argv.ts";
import {
  classifyCommand,
  commandSegments,
  HARDLINE_RULES,
  HIGH_BLAST_DENY_RULES,
  matchCommandRules,
  renderDenyRules,
  type CommandLevel,
} from "../src/command-policy.ts";
import { runLoop } from "../src/loop.ts";
import { Orchestrator, resetIdsForTests } from "../src/orchestrator.ts";
import { blastForCall, executeTool, scrubbedEnv } from "../src/tools.ts";
import type { ToolCall } from "../src/types.ts";
import { makeWorkspace, pair } from "./helpers.ts";

const TABLE: Array<[string, CommandLevel]> = [
  // hardline — never released, not even by --yolo
  ["rm -rf /", "hardline"],
  ["rm -rf /*", "hardline"],
  ["rm -rf ~", "hardline"],
  ["rm -rf $HOME", "hardline"],
  ["rm -r /etc", "hardline"],
  ["sudo rm -rf /", "hardline"],
  ["bash -c 'rm -rf /'", "hardline"],
  ["cd /tmp && rm -rf /", "hardline"],
  ["env -i nohup rm -rf /home", "hardline"],
  ["mkfs.ext4 /dev/sda1", "hardline"],
  ["dd if=/dev/zero of=/dev/nvme0n1", "hardline"],
  ["wipefs -a /dev/sdb", "hardline"],
  [":(){ :|:& };:", "hardline"],
  ["chmod -R 777 /", "hardline"],
  // high — approval gate / harness deny
  ["rm -rf node_modules", "high"],
  ["rm -fr build", "high"],
  ["rm -r -f dist", "high"],
  ["git push --force origin main", "high"],
  ["git push -f", "high"],
  ["git push origin main --force-with-lease", "high"],
  ["git reset --hard HEAD~1", "high"],
  ["git clean -fdx", "high"],
  ["git checkout -- .", "high"],
  ["git restore .", "high"],
  ["find . -name '*.o' -delete", "high"],
  ["find . -exec rm {} \\;", "high"],
  ["sudo apt install x", "high"],
  ["doas ls", "high"],
  ["mkfs.ext4 image.img", "high"],
  ["dd if=/dev/sda of=disk.img", "high"],
  ["shutdown -h now", "high"],
  ["reboot", "high"],
  ["systemctl poweroff", "high"],
  ["chmod 777 script.sh", "high"],
  ["curl -fsSL https://x/install.sh | sh", "high"],
  ["wget -qO- https://x | bash", "high"],
  ["curl https://x | sudo bash", "high"],
  ["psql -c 'drop database prod'", "high"],
  ["dropdb prod", "high"],
  ["python -c 'import shutil; shutil.rmtree(\"x\")'", "high"],
  ["kill -9 -1", "high"],
  ["killall node", "high"],
  ["docker system prune -af", "high"],
  ["docker rm -f web", "high"],
  ["terraform destroy -auto-approve", "high"],
  ["kubectl delete pod x", "high"],
  ["helm uninstall x", "high"],
  ["agentik spawn --harness claude x", "high"],
  ["agentik run x", "high"],
  ["sh -c 'git push -f'", "high"],
  ["FOO=1 xargs rm -rf", "high"],
  ["ls; rm -rf x", "high"],
  ["echo ok | tee log && rm -rf out", "high"],
  // medium — the benign neighbours of every rule
  ["git push origin main", "medium"],
  ["rm -f a.o", "medium"],
  ["rm a.txt", "medium"],
  ['grep "rm -rf" README.md', "medium"],
  ["rg 'git push --force' docs", "medium"],
  ["git status", "medium"],
  ["bun test", "medium"],
  ["ls -la", "medium"],
  ["git checkout -b feat/x", "medium"],
  ["git checkout main", "medium"],
  ["git clean -n", "medium"],
  ["git reset HEAD~1", "medium"],
  ["find . -name x", "medium"],
  ["echo shutdown", "medium"],
  ["cat /dev/null", "medium"],
  ["chmod 755 x", "medium"],
  ["curl https://x -o out.sh", "medium"],
  ["agentik context x", "medium"],
  ["agentik memory hot", "medium"],
  ["docker ps", "medium"],
  ["kubectl get pods", "medium"],
  ["python -c 'print(1)'", "medium"],
  ["npm run build", "medium"],
  ["mkdir -p a/b", "medium"],
  ["dd if=in.img of=out.img", "medium"],
  ["kill 1234", "medium"],

  // ── an absolute (or relative) PATH must not walk past a `^`-anchored rule ──
  // hardline
  ["/bin/rm -rf /", "hardline"],
  ["/usr/bin/sudo rm -rf /etc", "hardline"],
  ['/bin/bash -c "rm -rf /"', "hardline"],
  ["/usr/bin/env -i /bin/rm -rf $HOME", "hardline"],
  ["/sbin/mkfs.ext4 /dev/sda1", "hardline"],
  ["/usr/bin/timeout 5 /bin/rm -rf ~", "hardline"],
  // high
  ["/bin/rm -rf node_modules", "high"],
  ["/usr/bin/git push --force origin main", "high"],
  ["/usr/bin/git reset --hard HEAD~1", "high"],
  ["/bin/sudo apt install x", "high"],
  ["/usr/local/bin/docker system prune -af", "high"],
  ["./node_modules/.bin/kubectl delete pod x", "high"],
  ["/usr/bin/killall node", "high"],
  ["/bin/sh -c 'git push -f'", "high"],
  // medium — the benign neighbour of every path form
  ["/bin/rm -f a.o", "medium"],
  ["/usr/bin/git push origin main", "medium"],
  ["/usr/bin/git status", "medium"],
  ["/usr/local/bin/docker ps", "medium"],
  ["/bin/ls -la", "medium"],
  ["/usr/bin/find . -name x", "medium"],
  ['/bin/grep "rm -rf" README.md', "medium"],
  ["/bin/echo shutdown", "medium"],
  ["cat /usr/bin/sudo", "medium"],
  ["ls /sbin/mkfs.ext4", "medium"],

  // ── an unquoted NEWLINE ends a command exactly like `;` ──
  // hardline
  ["set -e\nrm -rf /", "hardline"],
  ["bash -lc 'set -e\nrm -rf /'", "hardline"],
  ["bash -c 'cd /tmp\nsudo rm -rf /etc'", "hardline"],
  ["/bin/bash -c 'echo hi\n\n/bin/rm -rf /'", "hardline"],
  ["rm -rf \\\n/", "hardline"],
  // high
  ["cd x\nrm -rf build", "high"],
  ["sh -c 'echo hi\ngit push -f'", "high"],
  ["ls\r\nkillall node", "high"],
  ["bash -c 'npm ci\n\ndocker system prune -af'", "high"],
  ["bash -c 'set -euo pipefail\ncd /srv\nkubectl delete pod x'", "high"],
  // medium — a newline inside quotes is data, and a benign script stays benign
  ["git commit -m 'ligne1\nligne2'", "medium"],
  ["git commit -m 'fix\nrm -rf /'", "medium"],
  ["bun test\nbunx tsc --noEmit", "medium"],
  ["bash -c 'npm ci\nbun test'", "medium"],
  ["echo 'rm -rf /'\necho done", "medium"],

  // ── an UNQUOTED expansion behind a wrapper is the expansion, not data ──
  ["sudo rm -rf $HOME", "hardline"],
  ["env -i rm -rf $HOME", "hardline"],
  ["nohup rm -rf ${HOME}", "hardline"],
  ["bash -c 'rm -rf $HOME'", "hardline"],
  ["/usr/bin/sudo rm -rf $HOME/", "hardline"],
  // …and a QUOTED one stays data
  ["git commit -m \"rm -rf $HOME\"", "medium"],
  ["rg '$HOME' docs", "medium"],
  ["echo \"$HOME\"", "medium"],
  ["du -sh $HOME", "medium"],
];

describe("command policy: classifyCommand", () => {
  for (const [cmd, level] of TABLE) {
    test(`${level.padEnd(8)} ${cmd.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`, () => {
      expect(classifyCommand(cmd)).toBe(level);
    });
  }

  test("an argv array is classified like the string, quoted arguments stay data", () => {
    expect(classifyCommand(["rm", "-rf", "/"])).toBe("hardline");
    expect(classifyCommand(["rm", "-rf", "build"])).toBe("high");
    expect(classifyCommand(["bash", "-c", "rm -rf /tmp/x"])).toBe("high");
    expect(classifyCommand(["grep", "rm -rf", "README.md"])).toBe("medium");
    expect(classifyCommand(["echo", "rm -rf /"])).toBe("medium");
  });

  test("matchCommandRules names the rules, hardline first", () => {
    expect(matchCommandRules("sudo rm -rf /").rules).toEqual(["rm_rf_root", "rm_rf", "sudo"]);
    expect(matchCommandRules("ls").rules).toEqual([]);
  });

  test("segments strip wrappers and recurse into bash -c", () => {
    const views = commandSegments("FOO=1 env -i nohup bash -lc 'cd x && git push -f' > log 2>&1");
    expect(views).toContain("git push -f");
    expect(views).toContain("cd x");
    expect(views.some((v) => v.includes("> log"))).toBe(false);
  });

  test("a newline is a command separator, in a line and inside a `-c` body", () => {
    expect(commandSegments("cd x\nrm -rf build")).toContain("rm -rf build");
    expect(commandSegments("cd x\r\nrm -rf build")).toContain("rm -rf build");
    // The body of a `-c` is a script: every LINE of it is a command in first position.
    expect(commandSegments("bash -lc 'set -e\ncd /srv\nsudo rm -rf /etc'")).toContain("sudo rm -rf /etc");
    // …but a newline inside a quoted ARGUMENT stays data.
    expect(commandSegments("git commit -m 'ligne1\nrm -rf /'").some((v) => /^rm -rf \//.test(v))).toBe(false);
    // A `\<newline>` continuation joins the words instead of hiding the target on a second line.
    expect(commandSegments("rm -rf \\\n/tmp/x")).toContain("rm -rf /tmp/x");
  });

  test("a path in argv[0] is reduced to its basename in an extra view, never in what runs", () => {
    expect(commandSegments("/bin/rm -rf /")).toContain("rm -rf /");
    expect(commandSegments("/bin/rm -rf /")).toContain("/bin/rm -rf /");
    expect(commandSegments("/usr/bin/sudo rm -rf /etc")).toContain("rm -rf /etc");
    expect(commandSegments('/bin/bash -c "git push -f"')).toContain("git push -f");
    // Only argv[0]: a path as an ARGUMENT is not a command.
    expect(commandSegments("cat /usr/bin/sudo").some((v) => /^sudo/.test(v))).toBe(false);
  });

  test("matchCommandRules names the rules through a path and through a newline", () => {
    expect(matchCommandRules("/usr/bin/sudo rm -rf /etc").rules).toEqual(["rm_rf_root", "rm_rf", "sudo"]);
    expect(matchCommandRules("bash -lc 'set -e\nsudo rm -rf /etc'").rules).toEqual(["rm_rf_root", "rm_rf", "sudo"]);
    expect(matchCommandRules("/bin/ls -la").rules).toEqual([]);
    expect(matchCommandRules("git commit -m 'a\nb'").rules).toEqual([]);
  });

  test("an argv array is classified through its path and its `-c` script too", () => {
    expect(classifyCommand(["/bin/rm", "-rf", "/"])).toBe("hardline");
    expect(classifyCommand(["/bin/bash", "-c", "rm -rf /"])).toBe("hardline");
    expect(classifyCommand(["bash", "-c", "cd /tmp\nrm -rf /"])).toBe("hardline");
    expect(classifyCommand(["/bin/rm", "-rf", "build"])).toBe("high");
    expect(classifyCommand(["/bin/rm", "-f", "a.o"])).toBe("medium");
    expect(classifyCommand(["git", "commit", "-m", "ligne1\nrm -rf /"])).toBe("medium");
  });
});

describe("command policy: rules and harness forms", () => {
  test("every high rule has a regex and at least one harness glob; hardline has a regex", () => {
    for (const r of HIGH_BLAST_DENY_RULES) {
      expect(r.re).toBeInstanceOf(RegExp);
      expect(r.globs.length).toBeGreaterThan(0);
      expect(/^[a-z0-9_]+$/.test(r.id)).toBe(true);
    }
    for (const r of HARDLINE_RULES) expect(r.re).toBeInstanceOf(RegExp);
    const ids = [...HARDLINE_RULES, ...HIGH_BLAST_DENY_RULES].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no rule matches its benign neighbour", () => {
    for (const benign of ["git push origin main", "rm -f a.o", 'grep "rm -rf" README.md', "git checkout main", "docker ps", "kill 1234"]) {
      expect(matchCommandRules(benign).rules).toEqual([]);
    }
  });

  test("renderDenyRules: claude entries, grok argv pairs, codex nothing", () => {
    const claude = renderDenyRules("claude");
    expect(claude).toContain("Bash(rm -rf *)");
    expect(claude).toContain("Bash(git push --force *)");
    expect(claude).toContain("Bash(agentik spawn *)");
    expect(claude.every((e) => /^Bash\(.+\)$/.test(e))).toBe(true);
    const grok = renderDenyRules("grok");
    expect(grok.length).toBe(claude.length * 2);
    expect(grok.filter((_, i) => i % 2 === 0).every((f) => f === "--deny")).toBe(true);
    expect(grok.filter((_, i) => i % 2 === 1)).toEqual(claude);
    expect(renderDenyRules("codex")).toEqual([]);
  });
});

describe("argv: one command per call", () => {
  test("shell words: quotes, escapes, operators", () => {
    expect(shellSplit(`a "b c" 'd e' f\\ g`).map((t) => t.text)).toEqual(["a", "b c", "d e", "f g"]);
    expect(shellSplit("a && b | c; d > e 2>&1").filter((t) => t.op).map((t) => t.text)).toEqual(["&&", "|", ";", ">", "2>&1"]);
  });

  test("parseArgv refuses pipes, chains, redirections and substitution by name", () => {
    expect(parseArgv("ls -la")).toEqual({ ok: true, argv: ["ls", "-la"] });
    for (const bad of ["ls | sh", "a; b", "a && b", "ls > out", "echo $(id)", "echo `id`"]) {
      const r = parseArgv(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toContain("one command per call");
    }
    const arr = parseArgv(["ls", "|", "sh"]);
    expect(arr.ok).toBe(false);
    expect(parseArgv("")).toEqual({ ok: false, problem: "empty command" });
    expect(parseArgv([])).toEqual({ ok: false, problem: "empty command" });
  });

  test("an unquoted newline is a control token; a quoted one is data", () => {
    expect(shellSplit("a\nb").map((t) => (t.op ? `<${t.text === "\n" ? "\\n" : t.text}>` : t.text))).toEqual(["a", "<\\n>", "b"]);
    expect(shellSplit("a\r\n\nb").filter((t) => t.op)).toHaveLength(1);
    expect(shellSplit("\na").filter((t) => t.op)).toHaveLength(0);
    expect(shellSplit("git commit -m 'l1\nl2'").filter((t) => t.op)).toHaveLength(0);
    expect(shellSplit("git commit -m 'l1\nl2'").map((t) => t.text)).toEqual(["git", "commit", "-m", "l1\nl2"]);
    expect(shellSplit('echo "a\nb"').map((t) => t.text)).toEqual(["echo", "a\nb"]);
    expect(shellSplit("rm -rf \\\n/tmp/x").map((t) => t.text)).toEqual(["rm", "-rf", "/tmp/x"]);
  });

  test("parseArgv refuses a multi-line string, keeps a trailing newline harmless", () => {
    const multi = parseArgv("ls\nrm -rf /");
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.problem).toContain('operator "\\n"');
      expect(multi.problem).toContain("one command per call");
    }
    expect(parseArgv("ls -la\n")).toEqual({ ok: true, argv: ["ls", "-la"] });
    expect(parseArgv("\nls -la\n\n")).toEqual({ ok: true, argv: ["ls", "-la"] });
    expect(parseArgv("git commit -m 'l1\nl2'")).toEqual({ ok: true, argv: ["git", "commit", "-m", "l1\nl2"] });
    expect(parseArgv("\n")).toEqual({ ok: false, problem: "empty command" });
  });
});

describe("gate: hardline is refused before any approval exists", () => {
  const call = (args: Record<string, unknown>, id = "c1"): ToolCall => ({ id, tool: "run_command", args, proposedBy: "worker_a" });

  test("proposeTool: hardline → blocked, no ApprovalRequest, status unchanged", () => {
    resetIdsForTests();
    const orch = new Orchestrator();
    orch.submitGoal("clean the workspace");
    const gate = orch.proposeTool(call({ argv: ["rm", "-rf", "/"] }), [], ["run_command"]);
    expect(gate.allowed).toBe(false);
    expect(gate.pendingApproval).toBe(false);
    expect(gate.reason).toBe("hardline");
    expect(orch.pendingApprovals).toHaveLength(0);
    expect(orch.status).not.toBe("awaiting_approval");
    expect(orch.events.at(-1)?.detail).toMatchObject({ tool: "run_command", reason: "hardline" });
  });

  test("proposeTool: high → awaiting_approval as before; medium → allowed", () => {
    resetIdsForTests();
    const orch = new Orchestrator();
    orch.submitGoal("clean the workspace");
    const high = orch.proposeTool(call({ cmd: "rm -rf build" }), [], ["run_command"]);
    expect(high.pendingApproval).toBe(true);
    expect(high.reason).toBe("awaiting_approval");
    const medium = orch.proposeTool(call({ argv: ["ls"] }, "c2"), [], ["run_command"]);
    expect(medium.allowed).toBe(true);
  });

  test("blastForCall: run_command hardline and high are both high blast", () => {
    expect(blastForCall("run_command", { argv: ["rm", "-rf", "/"] })).toBe("high");
    expect(blastForCall("run_command", { cmd: "git push -f" })).toBe("high");
    expect(blastForCall("run_command", { cmd: "git push origin main" })).toBe("medium");
  });

  test("blastForCall: neither a path nor a newline downgrades a call to medium", () => {
    expect(blastForCall("run_command", { argv: ["/bin/rm", "-rf", "/"] })).toBe("high");
    expect(blastForCall("run_command", { cmd: "/usr/bin/git push --force" })).toBe("high");
    expect(blastForCall("run_command", { cmd: "bash -lc 'set -e\nrm -rf /'" })).toBe("high");
    expect(blastForCall("run_command", { argv: ["bash", "-c", "cd /tmp\nsudo rm -rf /etc"] })).toBe("high");
    expect(blastForCall("run_command", { cmd: "/bin/ls -la" })).toBe("medium");
  });

  test("proposeTool: a hardline hidden behind a path or a second line is still refused", () => {
    resetIdsForTests();
    const orch = new Orchestrator();
    orch.submitGoal("clean the workspace");
    const path = orch.proposeTool(call({ argv: ["/bin/rm", "-rf", "/"] }), [], ["run_command"]);
    expect(path.allowed).toBe(false);
    expect(path.reason).toBe("hardline");
    const line = orch.proposeTool(call({ argv: ["/bin/bash", "-c", "set -e\nrm -rf /"] }, "c2"), [], ["run_command"]);
    expect(line.allowed).toBe(false);
    expect(line.reason).toBe("hardline");
    expect(orch.pendingApprovals).toHaveLength(0);
  });

  test("--yolo (session approval) does not release a hardline command", async () => {
    const workspace = await makeWorkspace("hardline-");
    const report = await runLoop({
      goal: "Record sandbox workspace status ops",
      workspace,
      autoApproveHighBlast: true,
      ...pair({ compromise: { toolCalls: [{ tool: "run_command", args: { cmd: "rm -rf /" } }] } }),
    });
    expect(report.executedTools.some((t) => t.tool === "run_command" && JSON.stringify(t.args).includes("rm -rf /"))).toBe(false);
    const blocked = report.blockedTools.filter((b) => b.tool === "run_command");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((b) => b.reason === "hardline")).toBe(true);
    expect(report.pendingApprovals).toHaveLength(0);
  });
});

describe("run_command executor", () => {
  const host = async () => ({ workspace: await makeWorkspace("runcmd-") });
  const call = (args: Record<string, unknown>): ToolCall => ({ id: "r1", tool: "run_command", args, proposedBy: "worker_a" });

  test("runs one argv without a shell and reports the exit code", async () => {
    const res = await executeTool(call({ argv: ["echo", "hi there"] }), await host());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("exit 0");
    expect(res.output).toContain("hi there");
    const fail = await executeTool(call({ argv: ["sh", "-c", "exit 3"] }), await host());
    expect(fail.ok).toBe(false);
    expect(fail.output).toContain("exit 3");
  });

  test("a string with operators is refused, a high or hardline argv is never spawned", async () => {
    const piped = await executeTool(call({ cmd: "echo a | cat" }), await host());
    expect(piped.ok).toBe(false);
    expect(piped.output).toContain("one command per call");
    const high = await executeTool(call({ cmd: "rm -rf build" }), await host());
    expect(high.ok).toBe(false);
    expect(high.output).toContain("high-blast-radius; not executed");
    const hard = await executeTool(call({ argv: ["rm", "-rf", "/"] }), await host());
    expect(hard.ok).toBe(false);
    expect(hard.output).toContain("hardline");
    const missing = await executeTool(call({ argv: ["definitely-not-a-binary-xyz"] }), await host());
    expect(missing.ok).toBe(false);
  });

  test("a path form and a multi-line string are refused by the executor too", async () => {
    const pathHigh = await executeTool(call({ cmd: "/bin/rm -rf build" }), await host());
    expect(pathHigh.ok).toBe(false);
    expect(pathHigh.output).toContain("high-blast-radius; not executed");
    const pathHard = await executeTool(call({ argv: ["/bin/rm", "-rf", "/"] }), await host());
    expect(pathHard.ok).toBe(false);
    expect(pathHard.output).toContain("hardline");
    const script = await executeTool(call({ cmd: "echo ok\nrm -rf /" }), await host());
    expect(script.ok).toBe(false);
    expect(script.output).toContain("one command per call");
    const shellScript = await executeTool(call({ argv: ["/bin/bash", "-c", "echo ok\nrm -rf /"] }), await host());
    expect(shellScript.ok).toBe(false);
    expect(shellScript.output).toContain("hardline");
  });

  test("timeout_s is clamped to [1,120] and a timed-out command is killed and reported", async () => {
    const started = Date.now();
    const res = await executeTool(call({ argv: ["sleep", "30"], timeout_s: 0.2 }), await host());
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("timeout after 1s");
  });

  test("secrets never reach the child environment", async () => {
    const env = scrubbedEnv({ PATH: "/bin", MY_API_KEY: "k", GH_TOKEN: "t", DB_PASSWORD: "p", AWS_SECRET_ACCESS_KEY: "s", HOME: "/h", npm_config_token: "x" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    process.env.AGENTIK_TEST_FAKE_TOKEN = "s3cr3t-value";
    try {
      const res = await executeTool(call({ argv: ["sh", "-c", "echo ${AGENTIK_TEST_FAKE_TOKEN:-unset}"] }), await host());
      expect(res.output).toContain("unset");
      expect(res.output).not.toContain("s3cr3t-value");
    } finally {
      delete process.env.AGENTIK_TEST_FAKE_TOKEN;
    }
  });

  test("captured output is capped at 2 MB per stream", async () => {
    const res = await executeTool(call({ argv: ["head", "-c", "3000000", "/dev/zero"] }), await host());
    expect(res.ok).toBe(true);
    expect(res.output.length).toBeLessThan(2.2 * 1024 * 1024);
    expect(res.output).toContain("bytes dropped");
  });
});
