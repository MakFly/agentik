import { dirname, posix } from "node:path";

/**
 * Pure chunking of a source file into declaration-sized pieces. No I/O, no sqlite: the index
 * (code-index.ts) feeds it text and stores what it returns — line ranges, the symbol a chunk
 * declares and the identifiers it mentions. The source text itself is never stored.
 *
 *   ts/js   top-level `export? (async)? function|class|const|let|var|interface|type|enum name`,
 *           `module.exports.name =` (CJS); the chunk starts at the comment/decorator block above
 *   python  top-level `class|def|async def` + indented methods (kind `method`)
 *   go      `func (recv)? Name`, `type Name struct|interface`
 *   rust    `pub? fn|struct|enum|impl|trait|mod|type|const|static Name`
 *   md      headings
 *   other   60-line windows with a 10-line overlap
 * A chunk longer than CHUNK_MAX_LINES is split.
 */

export type Lang = "ts" | "js" | "py" | "go" | "rs" | "md" | "other";

export interface Chunk {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  symbol: string;
  kind: string;
  exported: boolean;
  idents: string[];
}

export const CHUNK_MAX_LINES = 200;
export const WINDOW_LINES = 60;
export const WINDOW_OVERLAP = 10;
export const IDENTS_MAX = 400;

const EXT_LANG: Record<string, Lang> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py",
  go: "go",
  rs: "rs",
  md: "md", mdx: "md", markdown: "md",
};

export function detectLang(path: string): Lang {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && EXT_LANG[m[1].toLowerCase()]) || "other";
}

interface Decl {
  line: number; // 0-based
  symbol: string;
  kind: string;
  exported: boolean;
}

const TS_DECL =
  /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\s*\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_DEFAULT_ANON = /^export\s+default\s+(async\s+)?(function|class)\b/;
const CJS_EXPORT = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/;
const PY_TOP = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const PY_METHOD = /^ {4}(async\s+def|def)\s+([A-Za-z_]\w*)/;
const GO_FUNC = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/;
const RS_DECL = /^(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn|struct|enum|impl|trait|mod|type|const|static)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/;
const MD_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const COMMENT_OR_DECORATOR = /^\s*(\/\/|\/\*|\*|\*\/|#|@|\/\*\*)/;

function findDeclarations(lines: string[], lang: Lang): Decl[] {
  const out: Decl[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (lang === "ts" || lang === "js") {
      const m = TS_DECL.exec(l);
      if (m) {
        out.push({ line: i, symbol: m[7], kind: m[6].replace(/\s*\*$/, "").trim(), exported: Boolean(m[1]) });
        continue;
      }
      if (TS_DEFAULT_ANON.test(l)) {
        out.push({ line: i, symbol: "default", kind: /class/.test(l) ? "class" : "function", exported: true });
        continue;
      }
      const c = CJS_EXPORT.exec(l);
      if (c) out.push({ line: i, symbol: c[1], kind: "export", exported: true });
    } else if (lang === "py") {
      const m = PY_TOP.exec(l);
      if (m) {
        out.push({ line: i, symbol: m[2], kind: m[1] === "class" ? "class" : "function", exported: !m[2].startsWith("_") });
        continue;
      }
      const mm = PY_METHOD.exec(l);
      if (mm) out.push({ line: i, symbol: mm[2], kind: "method", exported: !mm[2].startsWith("_") });
    } else if (lang === "go") {
      const f = GO_FUNC.exec(l);
      if (f) {
        out.push({ line: i, symbol: f[1], kind: "function", exported: /^[A-Z]/.test(f[1]) });
        continue;
      }
      const t = GO_TYPE.exec(l);
      if (t) out.push({ line: i, symbol: t[1], kind: t[2], exported: /^[A-Z]/.test(t[1]) });
    } else if (lang === "rs") {
      const m = RS_DECL.exec(l);
      if (m) out.push({ line: i, symbol: m[3], kind: m[2], exported: Boolean(m[1]) });
    } else if (lang === "md") {
      const m = MD_HEADING.exec(l);
      if (m) out.push({ line: i, symbol: m[1].slice(0, 60), kind: "heading", exported: false });
    }
  }
  return out;
}

/** Walk back over the comment / decorator block that documents a declaration. */
function chunkStartFor(lines: string[], declLine: number, floor: number): number {
  let start = declLine;
  while (start - 1 >= floor && COMMENT_OR_DECORATOR.test(lines[start - 1]) && lines[start - 1].trim() !== "") start--;
  return start;
}

function isBlank(lines: string[], start: number, end: number): boolean {
  for (let i = start; i <= end; i++) if (lines[i].trim() !== "") return false;
  return true;
}

function windows(lines: string[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const step = WINDOW_LINES - WINDOW_OVERLAP;
  for (let s = 0; s < lines.length; s += step) {
    const e = Math.min(lines.length - 1, s + WINDOW_LINES - 1);
    out.push({ start: s, end: e });
    if (e === lines.length - 1) break;
  }
  return out;
}

export function chunkFile(path: string, text: string, lang: Lang = detectLang(path)): Chunk[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  const decls = findDeclarations(lines, lang);
  const pieces: Array<{ start: number; end: number; symbol: string; kind: string; exported: boolean }> = [];
  if (decls.length === 0) {
    for (const w of windows(lines)) pieces.push({ ...w, symbol: "", kind: "window", exported: false });
  } else {
    // Declaration i owns [its comment block .. the line before declaration i+1's comment block].
    const starts = decls.map((d, i) => chunkStartFor(lines, d.line, i === 0 ? 0 : decls[i - 1].line + 1));
    if (starts[0] > 0 && !isBlank(lines, 0, starts[0] - 1)) {
      pieces.push({ start: 0, end: starts[0] - 1, symbol: "", kind: "head", exported: false });
    }
    for (let i = 0; i < decls.length; i++) {
      const end = i + 1 < decls.length ? starts[i + 1] - 1 : lines.length - 1;
      if (end < starts[i]) continue;
      pieces.push({ start: starts[i], end, symbol: decls[i].symbol, kind: decls[i].kind, exported: decls[i].exported });
    }
  }
  const out: Chunk[] = [];
  for (const p of pieces) {
    for (let s = p.start; s <= p.end; s += CHUNK_MAX_LINES) {
      const e = Math.min(p.end, s + CHUNK_MAX_LINES - 1);
      if (isBlank(lines, s, e)) continue;
      out.push({
        start: s + 1,
        end: e + 1,
        symbol: p.symbol,
        kind: p.kind,
        exported: p.exported,
        idents: extractIdents(lines.slice(s, e + 1).join("\n")),
      });
    }
  }
  return out;
}

const IDENT_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** `getHTTPResponseCode` → get, HTTP, Response, Code ; `snake_case` → snake, case. */
export function splitIdent(word: string): string[] {
  return word
    .split(/[_$]+/)
    .flatMap((w) => w.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u))
    .filter((w) => w.length > 0);
}

/** Identifiers of a text plus their camel/snake parts, deduplicated, at most IDENTS_MAX. */
export function extractIdents(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (w: string) => {
    if (w.length < 2 || seen.has(w)) return;
    seen.add(w);
    out.push(w);
  };
  for (const m of text.matchAll(IDENT_RE)) {
    const word = m[0];
    push(word);
    const parts = splitIdent(word);
    if (parts.length > 1) for (const p of parts) push(p);
    if (out.length >= IDENTS_MAX) break;
  }
  return out.slice(0, IDENTS_MAX);
}

const TS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/gm;
const TS_EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

function resolveTs(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;
  const base = posix.normalize(posix.join(dirname(from), spec));
  const stems = [base, base.replace(/\.(js|mjs|cjs|jsx)$/, ".ts"), base.replace(/\.js$/, ".tsx")];
  for (const stem of stems) for (const ext of TS_EXTS) if (known.has(stem + ext)) return stem + ext;
  return undefined;
}

function resolvePy(from: string, mod: string, known: Set<string>): string | undefined {
  let dir = dirname(from);
  let name = mod;
  const dots = /^\.+/.exec(mod)?.[0].length ?? 0;
  if (dots > 0) {
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    name = mod.slice(dots);
  } else {
    dir = ".";
  }
  const rel = name.replace(/\./g, "/");
  const cands = rel ? [posix.join(dir, `${rel}.py`), posix.join(dir, rel, "__init__.py")] : [posix.join(dir, "__init__.py")];
  for (const c of cands) {
    const n = posix.normalize(c);
    if (known.has(n)) return n;
  }
  return undefined;
}

/** Repository-relative paths this file imports, resolved against `known` (the indexed paths). */
export function extractImports(path: string, text: string, lang: Lang, known: Set<string>): string[] {
  const out = new Set<string>();
  if (lang === "ts" || lang === "js") {
    for (const m of text.matchAll(TS_IMPORT)) {
      const hit = resolveTs(path, m[1], known);
      if (hit && hit !== path) out.add(hit);
    }
  } else if (lang === "py") {
    for (const m of text.matchAll(PY_IMPORT)) {
      const hit = resolvePy(path, m[1] ?? m[2], known);
      if (hit && hit !== path) out.add(hit);
    }
  }
  return [...out];
}
