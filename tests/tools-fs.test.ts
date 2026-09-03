import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWER_ONLY_TOOLS, TOOL_CATALOG, workerToolNames } from "../src/tool-catalog.ts";
import { executeTool, resolveSafe, resolveSafeReal } from "../src/tools.ts";
import type { ToolCall } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

const call = (tool: string, args: Record<string, unknown>, id = "c"): ToolCall => ({
  id,
  tool,
  args,
  proposedBy: "worker_a",
});

/** A directory really OUTSIDE the workspace tree (never under `<repo>/.tmp`). */
async function outsideDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("symlink containment (resolveSafeReal)", () => {
  test("the decisive case: a directory symlink out of the workspace does NOT let fs_destructive delete", async () => {
    const ws = await makeWorkspace("fsreal-del-");
    const outside = await outsideDir("dehors-");
    await writeFile(join(outside, "cible"), "do not delete me", "utf8");
    await symlink(outside, join(ws, "link")); // link -> /tmp/dehors-XXXX

    // `resolveSafe` (lexical) accepts it — that is the bug, and it is why the real check exists.
    expect(() => resolveSafe(ws, "link/cible")).not.toThrow();

    const r = await executeTool(call("fs_destructive", { action: "delete", path: "link/cible" }), {
      workspace: ws,
      approved: new Set(["c"]),
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/escapes workspace/);
    expect(existsSync(join(outside, "cible"))).toBe(true);
    expect(await readFile(join(outside, "cible"), "utf8")).toBe("do not delete me");
  });

  test("a move whose TARGET goes through a directory symlink is refused too", async () => {
    const ws = await makeWorkspace("fsreal-mv-");
    const outside = await outsideDir("dehors-");
    await symlink(outside, join(ws, "link"));
    await writeFile(join(ws, "inside.txt"), "x", "utf8");
    const r = await executeTool(call("fs_destructive", { action: "move", path: "inside.txt", to: "link/exfil.txt" }), {
      workspace: ws,
      approved: new Set(["c"]),
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/target.*escapes workspace/);
    expect(existsSync(join(outside, "exfil.txt"))).toBe(false);
    expect(existsSync(join(ws, "inside.txt"))).toBe(true);
  });

  test("FS_PROTECTED is not fooled by a link to .git inside the workspace", async () => {
    const ws = await makeWorkspace("fsreal-git-");
    await mkdir(join(ws, ".git"), { recursive: true });
    await writeFile(join(ws, ".git", "config"), "[core]", "utf8");
    await symlink(join(ws, ".git"), join(ws, "g")); // g -> .git, lexically innocent

    const del = await executeTool(call("fs_destructive", { action: "delete", path: "g/config" }), {
      workspace: ws,
      approved: new Set(["c"]),
    });
    expect(del.ok).toBe(false);
    expect(del.output).toMatch(/\.git\/ is protected/);
    expect(existsSync(join(ws, ".git", "config"))).toBe(true);

    const wr = await executeTool(call("write_file", { path: "g/config", content: "pwned" }), { workspace: ws });
    expect(wr.ok).toBe(false);
    expect(wr.output).toMatch(/\.git\/ is protected/);
    expect(await readFile(join(ws, ".git", "config"), "utf8")).toBe("[core]");
  });

  test("write_file and read_file refuse a path that lands outside through a link", async () => {
    const ws = await makeWorkspace("fsreal-rw-");
    const outside = await outsideDir("dehors-");
    await writeFile(join(outside, "secret.txt"), "top secret", "utf8");
    await symlink(outside, join(ws, "link"));

    // The file does NOT exist yet: the parent decides.
    expect(executeTool(call("write_file", { path: "link/new.txt", content: "x" }), { workspace: ws }))
      .rejects.toThrow(/escapes workspace/);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);

    expect(executeTool(call("read_file", { path: "link/secret.txt" }), { workspace: ws }))
      .rejects.toThrow(/escapes workspace/);
    expect(executeTool(call("edit_file", { path: "link/secret.txt", old_string: "top", new_string: "no" }), { workspace: ws }))
      .rejects.toThrow(/escapes workspace/);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("top secret");
  });

  test("write_file still refuses .git/ and .agentik/ without any link", async () => {
    const ws = await makeWorkspace("fsreal-prot-");
    await mkdir(join(ws, ".git"), { recursive: true });
    for (const path of [".git/hooks/pre-commit", ".agentik/runs/x.json"]) {
      const r = await executeTool(call("write_file", { path, content: "x" }), { workspace: ws });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/is protected/);
      expect(existsSync(join(ws, path))).toBe(false);
    }
  });

  test("a symlink that stays INSIDE the workspace keeps working", async () => {
    const ws = await makeWorkspace("fsreal-ok-");
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "sub", "a.txt"), "hello", "utf8");
    await symlink(join(ws, "sub"), join(ws, "inner"));

    const read = await executeTool(call("read_file", { path: "inner/a.txt" }), { workspace: ws });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("hello");

    const wrote = await executeTool(call("write_file", { path: "inner/b.txt", content: "bee" }), { workspace: ws });
    expect(wrote.ok).toBe(true);
    expect(await readFile(join(ws, "sub", "b.txt"), "utf8")).toBe("bee");

    const del = await executeTool(call("fs_destructive", { action: "delete", path: "inner/b.txt" }), {
      workspace: ws,
      approved: new Set(["c"]),
    });
    expect(del.ok).toBe(true);
    expect(existsSync(join(ws, "sub", "b.txt"))).toBe(false);
  });

  test("resolveSafeReal returns the lexical path to act on, and the real one it lands on", async () => {
    const ws = await makeWorkspace("fsreal-api-");
    await mkdir(join(ws, "sub"), { recursive: true });
    await symlink(join(ws, "sub"), join(ws, "inner"));
    const sp = await resolveSafeReal(ws, "inner/c.txt");
    expect(sp.full).toBe(join(ws, "inner", "c.txt"));
    expect(sp.real.endsWith(join("sub", "c.txt"))).toBe(true);
    expect(sp.real.startsWith(sp.root)).toBe(true);
    expect(resolveSafeReal(ws, "../outside.txt")).rejects.toThrow(/escapes workspace/);
  });
});

describe("edit_file", () => {
  const host = (ws: string) => ({ workspace: ws });

  test("is in the catalogue, medium blast, offered to workers", () => {
    expect(TOOL_CATALOG.find((t) => t.name === "edit_file")).toMatchObject({ blastRadius: "medium" });
    expect(workerToolNames()).toContain("edit_file");
    expect(REVIEWER_ONLY_TOOLS.has("edit_file")).toBe(false);
  });

  test("replaces a unique anchor and reports the file as an artifact", async () => {
    const ws = await makeWorkspace("edit-ok-");
    await writeFile(join(ws, "a.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const r = await executeTool(call("edit_file", { path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }), host(ws));
    expect(r.ok).toBe(true);
    expect(r.artifact).toBe("a.ts");
    expect(r.output).toMatch(/edited a\.ts \(1 replacement/);
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  test("a missing anchor writes NOTHING", async () => {
    const ws = await makeWorkspace("edit-miss-");
    await writeFile(join(ws, "a.ts"), "const a = 1;\n", "utf8");
    const r = await executeTool(call("edit_file", { path: "a.ts", old_string: "const z = 9;", new_string: "x" }), host(ws));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/anchor not found/);
    expect(r.output).toMatch(/Nothing was written/);
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("const a = 1;\n");
  });

  test("an ambiguous anchor writes NOTHING, unless replace_all", async () => {
    const ws = await makeWorkspace("edit-amb-");
    await writeFile(join(ws, "a.ts"), "x = 1;\ny = 1;\nz = 1;\n", "utf8");
    const bad = await executeTool(call("edit_file", { path: "a.ts", old_string: "= 1;", new_string: "= 2;" }), host(ws));
    expect(bad.ok).toBe(false);
    expect(bad.output).toMatch(/ambiguous in a\.ts \(3 occurrences\)/);
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("x = 1;\ny = 1;\nz = 1;\n");

    const all = await executeTool(call("edit_file", { path: "a.ts", old_string: "= 1;", new_string: "= 2;", replace_all: true }), host(ws));
    expect(all.ok).toBe(true);
    expect(all.output).toMatch(/3 replacements/);
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("x = 2;\ny = 2;\nz = 2;\n");
  });

  test("refuses a missing file, an empty anchor, a no-op and a non-string new_string", async () => {
    const ws = await makeWorkspace("edit-args-");
    await writeFile(join(ws, "a.ts"), "keep", "utf8");
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ path: "ghost.ts", old_string: "a", new_string: "b" }, /does not exist in the workspace/],
      [{ path: "a.ts", old_string: "", new_string: "b" }, /old_string is required/],
      [{ path: "a.ts", new_string: "b" }, /old_string is required/],
      [{ path: "a.ts", old_string: "keep" }, /new_string is required/],
      [{ path: "a.ts", old_string: "keep", new_string: "keep" }, /identical/],
      [{ old_string: "a", new_string: "b" }, /path is required/],
    ];
    for (const [args, re] of cases) {
      const r = await executeTool(call("edit_file", args), host(ws));
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(re);
    }
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("keep");
  });

  test("deletes the anchor with an empty new_string", async () => {
    const ws = await makeWorkspace("edit-del-");
    await writeFile(join(ws, "a.ts"), "aXb", "utf8");
    const r = await executeTool(call("edit_file", { path: "a.ts", old_string: "X", new_string: "" }), host(ws));
    expect(r.ok).toBe(true);
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("ab");
  });
});
