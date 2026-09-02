import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main, spawnCodeBlock } from "../src/cli.ts";
import { AUTO_INDEX_MAX_FILES_ENV, countIndexable, ensureIndex, hasIndex, indexKey, indexPaths, indexStats, refreshIndex, resetIndexHints } from "../src/code-index.ts";
import { DEPTH_ENV } from "../src/depth.ts";
import { runLoop } from "../src/loop.ts";
import { makeWorkspace, pair } from "./helpers.ts";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

async function repo(files = 3): Promise<{ ws: string; home: string }> {
  const ws = await makeWorkspace("index-auto-ws-");
  const home = await makeWorkspace("index-auto-home-");
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  for (let i = 0; i < files; i++) await writeFile(join(ws, "src", `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  resetIndexHints();
  return { ws, home };
}

const clean = { PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv;

/** The preload turns the auto-build off for every test; these tests are about it. */
async function withAuto<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AGENTIK_INDEX_AUTO;
  process.env.AGENTIK_INDEX_AUTO = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTIK_INDEX_AUTO;
    else process.env.AGENTIK_INDEX_AUTO = prev;
  }
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write;
  console.log = (...a: unknown[]) => { out.push(`${a.map(String).join(" ")}\n`); };
  console.error = (...a: unknown[]) => { err.push(`${a.map(String).join(" ")}\n`); };
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    return { code: await fn(), out: out.join(""), err: err.join("") };
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
  }
}

describe("ensureIndex: the conductor builds, the worker reads", () => {
  test("auto-build under the cap, then refresh; built_at stays, refreshed_at moves", async () => {
    const { ws, home } = await repo();
    const lines: string[] = [];
    const first = await ensureIndex(home, ws, { env: clean, log: (l) => lines.push(l) });
    expect(first.built).toBe(true);
    expect(first.stats?.files).toBe(3);
    expect(first.stats?.built).toBe(true);
    expect(hasIndex(home, ws)).toBe(true);
    expect(lines[0]).toMatch(/^agentik: indexing .* \(3 files\)…$/);
    expect(lines[1]).toMatch(/^index: /);
    const builtAt = indexStats(home, ws)!.builtAt;
    await Bun.sleep(5);
    await writeFile(join(ws, "src", "f0.ts"), "export function fn0() { return 'x'; }\n");
    const again = await ensureIndex(home, ws, { env: clean });
    expect(again.built).toBe(false);
    expect(again.stats?.updated).toBe(1);
    expect(again.stats?.built).toBe(false);
    const after = indexStats(home, ws)!;
    expect(after.builtAt).toBe(builtAt);
    expect(after.refreshedAt > builtAt).toBe(true);
  });

  test("over the cap: no file, reason too_big, one hint per (root, reason) per process", async () => {
    const { ws, home } = await repo(4);
    const lines: string[] = [];
    const r1 = await ensureIndex(home, ws, { env: clean, maxFiles: 2, log: (l) => lines.push(l) });
    expect(r1).toMatchObject({ built: false, reason: "too_big" });
    expect(r1.files).toBe(3); // stopped at max + 1
    expect(existsSync(indexPaths(home, indexKey(ws).root).db)).toBe(false);
    const r2 = await ensureIndex(home, ws, { env: clean, maxFiles: 2, log: (l) => lines.push(l) });
    expect(r2.reason).toBe("too_big");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("agentik index --workspace");
    expect(lines[0]).toContain("AGENTIK_INDEX_AUTO=0");
    resetIndexHints();
    await ensureIndex(home, ws, { env: clean, maxFiles: 2, log: (l) => lines.push(l) });
    expect(lines.length).toBe(2);
    // The env cap is honoured the same way; the explicit command has no cap.
    const r3 = await ensureIndex(home, ws, { env: { ...clean, [AUTO_INDEX_MAX_FILES_ENV]: "1" } });
    expect(r3.reason).toBe("too_big");
    const built = await refreshIndex(home, ws);
    expect(built.files).toBe(4);
  });

  test("disabled by env or option; never built by a worker (depth ≥ 1)", async () => {
    const { ws, home } = await repo();
    expect((await ensureIndex(home, ws, { env: { ...clean, AGENTIK_INDEX_AUTO: "0" } })).reason).toBe("disabled");
    expect((await ensureIndex(home, ws, { env: clean, auto: false })).reason).toBe("disabled");
    const lines: string[] = [];
    const worker = await ensureIndex(home, ws, { env: { ...clean, [DEPTH_ENV]: "1" }, log: (l) => lines.push(l) });
    expect(worker.reason).toBe("depth");
    expect(lines[0]).toContain("a worker never builds one");
    expect(hasIndex(home, ws)).toBe(false);
    // Once the conductor built it, a worker refreshes it.
    await ensureIndex(home, ws, { env: clean });
    const refreshed = await ensureIndex(home, ws, { env: { ...clean, [DEPTH_ENV]: "1" } });
    expect(refreshed.stats?.files).toBe(3);
  });

  test("agentik search at depth 1 on a fresh checkout: exit 1, hint, nothing built", async () => {
    const { ws, home } = await repo();
    const res = Bun.spawnSync(["bun", "src/cli.ts", "search", "fn1", "--workspace", ws, "--agentik-home", home], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, [DEPTH_ENV]: "1", AGENTIK_INDEX_AUTO: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toString()).toContain("a worker never builds one");
    expect(hasIndex(home, ws)).toBe(false);
  });

  test("countIndexable never reads a file and stops at max + 1; ignore files are a union", async () => {
    const { ws, home } = await repo(5);
    await writeFile(join(ws, "src", "huge.bin"), Buffer.from([0, 1, 2])); // skipped by name? no: only by bytes → counted
    await writeFile(join(ws, ".cursorignore"), "src/f1.ts\n");
    await writeFile(join(ws, ".aiignore"), "src/f2.ts\n");
    await writeFile(join(ws, ".agentikignore"), "src/f3.ts\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "ignores");
    const c = await countIndexable(ws, 100);
    expect(c.mode).toBe("git");
    expect(c.over).toBe(false);
    // f0, f4, huge.bin, .cursorignore, .aiignore, .agentikignore = 6 (f1..f3 ignored by three different files)
    expect(c.files).toBe(6);
    expect((await countIndexable(ws, 2)).over).toBe(true);
    const stats = await refreshIndex(home, ws);
    expect(stats.ignoreFiles).toEqual([".agentikignore", ".cursorignore", ".aiignore"]);
    expect(stats.files).toBe(5); // huge.bin is binary → skipped at read time
    const plain = await makeWorkspace("index-auto-plain-");
    await writeFile(join(plain, "a.txt"), "x");
    await writeFile(join(plain, "b.txt"), "y");
    expect(await countIndexable(plain, 10)).toEqual({ files: 2, mode: "walk", over: false });
  });

  test("progress callback; a failed build is one line and reason failed", async () => {
    const { ws, home } = await repo(3);
    const seen: Array<[number, number]> = [];
    await refreshIndex(home, ws, { onProgress: (d, t) => seen.push([d, t]), progressEvery: 1 });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3], [3, 3]]);
    const lines: string[] = [];
    const broken = await ensureIndex("/proc/agentik-cannot-write", ws, { env: clean, log: (l) => lines.push(l) });
    expect(broken.reason).toBe("failed");
    expect(lines.some((l) => l.includes("not built"))).toBe(true);
  });

  test("run / context / spawn build on first use; --no-index builds nothing; report.codeIndex says so", () => withAuto(async () => {
    const { ws, home } = await repo();
    const { workerA, workerB } = pair();
    const off = await runLoop({ goal: "list files", workspace: ws, home, workerA, workerB, codeIndex: false });
    expect(off.codeIndex).toBeUndefined();
    expect(hasIndex(home, ws)).toBe(false);
    const on = await runLoop({ goal: "list files", workspace: ws, home, workerA, workerB });
    expect(on.codeIndex).toMatchObject({ built: true }); // the mock workers may have written files: count ≥ 3
    expect(on.codeIndex!.files).toBeGreaterThanOrEqual(3);
    expect(hasIndex(home, ws)).toBe(true);

    const { ws: ws2, home: home2 } = await repo();
    const ctxOff = await capture(() => main(["context", "seal", "--workspace", ws2, "--agentik-home", home2, "--no-index"]));
    expect(ctxOff.code).toBe(0);
    expect(hasIndex(home2, ws2)).toBe(false);
    const ctxOn = await capture(() => main(["context", "fn1", "--workspace", ws2, "--agentik-home", home2]));
    expect(ctxOn.code).toBe(0);
    expect(ctxOn.err).toMatch(/indexing .* \(3 files\)/);
    expect(ctxOn.out).toContain("CODE MAP");
    expect(hasIndex(home2, ws2)).toBe(true);

    const { ws: ws3, home: home3 } = await repo();
    const block = await spawnCodeBlock("fn1", ws3, home3);
    expect(block).toContain("origin=agentik:code");
    expect(hasIndex(home3, ws3)).toBe(true);

    // Over the cap through `run`: the report carries the reason.
    const { ws: ws4, home: home4 } = await repo(4);
    const prev = process.env[AUTO_INDEX_MAX_FILES_ENV];
    process.env[AUTO_INDEX_MAX_FILES_ENV] = "2";
    try {
      const big = await runLoop({ goal: "list files", workspace: ws4, home: home4, workerA, workerB });
      expect(big.codeIndex).toMatchObject({ built: false, reason: "too_big" });
    } finally {
      if (prev === undefined) delete process.env[AUTO_INDEX_MAX_FILES_ENV];
      else process.env[AUTO_INDEX_MAX_FILES_ENV] = prev;
    }
  }));

  test("two processes refreshing the same fresh index both succeed (race on UNIQUE(path) fixed)", async () => {
    const { ws, home } = await repo(40);
    const script = `import { refreshIndex } from "./src/code-index.ts"; const s = await refreshIndex(${JSON.stringify(home)}, ${JSON.stringify(ws)}); console.log(JSON.stringify({ files: s.files, added: s.added }));`;
    const cwd = join(import.meta.dir, "..");
    const [a, b] = await Promise.all([
      Bun.spawn(["bun", "-e", script], { cwd, stdout: "pipe", stderr: "pipe" }),
      Bun.spawn(["bun", "-e", script], { cwd, stdout: "pipe", stderr: "pipe" }),
    ].map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(a.err + b.err).toBe("");
    const stats = indexStats(home, ws)!;
    expect(stats.files).toBe(40);
    expect(JSON.parse(a.out).added + JSON.parse(b.out).added).toBe(40);
  });

  test("--if-present refreshes only; --quiet prints nothing", async () => {
    const { ws, home } = await repo();
    const none = await capture(() => main(["index", "--if-present", "--workspace", ws, "--agentik-home", home]));
    expect(none.code).toBe(0);
    expect(none.err).toContain("nothing to do");
    expect(hasIndex(home, ws)).toBe(false);
    const quiet = await capture(() => main(["index", "--if-present", "--quiet", "--workspace", ws, "--agentik-home", home]));
    expect(quiet).toEqual({ code: 0, out: "", err: "" });
    await refreshIndex(home, ws);
    const refreshed = await capture(() => main(["index", "--if-present", "--quiet", "--workspace", ws, "--agentik-home", home]));
    expect(refreshed).toEqual({ code: 0, out: "", err: "" });
    const shown = await capture(() => main(["runs", "ls", "--agentik-home", home]));
    expect(shown.code).toBe(0);
  });
});
