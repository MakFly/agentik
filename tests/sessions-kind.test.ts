import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { memoryPaths } from "../src/home.ts";
import { ensureColumn, formatSessionHit, getSession, latestSession, listSessions, recordSession, searchSessions } from "../src/sessions.ts";
import { makeWorkspace } from "./helpers.ts";

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  try {
    return { code: await fn(), out: chunks.join("") };
  } finally {
    console.log = orig;
  }
}

describe("sessions: kind and usage columns", () => {
  test("ensureColumn migrates an old sessions.sqlite in place; old rows are kind=run; FTS intact", async () => {
    const home = await makeWorkspace("kind-mig-");
    const path = memoryPaths(home).sessionsDb;
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, goal TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '', profile TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, verdict TEXT, artifacts TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
    old.run("INSERT INTO sessions (goal, status, summary, created_at) VALUES ('deploy the umami drawer', 'completed', 'old row', '2026-08-01T00:00:00.000Z')");
    expect(ensureColumn(old, "sessions", "kind", "TEXT NOT NULL DEFAULT 'run'")).toBe(true);
    expect(ensureColumn(old, "sessions", "kind", "TEXT NOT NULL DEFAULT 'run'")).toBe(false);
    old.close();
    const rec = await recordSession({ goal: "new run about the drawer", status: "completed", summary: "fresh" }, { home });
    expect(rec.kind).toBe("run");
    expect(rec.usage).toBeNull();
    const all = await listSessions({ home });
    expect(all.map((s) => s.kind)).toEqual(["run", "run"]);
    const hits = await searchSessions("drawer", { home });
    expect(hits.map((h) => h.summary).sort()).toEqual(["fresh", "old row"]);
  });

  test("spawn sessions: hidden from search unless --all, never the latest, always by id, [spawn] + usage in the hit", async () => {
    const home = await makeWorkspace("kind-spawn-");
    const ws = await makeWorkspace("kind-ws-");
    const run = await recordSession({ goal: "build the export button", workspace: ws, status: "completed", summary: "run" }, { home });
    const spawn = await recordSession({ goal: "build the export button (worker)", workspace: ws, status: "completed", summary: "claude as Korben: exit 0", kind: "spawn", usage: { inputTokens: 11_100, outputTokens: 42, costUsd: 0.0043 } }, { home });
    expect(spawn.kind).toBe("spawn");
    expect(spawn.usage).toEqual({ inputTokens: 11_100, outputTokens: 42, costUsd: 0.0043 });
    expect((await searchSessions("export button", { home, workspace: ws })).map((h) => h.id)).toEqual([run.id]);
    expect((await searchSessions("export button", { home, workspace: ws, all: true })).map((h) => h.id).sort()).toEqual([run.id, spawn.id].sort());
    expect((await latestSession({ home, workspace: ws }))?.id).toBe(run.id);
    expect((await latestSession({ home }))?.id).toBe(run.id);
    expect((await getSession(spawn.id, { home }))?.kind).toBe("spawn");
    expect(formatSessionHit(spawn)).toBe(`[spawn] [${spawn.createdAt.slice(0, 10)}] build the export button (worker) — claude as Korben: exit 0 · $0.0043 · 11k tok`);
    expect(formatSessionHit(run)).not.toContain("[spawn]");
    const search = await captureStdout(() => main(["memory", "search", "export button", "--workspace", ws, "--agentik-home", home]));
    expect(search.out).not.toContain("[spawn]");
    const searchAll = await captureStdout(() => main(["memory", "search", "export button", "--workspace", ws, "--agentik-home", home, "--all"]));
    expect(searchAll.out).toContain("[spawn]");
    expect(searchAll.out).toContain("$0.0043 · 11k tok");
  });

  test("harvest --usage: a JSON object is kept on the session; anything else exits 2", async () => {
    const home = await makeWorkspace("kind-harvest-");
    const ws = await makeWorkspace("kind-harvest-ws-");
    const bad = await captureStdout(() => main(["harvest", "did x", "--workspace", ws, "--agentik-home", home, "--usage", "[1,2]"]));
    expect(bad.code).toBe(2);
    expect(await listSessions({ home })).toHaveLength(0);
    const ok = await captureStdout(() => main(["harvest", "did x", "--workspace", ws, "--agentik-home", home, "--usage", '{"inputTokens":5000,"outputTokens":200,"costUsd":0.02}']));
    expect(ok.code).toBe(0);
    const [s] = await listSessions({ home });
    expect(s.kind).toBe("run");
    expect(s.usage).toEqual({ inputTokens: 5000, outputTokens: 200, costUsd: 0.02 });
  });

  test("agentik spawn records a kind=spawn session on success and on 125, not on a preflight refusal", async () => {
    const home = await makeWorkspace("kind-e2e-home-");
    const ws = await makeWorkspace("kind-e2e-ws-");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0.004, result: "narrated", usage: { input_tokens: 11_000, output_tokens: 40 } });
    await writeFile(join(bin, "claude"), ["#!/bin/sh", `if [ "$1" = "--help" ]; then echo '  --disallowedTools deny --settings'; exit 0; fi`, `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`, `printf '%s\\n' '${result}'`, "exit 0", ""].join("\n"), "utf8");
    await chmod(join(bin, "claude"), 0o755);
    const run = (extra: string[]) => {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "30", "--role", "Korben", ...extra, "write the thing"], {
        stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTIK_DEPTH: undefined },
      });
      return Promise.all([new Response(proc.stderr).text(), proc.exited]);
    };
    expect((await run([]))[1]).toBe(0);
    expect((await run(["--require-tools", "--expect-artifact", "out.txt"]))[1]).toBe(125);
    const sessions = await listSessions({ home });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.kind === "spawn")).toBe(true);
    const done = sessions.find((s) => s.status === "completed")!;
    expect(done.usage).toMatchObject({ inputTokens: 11_000, outputTokens: 40, costUsd: 0.004, turns: 1 });
    expect(done.verdict).toMatchObject({ harness: "claude", role: "Korben", exitCode: 0, evidence: "none", idle: false });
    const failed = sessions.find((s) => s.status === "failed")!;
    expect(failed.artifacts).toEqual(["out.txt"]);
    expect(failed.verdict).toMatchObject({ exitCode: 125 });
    expect(await latestSession({ home, workspace: ws })).toBeNull();
    // The conductor's own harvest stays the latest run.
    await main(["harvest", "did it", "--workspace", ws, "--agentik-home", home]);
    expect((await latestSession({ home, workspace: ws }))?.kind).toBe("run");
    // A preflight refusal (depth) writes no session.
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "x"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTIK_DEPTH: "1" },
    });
    expect(await proc.exited).toBe(2);
    expect(await listSessions({ home })).toHaveLength(3);
  });
});
