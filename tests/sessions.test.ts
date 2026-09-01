import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { agentikHome, resolveProfileHome } from "../src/home.ts";
import { readHot } from "../src/memory.ts";
import {
  formatSessionHit,
  migrateLegacyMemory,
  parseLegacySession,
  recordSession,
  searchSessions,
} from "../src/sessions.ts";
import { makeWorkspace } from "./helpers.ts";

describe("sessions.sqlite — searchable memory (FTS5 unicode61 + trigram)", () => {
  test("diacritics: « Clôturer » is found by cloturer and by clôturer", async () => {
    const home = await makeWorkspace("sess-diacritics-");
    await recordSession(
      { goal: "Clôturer le RAF migration 0021", status: "completed", artifacts: ["Makefile"], summary: "completed" },
      { home },
    );
    await recordSession({ goal: "unrelated ticket about CSS", status: "completed", summary: "x" }, { home });
    const plain = await searchSessions("cloturer", { home });
    const accented = await searchSessions("clôturer", { home });
    expect(plain.map((h) => h.goal)).toEqual(["Clôturer le RAF migration 0021"]);
    expect(accented.map((h) => h.goal)).toEqual(["Clôturer le RAF migration 0021"]);
    expect(formatSessionHit(plain[0])).toMatch(/^\[\d{4}-\d{2}-\d{2}\] Clôturer le RAF migration 0021 — completed$/);
  });

  test("trigram: a prefix (migrat) and a typo (drawr) still find the session", async () => {
    const home = await makeWorkspace("sess-trigram-");
    await recordSession({ goal: "revert sessions, migration 0021, PWA drawer fixes", status: "completed", summary: "s" }, { home });
    await recordSession({ goal: "build a CVE site under nextjs", status: "completed", summary: "s" }, { home });
    expect((await searchSessions("migrat", { home })).map((h) => h.goal)).toEqual([
      "revert sessions, migration 0021, PWA drawer fixes",
    ]);
    expect((await searchSessions("drawr", { home })).map((h) => h.goal)).toEqual([
      "revert sessions, migration 0021, PWA drawer fixes",
    ]);
    // A token hit ranks above a fuzzy-only hit.
    const mixed = await searchSessions("nextjs drawr", { home });
    expect(mixed[0].goal).toBe("build a CVE site under nextjs");
    expect(mixed).toHaveLength(2);
  });

  test("workspace filter hides other workspaces by default; --all lifts it", async () => {
    const home = await makeWorkspace("sess-ws-");
    await recordSession({ goal: "deploy umami on /tmp/a", workspace: "/tmp/a", status: "completed", summary: "s" }, { home });
    await recordSession({ goal: "deploy grafana on /tmp/b", workspace: "/tmp/b", status: "completed", summary: "s" }, { home });
    const b = await searchSessions("deploy", { home, workspace: "/tmp/b" });
    expect(b.map((h) => h.workspace)).toEqual(["/tmp/b"]);
    const all = await searchSessions("deploy", { home, workspace: "/tmp/b", all: true });
    expect(all).toHaveLength(2);
    // Unknown-workspace sessions (migrated ones) are never hidden.
    await recordSession({ goal: "deploy legacy row", status: "completed", summary: "s" }, { home });
    const withLegacy = await searchSessions("deploy", { home, workspace: "/tmp/b" });
    expect(withLegacy.map((h) => h.goal).sort()).toEqual(["deploy grafana on /tmp/b", "deploy legacy row"]);
    const limited = await searchSessions("deploy", { home, all: true, limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test("an FTS5-invalid query is escaped, not a crash", async () => {
    const home = await makeWorkspace("sess-invalid-");
    await recordSession({ goal: 'fix "unbalanced quote parsing', status: "completed", summary: "s" }, { home });
    await expect(searchSessions('"unbalanced', { home })).resolves.toHaveLength(1);
    await expect(searchSessions('AND OR NOT "*^ (', { home })).resolves.toEqual([]);
    await expect(searchSessions("unbalanced*", { home })).resolves.toHaveLength(1);
    await expect(searchSessions("   ", { home })).resolves.toEqual([]);
  });

  test("no store yet: search is empty and creates nothing", async () => {
    const home = await makeWorkspace("sess-empty-");
    expect(await searchSessions("anything", { home })).toEqual([]);
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(false);
  });
});

describe("migration of the legacy stores", () => {
  test("(session) lines leave HOT for sessions.sqlite, with a backup, once", async () => {
    const home = await makeWorkspace("sess-migrate-");
    await mkdir(join(home, "memory"), { recursive: true });
    const hotPath = join(home, "memory", "MEMORY.md");
    await writeFile(
      hotPath,
      [
        "# MEMORY",
        "- (session) session: Clôturer le RAF openhermesbot-web [completed] artifacts=Makefile,apps/web/src/a.ts",
        "- (fact) this repo uses bun test not jest",
        "- (session) session: 1 commit & push [completed] artifacts=none",
        "- (session) session: crée une US dans opentrack pour la sidebar [stalled] artifacts=opentrack:OHB-17",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = await migrateLegacyMemory({ home });
    expect(res).toMatchObject({ ran: true, fromHot: 3, fromNotes: 0 });
    expect(res.backup).toMatch(/MEMORY\.md\.bak\./);
    expect(existsSync(res.backup!)).toBe(true);
    expect(await readFile(res.backup!, "utf8")).toContain("(session) session: 1 commit");
    const hot = await readFile(hotPath, "utf8");
    expect(hot).toBe("# MEMORY\n- (fact) this repo uses bun test not jest\n");
    expect(existsSync(join(home, "memory", ".migrated-v1"))).toBe(true);

    const db = new Database(join(home, "sessions.sqlite"), { readonly: true });
    const rows = db.query("SELECT goal, status, artifacts, workspace FROM sessions ORDER BY id").all() as Array<{
      goal: string;
      status: string;
      artifacts: string;
      workspace: string;
    }>;
    db.close();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      goal: "Clôturer le RAF openhermesbot-web",
      status: "completed",
      artifacts: JSON.stringify(["Makefile", "apps/web/src/a.ts"]),
      workspace: "",
    });
    expect(rows[1]).toMatchObject({ goal: "1 commit & push", artifacts: "[]" });
    expect(rows[2]).toMatchObject({ status: "stalled", artifacts: JSON.stringify(["opentrack:OHB-17"]) });
    // Searchable right away, diacritics folded.
    expect((await searchSessions("cloturer", { home })).map((h) => h.goal)).toEqual(["Clôturer le RAF openhermesbot-web"]);

    // Replay: no-op, no second backup, HOT untouched.
    const again = await migrateLegacyMemory({ home });
    expect(again).toEqual({ ran: false, fromHot: 0, fromNotes: 0 });
    const backups = (await readdir(join(home, "memory"))).filter((f) => f.includes(".bak."));
    expect(backups).toHaveLength(1);
    expect(await readFile(hotPath, "utf8")).toBe("# MEMORY\n- (fact) this repo uses bun test not jest\n");
  });

  test("kind='session' rows of notes.sqlite are imported; the file stays", async () => {
    const home = await makeWorkspace("sess-migrate-notes-");
    await mkdir(join(home, "memory"), { recursive: true });
    const notesPath = join(home, "memory", "notes.sqlite");
    const notes = new Database(notesPath, { create: true });
    notes.run("CREATE VIRTUAL TABLE notes USING fts5(kind, body, created_at, tokenize='porter')");
    notes.run("INSERT INTO notes (kind, body, created_at) VALUES (?, ?, ?)", [
      "session",
      "session: build a CVE site under nextjs [completed] artifacts=app/page.tsx,README.md",
      "2026-08-31T10:00:00.000Z",
    ]);
    notes.run("INSERT INTO notes (kind, body, created_at) VALUES (?, ?, ?)", ["lesson", "not a session", "2026-08-31T10:00:00.000Z"]);
    notes.close();
    const res = await migrateLegacyMemory({ home });
    expect(res).toMatchObject({ ran: true, fromHot: 0, fromNotes: 1, backup: undefined });
    expect(existsSync(notesPath)).toBe(true);
    const hits = await searchSessions("nextjs", { home });
    expect(hits).toHaveLength(1);
    expect(hits[0].createdAt).toBe("2026-08-31T10:00:00.000Z");
    expect(hits[0].artifacts).toEqual(["app/page.tsx", "README.md"]);
    // readHot triggers the same migration path and sees no HOT: still a no-op.
    expect(await readHot({ home })).toBe("");
  });

  test("nothing to migrate: no marker, no store", async () => {
    const home = await makeWorkspace("sess-migrate-none-");
    expect(await migrateLegacyMemory({ home })).toEqual({ ran: false, fromHot: 0, fromNotes: 0 });
    expect(existsSync(join(home, "memory"))).toBe(false);
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(false);
  });

  test("parseLegacySession tolerates missing parts", () => {
    expect(parseLegacySession("session: only a goal")).toMatchObject({ goal: "only a goal", status: "unknown", artifacts: [] });
    expect(parseLegacySession("session: g [completed] artifacts=none")).toMatchObject({ goal: "g", status: "completed", artifacts: [] });
  });
});

describe("profiles", () => {
  test("default is ~/.agentik, any other name is ~/.agentik/profiles/<name>", () => {
    expect(resolveProfileHome("default")).toBe(join(homedir(), ".agentik"));
    expect(resolveProfileHome("work")).toBe(join(homedir(), ".agentik", "profiles", "work"));
    expect(() => resolveProfileHome("../escape")).toThrow(/invalid profile/);
  });

  test("AGENTIK_PROFILE is respected; override and AGENTIK_HOME win over it", () => {
    const prevProfile = process.env.AGENTIK_PROFILE;
    const prevHome = process.env.AGENTIK_HOME;
    try {
      delete process.env.AGENTIK_HOME;
      process.env.AGENTIK_PROFILE = "work";
      expect(resolveProfileHome()).toBe(join(homedir(), ".agentik", "profiles", "work"));
      expect(agentikHome()).toBe(join(homedir(), ".agentik", "profiles", "work"));
      expect(agentikHome(undefined, "perso")).toBe(join(homedir(), ".agentik", "profiles", "perso"));
      process.env.AGENTIK_HOME = "/tmp/explicit-home";
      expect(agentikHome(undefined, "perso")).toBe("/tmp/explicit-home");
      expect(agentikHome("/tmp/override", "perso")).toBe("/tmp/override");
      delete process.env.AGENTIK_PROFILE;
      delete process.env.AGENTIK_HOME;
      expect(agentikHome()).toBe(join(homedir(), ".agentik"));
    } finally {
      if (prevProfile === undefined) delete process.env.AGENTIK_PROFILE;
      else process.env.AGENTIK_PROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.AGENTIK_HOME;
      else process.env.AGENTIK_HOME = prevHome;
    }
  });
});
