import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DIFF_LINE_CAP, FAILURE_LINE_RE, SHAPERS, isFailureLine, shapeOutput } from "../src/shape.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "shape");
const fixture = (name: string) => readFile(join(FIXTURES, name), "utf8");

/** Every raw line that reads as a failure must be in the shaped text (verbatim or its key). */
function failureLinesSurvive(raw: string, shaped: string): void {
  for (const line of raw.split("\n")) {
    if (!isFailureLine(line)) continue;
    const m = FAILURE_LINE_RE.exec(line)!;
    const key = line.slice(m.index, m.index + m[0].length + 40).trim();
    expect(shaped.includes(line.trim()) || shaped.includes(key)).toBe(true);
  }
}

describe("shapeOutput — every shaper reduces without hiding a failure", () => {
  test("git status (long format) is grouped by state with counters", async () => {
    const raw = await fixture("git-status.txt");
    const r = shapeOutput(["git", "status"], raw, "", 0);
    expect(r.shaper).toBe("git-status");
    expect(r.savedChars).toBe(raw.length - r.text.length);
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.text).toContain("On branch feat/output-shape");
    expect(r.text).toContain("modified (3): src/tools.ts src/loop.ts src/tool-results.ts");
    expect(r.text).toContain("added (1): src/shape.ts");
    expect(r.text).toContain("deleted (1): docs/old.md");
    expect(r.text).toContain("renamed (1): src/a.ts -> src/b.ts");
    expect(r.text).toContain("untracked (2): tests/shape.test.ts tests/fixtures/shape/");
    expect(r.text).not.toContain("(use \"git add");
  });

  test("git status --porcelain is grouped the same way", async () => {
    const raw = await fixture("git-status-porcelain.txt");
    const r = shapeOutput(["git", "status", "--porcelain"], raw, "", 0);
    expect(r.shaper).toBe("git-status");
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.text).toContain("modified (24): src/module-1/index.ts src/module-2/index.ts");
    expect(r.text).toContain("docs/THREAT-MODEL.md src/tools.ts");
    expect(r.text).toContain("added (1): src/shape.ts");
    expect(r.text).toContain("deleted (1): docs/old.md");
    expect(r.text).toContain("renamed (1): src/a.ts -> src/b.ts");
    expect(r.text).toContain("untracked (2): tests/shape.test.ts tests/fixtures/shape/");
    expect(shapeOutput(["git", "-C", "/tmp/x", "status", "--porcelain"], raw, "", 0).shaper).toBe("git-status");
    // a tiny porcelain is already compact: grouping it would not be shorter, so it stays raw
    expect(shapeOutput(["git", "status", "--porcelain"], " M a\n?? b\n", "", 0).shaper).toBeUndefined();
  });

  test("git diff drops the diff --git / index / --- / +++ headers, keeps every hunk line, caps at 200 lines", async () => {
    const raw = await fixture("git-diff.txt");
    const r = shapeOutput(["git", "diff"], raw, "", 0);
    expect(r.shaper).toBe("git-diff");
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.text).not.toContain("diff --git");
    expect(r.text).not.toContain("index 3f2a1b4");
    expect(r.text).not.toContain("--- a/src/tools.ts");
    expect(r.text).not.toContain("+++ b/src/tools.ts");
    expect(r.text).toContain("### src/tools.ts");
    expect(r.text).toContain("### src/shape.ts");
    for (const line of raw.split("\n")) {
      if (/^(@@|[-+ ] )/.test(line) && !/^(--- |\+\+\+ )/.test(line)) expect(r.text).toContain(line);
    }
    const big = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,400 +1,400 @@", ...Array.from({ length: 400 }, (_, i) => `+line ${i}`)].join("\n");
    const capped = shapeOutput(["git", "diff", "--cached"], big, "", 0);
    expect(capped.shaper).toBe("git-diff");
    expect(capped.text.split("\n").length).toBe(DIFF_LINE_CAP + 1);
    expect(capped.text).toContain(`…[${402 - DIFF_LINE_CAP} lines omitted]`);
  });

  test("git log becomes one `hash subject` line per commit; --oneline is kept as is", async () => {
    const raw = await fixture("git-log.txt");
    const r = shapeOutput(["git", "log", "-3"], raw, "", 0);
    expect(r.shaper).toBe("git-log");
    expect(r.text.split("\n")).toEqual([
      "f1e0479 review eval: a case whose backend errored never passes",
      "0db2a21 review: known incidents as DATA in a normal review; eval scores only skill writes that landed",
      "4157b82 live fixes: a claim without text no longer crashes the report; a throwing review tool is a refusal",
    ]);
    const oneline = "f1e0479 review eval\n0db2a21 review\n";
    const kept = shapeOutput(["git", "log", "--oneline"], oneline, "", 0);
    expect(kept.shaper).toBeUndefined();
    expect(kept.text).toBe(oneline);
    expect(kept.savedChars).toBe(0);
  });

  test("bun test with one failure: passes collapse to `N passed`, the failure, its assertion and stack survive, counters stay", async () => {
    const raw = await fixture("bun-test-fail.txt");
    const r = shapeOutput(["bun", "test"], raw, "", 1);
    expect(r.shaper).toBe("test-runner");
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.text).toContain("11 passed, 1 skipped");
    expect(r.text).not.toContain("(pass)");
    expect(r.text).toContain("(fail) shape > failure lines survive [1.88ms]");
    expect(r.text).toContain("error: expect(received).toContain(expected)");
    expect(r.text).toContain('Expected to contain: "(fail) suite > b"');
    expect(r.text).toContain("at <anonymous> (/home/kev/lab/agentik/tests/shape.test.ts:14:29)");
    expect(r.text).toContain(" 11 pass");
    expect(r.text).toContain(" 1 fail");
    expect(r.text).toContain("Ran 13 tests across 1 file. [48.00ms]");
    failureLinesSurvive(raw, r.text);
    for (const argv of [["vitest", "run"], ["npx", "jest"], ["npm", "test"], ["pnpm", "run", "test"], ["pytest", "-q"], ["go", "test", "./..."], ["cargo", "test"]]) {
      expect(SHAPERS.find((s) => s.match(argv))?.id).toBe("test-runner");
    }
  });

  test("tsc: errors grouped by file, `L<line> error TS<code>` truncated to 160 chars, every code survives", async () => {
    const raw = await fixture("tsc.txt");
    const r = shapeOutput(["bunx", "tsc", "--noEmit"], raw, "", 2);
    expect(r.shaper).toBe("tsc");
    expect(r.savedChars).toBeGreaterThan(0);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("src/tools.ts: 2 errors");
    expect(lines[1]).toMatch(/^  L268 error TS2322: Type 'string \| undefined' is not assignable to type 'string'\.$/);
    expect(lines[2].startsWith("  L271 error TS2741: Property 'raw' is missing")).toBe(true);
    expect(lines[2].length).toBeLessThanOrEqual(160);
    expect(lines[2].endsWith("…")).toBe(true);
    expect(lines[3]).toBe("src/loop.ts: 1 error");
    expect(lines[4]).toBe("  L318 error TS2339: Property 'shaped' does not exist on type 'ToolResult'.");
    failureLinesSurvive(raw, r.text);
    expect(SHAPERS.find((s) => s.match(["tsc", "-p", "."]))?.id).toBe("tsc");
  });

  test("rg / grep: grouped by file, lines truncated at 160 chars, cap 40 files", async () => {
    const raw = await fixture("rg.txt");
    const r = shapeOutput(["rg", "-n", "spillToolResult"], raw, "", 0);
    expect(r.shaper).toBe("grep");
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.text).toContain("src/loop.ts (2)\n  9: import { spillToolResult }");
    expect(r.text).toContain("src/tool-results.ts (2)");
    expect(r.text).toContain("tests/tool-results.test.ts (3)");
    expect(r.text).toContain("CLAUDE.md (1)");
    const longest = r.text.split("\n").reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest.length).toBeLessThanOrEqual(160 + 8);
    expect(longest.endsWith("…")).toBe(true);
    const many = Array.from({ length: 50 }, (_, i) => [`src/module-${i}/index.ts:1:import { spillToolResult } from "../tool-results.ts";`, `src/module-${i}/index.ts:9:  await spillToolResult(ws, id, out, origin);`].join("\n")).join("\n");
    const capped = shapeOutput(["grep", "-rn", "spillToolResult", "src"], many, "", 0);
    expect(capped.shaper).toBe("grep");
    expect(capped.text).toContain("…[10 more files, 20 more matches]");
    expect(capped.text.split("\n").filter((l) => /^src\/module-\d+\/index\.ts \(2\)$/.test(l)).length).toBe(40);
  });

  test("find / ls: compact tree per directory with counters, cap 60 entries", async () => {
    const raw = await fixture("find.txt");
    const r = shapeOutput(["find", ".", "-name", "*"], raw, "", 0);
    expect(r.shaper).toBe("list");
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.text).toContain("src/ (9)");
    expect(r.text).toContain("  approval.ts argv.ts artifacts.ts");
    expect(r.text).toContain("tests/fixtures/shape/ (3)");
    const many = Array.from({ length: 80 }, (_, i) => `dir/file-${i}.txt`).join("\n");
    const capped = shapeOutput(["find", "dir"], many, "", 0);
    expect(capped.text).toContain("dir/ (80)");
    expect(capped.text).toContain("…[20 more entries]");
    const ls = shapeOutput(["ls", "-la"], ["total 8", "drwxr-xr-x  2 kev kev 4096 Sep  2 10:00 .", "-rw-r--r--  1 kev kev  120 Sep  2 10:00 a.txt", "-rw-r--r--  1 kev kev  120 Sep  2 10:00 b.txt", "lrwxrwxrwx  1 kev kev    5 Sep  2 10:00 c -> a.txt"].join("\n"), "", 0);
    expect(ls.shaper).toBe("list");
    expect(ls.text).toContain("./ (4)");
    expect(ls.text).toContain("./ a.txt b.txt c");
  });

  test("generic: strictly identical consecutive lines merge to `line ×N`; two different lines never merge", () => {
    const raw = ["boot", "tick", "tick", "tick", "tock", "tick", "", "", "done"].join("\n");
    const r = shapeOutput(["./daemon", "--verbose"], raw, "", 0);
    expect(r.shaper).toBe("generic");
    expect(r.text).toBe(["boot", "tick ×3", "tock", "tick", "", "", "done"].join("\n"));
    expect(r.savedChars).toBe(raw.length - r.text.length);
    const distinct = ["a", "b", "a", "b"].join("\n");
    const d = shapeOutput(["./daemon"], distinct, "", 0);
    expect(d.shaper).toBeUndefined();
    expect(d.text).toBe(distinct);
  });

  test("fail-open: exit ≠ 0 with no recognised failure line → raw, no shaper, savedChars 0", () => {
    const raw = ["tick", "tick", "tick", "something went wrong in a format nobody knows"].join("\n");
    const r = shapeOutput(["./daemon"], raw, "boom", 1);
    expect(r.shaper).toBeUndefined();
    expect(r.text).toBe(raw);
    expect(r.savedChars).toBe(0);
    expect(shapeOutput(["git", "status"], "", "fatal: not a git repository", 128)).toEqual({ text: "", savedChars: 0 });
    expect(shapeOutput(["bun", "test"], "tick\ntick\n", "", null).shaper).toBeUndefined();
    const withFailure = ["tick", "tick", "tick", "FAIL something"].join("\n");
    const f = shapeOutput(["./daemon"], withFailure, "", 1);
    expect(f.shaper).toBe("generic");
    expect(f.text).toContain("FAIL something");
  });

  test("a failure line is kept by every shaper, even where the shaper would drop it", async () => {
    const diff = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,300 +1,300 @@", ...Array.from({ length: 300 }, (_, i) => (i === 250 ? "+  expect FAIL: assertion broke" : `+line ${i}`))].join("\n");
    const d = shapeOutput(["git", "diff"], diff, "", 0);
    expect(d.text).toContain("…[");
    expect(d.text).toContain("+  expect FAIL: assertion broke");
    const list = ["src", "src/a.ts", "ERROR unreadable src/b.ts", "src/c.ts"].join("\n");
    const l = shapeOutput(["find", "src"], `${list}\n${Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`).join("\n")}`, "", 0);
    expect(l.text).toContain("ERROR unreadable src/b.ts");
    const generic = ["FAIL x", "FAIL x", "FAIL x", "ok"].join("\n");
    const g = shapeOutput(["./t"], generic, "", 1);
    expect(g.text).toContain("FAIL x ×3");
    failureLinesSurvive(generic, g.text);
    expect(isFailureLine("✗ test name")).toBe(true);
    expect(isFailureLine("Traceback (most recent call last):")).toBe(true);
    expect(isFailureLine("thread 'main' panicked at src/x.rs")).toBe(true);
    expect(isFailureLine("all good")).toBe(false);
  });

  test("a shaped text that is not shorter is discarded: raw, savedChars 0, no shaper", () => {
    const r = shapeOutput(["git", "status", "--porcelain"], " M a\n", "", 0);
    expect(r.shaper).toBeUndefined();
    expect(r.text).toBe(" M a\n");
    expect(r.savedChars).toBe(0);
    const short = shapeOutput(["ls"], "a\nb\n", "", 0);
    expect(short.shaper).toBeUndefined();
    expect(short.savedChars).toBe(0);
  });

  test("savedChars is raw.length - text.length and never negative; the shaper sees stdout only", () => {
    const raw = "x\nx\nx\n";
    const r = shapeOutput(["./t"], raw, "stderr FAIL line stays with the caller", 0);
    expect(r.text).toBe("x ×3\n");
    expect(r.savedChars).toBe(raw.length - r.text.length);
    expect(r.text).not.toContain("stderr");
    for (const s of SHAPERS) expect(typeof s.id).toBe("string");
  });
});
