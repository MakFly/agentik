import type { CompleteRequest, Phase } from "./types.ts";

/**
 * Model + reasoning effort per (harness, phase), as ONE table.
 *
 * A leaf module (types only), in the spirit of `tool-catalog.ts`: the three gated backends read
 * this table instead of each carrying its own copy, so a routing decision is made in one place and
 * cannot drift between the argv builders.
 *
 * The table is the owner's decision, not an inference:
 *
 *   harness | plan                                  | act & synthesize
 *   --------|---------------------------------------|--------------------------------------
 *   claude  | opus, effort high                     | sonnet, effort medium
 *   codex   | gpt-5.6-sol, reasoning high           | gpt-5.6-luna, reasoning xhigh
 *   grok    | default model, reasoning xhigh        | default model, reasoning high
 *
 * The shape of each flag was checked on the installed CLIs, never assumed:
 * `claude --model X --effort <low|medium|high|xhigh|max>`, `codex exec -m X -c
 * model_reasoning_effort=Y` (the key the user's own `~/.codex/config.toml` uses), `grok --model X
 * --reasoning-effort Y` (alias `--effort`).
 *
 * Scope: the GATED workers of `agentik run` only. `agentik spawn` (`foreignWorkerArgs`) and the
 * background review are deliberately out — see `routingFor`.
 */

export type RoutedHarness = "claude" | "codex" | "grok";

export interface Routing {
  /** Absent = keep whatever the backend was constructed with (grok: the CLI's default model). */
  model?: string;
  /** Absent = pass no effort flag at all. */
  effort?: string;
}

/**
 * Efforts each CLI accepts, as far as we can actually verify:
 *
 * - claude enumerates them itself (`claude --effort bogus --version` prints "Valid values: low,
 *   medium, high, xhigh, max").
 * - codex takes the value through `-c model_reasoning_effort=…`, parsed as TOML; the user's config
 *   uses `xhigh`.
 * - grok's `--help` enumerates NOTHING and its parser accepts `--effort bogus` without complaint,
 *   so this list is the only guard on that path. It comes from the owner's verification, not from
 *   the binary.
 */
export const HARNESS_EFFORTS: Record<RoutedHarness, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  grok: ["low", "medium", "high", "xhigh"],
};

/** `AGENTIK_<HARNESS>_MODEL` / `AGENTIK_<HARNESS>_EFFORT`: the human's A/B knobs, one per harness. */
export const ROUTING_ENV: Record<RoutedHarness, { model: string; effort: string }> = {
  claude: { model: "AGENTIK_CLAUDE_MODEL", effort: "AGENTIK_CLAUDE_EFFORT" },
  codex: { model: "AGENTIK_CODEX_MODEL", effort: "AGENTIK_CODEX_EFFORT" },
  grok: { model: "AGENTIK_GROK_MODEL", effort: "AGENTIK_GROK_EFFORT" },
};

/** The table itself. `plan` is the run-shaping phase; `act` and `synthesize` share a row. */
const TABLE: Record<RoutedHarness, { plan: Routing; work: Routing }> = {
  claude: {
    plan: { model: "opus", effort: "high" },
    work: { model: "sonnet", effort: "medium" },
  },
  codex: {
    plan: { model: "gpt-5.6-sol", effort: "high" },
    work: { model: "gpt-5.6-luna", effort: "xhigh" },
  },
  grok: {
    // No model: grok keeps whatever the user configured as their default.
    plan: { effort: "xhigh" },
    work: { effort: "high" },
  },
};

/**
 * A model name reaches an argv, so it is checked before it gets there: one token, no space, no
 * shell metacharacter, no leading dash (which would read as a flag). This is a shape check, not a
 * catalogue — the model names of three vendors move faster than this file.
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,63}$/;

export function modelProblem(value: string): string | undefined {
  return MODEL_RE.test(value) ? undefined : `must match ${MODEL_RE}`;
}

export function effortProblem(harness: RoutedHarness, value: string): string | undefined {
  return HARNESS_EFFORTS[harness].includes(value)
    ? undefined
    : `must be one of ${HARNESS_EFFORTS[harness].join("|")}`;
}

export interface RoutingOptions {
  /**
   * `reviewer` is the background review, not a worker of a run: it keeps what it has today (claude
   * sonnet, effort high; no flag at all on codex/grok). Its effort is a product decision — it is the
   * only thing that writes memory and skills — and its model is chosen by `agentik review`, not by
   * a phase table. `phase` is `"act"` there, which is exactly why this exemption is explicit.
   */
  role?: CompleteRequest["role"];
  env?: Record<string, string | undefined>;
  /** Where a rejected override is reported. Default: stderr. */
  log?: (line: string) => void;
}

/**
 * The routing for one invocation. Never throws: a bad override is dropped with one line on the log
 * and the table's value stands, because handing junk to a CLI kills the whole call (and grok would
 * not even complain — it would just think differently than we believe).
 */
export function routingFor(harness: RoutedHarness, phase: Phase, opts: RoutingOptions = {}): Routing {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.error(line));
  const base: Routing =
    opts.role === "reviewer"
      ? // The review as it is today: claude keeps effort high and its own model; codex and grok get
        // no routing flag at all. Not the phase table — a review is not a run phase.
        harness === "claude"
        ? { effort: "high" }
        : {}
      : phase === "plan"
        ? { ...TABLE[harness].plan }
        : { ...TABLE[harness].work };

  const names = ROUTING_ENV[harness];
  const rawModel = (env[names.model] ?? "").trim();
  if (rawModel) {
    const problem = modelProblem(rawModel);
    if (problem) log(`agentik: ${names.model}="${rawModel}" ignored — ${problem}`);
    else base.model = rawModel;
  }
  const rawEffort = (env[names.effort] ?? "").trim().toLowerCase();
  if (rawEffort) {
    const problem = effortProblem(harness, rawEffort);
    if (problem) log(`agentik: ${names.effort}="${rawEffort}" ignored — ${problem}`);
    else base.effort = rawEffort;
  }
  return base;
}
