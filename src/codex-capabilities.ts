import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { agentikHome } from "./home.ts";

/**
 * What the codex behind `codex exec` can actually do — learned, not assumed.
 *
 * Codex may be native (api.openai.com) or routed through a local proxy such as opencodex.
 * Native codex serves structured output (`--output-schema`); opencodex's responses adapter
 * does not and dies with `adapter_eof`. Hard-coding either answer breaks the other machine,
 * so the backend tries the schema once, falls back without it on a structured-output failure,
 * and remembers the verdict keyed by the codex base URL: change the routing and it re-learns.
 */
export type StructuredOutput = "ok" | "unsupported";

export interface CodexCapabilities {
  baseUrl: string;
  structuredOutput: StructuredOutput;
  checkedAt: string;
  /** What the failure looked like, for the human. */
  evidence?: string;
}

export const DEFAULT_CODEX_BASE_URL = "https://api.openai.com/v1";

/** `openai_base_url` from ~/.codex/config.toml (or CODEX_HOME), else the native endpoint. */
export async function readCodexBaseUrl(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): Promise<string> {
  try {
    const toml = await readFile(join(codexHome, "config.toml"), "utf8");
    const m = /^\s*openai_base_url\s*=\s*"([^"]+)"/m.exec(toml);
    if (m) return m[1];
  } catch {
    /* no config: native codex */
  }
  return process.env.OPENAI_BASE_URL || DEFAULT_CODEX_BASE_URL;
}

function capsPath(home?: string): string {
  return join(agentikHome(home), "codex-capabilities.json");
}

export async function loadCodexCapabilities(home?: string): Promise<CodexCapabilities | undefined> {
  try {
    return JSON.parse(await readFile(capsPath(home), "utf8")) as CodexCapabilities;
  } catch {
    return undefined;
  }
}

export async function saveCodexCapabilities(caps: CodexCapabilities, home?: string): Promise<void> {
  await mkdir(agentikHome(home), { recursive: true });
  await writeFile(capsPath(home), JSON.stringify(caps, null, 2), "utf8");
}

export type SchemaMode = "always" | "never" | "auto";

export function schemaModeFromEnv(env = process.env): SchemaMode {
  const v = (env.AGENTIK_CODEX_OUTPUT_SCHEMA ?? "auto").toLowerCase();
  return v === "always" || v === "never" ? v : "auto";
}

/**
 * Should the next codex call carry `--output-schema`?
 * `auto` (default): yes unless we learned "unsupported" for the *current* base URL.
 */
export async function shouldTryStructuredOutput(opts: {
  home?: string;
  baseUrl: string;
  mode?: SchemaMode;
}): Promise<boolean> {
  const mode = opts.mode ?? schemaModeFromEnv();
  if (mode === "always") return true;
  if (mode === "never") return false;
  const caps = await loadCodexCapabilities(opts.home);
  if (!caps || caps.baseUrl !== opts.baseUrl) return true;
  return caps.structuredOutput !== "unsupported";
}

/** The failure signature codex emits when the upstream cannot serve structured output. */
export function looksLikeStructuredOutputFailure(stdout: string, stderr = ""): boolean {
  const blob = `${stdout}\n${stderr}`;
  return /adapter_eof|Incomplete response returned|output_schema|json_schema|text\.format|structured output/i.test(blob);
}
