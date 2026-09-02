import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Git hooks that refresh the code index — installed, removed and inspected idempotently,
 * reversibly and inertly. Four hooks fire after the working tree moved: post-commit,
 * post-checkout, post-merge, post-rewrite. Each gets ONE marked block appended (never a
 * rewrite of what a project already has); `removeHooks` takes that block out byte for byte.
 *
 * Why every piece of the block is there (POSIX sh, no bashism):
 *
 *   AGENTIK_BIN="<abs path>" … || AGENTIK_BIN="$(command -v agentik …)"
 *       The absolute path is frozen at install time because an IDE or a GUI client runs git
 *       with a minimal PATH where `agentik` is not resolvable; `command -v agentik` is only
 *       the fallback when that binary moved.
 *   [ -n "$AGENTIK_BIN" ] && …
 *       No binary → the hook is a no-op, never an error: a commit must never fail because
 *       agentik is not installed any more.
 *   (unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX; … )
 *       `git commit <paths>` exports a TEMPORARY `GIT_INDEX_FILE` while the hook runs; a
 *       detached process that inherits it would read a file that no longer exists. GIT_DIR /
 *       GIT_WORK_TREE / GIT_PREFIX would likewise pin the child to git's view of THIS
 *       invocation instead of the checkout it resolves itself.
 *   --if-present
 *       `git worktree add` fires post-checkout in a brand-new checkout; a hook must never
 *       start a full index build in the background — only refresh an index that exists.
 *   --workspace "$(git rev-parse --show-toplevel)"
 *       The checkout that moved, resolved by git (a linked worktree has its own tree and
 *       its own index, while its hooks live in the main checkout's .git/hooks).
 *   </dev/null
 *       post-rewrite receives the rewritten shas on stdin; the child must not inherit (and
 *       hold open) that pipe.
 *   >/dev/null 2>&1 &  inside ( … )
 *       Detached: the subshell backgrounds the child and exits at once, so a commit never
 *       waits for the index, and git never blocks on a stdout pipe held by the child.
 *
 * No recursion is possible: `agentik index` only runs rev-parse / ls-files / status /
 * check-ignore / config, none of which fires a hook.
 *
 * Refusals (never a write): a repository with `core.hooksPath` set at any scope (a husky /
 * lefthook / pre-commit setup owns that directory — manage it yourself), a directory that is
 * not a git checkout, a hook with a non-shell interpreter, a hook that `exec`s another runner
 * before our block would be reached.
 */

export type HookName = "post-commit" | "post-checkout" | "post-merge" | "post-rewrite";

export const HOOK_NAMES: readonly HookName[] = ["post-commit", "post-checkout", "post-merge", "post-rewrite"];

export const HOOK_MARK_BEGIN = "# >>> agentik-index (agentik index --unhook removes this block)";
export const HOOK_MARK_END = "# <<< agentik-index";

const SHELL_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ash"]);
const BIN_LINE = /^AGENTIK_BIN="((?:[^"\\]|\\.)*)"/m;

export interface HookState {
  name: HookName;
  present: boolean;
  hooked: boolean;
  executable: boolean;
  foreign: boolean;
}

export interface InstallResult {
  hooksDir?: string;
  installed: HookName[];
  kept: HookName[];
  skipped: { name: HookName; why: string }[];
  refused?: string;
}

export interface RemoveResult {
  hooksDir?: string;
  removed: HookName[];
  deleted: HookName[];
  refused?: string;
}

export interface HookStatus {
  hooksDir?: string;
  refused?: string;
  bin?: string;
  binaryMissing?: boolean;
  hooks: HookState[];
}

/** Escape a path for a double-quoted POSIX sh string (`\`, `"`, `$` and the backquote). */
function shQuote(s: string): string {
  return s.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

function shUnquote(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** The complete marked block, terminated by "\n". */
export function hookBlock(bin: string): string {
  return [
    HOOK_MARK_BEGIN,
    `AGENTIK_BIN="${shQuote(bin)}"; command -v "$AGENTIK_BIN" >/dev/null 2>&1 || AGENTIK_BIN="$(command -v agentik 2>/dev/null)"`,
    '[ -n "$AGENTIK_BIN" ] && (unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX; exec "$AGENTIK_BIN" index --quiet --if-present --workspace "$(git rev-parse --show-toplevel)" </dev/null >/dev/null 2>&1 &)',
    HOOK_MARK_END,
    "",
  ].join("\n");
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    return { ok: res.exitCode === 0, out: res.stdout.toString().trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * Where the hooks of this checkout live. A linked worktree resolves to the main checkout's
 * `.git/hooks` (git ≥ 2.31, `--path-format=absolute`). `core.hooksPath` at ANY scope (local,
 * global, system) is a refusal: that directory belongs to another hook manager.
 */
export function hookPaths(workspace: string): { hooksDir: string } | { refused: string } {
  const top = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], workspace);
  if (!top.ok || top.out === "") return { refused: `${workspace} is not a git checkout` };
  const custom = git(["config", "--get", "core.hooksPath"], workspace);
  if (custom.ok && custom.out !== "") return { refused: `core.hooksPath is set (${custom.out}): manage that hook yourself` };
  return { hooksDir: top.out };
}

function defaultBin(): string {
  return resolve(Bun.which("agentik") ?? process.argv[1]);
}

function isHooked(body: string): boolean {
  return blockRange(body) !== undefined;
}

/** Line indexes [begin, end] of the marked block, or undefined when either marker is absent. */
function blockRange(body: string): { lines: string[]; begin: number; end: number } | undefined {
  const lines = body.split("\n");
  const begin = lines.indexOf(HOOK_MARK_BEGIN);
  if (begin < 0) return undefined;
  const end = lines.indexOf(HOOK_MARK_END, begin + 1);
  if (end < 0) return undefined;
  return { lines, begin, end };
}

/** `undefined` when the interpreter is a shell (or there is no shebang), else the shebang line. */
function foreignShebang(firstLine: string): string | undefined {
  if (!firstLine.startsWith("#!")) return undefined;
  const words = firstLine.slice(2).trim().split(/\s+/).filter((w) => w !== "");
  let prog = words[0] ?? "";
  if (prog.endsWith("/env") || prog === "env") {
    prog = words.find((w, i) => i > 0 && !w.startsWith("-") && !w.includes("=")) ?? "";
  }
  const base = prog.slice(prog.lastIndexOf("/") + 1);
  return SHELL_INTERPRETERS.has(base) ? undefined : firstLine;
}

function execsBeforeUs(body: string): boolean {
  return body.split("\n").some((l) => l.trimStart().startsWith("exec "));
}

async function ensureExecutable(path: string): Promise<void> {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o111) !== 0o111) await chmod(path, mode | 0o111);
}

export async function installHooks(workspace: string, opts?: { bin?: string }): Promise<InstallResult> {
  const paths = hookPaths(workspace);
  if ("refused" in paths) return { installed: [], kept: [], skipped: [], refused: paths.refused };
  const block = hookBlock(resolve(opts?.bin ?? defaultBin()));
  const result: InstallResult = { hooksDir: paths.hooksDir, installed: [], kept: [], skipped: [] };
  await mkdir(paths.hooksDir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = resolve(paths.hooksDir, name);
    if (!existsSync(file)) {
      writeFileSync(file, `#!/bin/sh\n${block}`, { mode: 0o755 });
      await chmod(file, 0o755);
      result.installed.push(name);
      continue;
    }
    if (!lstatSync(file).isFile()) {
      result.skipped.push({ name, why: "not a regular file" });
      continue;
    }
    const body = readFileSync(file, "utf8");
    if (isHooked(body)) {
      result.kept.push(name);
      continue;
    }
    const firstLine = body.split("\n", 1)[0] ?? "";
    const shebang = foreignShebang(firstLine);
    if (shebang !== undefined) {
      result.skipped.push({ name, why: `foreign interpreter: ${shebang}` });
      continue;
    }
    if (execsBeforeUs(body)) {
      result.skipped.push({ name, why: "runs exec before our block" });
      continue;
    }
    const sep = body === "" || body.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${body}${sep}${block}`);
    await ensureExecutable(file);
    result.installed.push(name);
  }
  return result;
}

/** What a hook file is once the marked block is gone; `undefined` when nothing meaningful remains. */
function stripBlock(body: string): string | undefined {
  const range = blockRange(body);
  if (!range) return body;
  const rest = [...range.lines.slice(0, range.begin), ...range.lines.slice(range.end + 1)].join("\n");
  const meaningful = rest.split("\n").filter((l, i) => !(i === 0 && l.startsWith("#!")) && l.trim() !== "");
  return meaningful.length === 0 ? undefined : rest;
}

export async function removeHooks(workspace: string): Promise<RemoveResult> {
  const paths = hookPaths(workspace);
  if ("refused" in paths) return { removed: [], deleted: [], refused: paths.refused };
  const result: RemoveResult = { hooksDir: paths.hooksDir, removed: [], deleted: [] };
  for (const name of HOOK_NAMES) {
    const file = resolve(paths.hooksDir, name);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const body = readFileSync(file, "utf8");
    if (!isHooked(body)) continue;
    const rest = stripBlock(body);
    if (rest === undefined) {
      await unlink(file);
      result.deleted.push(name);
    } else {
      writeFileSync(file, rest);
    }
    result.removed.push(name);
  }
  return result;
}

export async function hookStatus(workspace: string): Promise<HookStatus> {
  const paths = hookPaths(workspace);
  if ("refused" in paths) return { refused: paths.refused, hooks: [] };
  const status: HookStatus = { hooksDir: paths.hooksDir, hooks: [] };
  for (const name of HOOK_NAMES) {
    const file = resolve(paths.hooksDir, name);
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      status.hooks.push({ name, present: false, hooked: false, executable: false, foreign: false });
      continue;
    }
    const body = readFileSync(file, "utf8");
    const hooked = isHooked(body);
    status.hooks.push({ name, present: true, hooked, executable: (statSync(file).mode & 0o111) !== 0, foreign: !hooked });
    if (hooked && status.bin === undefined) {
      const m = BIN_LINE.exec(body);
      if (m) {
        status.bin = shUnquote(m[1]);
        status.binaryMissing = !existsSync(status.bin);
      }
    }
  }
  return status;
}
