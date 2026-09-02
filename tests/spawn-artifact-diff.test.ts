import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeArtifactDiff, diffArtifacts, snapshotArtifacts } from "../src/artifacts.ts";
import { listIncidents } from "../src/incidents.ts";
import { makeWorkspace } from "./helpers.ts";

describe("diffArtifacts", () => {
  test("expected changed / untouched; stream paths filtered by workspace and mtime; cap 10", async () => {
    const ws = await makeWorkspace("diff-");
    await writeFile(join(ws, "old.txt"), "old", "utf8");
    const before = await snapshotArtifacts(ws, ["a.txt", "old.txt", "never.txt"]);
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await writeFile(join(ws, "a.txt"), "new", "utf8");
    await writeFile(join(ws, "b.txt"), "stream said so", "utf8");
    const d = await diffArtifacts(ws, before, ["b.txt", `${ws}/b.txt`, "old.txt", "../escape.txt", "/etc/passwd", "ghost.txt"], started);
    expect(d.changed).toEqual(["a.txt"]);
    expect(d.untouched).toEqual(["old.txt", "never.txt"]);
    expect(d.touched).toEqual(["b.txt"]);
    expect(describeArtifactDiff(d)).toBe("changed: [a.txt] / untouched: [old.txt, never.txt] / touched (per stream): [b.txt]");
    const many = describeArtifactDiff({ changed: [], untouched: Array.from({ length: 12 }, (_, i) => `f${i}`), touched: [] });
    expect(many).toContain("+2 more");
    expect(many).toContain("changed: []");
  });
});

describe("agentik spawn: 124 and 125 say what moved on disk", () => {
  test("125 (--require-evidence): changed / untouched / touched line on stderr and first in the incident", async () => {
    const home = await makeWorkspace("diff-home-");
    const ws = await makeWorkspace("diff-ws-");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const write = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "b.txt", content: "OK" } }] } });
    const done = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "wrote b.txt" });
    await writeFile(join(bin, "claude"), [
      "#!/bin/sh",
      `if [ "$1" = "--help" ]; then echo '  --disallowedTools deny --settings'; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi`,
      `echo OK > '${join(ws, "b.txt")}'`,
      `printf '%s\\n' '${write}'`,
      `printf '%s\\n' '${done}'`,
      "exit 0",
      "",
    ].join("\n"), "utf8");
    await chmod(join(bin, "claude"), 0o755);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "--no-context", "--timeout", "30", "--require-evidence", "--expect-artifact", "b.txt", "--expect-artifact", "c.txt", "create b.txt and c.txt"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTIK_DEPTH: undefined },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(125);
    expect(stderr).toContain("agentik spawn: changed: [b.txt] / untouched: [c.txt] / touched (per stream): [b.txt]");
    const incidents = await listIncidents({ home, workspace: ws });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].errors[0]).toBe("changed: [b.txt] / untouched: [c.txt] / touched (per stream): [b.txt]");
    expect(incidents[0].errors[1]).toBe("evidence=none");
  });
});
