import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The key of a project is its repository, not the directory you happen to be in. A git
 * worktree (`../agentik-<topic>`) shares the project memory, sessions and incidents of the main
 * checkout; a plain directory or a subdirectory of a repository keeps its absolute path as key.
 *
 *   resolveWorkspaceRoot(ws):
 *     git rev-parse --show-toplevel  fails            → abs(ws) unchanged (not a repo)
 *     realpath(ws) !== toplevel                        → abs(ws) unchanged (a subdirectory: the
 *                                                        test workspaces under <repo>/.tmp/ stay
 *                                                        distinct projects)
 *     else first `worktree` line of git worktree list  → the main checkout (a worktree resolves
 *                                                        to it; the main checkout to itself)
 *
 * Memoized per absolute path: one git call per process per workspace.
 */

const memo = new Map<string, string>();

function git(args: string[], cwd: string): string | undefined {
  try {
    const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (res.exitCode !== 0) return undefined;
    return res.stdout.toString().trim();
  } catch {
    return undefined;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolveWorkspaceRoot(workspace: string): string {
  const abs = resolve(workspace);
  const hit = memo.get(abs);
  if (hit !== undefined) return hit;
  let root = abs;
  const top = git(["rev-parse", "--show-toplevel"], abs);
  if (top && real(abs) === real(top)) {
    const list = git(["worktree", "list", "--porcelain"], abs);
    const first = list?.split("\n").find((l) => l.startsWith("worktree "));
    if (first) root = first.slice("worktree ".length).trim() || abs;
  }
  memo.set(abs, root);
  return root;
}

/** Both spellings a stored row may carry for this workspace: its root and its absolute path. */
export function workspaceKeys(workspace: string | undefined): string[] {
  if (!workspace) return [];
  const abs = resolve(workspace);
  const root = resolveWorkspaceRoot(abs);
  return root === abs ? [abs] : [root, abs];
}

/** Test hook: forget memoized roots (a test may turn a directory into a repo after first use). */
export function resetWorkspaceRootCache(): void {
  memo.clear();
}
