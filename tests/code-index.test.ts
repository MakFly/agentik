import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blobSha, hasIndex, indexKey, indexPaths, indexStats, INDEX_SCHEMA_VERSION, listFiles, maskSecretLines, openIndex, refreshIndex, shouldSkip } from "../src/code-index.ts";
import { makeWorkspace } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString();
}

async function repo(): Promise<{ ws: string; home: string }> {
  const ws = await makeWorkspace("code-index-ws-");
  const home = await makeWorkspace("code-index-home-");
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "a.ts"), 'import { b } from "./b.ts";\nexport function alpha() {\n  return b();\n}\n');
  await writeFile(join(ws, "src", "b.ts"), "export function b() {\n  return 1;\n}\n");
  await writeFile(join(ws, "README.md"), "# demo\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  return { ws, home };
}

function rows(home: string, ws: string, sql: string): Array<Record<string, unknown>> {
  const db = new Database(indexPaths(home, indexKey(ws).root).db, { readonly: true });
  try {
    return db.query(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("code index: store and freshness", () => {
  test("build, no-op refresh, update, add, delete — only the moved rows are touched", async () => {
    const { ws, home } = await repo();
    expect(hasIndex(home, ws)).toBe(false);
    const first = await refreshIndex(home, ws);
    expect(first.mode).toBe("git");
    expect(first.files).toBe(3);
    expect(first.added).toBe(3);
    expect(hasIndex(home, ws)).toBe(true);
    const edges = rows(home, ws, "SELECT count(*) AS n FROM code_edges");
    expect(edges[0].n).toBe(1); // a.ts → b.ts
    const before = rows(home, ws, "SELECT path, indexed_at FROM code_files ORDER BY path");

    const again = await refreshIndex(home, ws);
    expect([again.added, again.updated, again.removed]).toEqual([0, 0, 0]);
    expect(rows(home, ws, "SELECT path, indexed_at FROM code_files ORDER BY path")).toEqual(before);

    await writeFile(join(ws, "src", "b.ts"), "export function b() {\n  return 2;\n}\nexport function c() {}\n");
    const upd = await refreshIndex(home, ws);
    expect([upd.added, upd.updated, upd.removed]).toEqual([0, 1, 0]);
    expect(rows(home, ws, "SELECT dirty FROM code_files WHERE path = 'src/b.ts'")[0].dirty).toBe(1);
    expect(rows(home, ws, "SELECT symbol FROM code_chunks WHERE path = 'src/b.ts' ORDER BY start").map((r) => r.symbol)).toEqual(["b", "c"]);
    expect(rows(home, ws, "SELECT count(*) AS n FROM code_edges")[0].n).toBe(1); // incoming edge kept: file ids are stable

    // Committing the dirty file does not re-index it: the sha was git's own blob id.
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "b");
    const listed = await listFiles(ws);
    expect(listed.files.get("src/b.ts")).toBe(rows(home, ws, "SELECT sha FROM code_files WHERE path = 'src/b.ts'")[0].sha as string);
    const afterCommit = await refreshIndex(home, ws);
    expect([afterCommit.added, afterCommit.updated, afterCommit.removed]).toEqual([0, 0, 0]);

    await writeFile(join(ws, "src", "new.ts"), "export const fresh = 1;\n"); // untracked
    await rm(join(ws, "README.md"));
    const mix = await refreshIndex(home, ws);
    expect([mix.added, mix.updated, mix.removed]).toEqual([1, 0, 1]);
    expect(rows(home, ws, "SELECT path FROM code_files ORDER BY path").map((r) => r.path)).toEqual(["src/a.ts", "src/b.ts", "src/new.ts"]);
    expect(rows(home, ws, "SELECT count(*) AS n FROM code_chunks WHERE path = 'README.md'")[0].n).toBe(0);
  });

  test("gitignored, always-skipped dirs, secret names, lock/minified, binary, >1 MB, .agentikignore, symlinks", async () => {
    const { ws, home } = await repo();
    await writeFile(join(ws, ".gitignore"), "ignored.ts\n");
    await writeFile(join(ws, "ignored.ts"), "export const ignored = 1;\n");
    await mkdir(join(ws, ".agentik", "tool-results"), { recursive: true });
    await writeFile(join(ws, ".agentik", "tool-results", "x.txt"), "spilled output");
    await mkdir(join(ws, "node_modules", "dep"), { recursive: true });
    await writeFile(join(ws, "node_modules", "dep", "index.js"), "module.exports = 1;");
    await writeFile(join(ws, ".env"), "API_KEY=abcdefghijklmnopqrstuvwxyz123456\n");
    await writeFile(join(ws, "server.pem"), "-----BEGIN PRIVATE KEY-----\nxxx\n");
    await writeFile(join(ws, "bun.lock"), "{}");
    await writeFile(join(ws, "app.min.js"), "x".repeat(10));
    await writeFile(join(ws, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await writeFile(join(ws, "huge.txt"), "a\n".repeat(600_000));
    await writeFile(join(ws, ".agentikignore"), "# comment\ngenerated/\n*.snap\n");
    await mkdir(join(ws, "generated"), { recursive: true });
    await writeFile(join(ws, "generated", "g.ts"), "export const g = 1;\n");
    await writeFile(join(ws, "a.snap"), "snapshot");
    await symlink("/etc/passwd", join(ws, "link.txt"));
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "noise");
    const s = await refreshIndex(home, ws);
    const paths = rows(home, ws, "SELECT path FROM code_files ORDER BY path").map((r) => r.path);
    expect(paths).toEqual([".agentikignore", ".gitignore", "README.md", "src/a.ts", "src/b.ts"]);
    expect(s.skipped).toBeGreaterThanOrEqual(8);
    expect(shouldSkip("node_modules/x.js", () => false)).toBe("always-skipped directory");
    expect(shouldSkip(".env.local", () => false)).toBe("secret-looking file name");
    expect(shouldSkip("id_rsa.pub", () => false)).toBe("secret-looking file name");
    expect(shouldSkip("package-lock.json", () => false)).toBe("lock or minified file");
    expect(shouldSkip("a.ts", () => false, new Uint8Array([1, 0, 2]))).toBe("binary");
  });

  test("a secret line never reaches the trigram index; blobSha equals git's blob id", async () => {
    const { ws, home } = await repo();
    const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    await writeFile(join(ws, "src", "cfg.ts"), `export const token = "${key}";\nexport const plain = "visible-marker-text";\n`);
    git(ws, "add", "-A");
    const sha = git(ws, "hash-object", "src/cfg.ts").trim();
    expect(blobSha(new Uint8Array(await Bun.file(join(ws, "src", "cfg.ts")).arrayBuffer()))).toBe(sha);
    await refreshIndex(home, ws);
    const db = new Database(indexPaths(home, indexKey(ws).root).db, { readonly: true });
    try {
      const hit = (m: string) => db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM files_tri WHERE files_tri MATCH ?").get(m)!.n;
      expect(hit('"vis" AND "isi" AND "sib"')).toBe(1);
      expect(hit('"api" AND "pi0" AND "i03"')).toBe(0);
    } finally {
      db.close();
    }
    expect(maskSecretLines(`a\n${key}\nb`)).toBe("a\n\nb");
  });

  test("a worktree has its own index; a plain directory is walked; a foreign index is refused", async () => {
    const { ws, home } = await repo();
    const wt = `${ws}-wt`;
    git(ws, "worktree", "add", "-q", wt, "-b", "topic");
    await refreshIndex(home, ws);
    await refreshIndex(home, wt);
    expect(indexKey(ws).root).not.toBe(indexKey(wt).root);
    expect(existsSync(indexPaths(home, indexKey(wt).root).db)).toBe(true);

    const plain = await makeWorkspace("code-index-plain-");
    await writeFile(join(plain, "notes.txt"), "hello world\n");
    await mkdir(join(plain, ".git"), { recursive: true }); // a stray dir, not a repo
    const s = await refreshIndex(home, plain);
    expect(s.mode).toBe("walk");
    expect(s.files).toBe(1);
    const again = await refreshIndex(home, plain);
    expect([again.added, again.updated]).toEqual([0, 0]);

    expect(() => openIndex(home, "/somewhere/else")).not.toThrow(); // no file → undefined
    await writeFile(indexPaths(home, indexKey(ws).root).workspaceFile, "/another/root\n");
    expect(hasIndex(home, ws)).toBe(false);
  });

  test("schema version bump rebuilds; --rebuild starts from an empty file; stats read without refreshing", async () => {
    const { ws, home } = await repo();
    await refreshIndex(home, ws);
    const p = indexPaths(home, indexKey(ws).root).db;
    const db = new Database(p);
    db.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(INDEX_SCHEMA_VERSION + 1)]);
    db.close();
    const s = await refreshIndex(home, ws);
    expect(s.added).toBe(3);
    const r = await refreshIndex(home, ws, { rebuild: true });
    expect(r.added).toBe(3);
    const st = indexStats(home, ws)!;
    expect(st.files).toBe(3);
    expect(st.chunks).toBeGreaterThan(0);
    expect(indexStats(home, await makeWorkspace("code-index-none-"))).toBeUndefined();
  });
});
