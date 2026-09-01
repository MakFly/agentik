import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CREW_NAMES,
  FRANCHISE_LABELS,
  MAX_SUBAGENTS,
  SUBAGENT_ROLES,
  normalizeWorkerRole,
} from "../src/types.ts";

const root = join(import.meta.dir, "..");
const skill = join(root, "harness/skill/SKILL.md");
const akSkill = join(root, "harness/ak/SKILL.md");
const home = homedir();
const agentsDir = join(root, "harness/agents");

function themedFile(name: string): string {
  return `${name.replace(/ /g, "-")}.md`;
}

describe("harness install (Claude / Grok / Codex)", () => {
  test("canonical skill names the three harnesses and the 5-subagent cap", () => {
    const body = readFileSync(skill, "utf8");
    expect(body).toContain("name: agentik");
    expect(body).toContain("Claude");
    expect(body).toContain("Grok");
    expect(body).toContain("Codex");
    expect(body).toContain("cla");
    expect(body).toContain("grok --yolo");
    expect(body).toContain("Never 6");
    expect(body).toContain("agentik-worker-a");
    expect(body).toContain("agentik-worker-e");
    expect(MAX_SUBAGENTS).toBe(5);
    expect(SUBAGENT_ROLES).toHaveLength(5);
  });

  test("each of 5 slots has Fifth Element, Star Wars, Matrix, and Retour vers le futur names", () => {
    const ak = readFileSync(akSkill, "utf8");
    const conductor = readFileSync(skill, "utf8");
    expect(ak).toContain("/ak");
    expect(ak).toContain("Never 6");
    expect(ak).toContain("agentik spawn");
    expect(ak).toContain("--harness grok");
    expect(ak).toContain("non-interactive");
    expect(ak).toContain("--single");
    expect(ak).toContain("--no-plan");
    expect(ak).toContain("codex exec");
    expect(ak).toContain("agentik memory");
    expect(ak).toContain("agentik harvest");
    expect(ak).toContain("Do not wait");
    expect(ak).toContain("Do not ask");
    expect(ak).not.toContain("agentik skill approve");
    expect(ak).not.toContain("agentik --learn");
    expect(conductor).toContain("/ak");
    expect(conductor).toContain("Never 6");
    expect(conductor).toContain("agentik harvest");
    expect(conductor).toContain("Do not wait");
    for (const label of Object.values(FRANCHISE_LABELS)) {
      expect(ak).toContain(label);
      expect(conductor).toContain(label);
    }
    for (const role of SUBAGENT_ROLES) {
      const letter = role.slice(-1);
      const slot = CREW_NAMES[role];
      const def = readFileSync(join(agentsDir, `agentik-worker-${letter}.md`), "utf8");
      const names = [slot.fifthElement, slot.starWars, slot.matrix, slot.bttf];
      expect(new Set(names).size).toBe(4);
      for (const n of names) {
        expect(def).toContain(n);
        expect(ak).toContain(n);
        expect(conductor).toContain(n);
      }
      expect(ak).toContain(`agentik-worker-${letter}`);
      expect(ak).toContain(`| ${letter} |`);
      expect(normalizeWorkerRole(letter)).toBe(role);
      expect(normalizeWorkerRole(`agentik-worker-${letter}`)).toBe(role);
      expect(normalizeWorkerRole(slot.fifthElement)).toBe(role);
      expect(normalizeWorkerRole(slot.starWars)).toBe(role);
      expect(normalizeWorkerRole(slot.matrix)).toBe(role);
      expect(normalizeWorkerRole(slot.bttf)).toBe(role);
    }
  });

  /**
   * The install links point at one checkout. From a worktree they point at another one, whose
   * files may legitimately lag behind: check content only when the link resolves into this
   * checkout, and existence always.
   */
  const sameAsHere = (installed: string, source: string) => {
    expect(existsSync(installed)).toBe(true);
    if (realpathSync(installed).startsWith(`${root}/`)) {
      expect(readFileSync(installed, "utf8")).toBe(readFileSync(source, "utf8"));
    }
  };

  test("skill and five agents are linked into each harness home", () => {
    const skillTargets = [
      join(home, ".claude/skills/agentik/SKILL.md"),
      join(home, ".grok/skills/agentik/SKILL.md"),
      join(home, ".codex/skills/agentik/SKILL.md"),
    ];
    for (const p of skillTargets) sameAsHere(p, skill);
    for (const letter of ["a", "b", "c", "d", "e"] as const) {
      const name = `agentik-worker-${letter}.md`;
      const src = join(root, "harness/agents", name);
      for (const dir of [".claude/agents", ".grok/agents", ".codex/agents"]) {
        sameAsHere(join(home, dir, name), src);
      }
    }
    for (const role of SUBAGENT_ROLES) {
      const slot = CREW_NAMES[role];
      for (const n of [slot.fifthElement, slot.starWars, slot.matrix, slot.bttf]) {
        const file = themedFile(n);
        const src = join(agentsDir, file);
        for (const dir of [".claude/agents", ".grok/agents", ".codex/agents"]) {
          sameAsHere(join(home, dir, file), src);
        }
      }
    }
  });

  test("/ak dump-and-run skill is global and adaptive (0–5, never 6)", () => {
    const ak = join(root, "harness/ak/SKILL.md");
    const body = readFileSync(ak, "utf8");
    expect(body).toContain("name: ak");
    expect(body).toContain("/ak");
    expect(body).toContain("Never 6");
    expect(body).toContain("+ c");
    expect(body).toContain("+ d");
    expect(body).toContain("+ e");
    expect(body).toContain("agentik-worker-a");
    for (const p of [
      join(home, ".claude/skills/ak/SKILL.md"),
      join(home, ".grok/skills/ak/SKILL.md"),
      join(home, ".codex/skills/ak/SKILL.md"),
    ]) {
      sameAsHere(p, ak);
    }
  });

  test("home AGENTS.md (Claude + Codex) and Grok rules point at agentik", () => {
    const agents = readFileSync(join(home, ".codex/AGENTS.md"), "utf8");
    expect(agents).toContain("agentik-worker-a");
    expect(agents).toContain("Korben");
    expect(agents).toContain("Fifth Element");
    expect(agents).toContain("Star Wars");
    expect(agents).toContain("Matrix");
    expect(agents).toContain("Retour vers le futur");
    expect(agents).toContain("Never 6");
    expect(agents).toContain("/ak");
    const claudeAgents = join(home, ".claude/AGENTS.md");
    expect(existsSync(claudeAgents)).toBe(true);
    expect(lstatSync(claudeAgents).isSymbolicLink() || realpathSync(claudeAgents).endsWith("AGENTS.md")).toBe(
      true,
    );
    const grokRule = join(home, ".grok/rules/agentik.md");
    expect(existsSync(grokRule)).toBe(true);
    const grokBody = readFileSync(grokRule, "utf8");
    expect(grokBody).toContain("agentik-worker-e");
    expect(grokBody).toContain("/ak");
    expect(grokBody).toContain("Fifth Element");
    expect(grokBody).toContain("Korben");
  });
});
