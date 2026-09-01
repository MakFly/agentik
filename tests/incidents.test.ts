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
  recordIncident,
  resolveIncident,
  searchIncidents,
} from "../src/incidents.ts";
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
        goal: "push the release",
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
    const raw = await Bun.file(join(home, "sessions.sqlite")).text();
    expect(raw).not.toContain(token);
    const fixed = await resolveIncident(rec.id, `export API_KEY=${token}`, { home });
    expect(fixed?.fix).toMatch(/^\[BLOCKED:/);
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
