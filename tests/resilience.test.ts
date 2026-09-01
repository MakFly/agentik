import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  autoCycle,
  BackendError,
  makeBackend,
  resolveBackends,
  spawnCapture,
} from "../src/backends.ts";
import {
  readsAsLoggedIn,
  summarizeProbe,
  type AvailabilityMap,
  type HarnessName,
} from "../src/availability.ts";
import { exitCodeFor, main } from "../src/cli.ts";
import { runLoop } from "../src/loop.ts";
import { buildPlan } from "../src/plan.ts";
import { makeWorkspace } from "./helpers.ts";
import type { Backend, CompleteRequest, RunReport, WorkerMessage } from "../src/types.ts";

function planTasks(goal: string, n = 2) {
  return buildPlan(goal, n).map((t) => ({
    assignee: t.assignee,
    instruction: t.instruction,
    allowedTools: t.allowedTools,
    maxSteps: t.maxSteps,
  }));
}

function availability(state: Partial<Record<HarnessName, boolean>>): AvailabilityMap {
  const at = new Date().toISOString();
  const one = (bin: HarnessName) => ({
    bin,
    present: state[bin] !== undefined,
    loggedIn: state[bin] === true,
    detail: state[bin] === true ? "ok" : "not logged in",
    checkedAt: at,
  });
  return { claude: one("claude"), codex: one("codex"), grok: one("grok") };
}

describe("spawnCapture reports a kill as a kill", () => {
  test("a child that traps SIGTERM and exits 0 is still marked timedOut", async () => {
// A child that handles SIGTERM and exits clean is byte-for-byte identical to a
    // finished run. (claude/grok/codex measured today all exit 143 instead — but the flag
    // must not depend on that staying true, and 143 alone cannot be told from a crash.)
    const res = await spawnCapture(
      "bun",
      [
        "-e",
        'process.on("SIGTERM", () => { console.log("partial"); process.exit(0); }); setTimeout(() => {}, 60_000);',
      ],
      1000,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("partial");
    expect(res.timedOut).toBe(true);
  }, 20_000);

  test("a child that ignores SIGTERM is killed hard and still marked timedOut", async () => {
    const res = await spawnCapture(
      "bun",
      ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000);'],
      500,
    );
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  }, 20_000);

  test("timeoutMs <= 0 means no bound", async () => {
    const res = await spawnCapture("bash", ["-c", "echo done"], 0);
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("done");
  });
});

describe("the auth probe reads each CLI's real output shape", () => {
  test("codex answers on stderr with exit 0 — that is still logged in", () => {
    expect(readsAsLoggedIn("", "Logged in using ChatGPT\n", 0)).toBe(true);
    expect(summarizeProbe("", "Logged in using ChatGPT\n", 0)).toBe("Logged in using ChatGPT");
  });

  test("grok answers on stdout", () => {
    expect(readsAsLoggedIn("You are logged in with grok.com.\n", "", 0)).toBe(true);
  });

  test("claude answers with JSON, and its account fields never reach the cache", () => {
    const json = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "someone@example.com",
      orgId: "9b1d3376-bd89-4d2d-b700-179fb7f3638a",
    });
    expect(readsAsLoggedIn(json, "", 0)).toBe(true);
    const summary = summarizeProbe(json, "", 0);
    expect(summary).toBe("logged in (claude.ai)");
    expect(summary).not.toContain("@");
    expect(summary).not.toContain("9b1d3376");
  });

  test("logged out and non-zero exits are not usable", () => {
    expect(readsAsLoggedIn(JSON.stringify({ loggedIn: false }), "", 0)).toBe(false);
    expect(readsAsLoggedIn("", "Not logged in. Run `grok login`.", 0)).toBe(false);
    expect(readsAsLoggedIn("anything", "", 1)).toBe(false);
  });
});

describe("backend selection refuses to invent a worker", () => {
  test("an unknown backend name throws instead of becoming a mock", () => {
    // `--worker-a gork` used to produce a MockBackend that wrote a placeholder artifact
    // and reported the run completed.
    expect(() => makeBackend("gork")).toThrow(/unknown backend/);
    expect(() => makeBackend("grok-4")).toThrow(/unknown backend/);
    expect(makeBackend("mock-c").id).toBe("mock-c");
  });

  test("autoCycle drops a harness that is present but not authenticated", () => {
    const all = autoCycle({ availability: availability({ claude: true, codex: true, grok: true }) });
    expect(all.map((b) => b.id)).toContain("grok");

    const expired = autoCycle({
      availability: availability({ claude: true, codex: true, grok: false }),
    });
    expect(expired.map((b) => b.id)).not.toContain("grok");
    expect(expired.length).toBeGreaterThan(0);
  });

  test("the always-on harnesses hold worker_a and worker_b; grok never does", () => {
    const cycle = autoCycle({ availability: availability({ claude: true, codex: true, grok: true }) });
    expect(cycle[0].id).toBe("claude-sonnet");
    expect(cycle[1].id).toBe("codex");
  });

  test("an explicitly named dead harness is rerouted, with a note", () => {
    const notes: string[] = [];
    const { workers } = resolveBackends("auto", undefined, undefined, {
      count: 2,
      names: ["grok", "claude"],
      availability: availability({ claude: true, codex: true, grok: false }),
      notes,
    });
    expect(workers[0].id).not.toBe("grok");
    expect(notes.join(" ")).toMatch(/grok is not usable/);
  });

  test("no authenticated harness at all is an error, never a silent mock", () => {
    expect(() =>
      resolveBackends("auto", undefined, undefined, {
        count: 2,
        availability: availability({ claude: false, codex: false, grok: false }),
      }),
    ).toThrow(/no authenticated worker CLI/);
  });
});

class DeadBackend implements Backend {
  readonly id: string;
  calls = 0;
  constructor(id: string, readonly kind: "timeout" | "auth" = "auth") {
    this.id = id;
  }
  async complete(): Promise<WorkerMessage> {
    this.calls += 1;
    throw new BackendError(this.id, this.kind, `${this.id} is done for`);
  }
}

class GoodBackend implements Backend {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  async complete(request: CompleteRequest): Promise<WorkerMessage> {
    if (request.phase === "plan") return { text: "plan", tasks: planTasks(request.trustedGoal) };
    if (request.phase === "synthesize") return { text: "done" };
    const allowed = request.task?.allowedTools ?? [];
    if (allowed.includes("write_file") && (request.step ?? 1) === 1) {
      return {
        text: "writing",
        toolCalls: [{ tool: "write_file", args: { path: "src/ok.txt", content: "OK" } }],
      };
    }
    return { text: "nothing left" };
  }
}

/** Names a tool it was never allowed, then corrects itself once it reads the refusal. */
class WrongToolBackend implements Backend {
  readonly id = "wrong-tool";
  async complete(request: CompleteRequest): Promise<WorkerMessage> {
    if (request.phase === "plan") return { text: "plan", tasks: planTasks(request.trustedGoal) };
    if (request.phase === "synthesize") return { text: "done" };
    const sawRefusal = request.envelopes.some((e) => e.body.includes("blocked: fs_destructive"));
    if (!sawRefusal) {
      return { text: "try 1", toolCalls: [{ tool: "fs_destructive", args: { path: "/" } }] };
    }
    return {
      text: "corrected",
      toolCalls: [{ tool: "write_file", args: { path: "src/second-try.txt", content: "OK" } }],
    };
  }
}

class MuteBackend implements Backend {
  readonly id = "mute";
  calls = 0;
  async complete(): Promise<WorkerMessage> {
    this.calls += 1;
    // What a truncated or killed stdout parses to.
    return { text: "" };
  }
}

describe("a dead backend does not take the run with it", () => {
  test("the run fails over to a live backend and says so in the report", async () => {
    const workspace = await makeWorkspace("failover-");
    const dead = new DeadBackend("grok");
    const alive = new GoodBackend("claude-sonnet");
    const report = await runLoop({
      goal: "Create src/ok.txt containing OK",
      workspace,
      workerA: dead,
      workerB: alive,
      workers: [dead, alive],
    });
    expect(report.backendSwitches.length).toBeGreaterThan(0);
    expect(report.backendSwitches[0].from).toBe("grok");
    expect(report.backendSwitches[0].to).toBe("claude-sonnet");
    expect(report.backendSwitches[0].reason).toContain("auth");
    // The healthy worker still did its job.
    expect(report.executedTools.some((t) => t.tool === "write_file")).toBe(true);
  });

  test("with nothing to fail over to, the task stalls instead of the run crashing", async () => {
    const workspace = await makeWorkspace("no-failover-");
    const dead = new DeadBackend("grok", "timeout");
    const report = await runLoop({
      goal: "Create src/ok.txt containing OK",
      workspace,
      workerA: dead,
      workerB: dead,
      workers: [dead],
      workerCount: 1,
    });
    expect(report.stalledTasks.length).toBeGreaterThan(0);
    expect(report.stalledTasks[0].reason).toContain("timeout");
    expect(exitCodeFor(report)).toBe(5);
  });
});

describe("the loop stops confusing 'refused' and 'unreadable' with 'finished'", () => {
  test("a refused tool is fed back and the worker gets another step", async () => {
    const workspace = await makeWorkspace("blocked-feedback-");
    const report = await runLoop({
      goal: "Create src/second-try.txt containing OK",
      workspace,
      workerA: new WrongToolBackend(),
      workerB: new WrongToolBackend(),
      workerCount: 1,
      workers: [new WrongToolBackend()],
    });
    expect(report.blockedTools.some((b) => b.tool === "fs_destructive")).toBe(true);
    // The point: step 1 was barren and the task kept going.
    expect(report.executedTools.some((t) => t.artifact === "src/second-try.txt")).toBe(true);
  });

  test("an empty answer is reprompted once, then stalls — it never reads as success", async () => {
    const workspace = await makeWorkspace("mute-");
    const mute = new MuteBackend();
    const report = await runLoop({
      goal: "Create src/never.txt containing OK",
      workspace,
      workerA: mute,
      workerB: mute,
      workers: [mute],
      workerCount: 1,
    });
    expect(report.stalledTasks.length).toBeGreaterThan(0);
    expect(report.stalledTasks[0].reason).toContain("no readable answer twice");
    expect(report.executedTools.length).toBe(0);
    expect(exitCodeFor(report)).toBe(5);
  });

  test("exitCodeFor ranks a stalled task above the orchestrator's own 'completed'", () => {
    const base = {
      status: "completed",
      stalledTasks: [{ taskId: "task-1", assignee: "worker_a", backend: "grok", reason: "timeout" }],
    } as unknown as RunReport;
    expect(exitCodeFor(base)).toBe(5);
    expect(exitCodeFor({ ...base, stalledTasks: [] } as RunReport)).toBe(0);
  });
});

describe("agentik spawn refuses a dead harness", () => {
  test("exits 2 with the reason instead of launching a CLI that cannot work", async () => {
    const home = await makeWorkspace("spawn-dead-home-");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "backends.json"),
      JSON.stringify(availability({ claude: true, codex: true, grok: false })),
      "utf8",
    );
    const code = await main([
      "spawn",
      "--harness",
      "grok",
      "--agentik-home",
      home,
      "implement the thing",
    ]);
    expect(code).toBe(2);
  });
});
