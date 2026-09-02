import { describe, expect, test } from "bun:test";
import { CHUNK_MAX_LINES, chunkFile, detectLang, extractIdents, extractImports, splitIdent, WINDOW_LINES, WINDOW_OVERLAP } from "../src/code-chunker.ts";

describe("code chunker", () => {
  test("detectLang by extension", () => {
    expect(detectLang("src/a.ts")).toBe("ts");
    expect(detectLang("a.tsx")).toBe("ts");
    expect(detectLang("a.mjs")).toBe("js");
    expect(detectLang("x/y.py")).toBe("py");
    expect(detectLang("main.go")).toBe("go");
    expect(detectLang("lib.rs")).toBe("rs");
    expect(detectLang("README.md")).toBe("md");
    expect(detectLang("Makefile")).toBe("other");
  });

  test("ts declarations own their leading JSDoc; head chunk keeps the imports", () => {
    const text = [
      'import { x } from "./x.ts";',
      "",
      "/**",
      " * Adds.",
      " */",
      "export function add(a: number, b: number) {",
      "  return a + b;",
      "}",
      "",
      "const hidden = 1;",
      "",
      "export default async function main() {}",
      "export class Store {}",
      "module.exports.legacy = 1;",
    ].join("\n");
    const chunks = chunkFile("src/a.ts", text);
    expect(chunks.map((c) => [c.symbol, c.kind, c.exported, c.start, c.end])).toEqual([
      ["", "head", false, 1, 2],
      ["add", "function", true, 3, 9],
      ["hidden", "const", false, 10, 11],
      ["main", "function", true, 12, 12],
      ["Store", "class", true, 13, 13],
      ["legacy", "export", true, 14, 14],
    ]);
    expect(chunks[1].idents).toContain("add");
  });

  test("python: top-level defs and classes, indented methods, private names not exported", () => {
    const text = ["class Foo:", "    def bar(self):", "        pass", "", "    def _hidden(self):", "        pass", "", "def top():", "    pass"].join("\n");
    const chunks = chunkFile("m.py", text);
    expect(chunks.map((c) => [c.symbol, c.kind, c.exported])).toEqual([
      ["Foo", "class", true],
      ["bar", "method", true],
      ["_hidden", "method", false],
      ["top", "function", true],
    ]);
  });

  test("go and rust", () => {
    const go = chunkFile("a.go", ["package a", "", "func (r *T) Name() {}", "func helper() {}", "type Thing struct {}"].join("\n"));
    expect(go.map((c) => [c.symbol, c.exported])).toEqual([
      ["", false],
      ["Name", true],
      ["helper", false],
      ["Thing", true],
    ]);
    const rs = chunkFile("a.rs", ["pub fn run() {}", "fn inner() {}", "pub(crate) struct S;", "impl S {}"].join("\n"));
    expect(rs.map((c) => [c.symbol, c.kind, c.exported])).toEqual([
      ["run", "fn", true],
      ["inner", "fn", false],
      ["S", "struct", true],
      ["S", "impl", false],
    ]);
  });

  test("markdown by heading", () => {
    const chunks = chunkFile("R.md", ["intro", "# Title", "text", "## Sub", "more"].join("\n"));
    expect(chunks.map((c) => c.symbol)).toEqual(["", "Title", "Sub"]);
    expect(chunks[1].kind).toBe("heading");
  });

  test("no declaration → 60-line windows with a 10-line overlap; a long chunk is split at 200", () => {
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`);
    const w = chunkFile("data.txt", lines.join("\n"));
    expect(w.map((c) => [c.start, c.end])).toEqual([
      [1, WINDOW_LINES],
      [WINDOW_LINES - WINDOW_OVERLAP + 1, 2 * WINDOW_LINES - WINDOW_OVERLAP],
      [2 * (WINDOW_LINES - WINDOW_OVERLAP) + 1, 130],
    ]);
    expect(w.every((c) => c.kind === "window")).toBe(true);
    const big = ["export function huge() {", ...Array.from({ length: 450 }, (_, i) => `  x${i};`), "}"].join("\n");
    const chunks = chunkFile("b.ts", big);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.end - c.start + 1 <= CHUNK_MAX_LINES)).toBe(true);
    expect(chunks.every((c) => c.symbol === "huge")).toBe(true);
  });

  test("splitIdent / extractIdents", () => {
    expect(splitIdent("getHTTPResponseCode")).toEqual(["get", "HTTP", "Response", "Code"]);
    expect(splitIdent("resolveWorkspaceRoot")).toEqual(["resolve", "Workspace", "Root"]);
    expect(splitIdent("snake_case_name")).toEqual(["snake", "case", "name"]);
    const idents = extractIdents("const resolveWorkspaceRoot = memoryPaths(x); resolveWorkspaceRoot();");
    expect(idents).toContain("resolveWorkspaceRoot");
    expect(idents).toContain("Workspace");
    expect(idents.filter((i) => i === "resolveWorkspaceRoot").length).toBe(1);
    expect(idents).not.toContain("x");
  });

  test("imports resolve relative specifiers against the known paths; bare ones are dropped", () => {
    const known = new Set(["src/a.ts", "src/b.ts", "src/lib/index.ts", "pkg/mod.py", "pkg/__init__.py"]);
    const ts = extractImports("src/a.ts", 'import { b } from "./b.js";\nimport lib from "./lib";\nimport x from "bun:sqlite";\nconst c = require("./missing");', "ts", known);
    expect(ts.sort()).toEqual(["src/b.ts", "src/lib/index.ts"]);
    const py = extractImports("pkg/other.py", "from .mod import x\nimport os\nfrom pkg import y", "py", known);
    expect(py.sort()).toEqual(["pkg/__init__.py", "pkg/mod.py"]);
  });
});
