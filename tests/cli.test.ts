import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { makeWorkspace } from "./helpers.ts";

describe("CLI entry (shipped src/cli.ts main)", () => {
  test("run completes a 3-role development goal and writes artifacts", async () => {
    const workspace = await makeWorkspace("cli-");
    const home = await makeWorkspace("cli-home-");
    const code = await main([
      "run",
      "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      "--workspace",
      workspace,
      "--backend",
      "mock",
      "--agentik-home",
      home,
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(workspace, "src/greet.txt"))).toBe(true);
    expect(await Bun.file(join(workspace, "src/greet.txt")).text()).toContain("AGENTIK_OK");
    expect(existsSync(join(workspace, ".agentik/ops-status.json"))).toBe(true);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(true);
  });

  test("prompt-first launch (no run subcommand) works like cla / grok --yolo", async () => {
    const workspace = await makeWorkspace("cli-prompt-");
    const home = await makeWorkspace("cli-prompt-home-");
    const code = await main([
      "Create src/greet.txt containing AGENTIK_OK and record sandbox workspace status",
      "--workspace",
      workspace,
      "--backend",
      "mock",
      "--agentik-home",
      home,
    ]);
    expect(code).toBe(0);
    expect(await Bun.file(join(workspace, "src/greet.txt")).text()).toContain("AGENTIK_OK");
  });

  test("--yolo is an explicit orchestrator session approval for high-blast", async () => {
    const workspace = await makeWorkspace("cli-yolo-");
    const home = await makeWorkspace("cli-yolo-home-");
    const code = await main([
      "--yolo",
      "server_admin remote reboot of the production hypervisor",
      "--workspace",
      workspace,
      "--backend",
      "mock",
      "--agentik-home",
      home,
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(workspace, ".agentik/admin-action.json"))).toBe(true);
  });

  test("bin/agentik PATH wrapper runs the shipped CLI", async () => {
    const workspace = await makeWorkspace("cli-bin-");
    const home = await makeWorkspace("cli-bin-home-");
    const bin = join(import.meta.dir, "..", "bin", "agentik");
    const proc = Bun.spawn(
      [
        bin,
        "Create src/greet.txt containing AGENTIK_OK",
        "--workspace",
        workspace,
        "--backend",
        "mock",
        "--agentik-home",
        home,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain("Module not found");
    expect(stdout).toContain("worker_a");
    expect(stdout).toContain("worker_b");
    expect(stdout).toContain("memory:");
    expect(await Bun.file(join(workspace, "src/greet.txt")).text()).toContain("AGENTIK_OK");
  });

  test("harvest retains a session note and does not write a skill", async () => {
    const home = await makeWorkspace("cli-harvest-");
    const code = await main([
      "harvest",
      "Export CSV on the leads list",
      "--artifact",
      "src/export.ts",
      "--artifact",
      "src/export.test.ts",
      "--step",
      "write_file -> src/export.ts",
      "--agentik-home",
      home,
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(true);
    expect(existsSync(join(home, "skills/export-csv-on-the-leads-list/SKILL.md"))).toBe(false);
    expect(existsSync(join(home, "skills"))).toBe(false);
  });
});
