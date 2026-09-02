import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approveMemory, approveSkillOps, rejectPending } from "../src/approval.ts";
import { main } from "../src/cli.ts";
import { ConfigError, readConfig } from "../src/config.ts";
import { retainNote } from "../src/memory.ts";
import { memoryAdd, MEMORY_CAP, readEntries } from "../src/memory-store.ts";
import { listPending, type PendingMemoryOp, type PendingSkillOp } from "../src/pending.ts";
import { runReview } from "../src/reviewer.ts";
import { readSkillUsage } from "../src/skill-usage.ts";
import { executeTool, newReviewState } from "../src/tools.ts";
import { makeWorkspace } from "./helpers.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";

async function homeWith(config: object, prefix = "approval-"): Promise<string> {
  const home = await makeWorkspace(prefix);
  await writeFile(join(home, "config.json"), JSON.stringify(config), "utf8");
  return home;
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  try {
    return { code: await fn(), out: chunks.join("") };
  } finally {
    console.log = origLog;
  }
}

class ScriptedReviewer implements Backend {
  readonly id = "scripted";
  seen: CompleteRequest[] = [];
  constructor(private readonly script: WorkerMessage[]) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    return this.script[this.seen.length - 1] ?? { text: "nothing more", toolCalls: [] };
  }
}

describe("config.json", () => {
  test("absent or partial: defaults are off; invalid JSON throws; camelCase and snake_case both read", async () => {
    const none = await makeWorkspace("config-none-");
    expect(await readConfig({ home: none })).toEqual({ memory: { writeApproval: false }, skills: { writeApproval: false } });
    const bad = await homeWith({} , "config-empty-");
    await writeFile(join(bad, "config.json"), "{not json", "utf8");
    await expect(readConfig({ home: bad })).rejects.toThrow(ConfigError);
    const snake = await homeWith({ memory: { write_approval: true }, skills: { writeApproval: true } }, "config-snake-");
    expect(await readConfig({ home: snake })).toEqual({ memory: { writeApproval: true }, skills: { writeApproval: true } });
  });
});

describe("memory.writeApproval: staged, never written until approved", () => {
  test("memoryAdd stages a pending op, MEMORY.md untouched; pending / approve / reject via CLI", async () => {
    const home = await homeWith({ memory: { writeApproval: true } });
    const res = await memoryAdd("memory", "The repo runs bun test, not jest.", { home });
    expect(res.ok).toBe(true);
    expect(res.staged).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
    expect(res.message).toContain(`staged for approval (#${res.staged})`);
    expect(existsSync(join(home, "memory", "MEMORY.md"))).toBe(false);
    const pending = await listPending<PendingMemoryOp>("memory", { home });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: res.staged, target: "memory", ops: [{ action: "add", content: "The repo runs bun test, not jest." }] });
    expect(pending[0].preview).toBe('add "The repo runs bun test, not jest."');
    expect(existsSync(join(home, "pending", "memory", `${res.staged}.json`))).toBe(true);

    const listed = await captureStdout(() => main(["memory", "pending", "--agentik-home", home]));
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`#${res.staged}  memory`);
    expect(listed.out).toContain("add \"The repo runs bun test");

    // retainNote goes through the same gate.
    const r = await retainNote("Typecheck is make typecheck.", { home });
    expect(r.layer).toBe("pending");
    expect(existsSync(join(home, "memory", "MEMORY.md"))).toBe(false);
    expect(await listPending("memory", { home })).toHaveLength(2);

    const approved = await captureStdout(() => main(["memory", "approve", res.staged!, "--agentik-home", home]));
    expect(approved.code).toBe(0);
    expect(approved.out).toContain(`ok #${res.staged}: added (33 chars)`);
    expect(await readEntries("memory", home)).toEqual(["The repo runs bun test, not jest."]);
    expect(existsSync(join(home, "pending", "memory", `${res.staged}.json`))).toBe(false);

    const [second] = await listPending<PendingMemoryOp>("memory", { home });
    const rejected = await captureStdout(() => main(["memory", "reject", second.id, "--agentik-home", home]));
    expect(rejected.code).toBe(0);
    expect(rejected.out).toContain(`ok #${second.id}: rejected`);
    expect(await listPending("memory", { home })).toHaveLength(0);
    expect(await readEntries("memory", home)).toEqual(["The repo runs bun test, not jest."]);
    expect(await main(["memory", "approve", "20260101T000000Z-abcd", "--agentik-home", home])).toBe(1);
    expect((await captureStdout(() => main(["memory", "approve", "all", "--agentik-home", home]))).out).toContain("nothing pending");
  });

  test("a project add is staged with its workspace and approved into that workspace's file only", async () => {
    const home = await homeWith({ memory: { writeApproval: true } }, "approval-project-");
    const ws = await makeWorkspace("approval-project-ws-");
    const res = await memoryAdd("project", "This checkout runs bun test.", { home, workspace: ws });
    expect(res.ok).toBe(true);
    expect(res.staged).toBeDefined();
    const [op] = await listPending<PendingMemoryOp>("memory", { home });
    expect(op.target).toBe("project");
    expect(op.workspace).toBe(ws);
    expect(await readEntries("project", home, { workspace: ws })).toEqual([]);
    const out = await approveMemory(op.id, { home });
    expect("error" in out).toBe(false);
    expect(await readEntries("project", home, { workspace: ws })).toEqual(["This checkout runs bun test."]);
    expect(await readEntries("memory", home)).toEqual([]);
    expect(existsSync(join(home, "memory/MEMORY.md"))).toBe(false);
  });

  test("the cap applies at approval: an add that no longer fits is refused and stays pending", async () => {
    const home = await makeWorkspace("approval-cap-");
    await writeFile(join(home, "config.json"), JSON.stringify({ memory: { writeApproval: true } }), "utf8");
    const staged = await memoryAdd("memory", "z".repeat(200), { home });
    expect(staged.ok).toBe(true);
    // Meanwhile the file fills up (bypassing approval, as `approve` itself would).
    await import("../src/memory-store.ts").then((m) => m.memoryApply("memory", [{ action: "add", content: "y".repeat(MEMORY_CAP - 50) }], { home, bypassApproval: true }));
    const out = await approveMemory(staged.staged!, { home });
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out[0].ok).toBe(false);
    expect(out[0].message).toContain("Consolidate now");
    expect(out[0].message).toContain("still pending");
    expect(await listPending("memory", { home })).toHaveLength(1);
    expect((await readEntries("memory", home)).join("")).not.toContain("zzzz");
    // `approve all` reports the refusal through the exit code.
    expect(await main(["memory", "approve", "all", "--agentik-home", home])).toBe(1);
  });

  test("staging still validates: a secret or an unknown target is refused immediately, not queued", async () => {
    const home = await homeWith({ memory: { writeApproval: true } }, "approval-validate-");
    const secret = await memoryAdd("memory", "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789", { home });
    expect(secret.ok).toBe(false);
    expect(secret.staged).toBeUndefined();
    const missing = await import("../src/memory-store.ts").then((m) => m.memoryRemove("memory", "not there", { home }));
    expect(missing.ok).toBe(false);
    expect(await listPending("memory", { home })).toHaveLength(0);
  });

  test("runReview with a scripted add counts memoryOps 1 (staged is a success) and MEMORY.md is intact", async () => {
    const home = await homeWith({ memory: { writeApproval: true } }, "approval-review-");
    const backend = new ScriptedReviewer([
      { text: "one fact", toolCalls: [{ tool: "memory", args: { target: "memory", action: "add", content: "openhermesbot-web runs unit tests with make test-unit." } }] },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runReview({ goal: "g", transcript: "t", workspace: "/tmp", home, backend });
    expect(out.memoryOps).toBe(1);
    expect(out.refused).toBe(0);
    expect(out.stoppedBecause).toBe("no_more_tool_calls");
    expect(out.events[0]).toContain("staged for approval");
    expect(existsSync(join(home, "memory", "MEMORY.md"))).toBe(false);
    expect(await listPending("memory", { home })).toHaveLength(1);
    // The reviewer was told it was staged, so it does not retry.
    expect(backend.seen[1].envelopes.map((e) => e.body).join("\n")).toContain("staged for approval");
  });
});

describe("skills.writeApproval: skill_manage patch/create are staged", () => {
  const body = "## When to use\nDrawer swipe bugs.\n## Procedure\n1. Read mobile-drawer-shell.\n## Pitfalls\nGhost clicks.\n## Verification\nbun test.";

  test("create staged → skills pending → approve creates it (no re-view required) → patch staged → approve all", async () => {
    const home = await homeWith({ skills: { writeApproval: true } }, "approval-skills-");
    const state = newReviewState(1);
    const host = { workspace: home, agentikHome: home, reviewState: state };
    // Read-before-write is still enforced at staging time.
    const noView = await executeTool({ id: "0", tool: "skill_manage", args: { action: "create", name: "pwa-drawer-swipe", description: "Drawer swipe rules.", body }, proposedBy: "reviewer" }, host);
    expect(noView.ok).toBe(false);
    await executeTool({ id: "1", tool: "skill_manage", args: { action: "view", name: "pwa-drawer-swipe" }, proposedBy: "reviewer" }, host);
    const created = await executeTool({ id: "2", tool: "skill_manage", args: { action: "create", name: "pwa-drawer-swipe", description: "Drawer swipe rules.", body }, proposedBy: "reviewer" }, host);
    expect(created.ok).toBe(true);
    expect(created.output).toContain("staged for approval");
    expect(existsSync(join(home, "skills", "pwa-drawer-swipe"))).toBe(false);
    expect(state.skillsCreated).toBe(1); // the budget is spent at staging
    const [op] = await listPending<PendingSkillOp>("skills", { home });
    expect(op).toMatchObject({ action: "create", name: "pwa-drawer-swipe", args: { description: "Drawer swipe rules.", body } });
    expect(existsSync(join(home, "pending", "skills-ops", `${op.id}.json`))).toBe(true);

    const listed = await captureStdout(() => main(["skills", "pending", "--agentik-home", home]));
    expect(listed.out).toContain(`#${op.id}  create pwa-drawer-swipe`);

    const approved = await captureStdout(() => main(["skills", "approve", op.id, "--agentik-home", home]));
    expect(approved.code).toBe(0);
    expect(approved.out).toContain(`ok #${op.id}: created pwa-drawer-swipe`);
    const file = join(home, "skills", "pwa-drawer-swipe", "SKILL.md");
    expect(await readFile(file, "utf8")).toContain("Ghost clicks.");
    expect(await listPending("skills", { home })).toHaveLength(0);
    expect((await readSkillUsage({ home }))["pwa-drawer-swipe"].createdBy).toBe("reviewer");

    const patch = await executeTool({ id: "3", tool: "skill_manage", args: { action: "patch", name: "pwa-drawer-swipe", old_string: "Ghost clicks.", new_string: "Ghost clicks within 450ms." }, proposedBy: "reviewer" }, host);
    expect(patch.ok).toBe(true);
    expect(await readFile(file, "utf8")).not.toContain("450ms");
    const all = await approveSkillOps("all", { home });
    expect("error" in all).toBe(false);
    if ("error" in all) return;
    expect(all[0].ok).toBe(true);
    expect(await readFile(file, "utf8")).toContain("450ms");
    expect((await readSkillUsage({ home }))["pwa-drawer-swipe"].patches).toBe(1);
  });

  test("a staged patch whose anchor is gone is refused at approval and stays pending; reject drops it", async () => {
    const home = await homeWith({ skills: { writeApproval: true } }, "approval-skills-stale-");
    const host = { workspace: home, agentikHome: home, reviewState: newReviewState(1) };
    await executeTool({ id: "1", tool: "skill_manage", args: { action: "view", name: "csv-export" }, proposedBy: "reviewer" }, host);
    await writeFile(join(home, "config.json"), "{}", "utf8");
    await executeTool({ id: "2", tool: "skill_manage", args: { action: "create", name: "csv-export", description: "CSV export.", body }, proposedBy: "reviewer" }, host);
    await writeFile(join(home, "config.json"), JSON.stringify({ skills: { writeApproval: true } }), "utf8");
    const staged = await executeTool({ id: "3", tool: "skill_manage", args: { action: "patch", name: "csv-export", old_string: "Ghost clicks.", new_string: "x" }, proposedBy: "reviewer" }, host);
    expect(staged.ok).toBe(true);
    const file = join(home, "skills", "csv-export", "SKILL.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("Ghost clicks.", "Nothing."), "utf8");
    const [op] = await listPending<PendingSkillOp>("skills", { home });
    const out = await approveSkillOps(op.id, { home });
    if ("error" in out) throw new Error(out.error);
    expect(out[0].ok).toBe(false);
    expect(out[0].message).toContain("matched 0");
    expect(await listPending("skills", { home })).toHaveLength(1);
    const rejected = await rejectPending("skills", "all", { home });
    if ("error" in rejected) throw new Error(rejected.error);
    expect(rejected[0].ok).toBe(true);
    expect(await listPending("skills", { home })).toHaveLength(0);
    // `skills approve <name>` still means "approve a human draft".
    expect(await main(["skills", "approve", "csv-export", "--agentik-home", home])).toBe(1);
  });
});

test("approve all keeps going past a project op that lost its workspace: it stays pending, the next op lands", async () => {
  const home = await makeWorkspace("approval-broken-");
  const dir = join(home, "pending", "memory");
  await mkdir(dir, { recursive: true });
  const broken = { id: "20260101T000000Z-aaaa", target: "project", ops: [{ action: "add", content: "orphan" }], at: "2026-01-01T00:00:00Z", preview: "add orphan" };
  const good = { id: "20260101T000001Z-bbbb", target: "memory", ops: [{ action: "add", content: "global survivor" }], at: "2026-01-01T00:00:01Z", preview: "add global survivor" };
  await writeFile(join(dir, `${broken.id}.json`), JSON.stringify(broken), "utf8");
  await writeFile(join(dir, `${good.id}.json`), JSON.stringify(good), "utf8");
  const out = await approveMemory("all", { home });
  if ("error" in out) throw new Error(out.error);
  expect(out).toHaveLength(2);
  const brokenOut = out.find((o) => o.id === broken.id)!;
  const goodOut = out.find((o) => o.id === good.id)!;
  expect(brokenOut.ok).toBe(false);
  expect(brokenOut.message).toContain("project memory needs a workspace");
  expect(brokenOut.message).toContain("still pending");
  expect(goodOut.ok).toBe(true);
  expect(await Bun.file(join(dir, `${broken.id}.json`)).exists()).toBe(true);
  expect(await Bun.file(join(dir, `${good.id}.json`)).exists()).toBe(false);
  expect(await Bun.file(join(home, "memory", "MEMORY.md")).text()).toContain("global survivor");
});
