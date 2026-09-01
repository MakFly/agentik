import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AvailabilityMap, HarnessName } from "../src/availability.ts";
import { main, recordRunIncidents } from "../src/cli.ts";
import { listIncidents } from "../src/incidents.ts";
import { listSessions } from "../src/sessions.ts";
import { makeWorkspace } from "./helpers.ts";

function availability(state: Partial<Record<HarnessName, boolean>>): AvailabilityMap {
  const at = new Date().toISOString();
  const one = (bin: HarnessName) => ({
    bin,
    present: state[bin] !== undefined,
    loggedIn: state[bin] === true,
    detail: state[bin] === true ? "ok" : "not logged in",
    checkedAt: at,
  });
  return { claude: one("claude"), codex: one("codex"), grok: one("grok") };
}

/** A `claude` that narrates and exits 0 without a single tool call: the exit-125 case. */
async function fakeClaudeOnPath(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"I would edit the file."}]}}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"described the work"}'`,
    "exit 0",
    "",
  ].join("\n");
  await writeFile(join(dir, "claude"), script, "utf8");
  await chmod(join(dir, "claude"), 0o755);
}

function silence(): () => string[] {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  process.stdout.write = (() => true) as typeof process.stdout.write;
  return () => {
    console.error = origErr;
    console.log = origLog;
    process.stdout.write = origWrite;
    return lines;
  };
}

describe("harvest --status: a declared failure is a session AND an incident", () => {
  test("--status failed --cause records the session as failed and one incident with that symptom", async () => {
    const home = await makeWorkspace("inc-harvest-");
    const restore = silence();
    let code: number;
    try {
      code = await main([
        "harvest",
        "Deploy umami on the VPS",
        "--workspace",
        "/tmp/umami",
        "--status",
        "failed",
        "--cause",
        "docker compose up died on port 3000 already in use",
        "--agentik-home",
        home,
      ]);
    } finally {
      var lines = restore();
    }
    expect(code).toBe(0);
    const sessions = await listSessions({ home });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("failed");
    const incidents = await listIncidents({ home });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].symptom).toBe("docker compose up died on port 3000 already in use");
    expect(incidents[0].workspace).toBe("/tmp/umami");
    expect(incidents[0].harness).toBe("");
    expect(incidents[0].errors).toEqual([]);
    expect(lines.some((l) => /^incident: #1 recorded \(seen 1×\)/.test(l))).toBe(true);
    // Same declared cause again on the same workspace: seen 2, still one row.
    const restore2 = silence();
    try {
      expect(
        await main(["harvest", "Deploy umami on the VPS", "--workspace", "/tmp/umami", "--status", "partial", "--cause", "docker compose up died on port 3001 already in use", "--agentik-home", home]),
      ).toBe(0);
    } finally {
      restore2();
    }
    const after = await listIncidents({ home });
    expect(after).toHaveLength(1);
    expect(after[0].seen).toBe(2);
    expect((await listSessions({ home })).map((s) => s.status).sort()).toEqual(["failed", "partial"]);
  });

  test("--status failed without --cause is a usage error (2) and records nothing", async () => {
    const home = await makeWorkspace("inc-harvest-nocause-");
    const restore = silence();
    let code: number;
    let bogus: number;
    try {
      code = await main(["harvest", "Deploy umami", "--workspace", "/tmp/umami", "--status", "failed", "--agentik-home", home]);
      bogus = await main(["harvest", "Deploy umami", "--workspace", "/tmp/umami", "--status", "meh", "--cause", "x", "--agentik-home", home]);
    } finally {
      var lines = restore();
    }
    expect(code).toBe(2);
    expect(bogus).toBe(2);
    expect(lines.some((l) => l.includes("a failure needs a cause"))).toBe(true);
    expect(await listSessions({ home })).toEqual([]);
    expect(await listIncidents({ home })).toEqual([]);
  });
});

describe("spawn: every non-zero exit leaves an incident", () => {
  // A child spawned by Bun does not see a `process.env.PATH` mutation made after startup, so
  // the CLI runs in a subprocess with the fake `claude` first on an explicit PATH.
  async function spawnCli(argv: string[], fakeBin: string): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr };
  }

  test("exit 125 (--require-tools, no tool call) records one incident; the same failure again makes seen=2", async () => {
    const home = await makeWorkspace("inc-spawn-home-");
    const workspace = await makeWorkspace("inc-spawn-ws-");
    const bin = join(home, "fakebin");
    await fakeClaudeOnPath(bin);
    await writeFile(join(home, "backends.json"), JSON.stringify(availability({ claude: true })), "utf8");
    const argv = ["spawn", "--harness", "claude", "--require-tools", "--workspace", workspace, "--agentik-home", home, "--timeout", "30", "implement the thing"];
    const first = await spawnCli(argv, bin);
    const second = await spawnCli(argv, bin);
    expect(first.code).toBe(125);
    expect(second.code).toBe(125);
    expect(first.stderr).toContain("agentik spawn: incident #1 recorded (seen 1×)");
    expect(second.stderr).toContain("agentik spawn: incident #1 recorded (seen 2×)");
    const incidents = await listIncidents({ home });
    expect(incidents).toHaveLength(1);
    const [inc] = incidents;
    expect(inc.seen).toBe(2);
    expect(inc.harness).toBe("claude");
    expect(inc.backend).toBe("claude");
    expect(inc.exitCode).toBe(125);
    expect(inc.stopReason).toBe("success");
    expect(inc.workspace).toBe(workspace);
    expect(inc.goal).toBe("implement the thing");
    expect(inc.symptom).toContain("finished without calling a single tool");
  }, 30_000);
});

describe("run: stalled tasks, backend switches and a blocked/rejected run are incidents", () => {
  test("recordRunIncidents writes one row per stalled task / switch / failed status, none on a clean run", async () => {
    const home = await makeWorkspace("inc-run-");
    const clean = await recordRunIncidents({
      goal: "g",
      report: { status: "completed", stalledTasks: [], backendSwitches: [], blockedTools: [] },
      home,
      workspace: "/tmp/run",
      quiet: true,
    });
    expect(clean).toEqual([]);
    expect(await listIncidents({ home })).toEqual([]);
    const ids = await recordRunIncidents({
      goal: "g",
      report: {
        status: "blocked",
        stalledTasks: [{ taskId: "task-1", assignee: "worker_a", backend: "grok", reason: "no readable answer twice" }],
        backendSwitches: [{ role: "worker_b", from: "codex", to: "claude-sonnet", reason: "exit 1: adapter_eof" }],
        blockedTools: [{ tool: "server_admin", args: {}, reason: "awaiting_approval" }],
      },
      home,
      workspace: "/tmp/run",
      quiet: true,
    });
    expect(ids).toHaveLength(3);
    const rows = (await listIncidents({ home })).sort((a, b) => a.id - b.id);
    expect(rows.map((r) => r.symptom)).toEqual([
      "stalled worker_a@grok: no readable answer twice",
      "backend switch worker_b codex→claude-sonnet: exit 1: adapter_eof",
      "run blocked",
    ]);
    expect(rows[0].harness).toBe("grok");
    expect(rows[1].harness).toBe("codex");
    expect(rows[1].backend).toBe("claude-sonnet");
    expect(rows[2].errors).toEqual(["server_admin: awaiting_approval"]);
    // awaiting_approval / overridden are the human's decisions, not failures.
    expect(
      await recordRunIncidents({ goal: "g", report: { status: "awaiting_approval", stalledTasks: [], backendSwitches: [], blockedTools: [] }, home, workspace: "/tmp/run", quiet: true }),
    ).toEqual([]);
  });
});
