import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnLines } from "../src/backends.ts";
import { listIncidents } from "../src/incidents.ts";
import { makeWorkspace } from "./helpers.ts";

describe("spawnLines idle timeout", () => {
  test("silence on stdout for idleMs kills the child: idle + timedOut, fast; stderr does not re-arm", async () => {
    const lines: string[] = [];
    const started = Date.now();
    const res = await spawnLines("sh", ["-c", "echo a; echo b; sleep 0.2; echo c; echo err >&2; sleep 30; echo d"], 0, undefined, (l) => lines.push(l), { idleMs: 700 });
    expect(lines).toEqual(["a", "b", "c"]);
    expect(res.idle).toBe(true);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("a chatty child is never idle; the wall clock still applies and is not idle", async () => {
    const chatty = await spawnLines("sh", ["-c", "for i in 1 2 3 4 5; do echo $i; sleep 0.1; done"], 0, undefined, () => {}, { idleMs: 1_000 });
    expect(chatty.idle).toBe(false);
    expect(chatty.timedOut).toBe(false);
    expect(chatty.exitCode).toBe(0);
    const wall = await spawnLines("sh", ["-c", "while true; do echo tick; sleep 0.1; done"], 600, undefined, () => {}, { idleMs: 5_000 });
    expect(wall.timedOut).toBe(true);
    expect(wall.idle).toBe(false);
  });
});

describe("agentik spawn --idle-timeout", () => {
  test("a harness that goes silent → 124, idle symptom, incident; --raw says the flag is ignored", async () => {
    const home = await makeWorkspace("idle-home-");
    const ws = await makeWorkspace("idle-ws-");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), [
      "#!/bin/sh",
      `if [ "$1" = "--help" ]; then echo '  --disallowedTools deny --settings'; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`,
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}'`,
      "sleep 60",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    await chmod(join(bin, "claude"), 0o755);
    const run = (extra: string[]) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "120", ...extra, "x"], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTIK_DEPTH: undefined },
      });
      return Promise.all([new Response(proc.stderr).text(), proc.exited]);
    };
    const started = Date.now();
    const [err, code] = await run(["--idle-timeout", "1"]);
    expect(code).toBe(124);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(err).toContain("claude idle for 1s (no stream event) — killed, the task did NOT finish");
    const incidents = await listIncidents({ home, workspace: ws });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].symptom).toContain("idle for 1s (no stream event)");
    expect(incidents[0].exitCode).toBe(124);
    const [rawErr] = await run(["--raw", "--idle-timeout", "1", "--timeout", "2"]);
    expect(rawErr).toContain("--idle-timeout is ignored with --raw");
  }, 60_000);
});
