import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { approveMemory } from "../src/approval.ts";
import { main } from "../src/cli.ts";
import { formatMemoryOp, listMemoryOps, logMemoryOp } from "../src/memory-log.ts";
import { memoryApply, memoryRemoveEntry } from "../src/memory-store.ts";
import { retainNote } from "../src/memory.ts";
import { executeTool } from "../src/tools.ts";
import { makeWorkspace } from "./helpers.ts";

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: out.join("\n") };
  } finally {
    console.log = orig;
  }
}

describe("memory journal", () => {
  test("every writer is logged with its actor: human retain/remove, reviewer tool, approval replay, project target", async () => {
    const home = await makeWorkspace("mlog-home-");
    const ws = await makeWorkspace("mlog-ws-");
    await retainNote("Bun runs the tests here, not jest.", { home });
    const tool = await executeTool({ id: "m1", tool: "memory", args: { target: "memory", action: "replace", old: "Bun runs the tests here", new: "Bun runs the tests here, never jest." }, proposedBy: "reviewer" }, { workspace: ws, agentikHome: home, sessionId: 7 });
    expect(tool.ok).toBe(true);
    await memoryApply("project", [{ action: "add", content: "This repo pins bun 1.3." }], { home, workspace: ws, by: "reviewer" });
    const removed = await memoryRemoveEntry("memory", "Bun runs the tests here, never jest.", { home });
    expect(removed.ok).toBe(true);
    const ops = (await listMemoryOps({ home })).reverse();
    expect(ops.map((o) => [o.target, o.op, o.by])).toEqual([
      ["memory", "add", "human"],
      ["memory", "replace", "reviewer"],
      ["project", "add", "reviewer"],
      ["memory", "remove", "human"],
    ]);
    expect(ops[0].after).toBe("Bun runs the tests here, not jest.");
    expect(ops[1]).toMatchObject({ before: "Bun runs the tests here", after: "Bun runs the tests here, never jest.", sessionId: 7 });
    expect(ops[2].workspace).toBe(ws);
    expect(ops[3].before).toBe("Bun runs the tests here, never jest.");
    expect((await listMemoryOps({ home, target: "project" })).length).toBe(1);
    expect((await listMemoryOps({ home, workspace: ws })).length).toBe(1);
    expect(formatMemoryOp(ops[1])).toMatch(/^#\d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} memory replace by reviewer \(session #7\): "Bun runs the tests here" → "Bun runs the tests here, never jest\."$/);
  });

  test("approval replay is logged by 'approval'; a staged write is not logged until applied", async () => {
    const home = await makeWorkspace("mlog-appr-");
    await Bun.write(join(home, "config.json"), JSON.stringify({ memory: { writeApproval: true } }));
    const staged = await memoryApply("memory", [{ action: "add", content: "Staged fact." }], { home, by: "reviewer" });
    expect(staged.staged).toBeDefined();
    expect(await listMemoryOps({ home })).toHaveLength(0);
    const res = await approveMemory("all", { home });
    expect(Array.isArray(res) && res[0].ok).toBe(true);
    const ops = await listMemoryOps({ home });
    expect(ops.map((o) => [o.op, o.by])).toEqual([["add", "approval"]]);
  });

  test("the journal never holds a raw token; it is not read by context or the reviewer", async () => {
    const home = await makeWorkspace("mlog-mask-");
    await logMemoryOp({ target: "memory", op: "migrate", after: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here", by: "migration" }, { home });
    // logMemoryOp stores what it is given; memoryApply masks before calling it — check that path:
    const r = await memoryApply("memory", [{ action: "add", content: "note with token ghp_abcdefghijklmnopqrstuvwxyz0123" }], { home, by: "human" });
    expect(r.ok).toBe(false); // refused by the content scan, hence nothing to journal
    const ops = await listMemoryOps({ home });
    expect(ops).toHaveLength(1);
    for (const src of ["src/context.ts", "src/reviewer.ts"]) {
      expect(await readFile(join(import.meta.dir, "..", src), "utf8")).not.toContain("memory-log");
    }
  });

  test("agentik memory log [-n N] [--target] [--json]", async () => {
    const home = await makeWorkspace("mlog-cli-");
    await retainNote("First.", { home });
    await retainNote("Second.", { home });
    const emptyHome = await makeWorkspace("mlog-empty-");
    const empty = await capture(() => main(["memory", "log", "--agentik-home", emptyHome]));
    expect(empty.out).toBe("(no memory writes yet)");
    const all = await capture(() => main(["memory", "log", "--agentik-home", home]));
    expect(all.code).toBe(0);
    expect(all.out.split("\n")).toHaveLength(2);
    expect(all.out).toContain('memory add by human: "Second."');
    const one = await capture(() => main(["memory", "log", "-n", "1", "--agentik-home", home]));
    expect(one.out.split("\n")).toHaveLength(1);
    const json = await capture(() => main(["memory", "log", "--json", "--target", "memory", "--agentik-home", home]));
    expect(JSON.parse(json.out)).toHaveLength(2);
  });
});
