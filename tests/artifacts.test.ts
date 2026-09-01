import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactChanged,
  describeUntouched,
  snapshotArtifacts,
  untouchedArtifacts,
} from "../src/artifacts.ts";
import { parseRun } from "../src/cli.ts";
import { makeWorkspace } from "./helpers.ts";

describe("artifact proof", () => {
  test("a file that never appears is untouched", async () => {
    const ws = await makeWorkspace("art-missing-");
    const before = await snapshotArtifacts(ws, ["src/never.txt"]);
    expect(before[0].exists).toBe(false);
    expect(await untouchedArtifacts(ws, before)).toEqual(["src/never.txt"]);
  });

  test("a file created during the run counts as changed", async () => {
    const ws = await makeWorkspace("art-created-");
    const before = await snapshotArtifacts(ws, ["src/new.txt"]);
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src/new.txt"), "OK", "utf8");
    expect(await untouchedArtifacts(ws, before)).toEqual([]);
  });

  test("a file rewritten with different content counts as changed", async () => {
    const ws = await makeWorkspace("art-rewritten-");
    await writeFile(join(ws, "a.txt"), "before", "utf8");
    const before = await snapshotArtifacts(ws, ["a.txt"]);
    await writeFile(join(ws, "a.txt"), "after, and longer", "utf8");
    expect(await untouchedArtifacts(ws, before)).toEqual([]);
  });

  test("a file left exactly as it was is reported untouched", async () => {
    const ws = await makeWorkspace("art-same-");
    await writeFile(join(ws, "a.txt"), "unchanged", "utf8");
    const before = await snapshotArtifacts(ws, ["a.txt"]);
    expect(await untouchedArtifacts(ws, before)).toEqual(["a.txt"]);
  });

  test("deletion counts as a change — a task may legitimately remove a file", async () => {
    const ws = await makeWorkspace("art-deleted-");
    await writeFile(join(ws, "gone.txt"), "x", "utf8");
    const before = await snapshotArtifacts(ws, ["gone.txt"]);
    await rm(join(ws, "gone.txt"));
    expect(await untouchedArtifacts(ws, before)).toEqual([]);
  });

  test("only some of several artifacts moving is still a failure", async () => {
    const ws = await makeWorkspace("art-partial-");
    const before = await snapshotArtifacts(ws, ["one.txt", "two.txt"]);
    await writeFile(join(ws, "one.txt"), "done", "utf8");
    expect(await untouchedArtifacts(ws, before)).toEqual(["two.txt"]);
  });

  test("a path escaping the workspace is a caller error, not a run failure", async () => {
    const ws = await makeWorkspace("art-escape-");
    expect(snapshotArtifacts(ws, ["../../etc/passwd"])).rejects.toThrow(/escapes workspace/);
  });

  test("artifactChanged is size- and mtime-sensitive", () => {
    const base = { path: "a", exists: true, mtimeMs: 100, size: 10 };
    expect(artifactChanged(base, { ...base })).toBe(false);
    expect(artifactChanged(base, { ...base, size: 11 })).toBe(true);
    expect(artifactChanged(base, { ...base, mtimeMs: 101 })).toBe(true);
    expect(artifactChanged(base, { ...base, exists: false })).toBe(true);
  });

  test("the message names the paths", () => {
    expect(describeUntouched(["a.ts"])).toContain("a.ts");
    expect(describeUntouched(["a.ts", "b.ts"])).toContain("2 expected artifacts");
  });
});

describe("--expect-artifact parsing", () => {
  test("repeatable, and does not swallow other flags", () => {
    const { goal, flags } = parseRun([
      "--harness",
      "grok",
      "--expect-artifact",
      "src/a.ts",
      "--expect-artifact",
      "src/b.ts",
      "--require-tools",
      "do the thing",
    ]);
    expect(flags.expectArtifacts).toEqual(["src/a.ts", "src/b.ts"]);
    expect(flags.requireTools).toBe(true);
    expect(flags.harness).toBe("grok");
    expect(goal).toBe("do the thing");
  });

  test("absent by default", () => {
    const { flags } = parseRun(["--harness", "codex", "task"]);
    expect(flags.expectArtifacts).toEqual([]);
  });
});
