import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { childEnv, currentDepth, DEPTH_ENV, depthProblem, PARENT_ENV } from "../src/depth.ts";
import { listIncidents } from "../src/incidents.ts";
import { executeTool } from "../src/tools.ts";
import { makeWorkspace } from "./helpers.ts";

async function withDepth<T>(depth: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[DEPTH_ENV];
  if (depth === undefined) delete process.env[DEPTH_ENV];
  else process.env[DEPTH_ENV] = depth;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prev;
  }
}

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  try {
    return { code: await fn(), err: chunks.join("") };
  } finally {
    console.error = orig;
  }
}

describe("depth guard: a worker never spawns workers", () => {
  test("currentDepth / childEnv / depthProblem", () => {
    expect(currentDepth({})).toBe(0);
    expect(currentDepth({ [DEPTH_ENV]: "2" })).toBe(2);
    expect(currentDepth({ [DEPTH_ENV]: "junk" })).toBe(0);
    const child = childEnv({ PATH: "/bin", [DEPTH_ENV]: "1" });
    expect(child[DEPTH_ENV]).toBe("2");
    expect(child[PARENT_ENV]).toBe("agentik-spawn");
    expect(child.PATH).toBe("/bin");
    expect(depthProblem("spawn", {})).toBeUndefined();
    expect(depthProblem("spawn", { [DEPTH_ENV]: "1" })).toContain("agent #6");
    expect(depthProblem("run", { [DEPTH_ENV]: "1" })).toContain("refused at depth 1");
    for (const ok of ["harvest", "review", "memory", "context", "skills", "postmortem", "probe"]) {
      expect(depthProblem(ok, { [DEPTH_ENV]: "3" })).toBeUndefined();
    }
  });

  test("at depth 1, run and spawn exit 2 with an incident, before any probe; harvest/context/memory still work", async () => {
    const home = await makeWorkspace("depth-home-");
    const ws = await makeWorkspace("depth-ws-");
    await withDepth("1", async () => {
      const run = await captureStderr(() => main(["run", "do it", "--backend", "mock", "--workspace", ws, "--agentik-home", home]));
      expect(run.code).toBe(2);
      expect(run.err).toContain("a worker never spawns workers (that would be agent #6)");
      const prompt = await captureStderr(() => main(["--yolo", "do it", "--workspace", ws, "--agentik-home", home]));
      expect(prompt.code).toBe(2);
      const spawn = await captureStderr(() => main(["spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "x"]));
      expect(spawn.code).toBe(2);
      expect(spawn.err).toContain("agentik spawn refused at depth 1");
      expect(existsSync(join(home, "backends.json"))).toBe(false); // no probe ran
      const incidents = await listIncidents({ home, workspace: ws });
      expect(incidents.map((i) => i.symptom).sort()).toEqual(["nested agentik run refused at depth 1", "nested agentik spawn refused at depth 1"].sort());
      expect(incidents.find((i) => i.symptom.includes("run"))?.seen).toBe(2);
      const ctx = await captureStderr(() => main(["context", "x", "--workspace", ws, "--agentik-home", home]));
      expect(ctx.code).toBe(0);
      const hot = await captureStderr(() => main(["memory", "hot", "--agentik-home", home]));
      expect(hot.code).toBe(0);
    });
  });

  test("run_command children inherit the depth (belt under the harness floor)", async () => {
    const ws = await makeWorkspace("depth-cmd-");
    const res = await withDepth(undefined, () =>
      executeTool({ id: "d1", tool: "run_command", args: { argv: ["sh", "-c", "echo depth=$AGENTIK_DEPTH parent=$AGENTIK_PARENT"] }, proposedBy: "worker_a" }, { workspace: ws }),
    );
    expect(res.output).toContain("depth=1 parent=agentik-spawn");
  });
});

describe("agentik spawn e2e: a worker that calls agentik spawn is refused inside, the outer run is fine", () => {
  test("inner exit 2 + incident in the inner home; outer exit 0", async () => {
    const home = await makeWorkspace("nest-home-");
    const inner = await makeWorkspace("nest-inner-home-");
    const ws = await makeWorkspace("nest-ws-");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const marker = join(home, "inner-exit.txt");
    const script = [
      "#!/bin/sh",
      `if [ "$1" = "--help" ]; then echo '  --disallowedTools <tools...>  deny'; echo '  --settings <file-or-json>'; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`,
      // The worker tries to spawn a worker. Same fake claude on PATH, a different home.
      `'${process.execPath}' '${cli}' spawn --harness claude --workspace '${ws}' --agentik-home '${inner}' --no-context 'echo hi' >/dev/null 2>&1; echo $? > '${marker}'`,
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"agentik spawn --harness claude echo hi"}}]}}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"tried"}'`,
      "exit 0",
      "",
    ].join("\n");
    await writeFile(join(bin, "claude"), script, "utf8");
    await chmod(join(bin, "claude"), 0o755);
    const proc = Bun.spawn([process.execPath, cli, "spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "60", "delegate this"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, [DEPTH_ENV]: undefined },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect((await Bun.file(marker).text()).trim()).toBe("2");
    expect(existsSync(join(inner, "backends.json"))).toBe(false);
    const innerIncidents = await listIncidents({ home: inner, workspace: ws });
    expect(innerIncidents.map((i) => i.symptom)).toEqual(["nested agentik spawn refused at depth 1"]);
    // Belt: the outer verdict also sees `agentik spawn` in the stream as a floor violation.
    expect(stderr).toContain("FLOOR VIOLATION");
    expect(stderr).toContain("agentik_nested");
  });
});
