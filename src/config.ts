import { lstat, readFile } from "node:fs/promises";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * `<home>/config.json`. Everything is off by default, as in Hermes: an absent file or a missing
 * key means the defaults. Keys are accepted in camelCase (`writeApproval`) and snake_case
 * (`write_approval`, the Hermes spelling).
 *
 * The file is read STRICTLY: invalid JSON, a non-object, an unknown key, a non-boolean value
 * (`"true"` is not `true`) or camel/snake spellings that disagree raise a `ConfigError` instead
 * of silently falling back to "all off". A typo in the file that enables write approval must
 * never become an unattended write; the CLI preflights the file and exits 2 with the path.
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

export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.path = path;
  }
}

const SECTIONS = ["memory", "skills"] as const;
const SECTION_KEYS = ["writeApproval"] as const;

function snakeOf(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function describe(v: unknown): string {
  return typeof v === "string" ? `"${v}"` : Array.isArray(v) ? "an array" : v === null ? "null" : typeof v === "object" ? "an object" : String(v);
}

function readFlag(path: string, section: string, raw: Record<string, unknown>, key: string): boolean {
  const snake = snakeOf(key);
  const camelV = raw[key];
  const snakeV = raw[snake];
  for (const [name, v] of [[key, camelV], [snake, snakeV]] as const) {
    if (v !== undefined && typeof v !== "boolean") {
      throw new ConfigError(path, `${section}.${name} must be true or false, got ${describe(v)}`);
    }
  }
  if (camelV !== undefined && snakeV !== undefined && camelV !== snakeV) {
    throw new ConfigError(path, `${section}.${key} and ${section}.${snake} disagree (${String(camelV)} vs ${String(snakeV)})`);
  }
  return (camelV ?? snakeV ?? false) as boolean;
}

function readSection(path: string, name: string, raw: unknown): { writeApproval: boolean } {
  if (raw === undefined) return { writeApproval: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(path, `${name} must be an object, got ${describe(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  const known = new Set<string>(SECTION_KEYS.flatMap((k) => [k, snakeOf(k)]));
  for (const k of Object.keys(r)) {
    if (!known.has(k)) throw new ConfigError(path, `unknown key ${name}.${k} (known: ${SECTION_KEYS.map((x) => `${x} | ${snakeOf(x)}`).join(", ")})`);
  }
  return { writeApproval: readFlag(path, name, r, "writeApproval") };
}

/** Strict parse. `path` only names the file in the error. */
export function parseConfig(body: string, path = "config.json"): AgentikConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new ConfigError(path, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(path, `top level must be an object, got ${describe(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!(SECTIONS as readonly string[]).includes(k)) {
      throw new ConfigError(path, `unknown key "${k}" (known: ${SECTIONS.join(" | ")})`);
    }
  }
  return {
    memory: readSection(path, "memory", r.memory),
    skills: readSection(path, "skills", r.skills),
  };
}

export function configPath(home?: string): string {
  return memoryPaths(agentikHome(home)).config;
}

/**
 * Absent file → defaults. A symlink, an unreadable file or an invalid body → `ConfigError`
 * (never the defaults: a broken file that meant "approval on" must not run unattended).
 */
export async function readConfig(opts?: { home?: string }): Promise<AgentikConfig> {
  const path = configPath(opts?.home);
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { memory: { ...DEFAULT_CONFIG.memory }, skills: { ...DEFAULT_CONFIG.skills } };
    }
    throw new ConfigError(path, `cannot stat: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (st.isSymbolicLink()) throw new ConfigError(path, "is a symlink; refused (the config must be a regular file)");
  if (!st.isFile()) throw new ConfigError(path, "is not a regular file");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(path, `cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(body, path);
}

/** One line for stderr, exit 2: what is wrong and the only two ways out. */
export function formatConfigError(err: ConfigError): string {
  return `${err.path}: ${err.message} — fix or delete the file (defaults are all off)`;
}
