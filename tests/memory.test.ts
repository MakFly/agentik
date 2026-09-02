import { describe, expect, test } from "bun:test";
import { listSessions } from "../src/sessions.ts";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { buildContext } from "../src/context.ts";
import { projectMemoryPath } from "../src/home.ts";
import { HOT_CAP, recall, retainNote } from "../src/memory.ts";
import { memoryAdd, readEntries } from "../src/memory-store.ts";
import { makeWorkspace } from "./helpers.ts";

/** Run the CLI, capturing stdout (process.stdout.write + console.log) and stderr (console.error). */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origErr = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => { out += a.map(String).join(" ") + "\n"; };
  console.error = (...a: unknown[]) => { err += a.map(String).join(" ") + "\n"; };
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.error = origErr;
  }
}

describe("memory HOT (shipped retainNote / recall)", () => {
  test("retain writes HOT MEMORY.md and recall finds it", async () => {
    const home = await makeWorkspace("mem-hot-");
    const r = await retainNote("this repo uses bun test not jest", { home, kind: "fact" });
    expect(r.layer).toBe("hot");
    const body = await readFile(r.path, "utf8");
    expect(body).toContain("bun test");
    const hits = await recall("bun test", { home });
    expect(hits.some((h) => h.includes("bun test"))).toBe(true);
  });

  test("secrets are rejected", async () => {
    const home = await makeWorkspace("mem-secret-");
    const secret = await retainNote("api_key=sk-live-not-a-real-key", { home });
    expect(secret.layer).toBe("rejected");
    expect(secret.reason).toMatch(/secret/);
    expect(existsSync(join(home, "memory", "MEMORY.md"))).toBe(false);
  });

  test("the cap forces consolidation: a full HOT rejects the note and nothing is written elsewhere", async () => {
    const home = await makeWorkspace("mem-cap-");
    let last = await retainNote("seed", { home });
    for (let i = 0; i < 80 && last.layer === "hot"; i++) {
      last = await retainNote(`lesson ${i} about the memory cap and consolidation`, { home, kind: "lesson" });
    }
    expect(last.layer).toBe("rejected");
    expect(last.path).toBe(join(home, "memory", "MEMORY.md"));
    expect(last.reason).toMatch(new RegExp(`^MEMORY\\.md at \\d+/${HOT_CAP} chars — consolidate \\(replace/remove\\) before adding$`));
    const hot = await readFile(last.path, "utf8");
    expect(hot.length).toBeLessThanOrEqual(HOT_CAP);
    expect(hot).not.toContain(last.reason);
    // No WARM overflow: no notes.sqlite, no sessions row, nothing but MEMORY.md under memory/.
    const files = (await readdir(join(home, "memory"))).filter((f) => f !== ".migrated-v1" && f !== ".seal.json");
    expect(files).toEqual(["MEMORY.md"]);
    // sessions.sqlite may exist (the memory journal lives there) but holds no session row.
    expect(await listSessions({ home })).toEqual([]);
    // A subsequent, shorter note still fits and is accepted.
    const short = await retainNote("ok", { home });
    expect(short.layer).toBe("hot");
  });
});

describe("context: PROJECT MEMORY is this workspace's section, shown only when it has entries", () => {
  test("no --workspace or an empty project file: no header; entries of another workspace never appear", async () => {
    const home = await makeWorkspace("ctx-proj-home-");
    const ws = await makeWorkspace("ctx-proj-ws-");
    const other = await makeWorkspace("ctx-proj-other-");
    await memoryAdd("memory", "Global: bun is the runtime everywhere.", { home });
    await memoryAdd("project", "Only the OTHER checkout uses make test.", { home, workspace: other });
    const bare = await buildContext({ home, goal: "g" });
    expect(bare).not.toContain("PROJECT MEMORY");
    const empty = await buildContext({ home, workspace: ws, goal: "g" });
    expect(empty).not.toContain("PROJECT MEMORY");
    expect(empty).not.toContain("OTHER checkout");
    expect(empty).toContain("Global: bun is the runtime everywhere.");

    await memoryAdd("project", "This checkout runs bun test; tests/harness.test.ts fails from a worktree.", { home, workspace: ws });
    const { code, out } = await cli(["context", "run the tests", "--workspace", ws, "--agentik-home", home]);
    expect(code).toBe(0);
    const lines = out.split("\n");
    const memAt = lines.findIndex((l) => l.startsWith("MEMORY (durable facts)"));
    const projAt = lines.indexOf("PROJECT MEMORY (this workspace) [3% — 73/2200 chars]");
    const skillsAt = lines.indexOf("SKILLS (load a body only when relevant)");
    expect(memAt).toBeGreaterThan(0);
    expect(projAt).toBeGreaterThan(memAt);
    expect(skillsAt).toBeGreaterThan(projAt);
    expect(lines[projAt + 1]).toBe("This checkout runs bun test; tests/harness.test.ts fails from a worktree.");
    expect(out).not.toContain("OTHER checkout");
    // The other workspace sees its own entries and not these.
    const otherOut = (await cli(["context", "run the tests", "--workspace", other, "--agentik-home", home])).out;
    expect(otherOut).toContain("OTHER checkout");
    expect(otherOut).not.toContain("harness.test.ts");
  });
});

describe("agentik memory hot | retain | remove --target …: the human's pen", () => {
  test("retain / hot on target project write and read the workspace's file, not MEMORY.md", async () => {
    const home = await makeWorkspace("mem-cli-proj-home-");
    const ws = await makeWorkspace("mem-cli-proj-ws-");
    const r = await cli(["memory", "retain", "This checkout uses bun test.", "--target", "project", "--workspace", ws, "--agentik-home", home]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`hot ${projectMemoryPath(home, ws)}`);
    expect(existsSync(join(home, "memory", "MEMORY.md"))).toBe(false);
    const hot = await cli(["memory", "hot", "--target", "project", "--workspace", ws, "--agentik-home", home]);
    expect(hot.out).toBe("This checkout uses bun test.\n");
    const globalHot = await cli(["memory", "hot", "--agentik-home", home]);
    expect(globalHot.out).toContain("(empty HOT MEMORY.md)");
    const bad = await cli(["memory", "hot", "--target", "nope", "--agentik-home", home]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown --target "nope"');
  });

  test("remove: exact, unique prefix, ambiguous (exit 1 with candidates), none (exit 1); backup first, no approval queue", async () => {
    const home = await makeWorkspace("mem-cli-remove-home-");
    await writeFile(join(home, "config.json"), JSON.stringify({ memory: { writeApproval: true } }), "utf8");
    await mkdir(join(home, "memory"), { recursive: true });
    await writeFile(
      join(home, "memory", "MEMORY.md"),
      ["The API uses Postgres 16.", "The worker uses Postgres 15.", "Tests: bun test, never jest.", "Tests: bunx tsc --noEmit before merge."].join("\n§\n") + "\n",
      "utf8",
    );
    const none = await cli(["memory", "remove", "nothing like this", "--agentik-home", home]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('no entry matches "nothing like this"');

    const ambiguous = await cli(["memory", "remove", "Tests:", "--agentik-home", home]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('"Tests:" matches 2 entries');
    expect(ambiguous.err).toContain("  § Tests: bun test, never jest.");
    expect(ambiguous.err).toContain("  § Tests: bunx tsc --noEmit before merge.");
    // "contains" is not "prefix": the middle of an entry does not match.
    expect((await cli(["memory", "remove", "Postgres 16", "--agentik-home", home])).code).toBe(1);
    expect(await readEntries("memory", home)).toHaveLength(4);
    expect((await readdir(join(home, "memory"))).filter((f) => f !== ".seal.json")).toEqual(["MEMORY.md"]);

    const prefix = await cli(["memory", "remove", "Tests: bun test", "--agentik-home", home]);
    expect(prefix.code).toBe(0);
    expect(prefix.out).toContain("removed: Tests: bun test, never jest.");
    expect(prefix.out).toMatch(/backup: .*MEMORY\.md\.bak\.\d{4}-\d{2}-\d{2}T/);
    expect(await readEntries("memory", home)).toEqual(["The API uses Postgres 16.", "The worker uses Postgres 15.", "Tests: bunx tsc --noEmit before merge."]);

    const exact = await cli(["memory", "remove", "The API uses Postgres 16.", "--agentik-home", home]);
    expect(exact.code).toBe(0);
    expect(await readEntries("memory", home)).toEqual(["The worker uses Postgres 15.", "Tests: bunx tsc --noEmit before merge."]);
    const backups = (await readdir(join(home, "memory"))).filter((f) => f.startsWith("MEMORY.md.bak.")).sort();
    expect(backups).toHaveLength(2);
    expect(await readFile(join(home, "memory", backups[0]), "utf8")).toContain("Tests: bun test, never jest.");
    // writeApproval is on, yet nothing was staged: the human is the approver.
    expect(existsSync(join(home, "pending", "memory"))).toBe(false);
  });

  test("remove on target project only touches that workspace's file, with its own backup", async () => {
    const home = await makeWorkspace("mem-cli-remove-proj-home-");
    const ws = await makeWorkspace("mem-cli-remove-proj-ws-");
    await memoryAdd("memory", "Global fact to keep.", { home });
    await memoryAdd("project", "Project fact to drop.", { home, workspace: ws });
    await memoryAdd("project", "Project fact to keep.", { home, workspace: ws });
    const r = await cli(["memory", "remove", "Project fact to drop", "--target", "project", "--workspace", ws, "--agentik-home", home]);
    expect(r.code).toBe(0);
    expect(await readEntries("project", home, { workspace: ws })).toEqual(["Project fact to keep."]);
    expect(await readEntries("memory", home)).toEqual(["Global fact to keep."]);
    const dir = join(home, "memory", "projects");
    const [slug] = await readdir(dir);
    const files = await readdir(join(dir, slug));
    expect(files).toContain(".workspace");
    expect(files.some((f) => f.startsWith("MEMORY.md.bak."))).toBe(true);
    // Without --workspace the cwd is the workspace: a different (empty) file, so no match.
    const cwdRun = await cli(["memory", "remove", "Project fact", "--target", "project", "--agentik-home", home]);
    expect(cwdRun.code).toBe(1);
    expect(cwdRun.err).toContain("no entry matches");
  });
});
