import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { legacyProjectSlug, projectMemoryPath, projectSlug } from "../src/home.ts";
import { listIncidents, recordIncident } from "../src/incidents.ts";
import { memoryApply, migrateProjectMemory, readEntries } from "../src/memory-store.ts";
import { latestSession, recordSession, searchSessions } from "../src/sessions.ts";
import { resetWorkspaceRootCache, resolveWorkspaceRoot, workspaceKeys } from "../src/workspace.ts";
import { makeWorkspace } from "./helpers.ts";

const git = (args: string[], cwd: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

/** A real repository with one worktree next to it, both under .tmp/. */
async function repoWithWorktree(prefix: string): Promise<{ main: string; worktree: string; sub: string }> {
  const main = await makeWorkspace(`${prefix}main-`);
  git(["init", "-q", "-b", "main"], main);
  await writeFile(join(main, "a.txt"), "a", "utf8");
  git(["add", "."], main);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], main);
  const worktree = `${main}-wt`;
  git(["worktree", "add", "-q", worktree, "-b", "topic"], main);
  const sub = join(main, "packages", "app");
  await mkdir(sub, { recursive: true });
  resetWorkspaceRootCache();
  return { main, worktree, sub };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

describe("resolveWorkspaceRoot", () => {
  test("not a repo → itself; main checkout → itself; worktree → main; subdirectory of a repo → itself", async () => {
    const plain = await makeWorkspace("wsroot-plain-");
    expect(resolveWorkspaceRoot(plain)).toBe(plain);
    const { main, worktree, sub } = await repoWithWorktree("wsroot-");
    expect(resolveWorkspaceRoot(main)).toBe(main);
    expect(resolveWorkspaceRoot(worktree)).toBe(main);
    expect(resolveWorkspaceRoot(sub)).toBe(sub);
    expect(workspaceKeys(worktree)).toEqual([main, worktree]);
    expect(workspaceKeys(main)).toEqual([main]);
    // The test workspaces live under <repo>/.tmp/: they are subdirectories, never resolved to agentik's root.
    expect(resolveWorkspaceRoot(plain)).not.toBe(join(import.meta.dir, ".."));
  });

  test("projectSlug: the main checkout keeps its historical slug; a worktree shares it", async () => {
    const { main, worktree, sub } = await repoWithWorktree("wsslug-");
    expect(projectSlug(main)).toBe(legacyProjectSlug(main));
    expect(projectSlug(worktree)).toBe(projectSlug(main));
    expect(projectSlug(worktree)).not.toBe(legacyProjectSlug(worktree));
    expect(projectSlug(sub)).toBe(legacyProjectSlug(sub));
    const agentik = join(import.meta.dir, "..");
    expect(projectSlug(agentik)).toBe(legacyProjectSlug(resolveWorkspaceRoot(agentik)));
  });
});

describe("project memory per repository", () => {
  test("a write from the worktree lands in the root's file; .workspace holds the root", async () => {
    const home = await makeWorkspace("wsmem-home-");
    const { main, worktree } = await repoWithWorktree("wsmem-");
    const r = await memoryApply("project", [{ action: "add", content: "Written from the worktree." }], { home, workspace: worktree });
    expect(r.ok).toBe(true);
    expect(await readEntries("project", home, { workspace: main })).toEqual(["Written from the worktree."]);
    expect(projectMemoryPath(home, worktree)).toBe(projectMemoryPath(home, main));
    expect((await readFile(join(home, "memory", "projects", projectSlug(main), ".workspace"), "utf8")).trim()).toBe(main);
  });

  test("legacy worktree file alone → moved under the root slug with .bak and .migrated-from", async () => {
    const home = await makeWorkspace("wsmig-home-");
    const { main, worktree } = await repoWithWorktree("wsmig-");
    const legacyDir = join(home, "memory", "projects", legacyProjectSlug(worktree));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "MEMORY.md"), "Old worktree fact.\n", "utf8");
    const err = await capture(async () => { await migrateProjectMemory(home, worktree); return 0; });
    expect(err.err).toContain("moved under the repository root");
    expect(existsSync(legacyDir)).toBe(false);
    const rootDir = join(home, "memory", "projects", projectSlug(main));
    expect(await readEntries("project", home, { workspace: main })).toEqual(["Old worktree fact."]);
    expect((await readFile(join(rootDir, ".workspace"), "utf8")).trim()).toBe(main);
    expect((await readFile(join(rootDir, ".migrated-from"), "utf8"))).toContain(worktree);
    expect((await readdir(rootDir)).some((f) => f.startsWith("MEMORY.md.bak."))).toBe(true);
  });

  test("legacy + root both present → merged entry by entry (dedup), legacy renamed .merged.<ts>, journaled by migration", async () => {
    const home = await makeWorkspace("wsmerge-home-");
    const { main, worktree } = await repoWithWorktree("wsmerge-");
    await memoryApply("project", [{ action: "add", content: "Shared fact." }], { home, workspace: main });
    const legacyDir = join(home, "memory", "projects", legacyProjectSlug(worktree));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "MEMORY.md"), "Shared fact.\n§\nOnly in the worktree.\n", "utf8");
    const res = await capture(async () => { await readEntries("project", home, { workspace: worktree }); return 0; });
    expect(res.err).toContain("merged into the repository root's");
    expect(await readEntries("project", home, { workspace: main })).toEqual(["Shared fact.", "Only in the worktree."]);
    expect(existsSync(legacyDir)).toBe(false);
    expect((await readdir(join(home, "memory", "projects"))).some((d) => d.startsWith(`${legacyProjectSlug(worktree)}.merged.`))).toBe(true);
    const { listMemoryOps } = await import("../src/memory-log.ts");
    const ops = await listMemoryOps({ home, target: "project" });
    expect(ops.some((o) => o.by === "migration" && o.after === "Only in the worktree.")).toBe(true);
  });
});

describe("sessions and incidents are keyed on the root; reads accept both spellings", () => {
  test("recorded from the worktree, found from main and from the worktree; incidents dedup repo-wide", async () => {
    const home = await makeWorkspace("wssess-home-");
    const { main, worktree } = await repoWithWorktree("wssess-");
    const s = await recordSession({ goal: "deploy the umami drawer", workspace: worktree, status: "completed", summary: "ok" }, { home });
    expect(s.workspace).toBe(main);
    expect((await searchSessions("umami drawer", { home, workspace: main })).map((h) => h.id)).toEqual([s.id]);
    expect((await searchSessions("umami drawer", { home, workspace: worktree })).map((h) => h.id)).toEqual([s.id]);
    expect((await latestSession({ home, workspace: worktree }))?.id).toBe(s.id);
    const a = await recordIncident({ goal: "g", workspace: worktree, harness: "codex", symptom: "adapter_eof at turn 3" }, { home });
    const b = await recordIncident({ goal: "g", workspace: main, harness: "codex", symptom: "adapter_eof at turn 4" }, { home });
    expect(b.id).toBe(a.id);
    expect(b.seen).toBe(2);
    expect((await listIncidents({ home, workspace: worktree })).map((i) => i.id)).toEqual([a.id]);
  });
});

describe("agentik memory where / hot", () => {
  test("where prints given, root, slug, file; hot warns from a worktree, stdout unchanged", async () => {
    const home = await makeWorkspace("wswhere-home-");
    const { main, worktree } = await repoWithWorktree("wswhere-");
    const w = await capture(() => main_(["memory", "where", "--workspace", worktree, "--agentik-home", home]));
    expect(w.code).toBe(0);
    expect(w.out).toContain(`given: ${worktree}`);
    expect(w.out).toContain(`root:  ${main}  (git worktree → main checkout)`);
    expect(w.out).toContain(`slug:  ${projectSlug(main)}`);
    expect(w.out).toContain("(does not exist yet)");
    const j = await capture(() => main_(["memory", "where", "--workspace", main, "--agentik-home", home, "--json"]));
    expect(JSON.parse(j.out)).toEqual({ given: main, root: main, slug: projectSlug(main), file: projectMemoryPath(home, main), exists: false });
    await main_(["memory", "retain", "From main.", "--target", "project", "--workspace", main, "--agentik-home", home]);
    const hot = await capture(() => main_(["memory", "hot", "--target", "project", "--workspace", worktree, "--agentik-home", home]));
    expect(hot.err).toContain("is a git worktree");
  });
});
const main_ = main;
