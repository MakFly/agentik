#!/usr/bin/env bun
/**
 * The 20 themed agent files (Korben.md, Luke.md, …) are GENERATED from the 5 canonical
 * `agentik-worker-<letter>.md`: same tools, same model, same body — only `name` and
 * `description` differ. Before this script they were hand-written copies and drifted
 * (the canonical slots got `SendMessage` and the peer-talk section, the themed names did not).
 *
 *   bun harness/sync-agents.ts          # rewrite the 20 files
 *   bun harness/sync-agents.ts --check  # exit 1 and name the stale file(s), write nothing
 *
 * `tests/harness.test.ts` runs the `--check` form, so a drift fails the suite.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CREW_NAMES, FRANCHISE_LABELS, SUBAGENT_ROLES } from "../src/types.ts";

export const AGENTS_DIR = join(import.meta.dir, "agents");

export function themedFile(name: string): string {
  return `${name.replace(/ /g, "-")}.md`;
}

/** Split a SKILL/agent markdown into its frontmatter lines and its body (after the closing ---). */
function split(md: string): { front: string[]; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("agent file without frontmatter");
  return { front: m[1].split("\n"), body: m[2] };
}

/** Frontmatter keys other than name/description, in file order. */
function keepKeys(front: string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of front) {
    if (/^(name|description):/.test(line)) { skipping = line.startsWith("description:") && /:\s*>?\s*$/.test(line); continue; }
    if (skipping && /^\s+/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out;
}

export function renderThemed(role: (typeof SUBAGENT_ROLES)[number], franchise: keyof typeof FRANCHISE_LABELS, canonical: string): string {
  const slot = CREW_NAMES[role];
  const letter = role.slice(-1);
  const name = slot[franchise];
  const others = (Object.keys(FRANCHISE_LABELS) as Array<keyof typeof FRANCHISE_LABELS>)
    .filter((f) => f !== franchise)
    .map((f) => `${slot[f]} (${FRANCHISE_LABELS[f]})`)
    .join(", ");
  const last = role === "worker_e" ? "Last of 5, never a 6th agent." : "Not a 6th agent.";
  const { front, body } = split(canonical);
  const head = [
    "---",
    `name: ${name}`,
    "description: >",
    `  ${FRANCHISE_LABELS[franchise]} name for ${slot.job} slot ${letter}. Same slot as ${others},`,
    `  agentik-worker-${letter}. ${last}`,
    ...keepKeys(front),
    "---",
  ];
  return `${head.join("\n")}\n${body}`;
}

export function expectedThemed(): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const role of SUBAGENT_ROLES) {
    const canonical = readFileSync(join(AGENTS_DIR, `agentik-worker-${role.slice(-1)}.md`), "utf8");
    for (const f of Object.keys(FRANCHISE_LABELS) as Array<keyof typeof FRANCHISE_LABELS>) {
      out.push({ file: themedFile(CREW_NAMES[role][f]), content: renderThemed(role, f, canonical) });
    }
  }
  return out;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale: string[] = [];
  for (const { file, content } of expectedThemed()) {
    const path = join(AGENTS_DIR, file);
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch { /* absent */ }
    if (current === content) continue;
    stale.push(file);
    if (!check) writeFileSync(path, content);
  }
  if (check && stale.length) {
    console.error(`sync-agents: ${stale.length} themed agent file(s) differ from their canonical slot: ${stale.join(", ")}\n  run: bun harness/sync-agents.ts`);
    process.exit(1);
  }
  console.log(check ? "sync-agents: 20 themed files in sync" : `sync-agents: ${stale.length} file(s) rewritten`);
}
