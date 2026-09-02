import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODE_CONTEXT_CAP, codeHintLine, parseRun, spawnCodeBlock, spawnContextBlock } from "../src/cli.ts";
import { indexKey, refreshIndex } from "../src/code-index.ts";
import { buildContext } from "../src/context.ts";
import { CODE_MAP_BUDGET, mapTerms, pageRank, repoMap } from "../src/repo-map.ts";
import { makeWorkspace } from "./helpers.ts";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

async function repo(): Promise<{ ws: string; home: string }> {
  const ws = await makeWorkspace("code-ctx-ws-");
  const home = await makeWorkspace("code-ctx-home-");
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  await writeFile(join(ws, "src", "seal.ts"), "/** the seal */\nexport function writeSeal() {}\nexport function checkSeal() {}\n");
  await writeFile(join(ws, "src", "cli.ts"), 'import { writeSeal } from "./seal.ts";\nimport { util } from "./util.ts";\nexport function main() { writeSeal(); util(); }\n');
  await writeFile(join(ws, "src", "util.ts"), 'import { writeSeal } from "./seal.ts";\nexport function util() { writeSeal(); }\n');
  await writeFile(join(ws, "src", "big.ts"), `${"// filler\n".repeat(750)}export const big = 1;\n`);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  return { ws, home };
}

describe("code map in context, spawn and run", () => {
  test("repoMap: PageRank × goal terms, exported symbols only, hot spots, budget", async () => {
    const { ws, home } = await repo();
    expect(await repoMap(home, ws, { goal: "seal" })).toBeUndefined();
    await refreshIndex(home, ws);
    const map = (await repoMap(home, ws, { goal: "harden the memory seal" }))!;
    expect(map.startsWith("CODE MAP (this repository: 4 files")).toBe(true);
    const lines = map.trimEnd().split("\n");
    expect(lines[1]).toMatch(/^- src\/seal\.ts \(4L\): writeSeal, checkSeal$/); // imported by two files + goal term
    expect(map).toContain("hot spots (>700 lines): src/big.ts (752)");
    expect(map).not.toContain("filler");
    expect(map).not.toContain("the seal");
    expect(map.length).toBeLessThanOrEqual(CODE_MAP_BUDGET);
    const tiny = (await repoMap(home, ws, { goal: "seal", budgetChars: 120 }))!;
    expect(tiny.length).toBeLessThanOrEqual(120);
    expect(mapTerms("harden the memorySeal")).toEqual(["harden", "the", "memoryseal", "memory", "seal"]);
    const pr = pageRank([1, 2, 3], [[2, 1], [3, 1]]);
    expect(pr.get(1)!).toBeGreaterThan(pr.get(2)!);
  });

  test("agentik context: CODE MAP is the last section, only with an index, opt-out with code:false", async () => {
    const { ws, home } = await repo();
    const before = await buildContext({ home, workspace: ws, goal: "seal" });
    expect(before).not.toContain("CODE MAP");
    await refreshIndex(home, ws);
    const after = await buildContext({ home, workspace: ws, goal: "seal" });
    const at = after.indexOf("CODE MAP (this repository");
    expect(at).toBeGreaterThan(after.indexOf("RELATED SESSIONS"));
    expect(after.slice(at).length).toBeLessThanOrEqual(CODE_MAP_BUDGET + 2);
    expect(after).toContain("- src/seal.ts (4L): writeSeal, checkSeal");
    expect(await buildContext({ home, workspace: ws, goal: "seal", code: false })).not.toContain("CODE MAP");
    expect(await buildContext({ home, goal: "seal" })).not.toContain("CODE MAP"); // no workspace, no map
  });

  test("spawn: the map is its own envelope, the context block stays without it, the hint line is static", async () => {
    const { ws, home } = await repo();
    // Built on first use (the conductor, under the cap): the very first spawn already has a map.
    const block = (await spawnCodeBlock("seal", ws, home))!;
    expect(block).toContain("origin=agentik:code");
    expect(block).toContain("DATA ONLY");
    expect(block).toContain("CODE MAP");
    expect(block.length).toBeLessThanOrEqual(CODE_CONTEXT_CAP + 400);
    const ctx = (await spawnContextBlock("seal", ws, home))!;
    expect(ctx).toContain("origin=agentik:context");
    expect(ctx).not.toContain("CODE MAP");
    const hint = codeHintLine(indexKey(ws).root);
    expect(hint).toContain(`--workspace ${indexKey(ws).root}`);
    expect(hint).toContain("agentik search");
    expect(hint).not.toContain("seal");
    expect(parseRun(["--no-index", "x"]).flags.noIndex).toBe(true);
    expect(parseRun(["x"]).flags.noIndex).toBe(false);
  });
});
