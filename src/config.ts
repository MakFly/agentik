import { readFile } from "node:fs/promises";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * `<home>/config.json`. Everything is off by default, as in Hermes: an absent file, an
 * unreadable file, or a missing key all mean the defaults. Keys are accepted in camelCase
 * (`writeApproval`) and snake_case (`write_approval`, the Hermes spelling).
 *
 * With `memory.writeApproval` on, every memory write — the reviewer's `memory` tool and
 * `agentik memory retain` alike — is staged under `pending/memory/` instead of landing in
 * MEMORY.md / USER.md, until a human runs `agentik memory approve`. `skills.writeApproval`
 * does the same for `skill_manage patch|create` under `pending/skills-ops/`.
 */
export interface AgentikConfig {
  memory: { writeApproval: boolean };
  skills: { writeApproval: boolean };
}

export const DEFAULT_CONFIG: AgentikConfig = {
  memory: { writeApproval: false },
  skills: { writeApproval: false },
};

function flag(section: unknown, key: string): boolean {
  if (!section || typeof section !== "object") return false;
  const s = section as Record<string, unknown>;
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return s[camel] === true || s[snake] === true;
}

export function parseConfig(body: string): AgentikConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const r = raw as Record<string, unknown>;
  return {
    memory: { writeApproval: flag(r.memory, "writeApproval") },
    skills: { writeApproval: flag(r.skills, "writeApproval") },
  };
}

export async function readConfig(opts?: { home?: string }): Promise<AgentikConfig> {
  const path = memoryPaths(agentikHome(opts?.home)).config;
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch {
    return { memory: { ...DEFAULT_CONFIG.memory }, skills: { ...DEFAULT_CONFIG.skills } };
  }
}
