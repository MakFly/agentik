import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { main } from "../src/cli.ts";
import { searchSessions } from "../src/sessions.ts";
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
    // The run is a session, not a HOT line.
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(true);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(false);
    const hits = await searchSessions("greet", { home, workspace });
    expect(hits).toHaveLength(1);
    expect(hits[0].workspace).toBe(workspace);
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
    expect(stdout).toContain("memory: session #");
    expect(await Bun.file(join(workspace, "src/greet.txt")).text()).toContain("AGENTIK_OK");
  });

  test("harvest records a session for the workspace and does not write a skill", async () => {
    const home = await makeWorkspace("cli-harvest-");
    const code = await main([
      "harvest",
      "Export CSV on the leads list",
      "--workspace",
      "/tmp/leads-app",
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
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(true);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(false);
    expect(existsSync(join(home, "skills/export-csv-on-the-leads-list/SKILL.md"))).toBe(false);
    expect(existsSync(join(home, "skills"))).toBe(false);
    const hits = await searchSessions("leads", { home, workspace: "/tmp/leads-app" });
    expect(hits).toHaveLength(1);
    expect(hits[0].artifacts).toEqual(["src/export.ts", "src/export.test.ts"]);
    expect(await searchSessions("leads", { home, workspace: "/tmp/elsewhere" })).toEqual([]);
  });

  test("memory search / recall print [date] goal — summary lines; --all lifts the workspace filter", async () => {
    const home = await makeWorkspace("cli-search-");
    await main(["harvest", "Clôturer le RAF migration 0021", "--workspace", "/tmp/ws-a", "--agentik-home", home]);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      expect(await main(["memory", "search", "cloturer", "--workspace", "/tmp/ws-b", "--agentik-home", home])).toBe(0);
      expect(lines.at(-1)).toBe("(no hits)");
      expect(await main(["memory", "search", "cloturer", "--workspace", "/tmp/ws-b", "--all", "--agentik-home", home])).toBe(0);
      expect(lines.at(-1)).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] Clôturer le RAF migration 0021 — completed — artifacts: none$/);
      expect(await main(["memory", "recall", "migrat", "--agentik-home", home])).toBe(0);
      expect(lines.at(-1)).toContain("Clôturer le RAF migration 0021");
      expect(await main(["memory", "search", "--agentik-home", home])).toBe(2);
    } finally {
      console.log = orig;
    }
  });

  test("context prints the four headers, pinned skills first with a 57+… description, related sessions", async () => {
    const home = await makeWorkspace("cli-context-");
    const descHead = "Explain WHY a self-hosted Next.js App Router app";
    const descTail = "leaks RAM in Docker and how to prove it";
    const longDesc = `${descHead} ${descTail}`;
    await mkdir(join(home, "skills", "nextjs-ram-autopsy"), { recursive: true });
    await writeFile(
      join(home, "skills", "nextjs-ram-autopsy", "SKILL.md"),
      `---\nname: nextjs-ram-autopsy\ndescription: >\n  ${descHead}\n  ${descTail}\n---\n\n# body\n`,
    );
    await mkdir(join(home, "skills", "aaa-first-alphabetically"), { recursive: true });
    await writeFile(join(home, "skills", "aaa-first-alphabetically", "SKILL.md"), "---\nname: aaa-first-alphabetically\ndescription: short one\n---\n");
    await mkdir(join(home, "skills", ".archive", "old-skill"), { recursive: true });
    await writeFile(join(home, "skills", ".archive", "old-skill", "SKILL.md"), "---\nname: old-skill\ndescription: archived\n---\n");
    await writeFile(join(home, "skills", ".pinned"), "nextjs-ram-autopsy\n");
    await main(["memory", "retain", "this repo uses bun test", "--agentik-home", home]);
    await main(["harvest", "PWA drawer swipe fix", "--workspace", "/tmp/pwa", "--artifact", "drawer.tsx", "--agentik-home", home]);
    await main(["harvest", "unrelated elsewhere", "--workspace", "/tmp/other", "--agentik-home", home]);

    let out = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(["context", "tiroir PWA drawr", "--workspace", "/tmp/pwa", "--agentik-home", home])).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const lines = out.split("\n");
    expect(lines[0]).toBe("USER PROFILE (who the user is) [0% — 0/1375 chars]");
    expect(lines[1]).toBe("(empty)");
    expect(lines.some((l) => /^MEMORY \(durable facts\) \[\d+% — \d+\/2200 chars\]$/.test(l))).toBe(true);
    expect(out).toContain("- (fact) this repo uses bun test");
    const skillsAt = lines.indexOf("SKILLS (load a body only when relevant)");
    expect(skillsAt).toBeGreaterThan(0);
    expect(lines[skillsAt + 1]).toBe(`- nextjs-ram-autopsy: ${longDesc.slice(0, 57).trimEnd()}…`);
    expect(lines[skillsAt + 2]).toBe("- aaa-first-alphabetically: short one");
    expect(out).not.toContain("old-skill");
    const sessAt = lines.indexOf("RELATED SESSIONS (workspace-filtered, top 6)");
    expect(sessAt).toBeGreaterThan(skillsAt);
    expect(lines[sessAt + 1]).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] PWA drawer swipe fix — completed — artifacts: drawer.tsx$/);
    expect(out).not.toContain("unrelated elsewhere");

    out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(["context", "--agentik-home", home])).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(out).toContain("RELATED SESSIONS (workspace-filtered, top 6)\n(pass a goal to search)");
  });
});
