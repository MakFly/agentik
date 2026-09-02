import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { gcIndexes, hasIndex, indexKey, indexPaths, INDEX_SCHEMA_VERSION, listIndexes, refreshIndex, removeIndex, watchIndex } from "../src/code-index.ts";
import { DEPTH_ENV } from "../src/depth.ts";
import { hookStatus } from "../src/index-hooks.ts";
import { makeWorkspace } from "./helpers.ts";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

async function repo(prefix = "registry-ws-"): Promise<string> {
  const ws = await makeWorkspace(prefix);
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "a.ts"), "export function a() {}\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  return ws;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(`${a.map(String).join(" ")}\n`); };
  console.error = (...a: unknown[]) => { err.push(`${a.map(String).join(" ")}\n`); };
  try {
    return { code: await fn(), out: out.join(""), err: err.join("") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function withDepth<T>(depth: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[DEPTH_ENV];
  process.env[DEPTH_ENV] = depth;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[DEPTH_ENV];
    else process.env[DEPTH_ENV] = prev;
  }
}

describe("index registry: ls / rm / gc", () => {
  test("ls reads every index read-only; a schema-bumped index stays untouched", async () => {
    const home = await makeWorkspace("registry-home-");
    const a = await repo();
    const b = await repo();
    await refreshIndex(home, a);
    await refreshIndex(home, b);
    const dbB = indexPaths(home, indexKey(b).root).db;
    const bump = new Database(dbB);
    bump.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(INDEX_SCHEMA_VERSION + 7)]);
    bump.close();
    const entries = await listIndexes(home);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.root).sort()).toEqual([indexKey(a).root, indexKey(b).root].sort());
    const eb = entries.find((e) => e.root === indexKey(b).root)!;
    expect(eb).toMatchObject({ rootExists: true, files: 1 });
    expect(eb.bytes).toBeGreaterThan(0);
    expect(eb.refreshedAt).toBeTruthy();
    const check = new Database(dbB, { readonly: true });
    expect(check.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value).toBe(String(INDEX_SCHEMA_VERSION + 7));
    expect(check.query<{ n: number }, []>("SELECT count(*) AS n FROM code_files").get()!.n).toBe(1);
    check.close();
    expect(await listIndexes(await makeWorkspace("registry-empty-"))).toEqual([]);
  });

  test("rm by slug and by workspace; .workspace goes first; unknown slug is an error", async () => {
    const home = await makeWorkspace("registry-home-");
    const a = await repo();
    const b = await repo();
    await refreshIndex(home, a);
    await refreshIndex(home, b);
    const pa = indexPaths(home, indexKey(a).root);
    const deleted = await removeIndex(home, { slug: pa.slug });
    expect(deleted[0]).toBe(pa.workspaceFile);
    expect(deleted).toContain(pa.db);
    expect(hasIndex(home, a)).toBe(false);
    expect(existsSync(pa.db)).toBe(false);
    await removeIndex(home, { workspace: b });
    expect(hasIndex(home, b)).toBe(false);
    await expect(removeIndex(home, { slug: pa.slug })).rejects.toThrow(/no index named/);
    await expect(removeIndex(home, { slug: "../evil" })).rejects.toThrow(/invalid index name/);
  });

  test("gc: root gone or stale refreshed_at → removed; recent kept; problem entries reported, never deleted; dry-run deletes nothing", async () => {
    const home = await makeWorkspace("registry-home-");
    const gone = await repo();
    const stale = await repo();
    const fresh = await repo();
    await refreshIndex(home, gone);
    await refreshIndex(home, stale);
    await refreshIndex(home, fresh);
    await rm(gone, { recursive: true, force: true });
    const dbStale = indexPaths(home, indexKey(stale).root).db;
    const old = new Database(dbStale);
    old.run("UPDATE meta SET value = ? WHERE key = 'refreshed_at'", ["2020-01-01T00:00:00.000Z"]);
    old.close();
    // A stray .workspace with no db is a problem entry.
    await writeFile(join(home, "index", "stray-0000000000.workspace"), "/nowhere\n");
    const dry = await gcIndexes(home, { dryRun: true });
    expect(dry.removed.map((e) => e.root).sort()).toEqual([indexKey(gone).root, indexKey(stale).root].sort());
    expect(dry.kept.map((e) => e.root)).toEqual([indexKey(fresh).root]);
    expect(dry.problems.map((e) => e.slug)).toEqual(["stray-0000000000"]);
    expect(existsSync(dbStale)).toBe(true);
    const real = await gcIndexes(home);
    expect(real.removed.length).toBe(2);
    expect(existsSync(dbStale)).toBe(false);
    expect(hasIndex(home, fresh)).toBe(true);
    expect(existsSync(join(home, "index", "stray-0000000000.workspace"))).toBe(true);
    // The window is a parameter: with a huge window the stale one would have been kept.
    const wide = await gcIndexes(home, { dryRun: true, unusedDays: 100_000, now: new Date("2021-01-01T00:00:00Z") });
    expect(wide.removed).toEqual([]);
  });

  test("CLI: ls / rm / gc; rm, gc, --watch, --hook, --unhook refused at depth 1; --hook-status allowed", async () => {
    const home = await makeWorkspace("registry-home-");
    const ws = await repo();
    await refreshIndex(home, ws);
    const ls = await capture(() => main(["index", "ls", "--agentik-home", home]));
    expect(ls.code).toBe(0);
    expect(ls.out).toContain(indexKey(ws).root);
    expect(ls.out).toMatch(/1 files · \d+ chunks/);
    const lsJson = await capture(() => main(["index", "ls", "--json", "--agentik-home", home]));
    expect(JSON.parse(lsJson.out).length).toBe(1);
    const dry = await capture(() => main(["index", "gc", "--dry-run", "--agentik-home", home]));
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("gc: 0 candidate(s) · 1 kept");
    await withDepth("1", async () => {
      for (const argv of [["index", "rm", "x"], ["index", "gc"], ["index", "--watch"], ["index", "--hook"], ["index", "--unhook"]]) {
        const r = await capture(() => main([...argv, "--workspace", ws, "--agentik-home", home]));
        expect(r.code).toBe(2);
        expect(r.err).toContain("the human's pen");
      }
      const st = await capture(() => main(["index", "--hook-status", "--workspace", ws, "--agentik-home", home]));
      expect(st.code).toBe(0);
      expect(st.out).toContain("post-commit: absent");
    });
    expect(hasIndex(home, ws)).toBe(true);
    const rmv = await capture(() => main(["index", "rm", "--workspace", ws, "--agentik-home", home]));
    expect(rmv.code).toBe(0);
    expect(rmv.out).toContain("removed");
    expect(hasIndex(home, ws)).toBe(false);
    const usage = await capture(() => main(["index", "rm", "--agentik-home", home]));
    expect(usage.code).toBe(2);
    expect(await capture(() => main(["index", "--help"]))).toMatchObject({ code: 0 });
  });

  test("CLI: --hook installs the block, --hook-status reports it, --unhook removes it", async () => {
    const home = await makeWorkspace("registry-home-");
    const ws = await repo();
    const fake = join(ws, "fake-agentik");
    await writeFile(fake, "#!/bin/sh\nexit 0\n");
    await chmod(fake, 0o755);
    const hook = await capture(() => main(["index", "--hook", "--workspace", ws, "--agentik-home", home]));
    expect(hook.code).toBe(0);
    expect(hook.out).toContain("installed post-commit, post-checkout, post-merge, post-rewrite");
    const st = await hookStatus(ws);
    expect(st.hooks.every((h) => h.hooked && h.executable)).toBe(true);
    const status = await capture(() => main(["index", "--hook-status", "--workspace", ws, "--agentik-home", home]));
    expect(status.out).toContain("post-commit: hooked");
    const again = await capture(() => main(["index", "--hook", "--workspace", ws, "--agentik-home", home]));
    expect(again.out).toContain("kept post-commit, post-checkout, post-merge, post-rewrite");
    const un = await capture(() => main(["index", "--unhook", "--workspace", ws, "--agentik-home", home]));
    expect(un.code).toBe(0);
    expect(un.out).toContain("block removed from post-commit");
    expect((await hookStatus(ws)).hooks.every((h) => !h.present)).toBe(true);
    // A directory under <repo>/.tmp/ is inside this repository: git would resolve its hooks to the
    // main checkout's .git/hooks. The non-git case must live outside the repo.
    const plain = await mkdtemp(join(tmpdir(), "agentik-registry-plain-"));
    const notGit = await capture(() => main(["index", "--hook", "--workspace", plain, "--agentik-home", home]));
    expect(notGit.code).toBe(2);
    expect(notGit.err).toContain("not a git checkout");
  });

  test("watchIndex: builds on the first tick, logs only ticks with changes, stops on abort", async () => {
    const home = await makeWorkspace("registry-home-");
    const ws = await repo();
    const lines: string[] = [];
    const ac = new AbortController();
    let ticks = 0;
    const res = await watchIndex(home, ws, {
      signal: ac.signal,
      intervalMs: 1,
      log: (l) => lines.push(l),
      sleep: async () => {},
      onTick: async () => {
        ticks++;
        if (ticks === 2) await writeFile(join(ws, "src", "b.ts"), "export function b() {}\n");
        if (ticks === 3) ac.abort();
      },
    });
    expect(res.ticks).toBe(3);
    expect(res.changed).toBe(2); // tick 1 built, tick 3 saw b.ts; tick 2 was silent
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/\+1 ~0 -0/);
    expect(lines[1]).toMatch(/\+1 ~0 -0/);
    expect(hasIndex(home, ws)).toBe(true);
  });
});
