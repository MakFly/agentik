import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  classifyIncident,
  formatIncidentHit,
  getIncident,
  listIncidents,
  mergeIncidents,
  normalizeSymptom,
  SYMPTOM_CLASS_MAX,
  symptomClass,
  recordIncident,
  resolveIncident,
  searchIncidents,
} from "../src/incidents.ts";
import { memoryPaths } from "../src/home.ts";
import { recordSession, searchSessions } from "../src/sessions.ts";
import { makeWorkspace } from "./helpers.ts";

describe("incidents — the failure log (same sessions.sqlite, FTS5 unicode61 + trigram)", () => {
  test("insert: a failure lands with seen=1, unresolved, next to the sessions", async () => {
    const home = await makeWorkspace("inc-insert-");
    const rec = await recordIncident(
      {
        goal: "implement the drawer",
        workspace: "/tmp/ws-a",
        profile: "default",
        harness: "codex",
        backend: "codex",
        exitCode: 125,
        stopReason: "turn.failed",
        errors: ["adapter_eof"],
        symptom: "codex never reported a completed turn",
      },
      { home },
    );
    expect(rec.id).toBe(1);
    expect(rec.seen).toBe(1);
    expect(rec.resolvedAt).toBeNull();
    expect(rec.exitCode).toBe(125);
    expect(rec.errors).toEqual(["adapter_eof"]);
    expect(rec.firstAt).toBe(rec.lastAt);
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(true);
    // Sessions keep working in the same file.
    await recordSession({ goal: "implement the drawer", status: "failed", summary: "s" }, { home });
    expect(await searchSessions("drawer", { home })).toHaveLength(1);
    expect(await listIncidents({ home })).toHaveLength(1);
  });

  test("dedup: same workspace + harness + normalized symptom increments seen and merges errors", async () => {
    const home = await makeWorkspace("inc-dedup-");
    const base = { goal: "g", workspace: "/tmp/ws-a", harness: "claude", errors: ["first"] };
    const a = await recordIncident({ ...base, symptom: "claude killed after 1800s (timeout)" }, { home });
    const b = await recordIncident(
      { ...base, symptom: "  Claude   killed after 900s (timeout) ", errors: ["first", "second"] },
      { home },
    );
    expect(b.id).toBe(a.id);
    expect(b.seen).toBe(2);
    expect(b.errors).toEqual(["first", "second"]);
    expect(b.lastAt >= a.lastAt).toBe(true);
    expect(normalizeSymptom("Claude killed after 900s")).toBe("claude killed after #s");
    // Another harness or another workspace is another incident.
    const c = await recordIncident({ ...base, harness: "codex", symptom: "codex killed after 1800s (timeout)" }, { home });
    expect(c.id).not.toBe(a.id);
    const d = await recordIncident({ ...base, workspace: "/tmp/ws-b", symptom: "claude killed after 1800s (timeout)" }, { home });
    expect(d.id).not.toBe(a.id);
    expect(d.seen).toBe(1);
  });

  test("a resolved incident does not absorb a new occurrence: a new row opens", async () => {
    const home = await makeWorkspace("inc-resolved-");
    const first = await recordIncident({ goal: "g", harness: "grok", symptom: "grok ended on stopReason=max_turns" }, { home });
    const resolved = await resolveIncident(first.id, "raise --max-turns", { home });
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.fix).toBe("raise --max-turns");
    const again = await recordIncident({ goal: "g", harness: "grok", symptom: "grok ended on stopReason=max_turns" }, { home });
    expect(again.id).not.toBe(first.id);
    expect(again.seen).toBe(1);
    expect(again.resolvedAt).toBeNull();
    expect(await listIncidents({ home })).toHaveLength(1);
    expect(await listIncidents({ home, includeResolved: true })).toHaveLength(2);
  });

  test("secrets are masked at write time: the raw token never reaches the disk", async () => {
    const home = await makeWorkspace("inc-secret-");
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
    const rec = await recordIncident(
      {
        goal: `push the release with ${token}`,
        harness: "codex",
        errors: [`auth failed with token ${token}`, "second error"],
        symptom: `bearer: ${token} rejected by the API`,
        cause: `password = ${token}`,
      },
      { home },
    );
    expect(rec.errors[0]).toMatch(/^\[BLOCKED: looks like a secret/);
    expect(rec.errors[1]).toBe("second error");
    expect(rec.symptom).toMatch(/^\[BLOCKED: looks like a secret/);
    expect(rec.cause).toMatch(/^\[BLOCKED:/);
    expect(rec.goal).toMatch(/^\[BLOCKED:/);
    const raw = await Bun.file(join(home, "sessions.sqlite")).text();
    expect(raw).not.toContain(token);
    const fixed = await resolveIncident(rec.id, `export API_KEY=${token}`, { home });
    expect(fixed?.fix).toMatch(/^\[BLOCKED:/);
  });

  test("an anthropic key in the symptom is masked at write: the raw sk-ant token never reaches sessions.sqlite", async () => {
    const home = await makeWorkspace("inc-secret-ant-");
    const token = "sk-ant-api03-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIj";
    const rec = await recordIncident(
      {
        goal: "call the API from the worker",
        harness: "claude",
        errors: ["401 unauthorized"],
        symptom: `authentication_error: invalid x-api-key ${token}`,
      },
      { home },
    );
    expect(rec.symptom).toBe("[BLOCKED: looks like a secret (anthropic_key)]");
    expect(rec.goal).toBe("call the API from the worker");
    expect(rec.errors).toEqual(["401 unauthorized"]);
    const raw = await Bun.file(join(home, "sessions.sqlite")).text();
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("sk-ant-api03");
    expect((await getIncident(rec.id, { home }))?.symptom).toBe("[BLOCKED: looks like a secret (anthropic_key)]");
  });

  test("FTS: « clôturer » is found via cloturer and the prefix migrat; a token hit outranks a fuzzy one", async () => {
    const home = await makeWorkspace("inc-fts-");
    await recordIncident({ goal: "Clôturer le RAF migration 0021", harness: "codex", symptom: "codex exited 1" }, { home });
    await recordIncident({ goal: "unrelated CSS ticket", harness: "codex", symptom: "codex exited 1 on nextjs build" }, { home });
    expect((await searchIncidents("cloturer", { home })).map((h) => h.goal)).toEqual(["Clôturer le RAF migration 0021"]);
    expect((await searchIncidents("clôturer", { home })).map((h) => h.goal)).toEqual(["Clôturer le RAF migration 0021"]);
    expect((await searchIncidents("migrat", { home })).map((h) => h.goal)).toEqual(["Clôturer le RAF migration 0021"]);
    const mixed = await searchIncidents("nextjs migrat", { home });
    expect(mixed).toHaveLength(2);
    expect(mixed[0].goal).toBe("unrelated CSS ticket");
    expect(await searchIncidents('AND OR NOT "*^ (', { home })).toEqual([]);
  });

  test("search: workspace filter never hides unknown-workspace rows; minSeen, unresolvedOnly, harness, order", async () => {
    const home = await makeWorkspace("inc-search-");
    await recordIncident({ goal: "deploy umami", workspace: "/tmp/a", harness: "codex", symptom: "deploy failed on a" }, { home });
    const b1 = await recordIncident({ goal: "deploy grafana", workspace: "/tmp/b", harness: "claude", symptom: "deploy failed on b" }, { home });
    await recordIncident({ goal: "deploy grafana", workspace: "/tmp/b", harness: "claude", symptom: "deploy failed on b" }, { home });
    await recordIncident({ goal: "deploy legacy", harness: "grok", symptom: "deploy failed nowhere" }, { home });
    const b = await searchIncidents("deploy", { home, workspace: "/tmp/b", limit: 10 });
    expect(b.map((h) => h.goal)).toEqual(["deploy grafana", "deploy legacy"]);
    expect(b[0].seen).toBe(2);
    expect((await searchIncidents("deploy", { home, workspace: "/tmp/b", minSeen: 2 })).map((h) => h.id)).toEqual([b1.id]);
    expect((await searchIncidents("deploy", { home, harness: "grok" })).map((h) => h.goal)).toEqual(["deploy legacy"]);
    await resolveIncident(b1.id, "use the right kubeconfig", { home });
    expect((await searchIncidents("deploy", { home, workspace: "/tmp/b" })).map((h) => h.goal)).toEqual(["deploy legacy"]);
    expect((await searchIncidents("deploy", { home, workspace: "/tmp/b", unresolvedOnly: false })).map((h) => h.goal)).toEqual([
      "deploy grafana",
      "deploy legacy",
    ]);
    expect(await searchIncidents("deploy", { home, limit: 0 })).toEqual([]);
  });

  test("no store yet: search and list are empty and create nothing", async () => {
    const home = await makeWorkspace("inc-empty-");
    expect(await searchIncidents("anything", { home })).toEqual([]);
    expect(await listIncidents({ home })).toEqual([]);
    expect(await getIncident(1, { home })).toBeNull();
    expect(await resolveIncident(1, "x", { home })).toBeNull();
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(false);
  });

  test("resolve / classify / merge", async () => {
    const home = await makeWorkspace("inc-ops-");
    const a = await recordIncident({ goal: "g", harness: "codex", errors: ["e1"], symptom: "adapter_eof on --output-schema" }, { home });
    await recordIncident({ goal: "g", harness: "codex", symptom: "adapter_eof on --output-schema" }, { home });
    const b = await recordIncident({ goal: "g2", harness: "codex", errors: ["e2"], symptom: "codex turn.failed adapter_eof" }, { home });
    const classified = await classifyIncident(a.id, "opencodex responses adapter rejects --output-schema", { home });
    expect(classified?.cause).toBe("opencodex responses adapter rejects --output-schema");
    expect(classified?.resolvedAt).toBeNull();
    const merged = await mergeIncidents(a.id, b.id, { home });
    expect(merged?.id).toBe(a.id);
    expect(merged?.seen).toBe(3);
    expect(merged?.firstAt).toBe(a.firstAt);
    expect(merged?.errors).toEqual(["e1", "e2"]);
    expect(await getIncident(b.id, { home })).toBeNull();
    expect(await mergeIncidents(a.id, a.id, { home })).toBeNull();
    expect(await mergeIncidents(a.id, 999, { home })).toBeNull();
    const resolved = await resolveIncident(a.id, "AGENTIK_CODEX_OUTPUT_SCHEMA=never", { home });
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.fix).toBe("AGENTIK_CODEX_OUTPUT_SCHEMA=never");
    expect(await classifyIncident(999, "x", { home })).toBeNull();
    // listIncidents: since + workspace
    await recordIncident({ goal: "g3", workspace: "/tmp/x", harness: "grok", symptom: "later one" }, { home });
    expect((await listIncidents({ home, workspace: "/tmp/y" })).map((r) => r.goal)).toEqual([]);
    expect((await listIncidents({ home, workspace: "/tmp/x" })).map((r) => r.goal)).toEqual(["g3"]);
    expect(await listIncidents({ home, since: "2999-01-01T00:00:00.000Z", includeResolved: true })).toEqual([]);
  });

  test("formatIncidentHit: one line, @backend only when it differs, fix only when set", () => {
    const base = { harness: "codex", backend: "opencodex", symptom: "adapter_eof on --output-schema", seen: 4, lastAt: "2026-09-01T10:00:00.000Z", fix: "AGENTIK_CODEX_OUTPUT_SCHEMA=never" };
    expect(formatIncidentHit(base)).toBe(
      "⚠ codex@opencodex · adapter_eof on --output-schema · seen 4× · last 2026-09-01 · fix: AGENTIK_CODEX_OUTPUT_SCHEMA=never",
    );
    expect(formatIncidentHit({ ...base, backend: "codex", fix: "" })).toBe("⚠ codex · adapter_eof on --output-schema · seen 4× · last 2026-09-01");
    expect(formatIncidentHit({ ...base, harness: "", backend: "", fix: "" })).toBe("⚠ adapter_eof on --output-schema · seen 4× · last 2026-09-01");
  });
});

describe("incidents FTS: an index created over an already-populated table is rebuilt once", () => {
  test("dropping the FTS tables and reopening finds the old rows again", async () => {
    const home = await makeWorkspace("incidents-rebuild-");
    const rec = await recordIncident({ goal: "deploy", symptom: "adapter_eof on opencodex", harness: "codex", workspace: "/w" }, { home });
    expect((await searchIncidents("opencodex", { home, workspace: "/w" })).map((i) => i.id)).toEqual([rec.id]);
    const db = new Database(memoryPaths(home).sessionsDb);
    for (const name of ["incidents_fts", "incidents_fts_tri"]) {
      for (const t of ["ai", "ad", "au"]) db.run(`DROP TRIGGER IF EXISTS ${name}_${t}`);
      db.run(`DROP TABLE IF EXISTS ${name}`);
    }
    db.close();
    expect((await searchIncidents("opencodex", { home, workspace: "/w" })).map((i) => i.id)).toEqual([rec.id]);
    expect((await searchIncidents("opencodx", { home, workspace: "/w" })).map((i) => i.id)).toEqual([rec.id]);
  });
});

/**
 * The bug this block exists for, measured on the owner's own home: after a whole day of real
 * failures `agentik postmortem` showed ONE incident, `seen 1×`. The dedup key was the symptom,
 * and for a claude worker that dies the symptom is the CLI's error object — whose first field is
 * a fresh `session_id` UUID. 200 characters of key were spent on an identifier that is unique by
 * construction (and its hex letters survived the digit folding), so two occurrences of the SAME
 * failure opened two rows at `seen 1`. `agentik context` only shows KNOWN FAILURES from
 * `seen >= 2` and the review prompt calls `seen 1` noise: nothing was ever learned.
 */
describe("incidents — the dedup key is a failure CLASS, not the payload", () => {
  const claudeFailure = (session: string, at: string, ms: number) =>
    `stalled worker_a@claude-sonnet: exit: claude -p failed (1): {"type":"result","subtype":"error_during_execution",` +
    `"is_error":true,"duration_ms":${ms},"num_turns":7,"session_id":"${session}","timestamp":"${at}"}`;

  test("two occurrences of one claude failure with different session ids are ONE incident seen 2×", async () => {
    const home = await makeWorkspace("inc-class-");
    const base = { goal: "fix the drawer", workspace: "/tmp/ws-class", harness: "claude-sonnet" };
    const one = claudeFailure("6f3a1b2c-1111-4aaa-8bbb-0123456789ab", "2026-09-03T10:11:12.345Z", 41233);
    const two = claudeFailure("d40e77aa-2222-4ccc-9ddd-fedcba987654", "2026-09-03T14:02:00.000Z", 9821);
    const a = await recordIncident({ ...base, symptom: one }, { home });
    const b = await recordIncident({ ...base, symptom: two }, { home });

    expect(b.id).toBe(a.id);
    expect(b.seen).toBe(2);
    // The row carries the class, short enough for the KNOWN FAILURES line (cap 60 there).
    expect(b.symptom).toBe("stalled worker_a@claude-sonnet: exit: claude -p failed (1)");
    // …and the payload of BOTH occurrences is still readable, in the errors.
    expect(b.errors).toEqual([one, two]);
    expect(await listIncidents({ home })).toHaveLength(1);
    // seen >= 2 is exactly the threshold agentik context uses for KNOWN FAILURES.
    expect((await searchIncidents("claude", { home, workspace: "/tmp/ws-class", minSeen: 2 })).map((h) => h.id)).toEqual([a.id]);
  });

  test("a payload that is not JSON still dedups: the UUID, the ISO stamp and the sha are folded in the key", async () => {
    const home = await makeWorkspace("inc-fold-");
    const base = { goal: "g", workspace: "/tmp/ws-fold", harness: "claude" };
    const a = await recordIncident(
      { ...base, symptom: "claude -p failed (1): API Error: request 6f3a1b2c-1111-4aaa-8bbb-0123456789ab at 2026-09-03T10:11:12.345Z on 9f1c3ade4b77 failed" },
      { home },
    );
    const b = await recordIncident(
      { ...base, symptom: "claude -p failed (1): API Error: request d40e77aa-2222-4ccc-9ddd-fedcba987654 at 2026-09-04T22:59:01.000Z on 0badc0ffee11 failed" },
      { home },
    );
    expect(b.id).toBe(a.id);
    expect(b.seen).toBe(2);

    expect(normalizeSymptom("run 20260903T101112Z-a1b2c3 at 2026-09-03T10:11:12.345Z")).toBe("run <ts>-<id> at <ts>");
    expect(normalizeSymptom("session 6F3A1B2C-1111-4AAA-8BBB-0123456789AB died")).toBe("session <id> died");
    expect(normalizeSymptom("sha 9f1c3ade4b77e0 and token ab12cd34ef56gh78")).toBe("sha <id> and token <id>");
    // Unchanged where it was already right: a plain digit run, a model name, an English word.
    expect(normalizeSymptom("Claude killed after 900s")).toBe("claude killed after #s");
    expect(normalizeSymptom("claude-sonnet-4-5 refused")).toBe("claude-sonnet-#-# refused");
    expect(normalizeSymptom("the deadbeef facade decoded")).toBe("the deadbeef facade decoded");
  });

  test("symptomClass: cuts the payload, keeps the headline, never empties a [BLOCKED: …] symptom", () => {
    expect(symptomClass('stalled worker_a@claude-sonnet: exit: claude -p failed (1): {"type":"result"}')).toBe(
      "stalled worker_a@claude-sonnet: exit: claude -p failed (1)",
    );
    expect(symptomClass('codex turn.failed: [{"error":"adapter_eof"}]')).toBe("codex turn.failed");
    expect(symptomClass("  claude   killed after 1800s (timeout) ")).toBe("claude killed after 1800s (timeout)");
    expect(symptomClass("[BLOCKED: looks like a secret (anthropic_key)]")).toBe("[BLOCKED: looks like a secret (anthropic_key)]");
    const long = `grok failed: ${"detail ".repeat(40)}end`;
    const cut = symptomClass(long);
    expect(cut.length).toBeLessThanOrEqual(SYMPTOM_CLASS_MAX + 1);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.startsWith("grok failed: detail")).toBe(true);
  });

  test("two different classes stay two incidents: a timeout is not an exit", async () => {
    const home = await makeWorkspace("inc-distinct-");
    const base = { goal: "g", workspace: "/tmp/ws-d", harness: "claude" };
    const a = await recordIncident({ ...base, symptom: 'claude -p killed after 600s (timeout); its answer is incomplete: {"session_id":"6f3a1b2c-1111-4aaa-8bbb-0123456789ab"}' }, { home });
    const b = await recordIncident({ ...base, symptom: 'claude -p failed (1): {"session_id":"6f3a1b2c-1111-4aaa-8bbb-0123456789ab"}' }, { home });
    expect(b.id).not.toBe(a.id);
    expect(await listIncidents({ home })).toHaveLength(2);
    // A class long enough to be cut is still stable: the tail that grows is not the key.
    const long = `grok failed: ${"detail ".repeat(40)}end`;
    const e = await recordIncident({ ...base, symptom: long }, { home });
    const f = await recordIncident({ ...base, symptom: `${long} and more` }, { home });
    expect(f.id).toBe(e.id);
    expect(f.seen).toBe(2);
    expect(await listIncidents({ home })).toHaveLength(3);
  });

  test("a legacy row whose symptom is a full blob absorbs the next occurrence instead of opening a new one", async () => {
    const home = await makeWorkspace("inc-legacy-");
    const blob = claudeFailure("6f3a1b2c-1111-4aaa-8bbb-0123456789ab", "2026-09-03T10:11:12.345Z", 41233);
    // Seed the row the OLD code would have written: the whole payload in `symptom`.
    const seed = await recordIncident({ goal: "g", workspace: "/tmp/ws-legacy", harness: "claude", symptom: "placeholder" }, { home });
    const db = new Database(memoryPaths(home).sessionsDb);
    db.run("UPDATE incidents SET symptom = ? WHERE id = ?", [blob, seed.id]);
    db.close();
    const next = await recordIncident(
      { goal: "g", workspace: "/tmp/ws-legacy", harness: "claude", symptom: claudeFailure("d40e77aa-2222-4ccc-9ddd-fedcba987654", "2026-09-04T01:02:03.000Z", 12) },
      { home },
    );
    expect(next.id).toBe(seed.id);
    expect(next.seen).toBe(2);
  });

  test("the read-modify-write is a transaction: 8 real processes racing from an empty key leave ONE incident, seen 8×", async () => {
    const home = await makeWorkspace("inc-race-");
    const workspace = "/tmp/ws-race";
    const src = join(import.meta.dir, "..", "src", "incidents.ts");
    // Create the schema first with ANOTHER class: the race under test is the dedup read-modify-
    // write, not the DDL. The class the 8 processes report has no open row when they start —
    // which is exactly the shape that used to insert N rows: they all read "nothing open".
    await recordIncident({ goal: "g", workspace, harness: "claude", symptom: "claude killed after 600s (timeout)" }, { home });
    const startAt = Date.now() + 1500;
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const { recordIncident } = await import(${JSON.stringify(src)});
           // A wall-clock barrier: bun's own startup would otherwise stagger the 8 writers.
           while (Date.now() < ${startAt} - 20) await Bun.sleep(1);
           while (Date.now() < ${startAt}) {}
           const s = ${JSON.stringify(claudeFailure("$SESSION", "$STAMP", 0))}
             .replace("$SESSION", "6f3a1b2c-1111-4aaa-8bbb-01234567890" + ${i})
             .replace("$STAMP", "2026-09-0" + ${i} + "T10:11:12.345Z");
           await recordIncident({ goal: "g", workspace: ${JSON.stringify(workspace)}, harness: "claude", symptom: s }, { home: ${JSON.stringify(home)} });`,
        ],
        { env: { ...process.env, AGENTIK_INDEX_AUTO: "0" }, stdout: "pipe", stderr: "pipe" },
      ),
    );
    const ran = await Promise.all(
      procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })),
    );
    expect(ran.filter((r) => r.code !== 0).map((r) => r.err.trim())).toEqual([]);
    const all = await listIncidents({ home });
    const stalled = all.filter((r) => r.symptom.startsWith("stalled"));
    expect(stalled.map((r) => r.symptom)).toEqual(["stalled worker_a@claude-sonnet: exit: claude -p failed (1)"]);
    expect(stalled[0].seen).toBe(8);
    // The 8 distinct payloads are all still readable, in the errors of that one row.
    expect(stalled[0].errors).toHaveLength(8);
    expect(all).toHaveLength(2);
  }, 60_000);
});
