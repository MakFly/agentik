import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { refreshIndex } from "../src/code-index.ts";
import { FORMAT_MAX_CHARS, formatSearch, fuseRRF, literalRuns, pathGlobProblem, regexProblem, searchCode, snippet, sqliteSearchIndex, trigramMatch } from "../src/code-search.ts";
import { makeWorkspace } from "./helpers.ts";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

async function fixture(): Promise<{ ws: string; home: string }> {
  const ws = await makeWorkspace("code-search-ws-");
  const home = await makeWorkspace("code-search-home-");
  git(ws, "init", "-q");
  await mkdir(join(ws, "src"), { recursive: true });
  await mkdir(join(ws, "docs"), { recursive: true });
  await writeFile(
    join(ws, "src", "sessions.ts"),
    [
      "/** Search the session log. */",
      "export async function searchSessions(query: string) {",
      "  return openSessions().query(query);",
      "}",
      "function openSessions() {",
      "  return { query: (q: string) => q };",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(join(ws, "src", "trust.ts"), 'export function wrapUntrusted(body: string) {\n  return `<<<UNTRUSTED>>>${body}`;\n}\nexport function wrapTrusted(body: string) {\n  return body;\n}\n');
  await writeFile(join(ws, "src", "noise.ts"), "// sessionsessionsession shares trigrams only\nexport const noise = 1;\n");
  await writeFile(join(ws, "docs", "guide.md"), "# Guide\n\nSessions are searched with searchSessions.\n");
  await writeFile(join(ws, "src", "secret.ts"), 'export const k = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\nexport const marker = "sessions";\n');
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "fixture");
  await refreshIndex(home, ws);
  return { ws, home };
}

describe("code search", () => {
  test("a camelCase part finds the identifier; an exact substring outranks a trigram-only neighbour", async () => {
    const { ws, home } = await fixture();
    const res = await searchCode(home, ws, { query: "sessions" });
    expect(res.hits[0].path).toBe("src/sessions.ts");
    const paths = res.hits.map((h) => h.path);
    expect(paths).toContain("docs/guide.md");
    expect(paths.indexOf("src/sessions.ts")).toBeLessThan(paths.indexOf("src/noise.ts") === -1 ? Infinity : paths.indexOf("src/noise.ts"));
    const exact = await searchCode(home, ws, { query: "searchSessions(" });
    expect(exact.hits[0].path).toBe("src/sessions.ts");
    expect(exact.hits[0].ranges[0].lines.some((l) => l.text.includes("searchSessions("))).toBe(true);
    expect(exact.hits.map((h) => h.path)).not.toContain("src/noise.ts");
  });

  test("regex reports matching lines; a trigram false positive is eliminated by verification", async () => {
    const { ws, home } = await fixture();
    const res = await searchCode(home, ws, { query: "wrap\\w+\\(body", regex: true });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].path).toBe("src/trust.ts");
    expect(res.hits[0].ranges.map((r) => r.symbol)).toEqual(["wrapUntrusted", "wrapTrusted"]);
    expect(res.hits[0].ranges[0].lines[0].n).toBe(1);
    const none = await searchCode(home, ws, { query: "wrapUntrusted\\d+", regex: true });
    expect(none.hits).toEqual([]);
  });

  test("regex bounds: length, backreference, lookbehind, nested quantifier, budget and no-literal note", async () => {
    expect(regexProblem("a".repeat(201))).toMatch(/longer/);
    expect(regexProblem("(a)\\1")).toMatch(/backreference/);
    expect(regexProblem("(?<=a)b")).toMatch(/lookbehind/);
    expect(regexProblem("(a+)+$")).toMatch(/nested/);
    expect(regexProblem("(")).toMatch(/invalid/);
    expect(regexProblem("wrap\\w+")).toBeUndefined();
    expect(literalRuns("wrap\\w+\\(body")).toEqual(["(body", "wrap"]);
    expect(literalRuns("resolveWorkspace\\w+")).toEqual(["resolveWorkspace"]);
    expect(literalRuns("colou?r")).toEqual(["colo"]);
    expect(literalRuns("foo|bar")).toEqual([]);
    expect(literalRuns("(foo|bar)baz")).toEqual(["baz"]);
    expect(literalRuns("\\d+")).toEqual([]);
    const { ws, home } = await fixture();
    const noLit = await searchCode(home, ws, { query: "\\bq\\b", regex: true });
    expect(noLit.hits.map((h) => h.path)).toEqual(["src/sessions.ts"]);
    const starved = await searchCode(home, ws, { query: "export", regex: true, budgetMs: -1 });
    expect(starved.truncated).toBe(true);
    expect(starved.note).toMatch(/budget/);
  });

  test("path glob, paging, k clamp, vanished and edited files", async () => {
    const { ws, home } = await fixture();
    expect(pathGlobProblem("../x")).toMatch(/\.\./);
    expect(pathGlobProblem("/abs")).toMatch(/relative/);
    expect(pathGlobProblem("src/**")).toBeUndefined();
    await expect(searchCode(home, ws, { query: "sessions", pathGlob: "../**" })).rejects.toThrow(/\.\./);
    const only = await searchCode(home, ws, { query: "sessions", pathGlob: "docs/**" });
    expect(only.hits.map((h) => h.path)).toEqual(["docs/guide.md"]);
    const all = await searchCode(home, ws, { query: "sessions" });
    const page1 = await searchCode(home, ws, { query: "sessions", k: 1 });
    const page2 = await searchCode(home, ws, { query: "sessions", k: 1, offset: 1 });
    expect(page1.hits[0].path).toBe(all.hits[0].path);
    expect(page2.hits[0].path).toBe(all.hits[1].path);
    expect(page1.total).toBe(all.total);
    const clamped = await searchCode(home, ws, { query: "sessions", k: 999 });
    expect(clamped.k).toBe(50);
    await expect(searchCode(home, ws, { query: "   " })).rejects.toThrow(/empty/);

    // The live file is what gets quoted: an edit shows up without a refresh; a deletion drops the hit.
    await writeFile(join(ws, "docs", "guide.md"), "# Guide\n\nSessions are searched with searchSessions, edited.\n");
    const edited = await searchCode(home, ws, { query: "sessions", pathGlob: "docs/**" });
    expect(edited.hits[0].ranges[0].lines.some((l) => l.text.includes("edited"))).toBe(true);
    await rm(join(ws, "docs", "guide.md"));
    const gone = await searchCode(home, ws, { query: "sessions", pathGlob: "docs/**" });
    expect(gone.hits).toEqual([]);
  });

  test("secret lines are masked in snippets; formatSearch is bounded and paged", async () => {
    const { ws, home } = await fixture();
    const res = await searchCode(home, ws, { query: "sk-ant-api03" });
    const secret = res.hits.find((h) => h.path === "src/secret.ts")!;
    expect(secret).toBeDefined();
    const texts = secret.ranges.flatMap((r) => r.lines.map((l) => l.text));
    expect(texts.some((t) => t.startsWith("[BLOCKED: looks like a secret"))).toBe(true);
    expect(texts.join("\n")).not.toContain("ABCDEFGHIJKLMNOP");
    expect(snippet("x".repeat(500)).length).toBeLessThanOrEqual(160);

    const out = formatSearch(await searchCode(home, ws, { query: "sessions", k: 2 }));
    expect(out).toContain("src/sessions.ts");
    expect(out).toMatch(/L\d+-\d+ searchSessions/);
    expect(out).toMatch(/\[\d+ files, offset 0, next offset 2\]/);
    expect(formatSearch({ hits: [], total: 0, offset: 0, k: 20, truncated: false, ms: 1 })).toBe("no hits\n[0 files, offset 0, end]\n");
    const many = {
      hits: Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.ts`, score: 1, ranges: [{ start: 1, end: 1, symbol: "s", kind: "k", lines: [{ n: 1, text: "y".repeat(150) }] }] })),
      total: 60,
      offset: 0,
      k: 60,
      truncated: false,
      ms: 1,
    };
    const big = formatSearch(many);
    expect(big.length).toBeLessThanOrEqual(FORMAT_MAX_CHARS + 200);
    expect(big).toMatch(/more files in this page/);
  });

  test("helpers: trigramMatch, fuseRRF, SearchIndex seam", async () => {
    expect(trigramMatch("ab")).toBeUndefined();
    expect(trigramMatch("Abcd")).toBe('"abc" AND "bcd"');
    const fused = fuseRRF([[1, 2], [2, 3]]);
    expect(fused.get(2)!).toBeGreaterThan(fused.get(1)!);
    const { ws, home } = await fixture();
    const idx = sqliteSearchIndex(home, ws);
    expect(idx.stats()!.files).toBe(5);
    expect((await idx.search({ query: "wrapUntrusted" })).hits[0].path).toBe("src/trust.ts");
    expect((await idx.refresh()).updated).toBe(0);
  });
});
