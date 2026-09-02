import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { refreshIndex } from "../src/code-index.ts";
import { DEPTH_ENV } from "../src/depth.ts";
import { makeWorkspace } from "./helpers.ts";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
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

async function repo(): Promise<{ ws: string; home: string }> {
  const ws = await makeWorkspace("cli-index-ws-");
  const home = await makeWorkspace("cli-index-home-");
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "seal.ts"), "export function writeSeal() {}\nexport function checkSeal() {}\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  return { ws, home };
}

describe("agentik index / search", () => {
  test("search without an index: exit 1 with the hint when auto-build is off, a build otherwise; index; --json; --stats", async () => {
    const { ws, home } = await repo();
    const prev = process.env.AGENTIK_INDEX_AUTO;
    process.env.AGENTIK_INDEX_AUTO = "0";
    let none: Awaited<ReturnType<typeof capture>>;
    try {
      none = await capture(() => main(["search", "seal", "--workspace", ws, "--agentik-home", home]));
    } finally {
      if (prev === undefined) delete process.env.AGENTIK_INDEX_AUTO;
      else process.env.AGENTIK_INDEX_AUTO = prev;
    }
    expect(none.code).toBe(1);
    expect(none.err).toContain("no code index");
    expect(none.err).toContain("agentik index --workspace");

    const built = await capture(() => main(["index", "--workspace", ws, "--agentik-home", home]));
    expect(built.code).toBe(0);
    expect(built.out).toMatch(/^index: .* · git · 1 files · \d+ chunks · \+1 ~0 -0 · /);

    const found = await capture(() => main(["search", "check seal", "--workspace", ws, "--agentik-home", home]));
    expect(found.code).toBe(0);
    expect(found.out).toContain("src/seal.ts");
    expect(found.out).toMatch(/checkSeal/);

    const json = await capture(() => main(["search", "Seal", "--regex", "-k", "1", "--json", "--workspace", ws, "--agentik-home", home]));
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(parsed.hits[0].path).toBe("src/seal.ts");
    expect(parsed.k).toBe(1);

    const stats = await capture(() => main(["index", "--stats", "--json", "--workspace", ws, "--agentik-home", home]));
    expect(stats.code).toBe(0);
    expect(JSON.parse(stats.out).files).toBe(1);

    const bad = await capture(() => main(["search", "(a+)+$", "--regex", "--workspace", ws, "--agentik-home", home]));
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/nested/);
    const usage = await capture(() => main(["search", "--workspace", ws, "--agentik-home", home]));
    expect(usage.code).toBe(2);
  });

  test("index and search are allowed inside a worker (depth ≥ 1) and exempt from the config preflight", async () => {
    const { ws, home } = await repo();
    await writeFile(join(home, "config.json"), "{ not json");
    const prev = process.env[DEPTH_ENV];
    process.env[DEPTH_ENV] = "1";
    try {
      const built = await capture(() => main(["index", "--workspace", ws, "--agentik-home", home]));
      expect(built.code).toBe(0);
      const found = await capture(() => main(["search", "writeSeal", "--workspace", ws, "--agentik-home", home]));
      expect(found.code).toBe(0);
      expect(found.out).toContain("writeSeal");
    } finally {
      if (prev === undefined) delete process.env[DEPTH_ENV];
      else process.env[DEPTH_ENV] = prev;
    }
  });

  test("a search that runs while an index is being written still answers (WAL + busy_timeout)", async () => {
    const { ws, home } = await repo();
    for (let i = 0; i < 40; i++) await writeFile(join(ws, "src", `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
    await refreshIndex(home, ws);
    await writeFile(join(ws, "src", "f0.ts"), "export function fn0() { return 'changed'; }\n");
    const [refresh, search] = await Promise.all([
      refreshIndex(home, ws),
      capture(() => main(["search", "fn1", "--workspace", ws, "--agentik-home", home])),
    ]);
    expect(refresh.updated).toBe(1);
    expect(search.err).toBe("");
    expect(search.code).toBe(0);
    expect(search.out).toContain("src/f1.ts");
  });
});
