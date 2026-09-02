/**
 * Output shaping for `run_command` — the "rtk" (Rust Token Killer) idea, in-process and pure.
 *
 * A worker that runs `git status`, `bun test` or `rg` pays for every line of the output on every
 * following model call. Most of those lines carry nothing the model acts on: 400 `(pass)` lines,
 * the `index …` headers of a diff, the same log line 800 times. A shaper rewrites the STDOUT of a
 * recognised command into a shorter text; the raw output always stays on disk (`tool-results.ts`).
 *
 * Hard rules, in this order:
 *   - a shaper sees stdout only; the `exit N` line and stderr are the caller's, byte for byte;
 *   - a line that reads as a failure (`FAILURE_LINE_RE`) is always kept — a shaper that drops one
 *     gets it appended back by `shapeOutput`;
 *   - fail-open: a non-zero exit whose stdout holds no failure line is returned raw — an unknown
 *     failure format is never compressed;
 *   - a shaped text that is not shorter is discarded; `savedChars` is never negative.
 */

export interface ShapeResult {
  text: string;
  savedChars: number;
  shaper?: string;
}

export interface Shaper {
  id: string;
  match(argv: string[]): boolean;
  /** Returns undefined when the output is not in the expected format (→ raw). */
  shape(stdout: string, exitCode: number | null, argv: string[]): string | undefined;
}

/**
 * A line matching this is a failure and survives every shaper. `\b` does not work next to a
 * symbol, so the marks (`✗`, `×`, `(fail)`) are matched bare.
 */
export const FAILURE_LINE_RE = /\b(FAIL|FAILED|ERROR|error TS\d+|panicked|Traceback|AssertionError)\b|✗|×|\(fail\)/;

export const LINE_MAX = 160;
export const DIFF_LINE_CAP = 200;
export const GREP_FILE_CAP = 40;
export const LIST_ENTRY_CAP = 60;
export const GROUP_PATH_CAP = 40;

export function isFailureLine(line: string): boolean {
  return FAILURE_LINE_RE.test(line);
}

/** Truncate a line to `max` chars; a failure line is never cut. */
function clip(line: string, max = LINE_MAX): string {
  if (line.length <= max || isFailureLine(line)) return line;
  return `${line.slice(0, max - 1)}…`;
}

function clipHard(line: string, max = LINE_MAX): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function splitLines(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/\r$/, ""));
}

function base(argv: string[]): string {
  const b = argv[0] ?? "";
  const i = b.lastIndexOf("/");
  return i >= 0 ? b.slice(i + 1) : b;
}

/** `git -C dir status --short` → `status`. */
function gitSubcommand(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

function isGit(argv: string[], sub: string): boolean {
  return base(argv) === "git" && gitSubcommand(argv) === sub;
}

/** `bunx tsc`, `npx vitest`, `bun x jest` → the wrapped binary. */
function unwrapRunner(argv: string[]): string[] {
  const b = base(argv);
  if ((b === "bunx" || b === "npx" || b === "pnpx") && argv.length > 1) return unwrapRunner(argv.slice(1));
  if (b === "bun" && argv[1] === "x" && argv.length > 2) return unwrapRunner(argv.slice(2));
  if ((b === "python" || b === "python3") && argv[1] === "-m" && argv.length > 2) return unwrapRunner(argv.slice(2));
  return argv;
}

// ───────────────────────────────────────── git status ─────────────────────────────────────────

const STATUS_ORDER = ["modified", "added", "deleted", "renamed", "copied", "conflicted", "untracked", "ignored"];

function statusFromXY(x: string, y: string): string {
  if (x === "?" || y === "?") return "untracked";
  if (x === "!" || y === "!") return "ignored";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "D" || y === "D") return "deleted";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

const LONG_KEYWORDS: Record<string, string> = {
  modified: "modified",
  "new file": "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  typechange: "modified",
  "both modified": "conflicted",
  "both added": "conflicted",
  "both deleted": "conflicted",
  "added by us": "conflicted",
  "added by them": "conflicted",
  "deleted by us": "conflicted",
  "deleted by them": "conflicted",
};

function shapeGitStatus(stdout: string): string | undefined {
  const groups = new Map<string, string[]>();
  const keep: string[] = [];
  let section: "staged" | "unstaged" | "untracked" | "unmerged" | undefined;
  let recognised = false;
  const add = (g: string, p: string) => {
    const list = groups.get(g) ?? [];
    list.push(p);
    groups.set(g, list);
    recognised = true;
  };
  for (const line of splitLines(stdout)) {
    if (!line.trim()) continue;
    if (/^## /.test(line) || /^(On branch |HEAD detached|Your branch|nothing to commit|no changes added|nothing added to commit|Unmerged paths|You have unmerged|All conflicts fixed)/.test(line)) {
      keep.push(line.replace(/^## /, "branch "));
      recognised = true;
      if (line.startsWith("Unmerged paths")) section = "unmerged";
      continue;
    }
    const por = /^([ MADRCU?!])([ MADRCU?!]) (.+)$/.exec(line);
    if (por) {
      add(statusFromXY(por[1], por[2]), por[3]);
      continue;
    }
    if (/^Changes to be committed:/.test(line)) {
      section = "staged";
      continue;
    }
    if (/^Changes not staged for commit:/.test(line)) {
      section = "unstaged";
      continue;
    }
    if (/^Untracked files:/.test(line)) {
      section = "untracked";
      continue;
    }
    if (/^Ignored files:/.test(line)) {
      section = "untracked";
      continue;
    }
    if (line.startsWith("\t")) {
      const body = line.slice(1);
      const kw = /^([a-z ]+?):\s+(.+)$/.exec(body);
      if (kw && LONG_KEYWORDS[kw[1]]) {
        add(LONG_KEYWORDS[kw[1]], kw[2]);
        continue;
      }
      if (section === "untracked") add("untracked", body);
      continue;
    }
    // hints "(use "git add <file>..." …)" and anything else: dropped
  }
  if (!recognised) return undefined;
  const out = [...keep];
  const ordered = [...groups.keys()].sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b));
  for (const g of ordered) {
    const paths = groups.get(g)!;
    const shown = paths.slice(0, GROUP_PATH_CAP);
    out.push(`${g} (${paths.length}): ${shown.join(" ")}${paths.length > shown.length ? ` +${paths.length - shown.length} more` : ""}`);
  }
  return out.join("\n");
}

// ───────────────────────────────────────── git diff ─────────────────────────────────────────

const DIFF_HEADER_RE = /^(index [0-9a-f]+\.\.[0-9a-f]+|new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files)/;

function shapeGitDiff(stdout: string): string | undefined {
  const out: string[] = [];
  let seenHeader = false;
  let inHunk = false;
  for (const line of splitLines(stdout)) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      out.push(`### ${m ? m[2] : line.slice("diff --git ".length)}`);
      seenHeader = true;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) inHunk = true;
    if (!inHunk && (DIFF_HEADER_RE.test(line) || /^(--- |\+\+\+ )/.test(line))) continue;
    out.push(line);
  }
  if (!seenHeader) return undefined;
  while (out.length && out[out.length - 1] === "") out.pop();
  if (out.length > DIFF_LINE_CAP) {
    const omitted = out.length - DIFF_LINE_CAP;
    return [...out.slice(0, DIFF_LINE_CAP), `…[${omitted} lines omitted]`].join("\n");
  }
  return out.join("\n");
}

// ───────────────────────────────────────── git log ─────────────────────────────────────────

function shapeGitLog(stdout: string): string | undefined {
  const out: string[] = [];
  let hash: string | undefined;
  let subject: string | undefined;
  const flush = () => {
    if (hash) out.push(`${hash.slice(0, 7)} ${subject ?? "(no subject)"}`);
    hash = undefined;
    subject = undefined;
  };
  for (const line of splitLines(stdout)) {
    const c = /^commit ([0-9a-f]{7,40})\b/.exec(line);
    if (c) {
      flush();
      hash = c[1];
      continue;
    }
    if (!hash) continue;
    if (/^(Author|Date|Merge|AuthorDate|Commit|CommitDate|Reflog|Notes):/.test(line) || !line.trim()) continue;
    if (subject === undefined && /^ {4}\S/.test(line)) subject = line.trim();
  }
  flush();
  return out.length ? out.join("\n") : undefined;
}

// ───────────────────────────────────────── test runners ─────────────────────────────────────────

const TEST_RUNNERS = new Set(["vitest", "jest", "pytest", "mocha", "ava", "tap"]);

function isTestRunner(argv: string[]): boolean {
  const a = unwrapRunner(argv);
  const b = base(a);
  if (TEST_RUNNERS.has(b)) return true;
  if (b === "bun" && a[1] === "test") return true;
  if ((b === "npm" || b === "pnpm" || b === "yarn") && (a[1] === "test" || a[1] === "t" || (a[1] === "run" && a[2] === "test"))) return true;
  if ((b === "go" || b === "cargo") && a[1] === "test") return true;
  return false;
}

const PASS_RE = /^\s*(\(pass\)|✓|✔|√|PASS\b|--- PASS:|ok\s|.*\.\.\. ok$|.*\bPASSED(\s+\[\s*\d+%\])?$)/;
const SKIP_RE = /^\s*(\(skip\)|\(todo\)|↓|○|SKIP\b|--- SKIP:|.*\.\.\. ignored$|.*\bSKIPPED$)/;
const RUNNER_FAIL_RE = /^\s*(--- FAIL:|✕|.*\.\.\. FAILED$)/;
const SUMMARY_RE = /^\s*(\d+ (pass|fail|skip|todo|error|expect\(\) calls)\b|Ran \d+ tests?|Tests?:|Test Suites:|Test Files|Snapshots:|Time:|Duration|Start at|=+ .*(passed|failed|error|no tests ran).* =+|test result:|running \d+ tests?|\d+ (passed|failed|skipped)\b|FAIL\b|ok\b|PASS\b|panic|--- FAIL)/;
const CONTEXT_RE = /^\s*(error:|Error:|Error\b|Expected|Received|expect\(|\^+\s*$|assert|[-+] |\d+ \| |at |E\s{3}|>\s{3}|File "|\S+\.(go|rs|py|ts|js|tsx|jsx|mjs|cjs):\d+|Error Trace|panic:|goroutine|thread '|left:|right:|note:|AssertionError|Traceback|\w+Error\b|Difference:|Snapshot|Message:|Stack:)/;
const PYTEST_PROGRESS_RE = /^\S+\.py\s+([.FsxE]+)(\s+\[\s*\d+%\])?$/;
const FILE_HEADING_RE = /^\S*[./]\S*:$/;

function shapeTestRun(stdout: string): string | undefined {
  const lines = splitLines(stdout);
  const out: string[] = [];
  let passed = 0;
  let skipped = 0;
  let failures = 0;
  let passSlot = -1;
  let window = 0;
  let stack = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const prog = PYTEST_PROGRESS_RE.exec(line);
    if (prog) {
      const marks = prog[1];
      passed += (marks.match(/\./g) ?? []).length;
      skipped += (marks.match(/[sx]/g) ?? []).length;
      if (/[FE]/.test(marks)) out.push(line);
      if (passSlot < 0) passSlot = out.length;
      continue;
    }
    if (isFailureLine(line) || RUNNER_FAIL_RE.test(line)) {
      failures += 1;
      window = 5;
      stack = 0;
      out.push(line);
      continue;
    }
    if (PASS_RE.test(line) && !SUMMARY_RE.test(line.replace(PASS_RE, "x"))) {
      passed += 1;
      if (passSlot < 0) passSlot = out.length;
      continue;
    }
    if (SKIP_RE.test(line)) {
      skipped += 1;
      continue;
    }
    if (SUMMARY_RE.test(line)) {
      out.push(line);
      continue;
    }
    if (/^\s*at /.test(line)) {
      stack += 1;
      if (stack <= 5) out.push(line);
      continue;
    }
    stack = 0;
    if (CONTEXT_RE.test(line) || FILE_HEADING_RE.test(line)) {
      out.push(line);
      continue;
    }
    if (window > 0) {
      window -= 1;
      out.push(line);
    }
  }
  if (passed === 0 && failures === 0 && skipped === 0) return undefined;
  if (passed > 0 || skipped > 0) {
    const bits = [`${passed} passed`];
    if (skipped > 0) bits.push(`${skipped} skipped`);
    out.splice(passSlot < 0 ? 0 : passSlot, 0, bits.join(", "));
  }
  return out.join("\n");
}

// ───────────────────────────────────────── tsc ─────────────────────────────────────────

function isTsc(argv: string[]): boolean {
  const a = unwrapRunner(argv);
  return base(a) === "tsc" || (base(a) === "bun" && a[1] === "tsc");
}

const TSC_PLAIN_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const TSC_PRETTY_RE = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;

function shapeTsc(stdout: string): string | undefined {
  const files = new Map<string, string[]>();
  const tail: string[] = [];
  for (const line of splitLines(stdout)) {
    const m = TSC_PLAIN_RE.exec(line) ?? TSC_PRETTY_RE.exec(line);
    if (m) {
      const list = files.get(m[1]) ?? [];
      list.push(clipHard(`  L${m[2]} ${m[4]} ${m[5]}: ${m[6]}`));
      files.set(m[1], list);
      continue;
    }
    if (/^Found \d+ error/.test(line) || /^error TS\d+:/.test(line)) tail.push(line);
  }
  if (!files.size && !tail.length) return undefined;
  const out: string[] = [];
  for (const [file, list] of files) {
    out.push(`${file}: ${list.length} error${list.length === 1 ? "" : "s"}`, ...list);
  }
  out.push(...tail);
  return out.join("\n");
}

// ───────────────────────────────────────── rg / grep ─────────────────────────────────────────

const GREP_BINS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);

function looksLikePath(s: string): boolean {
  return s.length > 0 && !/\s/.test(s) && /[./]/.test(s) && !/^\d+$/.test(s);
}

function shapeGrep(stdout: string): string | undefined {
  const files = new Map<string, string[]>();
  const counts = new Map<string, number>();
  let current: string | undefined;
  let parsed = 0;
  let total = 0;
  const push = (file: string, entry: string) => {
    const list = files.get(file) ?? [];
    list.push(entry);
    files.set(file, list);
    parsed += 1;
  };
  for (const line of splitLines(stdout)) {
    if (!line.trim() || line === "--") continue;
    total += 1;
    const m = /^(.+?)[:-](\d+)[:-](.*)$/.exec(line);
    if (m && looksLikePath(m[1])) {
      push(m[1], `${m[2]}: ${clip(m[3])}`);
      current = m[1];
      continue;
    }
    const c = /^(.+?):(\d+)$/.exec(line);
    if (c && looksLikePath(c[1])) {
      counts.set(c[1], Number(c[2]));
      if (!files.has(c[1])) files.set(c[1], []);
      parsed += 1;
      continue;
    }
    const h = /^(\d+)[:-](.*)$/.exec(line);
    if (h && current) {
      push(current, `${h[1]}: ${clip(h[2])}`);
      continue;
    }
    if (looksLikePath(line) && !line.includes(":")) {
      current = line;
      if (!files.has(line)) files.set(line, []);
      parsed += 1;
      continue;
    }
    if (current) push(current, clip(line));
  }
  if (!files.size || parsed * 2 < total) return undefined;
  const out: string[] = [];
  let shown = 0;
  let omittedFiles = 0;
  let omittedMatches = 0;
  for (const [file, list] of files) {
    if (shown >= GREP_FILE_CAP) {
      omittedFiles += 1;
      omittedMatches += list.length;
      continue;
    }
    shown += 1;
    const n = counts.get(file);
    out.push(list.length ? `${file} (${list.length})` : n !== undefined ? `${file} (${n} matches)` : file, ...list.map((e) => `  ${e}`));
  }
  if (omittedFiles) out.push(`…[${omittedFiles} more files, ${omittedMatches} more matches]`);
  // failure lines of the omitted files come back through shapeOutput
  return out.join("\n");
}

// ───────────────────────────────────────── ls / find ─────────────────────────────────────────

const LIST_BINS = new Set(["ls", "find", "fd", "fdfind"]);
const LONG_RE = /^([-dlcbps])[rwxsStT-]{9}[+@.]?\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+(.+)$/;

function shapeList(stdout: string, _exit: number | null, argv: string[]): string | undefined {
  const groups = new Map<string, string[]>();
  let currentDir: string | undefined;
  let entries = 0;
  const isFind = base(argv) !== "ls";
  for (const line of splitLines(stdout)) {
    if (!line.trim()) continue;
    if (/^total \d+$/.test(line)) continue;
    const hdr = /^(.+):$/.exec(line);
    if (hdr && !isFind && !line.includes(" ")) {
      currentDir = hdr[1];
      if (!groups.has(currentDir)) groups.set(currentDir, []);
      continue;
    }
    let name = line;
    let dirMark = "";
    const long = LONG_RE.exec(line);
    if (long) {
      name = long[2].replace(/ -> .*$/, "");
      if (long[1] === "d") dirMark = "/";
    }
    let dir: string;
    if (currentDir !== undefined) dir = currentDir;
    else if (isFind || name.includes("/")) {
      const i = name.lastIndexOf("/");
      dir = i > 0 ? name.slice(0, i) : i === 0 ? "/" : ".";
      name = i >= 0 ? name.slice(i + 1) : name;
      if (!name) {
        dir = ".";
        name = long ? long[2] : line;
      }
    } else dir = ".";
    const list = groups.get(dir) ?? [];
    list.push(`${name}${dirMark}`);
    groups.set(dir, list);
    entries += 1;
  }
  if (!entries) return undefined;
  const out: string[] = [];
  let shown = 0;
  let omitted = 0;
  for (const [dir, names] of groups) {
    if (shown >= LIST_ENTRY_CAP) {
      omitted += names.length;
      continue;
    }
    const room = LIST_ENTRY_CAP - shown;
    const take = names.slice(0, room);
    shown += take.length;
    omitted += names.length - take.length;
    out.push(`${dir}/ (${names.length})`);
    let row = " ";
    for (const n of take) {
      if (row.length + n.length + 2 > 100 && row.trim()) {
        out.push(row);
        row = " ";
      }
      row += ` ${n}`;
    }
    if (row.trim()) out.push(row);
  }
  if (omitted) out.push(`…[${omitted} more entries]`);
  return out.join("\n");
}

// ───────────────────────────────────────── generic ─────────────────────────────────────────

/** Strictly identical consecutive lines become `line ×N`; two different lines never merge. */
function shapeGeneric(stdout: string): string | undefined {
  const lines = stdout.split("\n");
  const out: string[] = [];
  let prev: string | undefined;
  let count = 0;
  let merged = false;
  const flush = () => {
    if (prev === undefined) return;
    if (count > 1) {
      out.push(`${prev} ×${count}`);
      merged = true;
    } else out.push(prev);
  };
  for (const line of lines) {
    if (line === prev && line.trim() !== "") {
      count += 1;
      continue;
    }
    flush();
    prev = line;
    count = 1;
  }
  flush();
  return merged ? out.join("\n") : undefined;
}

// ───────────────────────────────────────── table ─────────────────────────────────────────

export const SHAPERS: Shaper[] = [
  { id: "git-status", match: (argv) => isGit(argv, "status"), shape: shapeGitStatus },
  { id: "git-diff", match: (argv) => isGit(argv, "diff"), shape: shapeGitDiff },
  { id: "git-log", match: (argv) => isGit(argv, "log") && !argv.includes("--oneline"), shape: shapeGitLog },
  { id: "test-runner", match: isTestRunner, shape: shapeTestRun },
  { id: "tsc", match: isTsc, shape: shapeTsc },
  { id: "grep", match: (argv) => GREP_BINS.has(base(argv)), shape: shapeGrep },
  { id: "list", match: (argv) => LIST_BINS.has(base(argv)), shape: shapeList },
  { id: "generic", match: () => true, shape: shapeGeneric },
];

/** Every raw failure line must be in the shaped text (verbatim, or its match + 40 chars of tail). */
function keepFailureLines(shaped: string, raw: string): string {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || seen.has(t) || !isFailureLine(line)) continue;
    seen.add(t);
    if (shaped.includes(t)) continue;
    const m = FAILURE_LINE_RE.exec(line)!;
    const key = line.slice(m.index, m.index + m[0].length + 40).trim();
    if (shaped.includes(key)) continue;
    missing.push(line);
  }
  if (!missing.length) return shaped;
  return `${shaped}\n[failure lines kept from the raw output]\n${missing.join("\n")}`;
}

/**
 * Shape the stdout of `argv`. `stderr` is accepted for symmetry with the tool and never shaped:
 * the caller appends it verbatim. `exitCode` null = killed / timed out (treated as a failure).
 */
export function shapeOutput(argv: string[], stdout: string, stderr: string, exitCode: number | null): ShapeResult {
  void stderr;
  const raw = stdout;
  const asRaw: ShapeResult = { text: raw, savedChars: 0 };
  const shaper = SHAPERS.find((s) => s.match(argv));
  if (!shaper) return asRaw;
  const hasFailure = raw.split("\n").some(isFailureLine);
  if (exitCode !== 0 && !hasFailure) return asRaw;
  let shaped: string | undefined;
  try {
    shaped = shaper.shape(raw, exitCode, argv);
  } catch {
    return asRaw;
  }
  if (shaped === undefined) return asRaw;
  shaped = keepFailureLines(shaped, raw);
  if (shaped.length >= raw.length) return asRaw;
  return { text: shaped, savedChars: raw.length - shaped.length, shaper: shaper.id };
}
