#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  foreignWorkerArgs,
  harnessForName,
  resolveBackends,
  spawnCapture,
  spawnLines,
} from "./backends.ts";
import {
  describeStatus,
  HARNESSES,
  loadAvailability,
  type HarnessName,
} from "./availability.ts";
import {
  describeUntouched,
  snapshotArtifacts,
  untouchedArtifacts,
  type ArtifactSnapshot,
} from "./artifacts.ts";
import {
  consumeVerdictLine,
  newVerdict,
  summarizeVerdict,
  verdictArgs,
  verdictProblem,
} from "./verdict.ts";
import { formatReport, runLoop } from "./loop.ts";
import { defaultFetchImpl } from "./tools.ts";
import { retainNote, recall, readHot } from "./memory.ts";
import { recallBeforeRun, reviewAfterRun } from "./review.ts";
import {
  approveSkill,
  draftSkill,
  listSkills,
  slugifySkillName,
  updateSkill,
} from "./skill-factory.ts";
import {
  clampSubagentCount,
  MAX_SUBAGENTS,
  type OrchestratorDecision,
  type RunReport,
} from "./types.ts";

function usage(): string {
  return `agentik — 3-role agentic development system
You are the supreme orchestrator. Two AI workers take bounded tasks.

Launch like your other CLIs:
  agentik "Create src/greet.txt containing AGENTIK_OK"
  agentik --yolo "fix the failing test"          # same posture as grok --yolo / cla / cc

Auto-run: each worker is re-invoked on tool results until it returns no
toolCalls or --max-steps. Low/medium tools execute immediately. High-blast
waits unless you passed --yolo (your session approval).
  agentik --backend cla "…"                      # workers = claude -p (cla flags)
  agentik --backend grok "…"                     # workers = grok --yolo --single --no-plan
  agentik --worker-a grok --worker-b cc "…"      # mix grok + codex --yolo

Commands:
  agentik [run] <goal> [options]
  agentik spawn --harness grok|codex|claude [--workspace DIR] [--role Korben] <task>
                               One non-interactive CLI process per foreign-harness slot.
                               Each harness runs its OWN full agent loop to natural
                               completion (multiple tool calls/turns) before exiting;
                               agentik does not drive the loop for you here:
                                 grok   -> grok --yolo --single … --no-subagents --no-plan
                                 codex  -> codex exec --yolo --skip-git-repo-check --ephemeral
                                 claude -> claude -p --dangerously-skip-permissions --effort high
                               Output streams live and agentik reads the harness's own event
                               stream, so it reports what the worker actually did (turns, tool
                               calls, stop reason) instead of trusting the exit code. The
                               harness is probed first: a CLI that is not authenticated exits 2
                               instead of being launched.
                               Exit codes: 0 done · 1 the CLI failed · 2 unusable harness
                               · 124 killed by --timeout, the task did NOT finish
                               · 125 the harness ended without doing the work.
  agentik memory retain|recall|hot [text]
  agentik skill draft|approve|update|list ...
  agentik harvest "<goal>" [--artifact PATH] [--step TEXT]
  agentik probe [--json] [--refresh-backends]

Options:
  --workspace DIR              Workspace root (default: cwd)
  --backend mock|auto|cla|claude|grok|codex|cc
                               Worker pair (default: mock; --yolo implies auto)
  --workers N                  Subagent count 1–${MAX_SUBAGENTS} (default 2, hard cap ${MAX_SUBAGENTS})
  --worker-a mock|cla|sonnet|opus|grok|codex|cc
  --worker-b mock|cla|sonnet|opus|grok|codex|cc
  --worker-c / --worker-d / --worker-e
                               Backends for extra subagents
  --yolo                       Session approval (you launched yolo) + live CLIs
  --max-steps N                Auto-run cap per worker task (default: 8)
  --timeout SECONDS            Wall clock for agentik spawn (default 1800, 0 = unbounded)
  --step-timeout SECONDS       Wall clock for one worker-CLI invocation (default 600)
  --refresh-backends           Re-probe the harnesses instead of reading the 15min cache
  --strict-backend             Fail instead of rerouting when a named harness is unusable
  --require-tools              spawn: a run that calls no tool is a failure (exit 125).
                               Pass it for implement/fix tasks, omit it for diagnostics.
  --expect-artifact PATH       spawn: this workspace path must be created, modified or
                               removed by the run, else exit 125. Repeatable.
  --raw                        spawn: the harness's own output, no verdict
  --approve-high-blast         Explicit high-blast approval without --yolo
  --reject-high-blast          Reject pending high-blast tools
  --override stop|redirect     Stop or redirect the run
  --redirect-goal TEXT         New goal when --override redirect
  --json                       Print the full run report as JSON

Worker CLIs keep their native file/shell tools disabled; tool calls still go through
the gate. --backend auto only routes to a harness whose authenticated probe passes,
and a backend that dies mid-run is handed off to a live one (see "backend switches" in
the report). Exit 5 means a task stalled: it never produced a usable answer.
`;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(usage());
    return 0;
  }
  const cmd = argv[0];
  if (cmd === "probe") return probe(argv.slice(1));
  if (cmd === "spawn") return spawnForeign(argv.slice(1));
  if (cmd === "memory") return memoryCmd(argv.slice(1));
  if (cmd === "skill") return skillCmd(argv.slice(1));
  if (cmd === "harvest") return harvestCmd(argv.slice(1));

  const runArgv = cmd === "run" ? argv.slice(1) : argv;
  const { goal, flags } = parseRun(runArgv);
  if (!goal) {
    console.error("missing goal");
    console.error(usage());
    return 2;
  }

  const workspace = resolve(flags.workspace ?? process.cwd());
  await mkdir(workspace, { recursive: true });
  const backendSpec = flags.backend ?? (flags.yolo ? "auto" : "mock");
  const workerCount = clampSubagentCount(flags.workers ?? 2);
  const names = [flags.workerA, flags.workerB, flags.workerC, flags.workerD, flags.workerE];
  // Only probe when a real CLI could be routed to. A mock run must stay offline.
  const wantsLiveCli =
    harnessForName(backendSpec) !== null ||
    backendSpec === "auto" ||
    backendSpec === "yolo" ||
    names.some((n) => n && harnessForName(n) !== null);
  const availability = wantsLiveCli
    ? await loadAvailability({ home: flags.agentikHome, refresh: flags.refreshBackends })
    : undefined;
  const routingNotes: string[] = [];
  let workerA;
  let workerB;
  let workers;
  try {
    ({ workerA, workerB, workers } = resolveBackends(backendSpec, flags.workerA, flags.workerB, {
      count: workerCount,
      names,
      availability: flags.strictBackend ? undefined : availability,
      notes: routingNotes,
      timeoutMs: flags.stepTimeout === undefined ? undefined : flags.stepTimeout * 1000,
    }));
  } catch (err) {
    console.error(`agentik: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (flags.strictBackend && availability) {
    const dead = [backendSpec, ...names]
      .filter((n): n is string => Boolean(n))
      .map((n) => harnessForName(n))
      .filter((h): h is HarnessName => h !== null)
      .filter((h) => !availability[h].loggedIn);
    if (dead.length) {
      console.error(
        `agentik: --strict-backend and ${[...new Set(dead)].join(", ")} not authenticated — run \`agentik probe\``,
      );
      return 2;
    }
  }
  for (const note of routingNotes) console.error(`agentik: ${note}`);
  const decisions: OrchestratorDecision[] = [];
  if (flags.approveHighBlast && !flags.yolo) decisions.push({ type: "approve" });
  if (flags.rejectHighBlast) decisions.push({ type: "reject" });
  if (flags.override) {
    decisions.push({
      type: "override",
      overrideAction: flags.override,
      redirectGoal: flags.redirectGoal,
    });
  }

  const live = backendSpec !== "mock" || Boolean(flags.workerA && flags.workerA !== "mock");
  if (!flags.json) {
    const hits = await recallBeforeRun({ goal, home: flags.agentikHome });
    if (hits.length) {
      console.log(`memory recall:\n${hits.map((h) => `- ${h}`).join("\n")}`);
    }
  }
  const report = await runLoop({
    goal,
    workspace,
    workerA,
    workerB,
    workers,
    workerCount,
    decisions,
    fetchImpl: live ? defaultFetchImpl() : undefined,
    autoApproveHighBlast: Boolean(flags.yolo || flags.approveHighBlast),
    maxSteps: flags.maxSteps,
  });

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  const harvested = await reviewAfterRun({
    goal,
    report,
    home: flags.agentikHome,
  });
  if (!flags.json) {
    if (harvested.memoryLayer !== "rejected") {
      console.log(`memory: ${harvested.memoryLayer}`);
    }
    if (harvested.skill) {
      console.log(`skill ${harvested.skill.action}: ${harvested.skill.path}`);
    }
  }

  return exitCodeFor(report);
}

/**
 * 0 ok · 1 unfinished · 3 rejected/blocked · 4 awaiting approval · 5 stalled.
 * A stalled task outranks the orchestrator's own `completed`: a worker that never produced a
 * readable answer did not do the work, and the caller must be able to see that in `$?`.
 */
export function exitCodeFor(report: RunReport): number {
  if (report.status === "rejected" || report.status === "blocked") return 3;
  if (report.status === "awaiting_approval") return 4;
  if (report.stalledTasks.length > 0) return 5;
  if (report.status === "overridden") return 0;
  if (report.status !== "completed") return 1;
  return 0;
}

async function spawnForeign(args: string[]): Promise<number> {
  const { goal, flags } = parseRun(args);
  const harnessRaw = (flags.harness ?? flags.backend ?? "").toLowerCase();
  const harness =
    harnessRaw === "cc" || harnessRaw === "codex"
      ? "codex"
      : harnessRaw === "cla" || harnessRaw === "claude" || harnessRaw === "sonnet" || harnessRaw === "opus"
        ? "claude"
        : harnessRaw === "grok"
          ? "grok"
          : null;
  if (!harness || !goal) {
    console.error("usage: agentik spawn --harness grok|codex|claude [--workspace DIR] [--role NAME] <task>");
    return 2;
  }
  const availability = await loadAvailability({ home: flags.agentikHome });
  const status = availability[harness];
  if (!status.loggedIn) {
    console.error(
      `agentik spawn: ${harness} is ${describeStatus(status)} (${status.detail}) — not spawning a dead harness`,
    );
    const alive = HARNESSES.filter((h) => availability[h].loggedIn);
    console.error(
      alive.length
        ? `usable right now: ${alive.join(", ")}`
        : "no harness is authenticated — run `agentik probe`",
    );
    return 2;
  }

  const workspace = resolve(flags.workspace ?? process.cwd());
  const role = flags.role ? `You are ${flags.role}. ` : "";
  const prompt = `${role}Bounded task (no nested subagents, stay in ${workspace}):\n${goal}`;
  const expected = flags.expectArtifacts ?? [];
  let before: ArtifactSnapshot[] = [];
  try {
    before = await snapshotArtifacts(workspace, expected);
  } catch (err) {
    console.error(`agentik spawn: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const timeoutMs = (flags.timeout ?? DEFAULT_SPAWN_TIMEOUT_S) * 1000;
  const timedOutMsg = () =>
    `agentik spawn: ${harness} killed after ${Math.round(timeoutMs / 1000)}s (timeout) — the task did NOT finish, partial work may be on disk`;

  if (flags.raw) {
    // Opt-out: the harness's own rendering, no verdict.
    const { bin, args: rawArgs } = foreignWorkerArgs(harness, prompt, workspace);
    const res = await spawnCapture(bin, rawArgs, timeoutMs, workspace, { stream: true });
    if (res.timedOut) {
      console.error(timedOutMsg());
      return 124;
    }
    if (res.exitCode !== 0) return 1;
    const untouchedRaw = await untouchedArtifacts(workspace, before);
    if (untouchedRaw.length > 0) {
      console.error(`agentik spawn: ${describeUntouched(untouchedRaw)}`);
      return 125;
    }
    return 0;
  }

  // Read the harness's own event stream. Exit code alone cannot tell a worker that did the
  // job from one that narrated an intention and stopped — both exit 0.
  const { bin, args: streamArgs } = foreignWorkerArgs(harness, prompt, workspace, verdictArgs(harness));
  const verdict = newVerdict(harness);
  const res = await spawnLines(bin, streamArgs, timeoutMs, workspace, (line) =>
    consumeVerdictLine(verdict, line, {
      onText: (chunk) => process.stdout.write(chunk),
      onTool: (name, detail) => process.stderr.write(`  ⟩ ${name}${detail ? ` ${detail}` : ""}\n`),
    }),
  );
  process.stdout.write("\n");
  console.error(`agentik spawn: ${summarizeVerdict(verdict)}`);
  // Only an incomplete turn makes these errors; on a completed turn they are harness notes
  // (codex, for one, emits a benign config warning on every successful run).
  const label = verdict.completed ? "note" : "harness error";
  for (const e of verdict.errors) console.error(`agentik spawn: ${label} — ${e}`);

  if (res.timedOut) {
    console.error(timedOutMsg());
    return 124;
  }
  if (res.exitCode !== 0) {
    if (res.stderr.trim()) process.stderr.write(res.stderr);
    return 1;
  }
  const problem = verdictProblem(verdict, { requireTools: flags.requireTools });
  if (problem) {
    console.error(`agentik spawn: ${problem} — treating this as unfinished, not as success`);
    return 125;
  }
  // The stream proves tools ran; only the filesystem proves the deliverable moved.
  const untouched = await untouchedArtifacts(workspace, before);
  if (untouched.length > 0) {
    console.error(
      `agentik spawn: ${describeUntouched(untouched)} — treating this as unfinished, not as success`,
    );
    return 125;
  }
  if (expected.length > 0) {
    console.error(`agentik spawn: ${expected.length} expected artifact(s) verified on disk`);
  }
  return 0;
}

/**
 * Reports what each harness can actually do right now. `--version` used to stand in for this
 * and reported an expired or logged-out CLI as "ok", which is how dead backends stayed in the
 * rotation. Now it is a real authenticated status call per harness (no model tokens spent).
 */
async function probe(args: string[] = []): Promise<number> {
  const { flags } = parseRun(args);
  const map = await loadAvailability({
    home: flags.agentikHome,
    refresh: flags.refreshBackends ?? true,
  });
  if (flags.json) {
    console.log(JSON.stringify(map, null, 2));
  } else {
    for (const h of HARNESSES) {
      console.log(`${h}: ${describeStatus(map[h])} — ${map[h].detail}`);
    }
  }
  return HARNESSES.some((h) => map[h].loggedIn) ? 0 : 1;
}

export function parseRun(args: string[]): {
  goal: string;
  flags: {
    workspace?: string;
    backend?: string;
    workerA?: string;
    workerB?: string;
    workerC?: string;
    workerD?: string;
    workerE?: string;
    workers?: number;
    approveHighBlast?: boolean;
    rejectHighBlast?: boolean;
    yolo?: boolean;
    maxSteps?: number;
    override?: "stop" | "redirect";
    redirectGoal?: string;
    json?: boolean;
    harness?: string;
    role?: string;
    agentikHome?: string;
    goalFlag?: string;
    timeout?: number;
    stepTimeout?: number;
    refreshBackends?: boolean;
    strictBackend?: boolean;
    requireTools?: boolean;
    raw?: boolean;
    expectArtifacts?: string[];
  };
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const expectArtifacts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--yolo") flags.yolo = true;
    else if (a === "--agentik-home") {
      flags["agentik-home"] = args[i + 1];
      i++;
    }
    else if (a === "--workers") {
      flags.workers = args[i + 1];
      i++;
    }
    else if (a === "--max-steps") {
      flags.maxSteps = args[i + 1];
      i++;
    }
    else if (a === "--approve-high-blast") flags.approveHighBlast = true;
    else if (a === "--reject-high-blast") flags.rejectHighBlast = true;
    else if (a === "--refresh-backends") flags.refreshBackends = true;
    else if (a === "--strict-backend") flags.strictBackend = true;
    else if (a === "--require-tools") flags.requireTools = true;
    else if (a === "--raw") flags.raw = true;
    else if (a === "--expect-artifact" && args[i + 1]) {
      expectArtifacts.push(args[++i]);
    }
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = args[i + 1];
      if (!val || val.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = val;
        i++;
      }
    } else positional.push(a);
  }
  const goal = positional.join(" ").trim();
  const override = flags.override;
  return {
    goal,
    flags: {
      workspace: str(flags.workspace),
      backend: str(flags.backend),
      workerA: str(flags["worker-a"]),
      workerB: str(flags["worker-b"]),
      workerC: str(flags["worker-c"]),
      workerD: str(flags["worker-d"]),
      workerE: str(flags["worker-e"]),
      workers: Number.isFinite(Number(flags.workers)) ? Number(flags.workers) : undefined,
      approveHighBlast: Boolean(flags.approveHighBlast),
      rejectHighBlast: Boolean(flags.rejectHighBlast),
      yolo: Boolean(flags.yolo),
      maxSteps: Number.isFinite(Number(flags.maxSteps)) && Number(flags.maxSteps) > 0
        ? Number(flags.maxSteps)
        : undefined,
      override: override === "stop" || override === "redirect" ? override : undefined,
      redirectGoal: str(flags["redirect-goal"]),
      json: Boolean(flags.json),
      harness: str(flags.harness),
      role: str(flags.role),
      agentikHome: str(flags["agentik-home"]),
      goalFlag: str(flags.goal),
      timeout: nonNegative(flags.timeout),
      stepTimeout: nonNegative(flags["step-timeout"]),
      refreshBackends: Boolean(flags.refreshBackends),
      strictBackend: Boolean(flags.strictBackend),
      requireTools: Boolean(flags.requireTools),
      raw: Boolean(flags.raw),
      expectArtifacts,
    },
  };
}

/** `--timeout 0` is meaningful (no bound), so 0 must survive the parse. */
function nonNegative(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function harvestCmd(args: string[]): Promise<number> {
  const { goal, flags } = parseRun(args);
  const harvestGoal = goal || flags.goalFlag || "";
  if (!harvestGoal) {
    console.error('usage: agentik harvest "<goal>" [--artifact PATH] [--step TEXT]');
    return 2;
  }
  const artifacts: string[] = [];
  const steps: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--artifact" && args[i + 1]) artifacts.push(args[++i]);
    if (args[i] === "--step" && args[i + 1]) steps.push(args[++i]);
  }
  const executedTools = steps.map((s) => {
    const [tool, artifact] = s.split("->").map((x) => x.trim());
    return { tool: tool || "step", args: {}, output: s, artifact };
  });
  const harvested = await reviewAfterRun({
    goal: harvestGoal,
    report: {
      status: "completed",
      executedTools,
      artifacts,
    },
    home: flags.agentikHome,
  });
  console.log(`memory: ${harvested.memoryLayer}`);
  if (harvested.skill) console.log(`skill ${harvested.skill.action}: ${harvested.skill.path}`);
  else console.log("skill: (not enough signal)");
  return 0;
}

async function memoryCmd(args: string[]): Promise<number> {
  const sub = args[0];
  const { goal, flags } = parseRun(args.slice(1));
  const home = flags.agentikHome;
  if (sub === "hot") {
    process.stdout.write((await readHot({ home })) || "(empty HOT MEMORY.md)\n");
    return 0;
  }
  if (sub === "retain") {
    if (!goal) {
      console.error("usage: agentik memory retain <note>");
      return 2;
    }
    const r = await retainNote(goal, { home });
    console.log(`${r.layer} ${r.path}`);
    return r.layer === "rejected" ? 3 : 0;
  }
  if (sub === "recall") {
    if (!goal) {
      console.error("usage: agentik memory recall <query>");
      return 2;
    }
    const hits = await recall(goal, { home });
    console.log(hits.length ? hits.map((h) => `- ${h}`).join("\n") : "(no hits)");
    return 0;
  }
  console.error("usage: agentik memory retain|recall|hot");
  return 2;
}

async function skillCmd(args: string[]): Promise<number> {
  const sub = args[0];
  const { goal, flags } = parseRun(args.slice(1));
  const home = flags.agentikHome;
  if (sub === "list") {
    const { pending, approved } = await listSkills({ home });
    console.log(`pending: ${pending.join(", ") || "(none)"}`);
    console.log(`approved: ${approved.join(", ") || "(none)"}`);
    return 0;
  }
  if (sub === "draft") {
    if (!goal) {
      console.error("usage: agentik skill draft <goal>");
      return 2;
    }
    const drafted = await draftSkill({
      name: slugifySkillName(goal),
      goal,
      steps: ["Captured from CLI draft."],
      home,
    });
    console.log(drafted.path);
    return 0;
  }
  if (sub === "approve") {
    const name = args[1];
    if (!name) {
      console.error("usage: agentik skill approve <name>");
      return 2;
    }
    const ok = await approveSkill(name, { home, linkHarness: true });
    if ("error" in ok) {
      console.error(ok.error);
      return 1;
    }
    console.log(ok.path);
    return 0;
  }
  if (sub === "update") {
    const name = args[1];
    const rest = args.slice(2);
    const parsed = parseRun(rest);
    const updateGoal = parsed.goal;
    if (!name || !updateGoal) {
      console.error("usage: agentik skill update <name> <goal>");
      return 2;
    }
    const ok = await updateSkill(
      name,
      { goal: updateGoal, steps: [`Updated from CLI: ${updateGoal}`] },
      { home: parsed.flags.agentikHome ?? home },
    );
    if ("error" in ok) {
      console.error(ok.error);
      return 1;
    }
    console.log(ok.path);
    return 0;
  }
  console.error("usage: agentik skill draft|approve|update|list");
  return 2;
}

/** Wall-clock bound for one `agentik spawn`. 0 (via --timeout 0) means unbounded. */
export const DEFAULT_SPAWN_TIMEOUT_S = 1800;

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
