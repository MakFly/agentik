import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentikHome } from "./home.ts";

export type HarnessName = "claude" | "grok" | "codex";

export const HARNESSES: HarnessName[] = ["claude", "codex", "grok"];

/**
 * Cheap, authenticated status probes. None of these spends a model token — they read the
 * stored credential and print the account state:
 *   claude auth status  -> {"loggedIn": true, ...}      (~0.3s)
 *   codex login status  -> "Logged in using ChatGPT"     (~0.05s)
 *   grok models         -> "You are logged in with grok.com." + model list (~0.8s)
 *
 * `<bin> --version` is NOT a usable probe: it succeeds on an expired or logged-out CLI,
 * which is exactly how a dead backend used to stay in the rotation.
 */
const AUTH_PROBE: Record<HarnessName, string[]> = {
  claude: ["auth", "status"],
  codex: ["login", "status"],
  grok: ["models"],
};

const LOGGED_OUT = /\b(not logged in|logged out|no credentials|please (run )?login|unauthori[sz]ed|authentication (failed|required)|session expired|subscription (has )?expired)\b/i;

export interface BackendStatus {
  /** CLI name, also the cache key. */
  bin: HarnessName;
  /** Binary resolvable on PATH. */
  present: boolean;
  /** Probe exited 0 and did not report a logged-out / expired account. */
  loggedIn: boolean;
  /** First line of the probe output, for the human. */
  detail: string;
  /** `<bin> --help` advertises a deny-rule flag (claude `--disallowedTools`/`--settings`, grok `--deny`); codex never. */
  supportsDenyRules?: boolean;
  checkedAt: string;
}

const DENY_HELP: Record<HarnessName, RegExp | null> = {
  claude: /--disallowedTools|--settings\b/,
  grok: /--deny\b/,
  codex: null,
};

/**
 * Does this binary accept the high-blast floor? Read from `--help` (no token spent). A CLI that
 * dropped the flag would otherwise silently run without the floor — `spawn` refuses instead.
 */
export async function helpSupportsDenyRules(bin: HarnessName): Promise<boolean> {
  const re = DENY_HELP[bin];
  if (!re || !Bun.which(bin)) return false;
  try {
    const proc = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return re.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

export type AvailabilityMap = Record<HarnessName, BackendStatus>;

export const AVAILABILITY_TTL_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

export function availabilityCachePath(home?: string): string {
  return join(agentikHome(home), "backends.json");
}

function absent(bin: HarnessName): BackendStatus {
  return {
    bin,
    present: false,
    loggedIn: false,
    detail: "binary not on PATH",
    checkedAt: new Date().toISOString(),
  };
}

/**
 * claude answers with JSON on stdout; codex writes its one-liner to **stderr** with exit 0;
 * grok writes to stdout. All three shapes have to count as "logged in".
 */
export function readsAsLoggedIn(stdout: string, stderr: string, exitCode: number): boolean {
  if (exitCode !== 0) return false;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if ("loggedIn" in obj) return obj.loggedIn === true;
    } catch {
      /* fall through to the text reading */
    }
  }
  const blob = `${stdout}\n${stderr}`;
  if (LOGGED_OUT.test(blob)) return false;
  return blob.trim().length > 0;
}

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/**
 * One short line for the human. `claude auth status` returns the account email and org id;
 * this result is cached on disk and printed, so identifying fields never make it through.
 */
export function summarizeProbe(stdout: string, stderr: string, exitCode: number): string {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if ("loggedIn" in obj) {
        const how = typeof obj.authMethod === "string" ? ` (${obj.authMethod})` : "";
        return obj.loggedIn === true ? `logged in${how}` : `not logged in${how}`;
      }
    } catch {
      /* not the JSON we expected */
    }
  }
  const line =
    `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).find(Boolean) ?? `exit ${exitCode}`;
  return line.replace(EMAIL, "<redacted>").slice(0, 120);
}

export async function probeBackend(bin: HarnessName): Promise<BackendStatus> {
  if (!Bun.which(bin)) return absent(bin);
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  try {
    const proc = Bun.spawn([bin, ...AUTH_PROBE[bin]], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
  } catch (err) {
    return {
      bin,
      present: true,
      loggedIn: false,
      detail: String(err).split("\n")[0],
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    bin,
    present: true,
    loggedIn: readsAsLoggedIn(stdout, stderr, exitCode),
    detail: summarizeProbe(stdout, stderr, exitCode),
    supportsDenyRules: await helpSupportsDenyRules(bin),
    checkedAt: new Date().toISOString(),
  };
}

export async function probeAll(): Promise<AvailabilityMap> {
  const results = await Promise.all(HARNESSES.map((h) => probeBackend(h)));
  return Object.fromEntries(results.map((r) => [r.bin, r])) as AvailabilityMap;
}

function fresh(map: AvailabilityMap, ttlMs: number): boolean {
  const now = Date.now();
  return HARNESSES.every((h) => {
    const at = Date.parse(map[h]?.checkedAt ?? "");
    return Number.isFinite(at) && now - at < ttlMs;
  });
}

export interface AvailabilityOptions {
  home?: string;
  /** Ignore the cache and re-probe. */
  refresh?: boolean;
  ttlMs?: number;
}

/** Cached probe. One real probe per backend per TTL, shared by `run`, `spawn` and `probe`. */
export async function loadAvailability(opts: AvailabilityOptions = {}): Promise<AvailabilityMap> {
  const path = availabilityCachePath(opts.home);
  const ttl = opts.ttlMs ?? AVAILABILITY_TTL_MS;
  if (!opts.refresh) {
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as AvailabilityMap;
      if (cached && fresh(cached, ttl)) return cached;
    } catch {
      /* no cache yet, or unreadable */
    }
  }
  const map = await probeAll();
  try {
    await mkdir(agentikHome(opts.home), { recursive: true });
    await writeFile(path, JSON.stringify(map, null, 2), "utf8");
  } catch {
    /* cache is an optimisation, not a requirement */
  }
  return map;
}

export function isUsable(map: AvailabilityMap | undefined, bin: HarnessName): boolean {
  if (!map) return Boolean(Bun.which(bin));
  return Boolean(map[bin]?.present && map[bin]?.loggedIn);
}

export function describeStatus(s: BackendStatus): string {
  if (!s.present) return "absent";
  if (!s.loggedIn) return "present but not authenticated";
  return "ok";
}
