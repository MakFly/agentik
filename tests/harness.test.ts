import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
const agentsDir = join(root, "harness/agents");
const installer = join(root, "harness/install.sh");
const grokRuleSrc = join(root, "harness/rules/agentik.md");
const home = homedir();

function themedFile(name: string): string {
  return `${name.replace(/ /g, "-")}.md`;
}

/**
 * Every (source file → path relative to a harness home) that `harness/install.sh` must create.
 * Derived from `CREW_NAMES` / `SUBAGENT_ROLES`, never from a second hard-coded list: renaming a
 * slot in `src/types.ts` without touching the installer fails here.
 */
function expectedLinks(): Array<{ src: string; dest: string }> {
  const out: Array<{ src: string; dest: string }> = [];
  for (const h of [".claude", ".grok", ".codex"]) {
    out.push({ src: skill, dest: `${h}/skills/agentik/SKILL.md` });
    out.push({ src: akSkill, dest: `${h}/skills/ak/SKILL.md` });
    for (const role of SUBAGENT_ROLES) {
      const letter = role.slice(-1);
      const name = `agentik-worker-${letter}.md`;
      out.push({ src: join(agentsDir, name), dest: `${h}/agents/${name}` });
      const slot = CREW_NAMES[role];
      for (const n of [slot.fifthElement, slot.starWars, slot.matrix, slot.bttf]) {
        const file = themedFile(n);
        out.push({ src: join(agentsDir, file), dest: `${h}/agents/${file}` });
      }
    }
  }
  out.push({ src: grokRuleSrc, dest: ".grok/rules/agentik.md" });
  return out;
}

/** Directory-level symlinks the installer creates (the files above live inside them). */
const LINKED_DIRS = [
  ".claude/skills/agentik",
  ".grok/skills/agentik",
  ".codex/skills/agentik",
  ".claude/skills/ak",
  ".grok/skills/ak",
  ".codex/skills/ak",
];

describe("harness sources (repository files only — no machine state)", () => {
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

  test("the grok rule (installed at ~/.grok/rules/agentik.md) points at agentik", () => {
    const body = readFileSync(grokRuleSrc, "utf8");
    for (const term of [
      "agentik-worker-a",
      "agentik-worker-e",
      "Korben",
      "Fifth Element",
      "Star Wars",
      "Matrix",
      "Retour vers le futur",
      "Never 6",
      "/ak",
    ]) {
      expect(body).toContain(term);
    }
  });

  test("/ak dump-and-run skill is global and adaptive (0–5, never 6)", () => {
    const body = readFileSync(akSkill, "utf8");
    expect(body).toContain("name: ak");
    expect(body).toContain("/ak");
    expect(body).toContain("Never 6");
    expect(body).toContain("+ c");
    expect(body).toContain("+ d");
    expect(body).toContain("+ e");
    expect(body).toContain("agentik-worker-a");
  });

  test("the skills and the CLI help name the hardening flags of spawn", async () => {
    const ak = readFileSync(akSkill, "utf8");
    const conductor = readFileSync(skill, "utf8");
    for (const flag of ["--require-tools", "--expect-artifact", "--require-evidence", "--idle-timeout", "--allow-high-blast", "AGENTIK_DEPTH"]) {
      expect(ak).toContain(flag);
      expect(conductor).toContain(flag);
    }
    expect(ak).toContain("floor DISABLED");
    expect(ak).toContain("evidence=fresh");
    const { main } = await import("../src/cli.ts");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      expect(await main(["--help"])).toBe(0);
    } finally {
      console.log = orig;
    }
    const help = lines.join("\n");
    for (const flag of ["--require-tools", "--expect-artifact", "--require-evidence", "--idle-timeout", "--allow-high-blast", "--plan-only", "--concurrency", "runs resume", "memory reseal", "memory where", "memory log", "review --eval", "undo <name>"]) {
      expect(help).toContain(flag);
    }
    expect(help).not.toContain("default: mock");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf8");
    for (const term of ["--allow-high-blast", "--idle-timeout", "--require-evidence", "AGENTIK_DEPTH", "runs resume", "memory reseal", "review --eval"]) {
      expect(readme).toContain(term);
      expect(claudeMd).toContain(term);
    }
  });
});

/**
 * The install LOGIC, run against a throwaway HOME under os.tmpdir() — never `~`, never
 * `<repo>/.tmp/`. A fresh clone passes this suite: it depends on the repository and on `bash`,
 * on nothing that a previous `harness/install.sh` (or a harness CLI migration) left behind.
 */
describe("harness install (Claude / Grok / Codex) — logic, temporary HOME", () => {
  let tmpHome = "";

  beforeAll(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "agentik-harness-home-"));
  });
  afterAll(async () => {
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
  });

  async function runInstaller(): Promise<{ code: number; out: string; err: string }> {
    const p = Bun.spawn(["bash", installer], {
      env: { ...process.env, HOME: tmpHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out, err };
  }

  test("install.sh links every skill, agent and rule into a fresh home, and is idempotent", async () => {
    const links = expectedLinks();
    expect(links.length).toBe(3 * (2 + 5 * 5) + 1); // 3 harnesses × (2 skills + 5 × (1 + 4 names)) + grok rule
    for (const pass of [1, 2]) {
      const r = await runInstaller();
      expect(r.code === 0 ? "ok" : `pass ${pass} exit ${r.code}: ${r.err}`).toBe("ok");
      expect(r.out).toContain("agentik harness installed:");
      for (const { src, dest } of links) {
        const installed = join(tmpHome, dest);
        expect(existsSync(installed) ? dest : `MISSING after pass ${pass}: ${dest}`).toBe(dest);
        expect(realpathSync(installed)).toBe(realpathSync(src));
        expect(readFileSync(installed, "utf8")).toBe(readFileSync(src, "utf8"));
      }
      for (const dir of LINKED_DIRS) {
        const p = join(tmpHome, dir);
        expect(lstatSync(p).isSymbolicLink()).toBe(true);
      }
      expect(lstatSync(join(tmpHome, ".grok/rules/agentik.md")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(tmpHome, ".claude/agents/Korben.md")).isSymbolicLink()).toBe(true);
    }
  });

  test("install.sh writes nothing outside the HOME it is given", async () => {
    await runInstaller();
    // Only the three harness homes are created; no stray file at the top of the temporary home.
    expect(readdirSync(tmpHome).sort()).toEqual([".claude", ".codex", ".grok"]);
  });
});

/**
 * The only tests that look at the real machine. They are an observation, not a contract: a fresh
 * clone (or a harness CLI that wiped its own home, as the codex migration did to `~/.codex`) has
 * not run `harness/install.sh` yet, and that is not a defect of this repository. They SKIP with a
 * named reason instead of failing.
 */
const machineMissing = expectedLinks()
  .filter(({ dest }) => !existsSync(join(home, dest)))
  .map(({ dest }) => dest);

if (machineMissing.length > 0) {
  console.warn(
    `harness.test: skipping the machine checks — ${machineMissing.length} link(s) absent from ${home}, ` +
      `first: ${machineMissing.slice(0, 3).join(", ")}. Run \`bash harness/install.sh\` to install them.`,
  );
}

const codexAgentsMd = join(home, ".codex/AGENTS.md");
const claudeAgentsMd = join(home, ".claude/AGENTS.md");
if (!existsSync(codexAgentsMd)) {
  console.warn(
    `harness.test: skipping the AGENTS.md check — ${codexAgentsMd} is absent. ` +
      "It is hand-written per machine; `harness/install.sh` does not create it.",
  );
}
if (!existsSync(claudeAgentsMd)) {
  console.warn(`harness.test: skipping the AGENTS.md check — ${claudeAgentsMd} is absent (hand-written too).`);
}

describe("harness install — this machine (skipped when not installed here)", () => {
  test.skipIf(machineMissing.length > 0)("every installed link resolves to a real agentik checkout", () => {
    for (const { src, dest } of expectedLinks()) {
      const installed = join(home, dest);
      expect(existsSync(installed)).toBe(true);
      // From a worktree the links point at another checkout, whose files may legitimately lag
      // behind: compare content only when the link resolves into THIS checkout.
      if (realpathSync(installed).startsWith(`${root}/`)) {
        expect(readFileSync(installed, "utf8")).toBe(readFileSync(src, "utf8"));
      } else {
        expect(realpathSync(installed).endsWith(dest.split("/").pop()!)).toBe(true);
      }
    }
  });

  test.skipIf(!existsSync(codexAgentsMd))("home AGENTS.md (Codex, hand-written) points at agentik", () => {
    const agents = readFileSync(codexAgentsMd, "utf8");
    for (const term of [
      "agentik-worker-a",
      "Korben",
      "Fifth Element",
      "Star Wars",
      "Matrix",
      "Retour vers le futur",
      "Never 6",
      "/ak",
    ]) {
      expect(agents).toContain(term);
    }
  });

  test.skipIf(!existsSync(claudeAgentsMd))("home AGENTS.md (Claude) is a link or a real AGENTS.md", () => {
    expect(
      lstatSync(claudeAgentsMd).isSymbolicLink() || realpathSync(claudeAgentsMd).endsWith("AGENTS.md"),
    ).toBe(true);
  });
});

/**
 * `bin/agentik` is the first thing a fresh clone runs. Under `set -euo pipefail`, `command -v bun`
 * failing used to abort the script with exit 1 and NOT ONE character of output.
 */
describe("bin/agentik — the launcher a fresh clone runs", () => {
  const launcher = join(root, "bin/agentik");
  let tmp = "";

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentik-launcher-"));
    // A PATH with no `bun` in it, but with the coreutils the launcher itself needs.
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    for (const cmd of ["bash", "sh", "env", "readlink", "dirname", "cat"]) {
      const real = Bun.which(cmd);
      if (real) symlinkSync(real, join(bin, cmd));
    }
    mkdirSync(join(tmp, "home"), { recursive: true });
    const fake = join(tmp, "fakebun");
    writeFileSync(fake, '#!/bin/sh\necho "FAKEBUN $*"\n');
    chmodSync(fake, 0o755);
  });
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  async function launch(env: Record<string, string>, ...args: string[]) {
    const p = Bun.spawn(["bash", launcher, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out, err };
  }

  test("without bun it names the prerequisite and where to get it, and exits 2", async () => {
    const r = await launch({ PATH: join(tmp, "bin"), HOME: join(tmp, "home") }, "--help");
    expect(r.code).toBe(2);
    expect(r.err).toContain("bun not found");
    expect(r.err).toContain("https://bun.sh");
    expect(r.err).toContain("BUN=");
    expect(r.err.trim().length).toBeGreaterThan(40);
  });

  test("BUN=<path> is honoured and the CLI entrypoint is what gets executed", async () => {
    const r = await launch(
      { ...process.env, BUN: join(tmp, "fakebun"), HOME: join(tmp, "home") } as Record<string, string>,
      "--help",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("FAKEBUN");
    expect(r.out).toContain(join(root, "src/cli.ts"));
    expect(r.out).toContain("--help");
  });
});
