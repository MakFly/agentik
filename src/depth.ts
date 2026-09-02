/**
 * Nesting guard. An agentik worker is a headless CLI that inherits `AGENTIK_DEPTH=1`; if it
 * runs `agentik spawn` or `agentik run` itself, that would be a worker spawning workers — agent
 * #6 by another route, outside the conductor's five slots and outside the gate. The env var is
 * set by `spawnManaged` on every child (harness workers, gated backends, run_command), so the
 * guard holds even when the worker reaches agentik through a shell.
 *
 * `harvest`, `review`, `memory`, `context`, `skills`, `postmortem`, `probe`, `index`, `search` stay
 * allowed at any depth: reading memory or recording what happened is not spawning. The code index
 * is the one thing depth also gates on its own: a worker refreshes an index but never BUILDS one
 * (`ensureIndex`, "the conductor builds, the worker reads").
 */

export const DEPTH_ENV = "AGENTIK_DEPTH";
export const PARENT_ENV = "AGENTIK_PARENT";
export const PARENT_VALUE = "agentik-spawn";

/** Commands a worker may never run: they start more agents. */
export const NESTING_COMMANDS = new Set(["spawn", "run"]);

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEPTH_ENV];
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The environment a child gets: one level deeper, and it knows who started it. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  out[DEPTH_ENV] = String(currentDepth(base) + 1);
  out[PARENT_ENV] = PARENT_VALUE;
  return out;
}

/** Why `agentik <cmd>` must not run here, or undefined when it may. */
export function depthProblem(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const depth = currentDepth(env);
  if (depth < 1 || !NESTING_COMMANDS.has(cmd)) return undefined;
  return `agentik ${cmd} refused at depth ${depth}: you are already an agentik worker; a worker never spawns workers (that would be agent #6). Do the task yourself, or report that it needs another agent.`;
}

/** Incident symptom for a refused nested call (digits are folded by the incident log). */
export function nestedSymptom(cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  return `nested agentik ${cmd} refused at depth ${currentDepth(env)}`;
}
