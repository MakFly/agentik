import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_MARK_BEGIN, HOOK_MARK_END, HOOK_NAMES, hookBlock, hookPaths, hookStatus, installHooks, removeHooks } from "../src/index-hooks.ts";
import { makeWorkspace } from "./helpers.ts";

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: process.env.PATH },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString();
}

async function repo(): Promise<{ ws: string; hooks: string; bin: string }> {
  const ws = await makeWorkspace("index-hooks-ws-");
  git(ws, "init", "-q");
  await writeFile(join(ws, "README.md"), "# demo\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  const bin = join(ws, "fake-agentik");
  await writeFile(join(ws, "fake-agentik"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { ws, hooks: join(ws, ".git", "hooks"), bin };
}

const count = (body: string, needle: string) => body.split(needle).length - 1;

describe("index hooks: install / status", () => {
  test("a virgin repository gets four executable hooks carrying the block and the bin", async () => {
    const { ws, hooks, bin } = await repo();
    const r = await installHooks(ws, { bin });
    expect(r.refused).toBeUndefined();
    expect(r.hooksDir).toBe(hooks);
    expect(r.installed).toEqual([...HOOK_NAMES]);
    expect(r.kept).toEqual([]);
    expect(r.skipped).toEqual([]);
    for (const name of HOOK_NAMES) {
      const file = join(hooks, name);
      expect(statSync(file).mode & 0o111).toBe(0o111);
      const body = await readFile(file, "utf8");
      expect(body).toBe(`#!/bin/sh\n${hookBlock(bin)}`);
      expect(body).toContain(`AGENTIK_BIN="${bin}"`);
      expect(body).toContain("index --quiet --if-present --workspace");
    }
    const s = await hookStatus(ws);
    expect(s.refused).toBeUndefined();
    expect(s.hooksDir).toBe(hooks);
    expect(s.hooks.map((h) => h.name)).toEqual([...HOOK_NAMES]);
    for (const h of s.hooks) expect(h).toEqual({ name: h.name, present: true, hooked: true, executable: true, foreign: false });
    expect(s.bin).toBe(bin);
    expect(s.binaryMissing).toBe(false);
  });

  test("re-install is idempotent: kept ×4, bytes identical, one block per file", async () => {
    const { ws, hooks, bin } = await repo();
    await installHooks(ws, { bin });
    const before = await Promise.all(HOOK_NAMES.map((n) => readFile(join(hooks, n), "utf8")));
    const r = await installHooks(ws, { bin });
    expect(r.installed).toEqual([]);
    expect(r.kept).toEqual([...HOOK_NAMES]);
    expect(r.skipped).toEqual([]);
    const after = await Promise.all(HOOK_NAMES.map((n) => readFile(join(hooks, n), "utf8")));
    expect(after).toEqual(before);
    for (const body of after) {
      expect(count(body, HOOK_MARK_BEGIN)).toBe(1);
      expect(count(body, HOOK_MARK_END)).toBe(1);
    }
  });

  test("an existing shell hook keeps its body byte for byte; remove restores it exactly", async () => {
    const { ws, hooks, bin } = await repo();
    const original = "#!/bin/sh\necho hi\n";
    await writeFile(join(hooks, "post-commit"), original, { mode: 0o644 });
    const r = await installHooks(ws, { bin });
    expect(r.installed).toEqual([...HOOK_NAMES]);
    const body = await readFile(join(hooks, "post-commit"), "utf8");
    expect(body).toBe(`${original}${hookBlock(bin)}`);
    expect(statSync(join(hooks, "post-commit")).mode & 0o111).toBe(0o111);
    const s = await hookStatus(ws);
    expect(s.hooks.find((h) => h.name === "post-commit")).toEqual({ name: "post-commit", present: true, hooked: true, executable: true, foreign: false });

    const rm = await removeHooks(ws);
    expect(rm.refused).toBeUndefined();
    expect(rm.removed).toEqual([...HOOK_NAMES]);
    expect(rm.deleted).toEqual(["post-checkout", "post-merge", "post-rewrite"]);
    expect(await readFile(join(hooks, "post-commit"), "utf8")).toBe(original);
    expect(existsSync(join(hooks, "post-merge"))).toBe(false);
  });

  test("a foreign interpreter or an exec-style runner is skipped and left intact", async () => {
    const { ws, hooks, bin } = await repo();
    const py = "#!/usr/bin/env python3\nprint(1)\n";
    const husky = "#!/bin/sh\nexec .husky/run\n";
    await writeFile(join(hooks, "post-commit"), py);
    await writeFile(join(hooks, "post-merge"), husky);
    const r = await installHooks(ws, { bin });
    expect(r.installed).toEqual(["post-checkout", "post-rewrite"]);
    expect(r.kept).toEqual([]);
    expect(r.skipped).toEqual([
      { name: "post-commit", why: "foreign interpreter: #!/usr/bin/env python3" },
      { name: "post-merge", why: "runs exec before our block" },
    ]);
    expect(await readFile(join(hooks, "post-commit"), "utf8")).toBe(py);
    expect(await readFile(join(hooks, "post-merge"), "utf8")).toBe(husky);
    const s = await hookStatus(ws);
    expect(s.hooks.find((h) => h.name === "post-commit")).toMatchObject({ present: true, hooked: false, foreign: true });
    expect(s.hooks.find((h) => h.name === "post-merge")).toMatchObject({ present: true, hooked: false, foreign: true });
    expect(s.hooks.find((h) => h.name === "post-checkout")).toMatchObject({ present: true, hooked: true, foreign: false });
  });

  test("hookBlock escapes a path for a double-quoted sh string; status reads it back", async () => {
    const { ws, hooks } = await repo();
    const odd = join(ws, 'we"ird $dir', "agentik");
    await mkdir(join(ws, 'we"ird $dir'), { recursive: true });
    await writeFile(odd, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(hookBlock(odd)).toContain(`AGENTIK_BIN="${odd.replace(/[\\"$`]/g, (c) => `\\${c}`)}";`);
    await installHooks(ws, { bin: odd });
    expect(await readFile(join(hooks, "post-commit"), "utf8")).toContain('we\\"ird \\$dir');
    const s = await hookStatus(ws);
    expect(s.bin).toBe(odd);
    expect(s.binaryMissing).toBe(false);
  });
});

describe("index hooks: remove / refusals", () => {
  test("a hook reduced to shebang + block is deleted; a foreign hook is never touched", async () => {
    const { ws, hooks, bin } = await repo();
    const foreign = "#!/bin/bash\nexec lefthook run post-merge\n";
    await writeFile(join(hooks, "post-merge"), foreign);
    await installHooks(ws, { bin });
    const rm = await removeHooks(ws);
    expect(rm.removed).toEqual(["post-commit", "post-checkout", "post-rewrite"]);
    expect(rm.deleted).toEqual(["post-commit", "post-checkout", "post-rewrite"]);
    for (const n of ["post-commit", "post-checkout", "post-rewrite"]) expect(existsSync(join(hooks, n))).toBe(false);
    expect(await readFile(join(hooks, "post-merge"), "utf8")).toBe(foreign);
    const again = await removeHooks(ws);
    expect(again.removed).toEqual([]);
    const s = await hookStatus(ws);
    expect(s.bin).toBeUndefined();
    expect(s.hooks.filter((h) => h.present).map((h) => h.name)).toEqual(["post-merge"]);
  });

  test("a binary that vanished is reported as missing", async () => {
    const { ws, bin } = await repo();
    await installHooks(ws, { bin });
    await Bun.file(bin).delete();
    const s = await hookStatus(ws);
    expect(s.bin).toBe(bin);
    expect(s.binaryMissing).toBe(true);
  });

  test("core.hooksPath at any scope is a refusal and nothing is written", async () => {
    const { ws, hooks, bin } = await repo();
    git(ws, "config", "core.hooksPath", "/tmp/x");
    const p = hookPaths(ws);
    expect("refused" in p && p.refused).toContain("core.hooksPath");
    const r = await installHooks(ws, { bin });
    expect(r.refused).toContain("core.hooksPath is set (/tmp/x)");
    expect(r.installed).toEqual([]);
    for (const n of HOOK_NAMES) expect(existsSync(join(hooks, n))).toBe(false);
    expect(existsSync("/tmp/x/post-commit")).toBe(false);
    const rm = await removeHooks(ws);
    expect(rm.refused).toContain("core.hooksPath");
    const s = await hookStatus(ws);
    expect(s.refused).toContain("core.hooksPath");
    expect(s.hooks).toEqual([]);
  });

  test("a linked worktree resolves to the main checkout's hooks", async () => {
    const { ws, hooks } = await repo();
    const wt = `${ws}-wt`;
    git(ws, "worktree", "add", "-q", wt, "-b", "topic");
    const a = hookPaths(ws);
    const b = hookPaths(wt);
    expect(a).toEqual({ hooksDir: hooks });
    expect(b).toEqual(a);
  });

  test("not a git checkout → refused", async () => {
    // Outside the repository tree: git discovery walks up, and .tmp/ sits inside this checkout.
    const plain = await mkdtemp(join(tmpdir(), "index-hooks-plain-"));
    const p = hookPaths(plain);
    expect(p).toEqual({ refused: `${plain} is not a git checkout` });
    expect((await installHooks(plain, { bin: "/bin/true" })).refused).toContain("not a git checkout");
    expect((await removeHooks(plain)).refused).toContain("not a git checkout");
    expect(existsSync(join(plain, ".git", "hooks"))).toBe(false);
    const missing = join(plain, "does-not-exist");
    expect(hookPaths(missing)).toEqual({ refused: `${missing} is not a git checkout` });
  });
});

describe("index hooks: the hook really runs, detached, with a clean environment", () => {
  test("git commit returns before the child finishes; the child sees no GIT_INDEX_FILE / GIT_DIR", async () => {
    const { ws } = await repo();
    const marker = join(ws, "..", `index-hooks-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const fake = join(ws, "fake-index");
    await writeFile(fake, `#!/bin/sh\nsleep 1\necho "$@" > "${marker}"\nenv >> "${marker}"\n`, { mode: 0o755 });
    const r = await installHooks(ws, { bin: fake });
    expect(r.installed).toEqual([...HOOK_NAMES]);

    const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "probe"], {
      cwd: ws,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: process.env.PATH },
    });
    expect(res.exitCode).toBe(0);
    // The commit came back while the child is still sleeping: the hook detached it.
    expect(existsSync(marker)).toBe(false);

    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(marker)).toBe(true);
    // The file may still be mid-write right after creation: wait for the env dump to land.
    let body = "";
    while (Date.now() < deadline) {
      body = await readFile(marker, "utf8");
      if (body.includes("PATH=")) break;
      await Bun.sleep(50);
    }
    expect(body.split("\n")[0]).toBe(`index --quiet --if-present --workspace ${ws}`);
    expect(body).not.toContain("GIT_INDEX_FILE=");
    expect(body).not.toContain("GIT_DIR=");
    expect(body).not.toContain("GIT_WORK_TREE=");
    await Bun.file(marker).delete();
  });
});
