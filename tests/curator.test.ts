import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { curateSkills, isCurationEntry, planCuration, readLedger, rollbackSkills } from "../src/curator.ts";
import { pinSkill } from "../src/skill-factory.ts";
import { readSkillUsage, recordSkillUsage, writeSkillUsage } from "../src/skill-usage.ts";
import { executeTool, newReviewState } from "../src/tools.ts";
import { makeWorkspace } from "./helpers.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function putSkill(home: string, name: string, body = `## When to use\n${name}.\n`): Promise<string> {
  const dir = join(home, "skills", name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} procedure.\n---\n\n${body}`, "utf8");
  return file;
}

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  (process.stdout as { write: unknown }).write = (c: string | Uint8Array) => { chunks.push(String(c)); return true; };
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    console.log = origLog;
    (process.stdout as { write: unknown }).write = origWrite;
  }
}

describe("skill usage telemetry (.usage.json)", () => {
  test("view ×2 + patch ×1 through skill_manage: exact counters, lastUsedAt advances", async () => {
    const home = await makeWorkspace("usage-");
    await putSkill(home, "csv-export", "## Procedure\nWrite the header first.\n");
    const state = newReviewState(1);
    const host = { workspace: home, agentikHome: home, reviewState: state };
    const view = { id: "v", tool: "skill_manage", args: { action: "view", name: "csv-export" }, proposedBy: "reviewer" as const };
    expect((await executeTool(view, host)).ok).toBe(true);
    const first = (await readSkillUsage({ home }))["csv-export"];
    expect(first.views).toBe(1);
    expect(first.patches).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    expect((await executeTool({ ...view, id: "v2" }, host)).ok).toBe(true);
    const patched = await executeTool(
      { id: "p", tool: "skill_manage", args: { action: "patch", name: "csv-export", old_string: "header first", new_string: "header first, then rows" }, proposedBy: "reviewer" },
      host,
    );
    expect(patched.ok).toBe(true);
    const u = (await readSkillUsage({ home }))["csv-export"];
    expect(u.views).toBe(2);
    expect(u.patches).toBe(1);
    expect(u.lastUsedAt).toBeDefined();
    expect(Date.parse(u.lastUsedAt!)).toBeGreaterThan(Date.parse(first.lastUsedAt!));
    expect(u.state).toBe("active");
    // A view of a skill that does not exist counts nothing.
    await executeTool({ id: "v3", tool: "skill_manage", args: { action: "view", name: "nope-skill" }, proposedBy: "reviewer" }, host);
    expect((await readSkillUsage({ home }))["nope-skill"]).toBeUndefined();
  });

  test("create through skill_manage records createdBy reviewer; skill approve records human", async () => {
    const home = await makeWorkspace("usage-create-");
    const state = newReviewState(1);
    const host = { workspace: home, agentikHome: home, reviewState: state };
    const body = "## When to use\nDrawer swipe bugs.\n## Procedure\n1. Read mobile-drawer-shell.\n## Pitfalls\nGhost clicks.\n## Verification\nbun test.";
    await executeTool({ id: "1", tool: "skill_manage", args: { action: "view", name: "pwa-drawer-swipe" }, proposedBy: "reviewer" }, host);
    const created = await executeTool({ id: "2", tool: "skill_manage", args: { action: "create", name: "pwa-drawer-swipe", description: "Drawer swipe rules.", body }, proposedBy: "reviewer" }, host);
    expect(created.ok).toBe(true);
    const u = await readSkillUsage({ home });
    expect(u["pwa-drawer-swipe"].createdBy).toBe("reviewer");
    expect(u["pwa-drawer-swipe"].createdAt).toBeDefined();

    expect(await main(["skill", "draft", "csv-export", "--description", "Export as CSV.", "export the leads", "--agentik-home", home])).toBe(0);
    expect(await main(["skill", "approve", "csv-export", "--agentik-home", home])).toBe(0);
    expect((await readSkillUsage({ home }))["csv-export"].createdBy).toBe("human");
  });

  test("agentik skills view <name> prints the body and counts one view; list shows state and counters", async () => {
    const home = await makeWorkspace("usage-cli-");
    await putSkill(home, "csv-export", "## Procedure\nBOM then rows.\n");
    const { code, out } = await captureStdout(() => main(["skills", "view", "csv-export", "--agentik-home", home]));
    expect(code).toBe(0);
    expect(out).toContain("BOM then rows.");
    expect((await readSkillUsage({ home }))["csv-export"].views).toBe(1);
    expect(await main(["skills", "view", "missing-skill", "--agentik-home", home])).toBe(1);
    const list = await captureStdout(() => main(["skills", "list", "--agentik-home", home]));
    expect(list.out).toContain("- csv-export [active, views 1, patches 0");
  });
});

/** A (viewed yesterday), B (31d), C (91d, never viewed), D (like C, pinned), E (like C, human). */
async function fiveSkills(home: string): Promise<void> {
  for (const n of ["skill-a", "skill-b", "skill-c", "skill-d", "skill-e"]) await putSkill(home, n);
  await writeSkillUsage(
    {
      "skill-a": { views: 3, patches: 0, lastUsedAt: daysAgo(1).toISOString() },
      "skill-b": { views: 1, patches: 0, lastUsedAt: daysAgo(31).toISOString() },
      "skill-c": { views: 0, patches: 0, createdBy: "reviewer", createdAt: daysAgo(91).toISOString() },
      "skill-d": { views: 0, patches: 0, createdBy: "reviewer", createdAt: daysAgo(91).toISOString() },
      "skill-e": { views: 0, patches: 0, createdBy: "human", createdAt: daysAgo(91).toISOString() },
    },
    { home },
  );
  await pinSkill("skill-d", { home });
}

describe("curator: stale after 30 days, archived after 90, never deleted, snapshot + ledger", () => {
  test("one pass: B/D/E stale, C archived, A untouched; dry-run changes nothing; second pass is idempotent", async () => {
    const home = await makeWorkspace("curate-");
    await fiveSkills(home);
    const snapshots = join(home, "skills", ".snapshots");

    const dry = await curateSkills({ home, dryRun: true, now: NOW });
    expect(dry.dryRun).toBe(true);
    expect(dry.actions.map((a) => `${a.name}:${a.from}>${a.to}`).sort()).toEqual([
      "skill-b:active>stale",
      "skill-c:active>archived",
      "skill-d:active>stale",
      "skill-e:active>stale",
    ]);
    expect(dry.stale).toBe(3);
    expect(dry.archived).toBe(1);
    expect(dry.untouched).toBe(1);
    expect(dry.snapshot).toBeUndefined();
    expect(existsSync(snapshots)).toBe(false);
    expect(existsSync(join(home, "skills", "skill-c", "SKILL.md"))).toBe(true);
    expect((await readSkillUsage({ home }))["skill-b"].state).toBeUndefined();
    expect(await readLedger({ home })).toEqual([]);

    const real = await curateSkills({ home, now: NOW });
    expect(real.actions).toHaveLength(4);
    expect(real.snapshot).toMatch(/^skills\/\.snapshots\/2026-09-01T12-00-00\.000Z\.tar\.gz$/);
    expect(existsSync(join(home, real.snapshot!))).toBe(true);
    expect(existsSync(join(home, "skills", "skill-c"))).toBe(false);
    expect(existsSync(join(home, "skills", ".archive", "skill-c", "SKILL.md"))).toBe(true);
    for (const n of ["skill-a", "skill-b", "skill-d", "skill-e"]) expect(existsSync(join(home, "skills", n, "SKILL.md"))).toBe(true);
    const usage = await readSkillUsage({ home });
    expect(usage["skill-a"].state).toBeUndefined();
    expect(usage["skill-b"].state).toBe("stale");
    expect(usage["skill-c"].state).toBe("archived");
    expect(usage["skill-d"].state).toBe("stale");
    expect(usage["skill-e"].state).toBe("stale");
    const ledger = (await readLedger({ home })).filter(isCurationEntry);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].snapshot).toBe(real.snapshot!);
    expect(ledger[0].actions).toHaveLength(4);
    expect(ledger[0].actions).toContainEqual({ name: "skill-c", from: "active", to: "archived" });
    // The snapshot holds the pre-pass tree: C is still a live skill inside it.
    const tarList = Bun.spawnSync(["tar", "-tzf", join(home, real.snapshot!)]);
    const members = tarList.stdout.toString();
    expect(members).toContain("./skill-c/SKILL.md");
    expect(members).not.toContain(".snapshots/");

    const again = await curateSkills({ home, now: NOW });
    expect(again.actions).toHaveLength(0);
    expect(again.snapshot).toBeUndefined();
    expect(await readdir(snapshots)).toHaveLength(1);
    expect(await readLedger({ home })).toHaveLength(1);
  });

  test("a stale skill that gets viewed again is active on the next pass; mtime is the fallback age", async () => {
    const home = await makeWorkspace("curate-revive-");
    await fiveSkills(home);
    await curateSkills({ home, now: NOW });
    await recordSkillUsage("skill-b", "view", { home, now: NOW });
    expect(await planCuration({ home, now: NOW })).toEqual([]);
    expect((await readSkillUsage({ home }))["skill-b"].state).toBe("active");
    // No usage record at all: the SKILL.md mtime decides.
    const file = await putSkill(home, "skill-old");
    await utimes(file, daysAgo(40), daysAgo(40));
    const plan = await planCuration({ home, now: NOW });
    expect(plan).toEqual([{ name: "skill-old", from: "active", to: "stale", reason: "40d since file mtime" }]);
  });

  test("rollback restores the archived skill and takes a safety snapshot first", async () => {
    const home = await makeWorkspace("curate-rollback-");
    await fiveSkills(home);
    const pass = await curateSkills({ home, now: NOW });
    expect(existsSync(join(home, "skills", "skill-c"))).toBe(false);
    const later = new Date(NOW.getTime() + 60_000);
    const r = await rollbackSkills(pass.snapshot!, { home, now: later });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.restored).toBe(pass.snapshot!);
    expect(r.safetySnapshot).not.toBe(pass.snapshot);
    expect(existsSync(join(home, r.safetySnapshot))).toBe(true);
    expect(existsSync(join(home, "skills", "skill-c", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "skills", ".archive", "skill-c"))).toBe(false);
    expect((await readSkillUsage({ home }))["skill-c"].state).toBeUndefined();
    expect((await readSkillUsage({ home }))["skill-b"].state).toBeUndefined();
    expect(existsSync(join(home, "skills", ".pinned"))).toBe(true);
    const ledger = (await readLedger({ home })).filter(isCurationEntry);
    expect(ledger).toHaveLength(2);
    expect(ledger[1].restored).toBe(pass.snapshot);
    expect(ledger[1].snapshot).toBe(r.safetySnapshot);
    // The safety snapshot captures the post-pass state (C under .archive).
    const members = Bun.spawnSync(["tar", "-tzf", join(home, r.safetySnapshot)]).stdout.toString();
    expect(members).toContain("./.archive/skill-c/SKILL.md");
    expect(await rollbackSkills("nope.tar.gz", { home })).toEqual({ error: "no such snapshot: nope.tar.gz" });
  });

  test("CLI: curate --dry-run, curate, --rollback, with thresholds", async () => {
    const home = await makeWorkspace("curate-cli-");
    await fiveSkills(home);
    const dry = await captureStdout(() => main(["skills", "curate", "--dry-run", "--agentik-home", home]));
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("curate (dry-run): 3 stale, 1 archived, 1 untouched — nothing changed, no snapshot taken");
    const real = await captureStdout(() => main(["skills", "curate", "--agentik-home", home]));
    expect(real.out).toMatch(/curate: 3 stale, 1 archived, 1 untouched — snapshot skills\/\.snapshots\/.*\.tar\.gz/);
    const snap = /snapshot (skills\/\.snapshots\/\S+\.tar\.gz)/.exec(real.out)![1];
    const rb = await captureStdout(() => main(["skills", "curate", "--rollback", snap, "--agentik-home", home]));
    expect(rb.code).toBe(0);
    expect(rb.out).toContain(`rollback: restored ${snap} — safety snapshot skills/.snapshots/`);
    expect(existsSync(join(home, "skills", "skill-c", "SKILL.md"))).toBe(true);
    // Looser thresholds: nothing is old enough.
    const loose = await captureStdout(() => main(["skills", "curate", "--stale-days", "365", "--archive-days", "999", "--agentik-home", home]));
    expect(loose.out).toContain("curate: 0 stale, 0 archived, 5 untouched — nothing to do, no snapshot taken");
  });
});
