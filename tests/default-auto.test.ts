import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeWorkspace } from "./helpers.ts";

/** The CLI in a subprocess whose PATH holds no harness binary at all. */
async function run(argv: string[], home: string): Promise<{ code: number; out: string; err: string }> {
  const empty = join(home, "emptybin");
  await mkdir(empty, { recursive: true });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: empty, AGENTIK_HOME: undefined, AGENTIK_DEPTH: undefined },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

describe("agentik run: auto is the default, mock is explicit", () => {
  test("no --backend and no authenticated CLI → exit 2 naming probe and --backend mock; no run file", async () => {
    const home = await makeWorkspace("auto-home-");
    const ws = await makeWorkspace("auto-ws-");
    const r = await run(["--workspace", ws, "--agentik-home", home, "Create a.txt containing X"], home);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no authenticated worker CLI available");
    expect(r.err).toContain("agentik probe");
    expect(r.err).toContain("--backend mock");
    expect(existsSync(join(home, "runs"))).toBe(false);
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
    // --yolo alone does not turn the run into a mock one either.
    const y = await run(["--yolo", "--workspace", ws, "--agentik-home", home, "Create a.txt containing X"], home);
    expect(y.code).toBe(2);
  });

  test("--backend mock runs offline: no probe, no backends.json, the file is created", async () => {
    const home = await makeWorkspace("auto-mock-home-");
    const ws = await makeWorkspace("auto-mock-ws-");
    const r = await run(["--backend", "mock", "--workspace", ws, "--agentik-home", home, "Create a.txt containing X"], home);
    expect(r.code).toBe(0);
    expect(existsSync(join(ws, "a.txt"))).toBe(true);
    expect(existsSync(join(home, "backends.json"))).toBe(false);
    expect(r.out).toContain("run file: ");
  });
});
