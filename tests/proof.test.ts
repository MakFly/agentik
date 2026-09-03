import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exitCodeFor } from "../src/cli.ts";
import { gitDirty } from "../src/artifacts.ts";
import { runLoop } from "../src/loop.ts";
import { TOOL_OUTPUT_INLINE_MAX } from "../src/tool-results.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";
import { makeWorkspace } from "./helpers.ts";

/**
 * Proof of work: a run that did nothing must not exit 0.
 *
 * Four holes closed here, all of them "the report says success and the disk says otherwise":
 *   1. a failed acceptance never reached the exit code (`completed`, exit 0);
 *   2. a worker that answers politely without touching anything was `done`;
 *   3. `touch` beat the artifact witness (mtime moves, content does not);
 *   4. two concurrent runs overwrote each other's spilled tool output.
 *
 * The trigger of the refusal is STRUCTURAL — mutation declared, mutation nil — never lexical: no
 * regex on "I cannot", "policy" or "AGENTS.md" appears in the decision, because a rephrasing beats
 * a keyword list and a polite refusal is exactly the observed failure. The refusal wording is
 * quoted in the reason as evidence, never used as the criterion; test 2 proves it by refusing a
 * message that contains no refusal word at all.
 */

/** Same shape as the `Scripted` backend of tests/task-results.test.ts and tests/run-cost.test.ts. */
class Scripted implements Backend {
  seen: CompleteRequest[] = [];
  constructor(
    readonly id: string,
    private readonly plan: WorkerMessage["tasks"],
    private readonly acts: Record<string, WorkerMessage[]> = {},
    private readonly synth: WorkerMessage = { text: "synthesis" },
  ) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    if (req.phase === "plan") return { text: "plan", tasks: this.plan };
    if (req.phase === "synthesize") return this.synth;
    const id = req.task?.id ?? "?";
    const n = this.seen.filter((r) => r.phase === "act" && r.task?.id === id).length;
    return this.acts[id]?.[n - 1] ?? { text: `${id} finished`, toolCalls: [] };
  }
}

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

/**
 * A git workspace must NOT live under `<repo>/.tmp/`: git would resolve its hooks directory to
 * this repository's `.git/hooks` (it happened live). `os.tmpdir()` is outside every checkout.
 */
async function gitWorkspace(prefix: string): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), prefix));
  git(ws, "init", "-q");
  return ws;
}

const POLITE_REFUSAL =
  "I reviewed the request. A repository-level instruction file governs this kind of invocation, so I did not modify anything; here is what I would do instead.";

describe("hole 1+2: a mutating task that mutates nothing is refused, and the run does not exit 0", () => {
  test("prose only, no tool call: refused with the worker's own words as evidence, run blocked, exit 3", async () => {
    const ws = await makeWorkspace("proof-refused-");
    const plan: WorkerMessage["tasks"] = [
      { id: "impl", assignee: "worker_a", instruction: "write greet.txt", allowedTools: ["read_file", "write_file"], maxSteps: 2 },
    ];
    const a = new Scripted("s-a", plan, { impl: [{ text: POLITE_REFUSAL, toolCalls: [] }] });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "write greet.txt", workspace: ws, workerA: a, workerB: b, codeIndex: false });

    const impl = report.taskResults[0];
    expect(impl.status).toBe("refused");
    // The refusal is quoted verbatim: a human reading the report sees WHY, without re-running.
    expect(impl.reason).toContain(POLITE_REFUSAL);
    expect(impl.artifacts).toEqual([]);
    expect(existsSync(join(ws, "greet.txt"))).toBe(false);
    // The status the whole run gets: `blocked`, which the CLI already maps to exit 3 and to an
    // incident. Before this, it was `completed` and exit 0.
    expect(report.status).toBe("blocked");
    expect(exitCodeFor(report)).toBe(3);
  });

  test("negative case: the same worker writes the file — done, completed, exit 0 (no fabricated objection)", async () => {
    const ws = await makeWorkspace("proof-done-");
    const plan: WorkerMessage["tasks"] = [
      { id: "impl", assignee: "worker_a", instruction: "write greet.txt", allowedTools: ["read_file", "write_file"], maxSteps: 2 },
    ];
    const a = new Scripted("s-a", plan, {
      impl: [
        { text: "writing it", toolCalls: [{ tool: "write_file", args: { path: "greet.txt", content: "AGENTIK_OK" } }] },
        { text: "wrote greet.txt", toolCalls: [] },
      ],
    });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "write greet.txt", workspace: ws, workerA: a, workerB: b, codeIndex: false });

    expect(report.taskResults[0].status).toBe("done");
    expect(report.taskResults[0].artifacts).toEqual(["greet.txt"]);
    expect(await readFile(join(ws, "greet.txt"), "utf8")).toBe("AGENTIK_OK");
    expect(report.status).toBe("completed");
    expect(exitCodeFor(report)).toBe(0);
  });

  test("structural, not lexical: a tool ran, the answer contains no refusal word, nothing changed — still refused", async () => {
    const ws = await makeWorkspace("proof-structural-");
    await writeFile(join(ws, "notes.md"), "# notes\n", "utf8");
    const plan: WorkerMessage["tasks"] = [
      { id: "impl", assignee: "worker_a", instruction: "update notes.md", allowedTools: ["read_file", "write_file"], maxSteps: 3 },
    ];
    // Not a single word a keyword detector could catch: no "cannot", no "policy", no "sorry",
    // no "instead". It reads as a success report — and it is a lie the disk contradicts.
    const claimsSuccess = "Reviewed notes.md end to end. The structure already matches the target layout and the wording is consistent, so the deliverable is in the state the goal describes.";
    const a = new Scripted("s-a", plan, {
      impl: [
        { text: "reading the file", toolCalls: [{ tool: "read_file", args: { path: "notes.md" } }] },
        { text: claimsSuccess, toolCalls: [] },
      ],
    });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "update notes.md", workspace: ws, workerA: a, workerB: b, codeIndex: false });

    const impl = report.taskResults[0];
    expect(impl.evidence.executed).toBe(1); // a tool DID run: "it called a tool" proves nothing
    expect(impl.status).toBe("refused");
    expect(impl.reason).toContain(claimsSuccess);
    expect(await readFile(join(ws, "notes.md"), "utf8")).toBe("# notes\n");
    expect(exitCodeFor(report)).toBe(3);
  });

  test("a task allowed read_file only and answering in prose is done: no objection is fabricated", async () => {
    const ws = await makeWorkspace("proof-readonly-");
    await writeFile(join(ws, "notes.md"), "# notes\n", "utf8");
    const plan: WorkerMessage["tasks"] = [
      { id: "look", assignee: "worker_a", instruction: "read notes.md and report", allowedTools: ["read_file"], maxSteps: 2 },
    ];
    const a = new Scripted("s-a", plan, { look: [{ text: "notes.md has one heading and no body.", toolCalls: [] }] });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "review notes.md", workspace: ws, workerA: a, workerB: b, codeIndex: false });

    expect(report.taskResults[0].status).toBe("done");
    expect(report.status).toBe("completed");
    expect(exitCodeFor(report)).toBe(0);
  });
});

describe("hole 3: the git witness — `touch` moves the stat, not the content", () => {
  test("a tracked, committed file touched through run_command: mtime moves, git says nothing, task refused", async () => {
    const ws = await gitWorkspace("proof-git-");
    await writeFile(join(ws, "tracked.txt"), "content\n", "utf8");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "init");
    expect(gitDirty(ws)).toEqual([]);
    const mtimeBefore = statSync(join(ws, "tracked.txt")).mtimeMs;

    const plan: WorkerMessage["tasks"] = [
      { id: "impl", assignee: "worker_a", instruction: "update tracked.txt", allowedTools: ["read_file", "run_command"], maxSteps: 3 },
    ];
    const a = new Scripted("s-a", plan, {
      impl: [
        { text: "refreshing the file", toolCalls: [{ tool: "run_command", args: { argv: ["touch", "tracked.txt"] } }] },
        { text: "tracked.txt is up to date.", toolCalls: [] },
      ],
    });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "update tracked.txt", workspace: ws, workerA: a, workerB: b, codeIndex: false });

    // The stat witness alone would have been satisfied…
    expect(statSync(join(ws, "tracked.txt")).mtimeMs).not.toBe(mtimeBefore);
    // …and the content witness is not.
    expect(gitDirty(ws)).toEqual([]);
    expect(await readFile(join(ws, "tracked.txt"), "utf8")).toBe("content\n");
    expect(report.taskResults[0].status).toBe("refused");
    expect(exitCodeFor(report)).toBe(3);
  });

  test("the same task writing real content through run_command is done", async () => {
    const ws = await gitWorkspace("proof-git-ok-");
    await writeFile(join(ws, "tracked.txt"), "content\n", "utf8");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "init");

    const plan: WorkerMessage["tasks"] = [
      { id: "impl", assignee: "worker_a", instruction: "update tracked.txt", allowedTools: ["read_file", "run_command"], maxSteps: 3 },
    ];
    // No journalled artifact (run_command produces none) and no declared path: git is the ONLY
    // witness here, and it is the one that says the work happened.
    const a = new Scripted("s-a", plan, {
      impl: [
        { text: "rewriting the file", toolCalls: [{ tool: "run_command", args: { argv: ["cp", "/dev/null", "tracked.txt"] } }] },
        { text: "tracked.txt rewritten.", toolCalls: [] },
      ],
    });
    const b = new Scripted("s-b", plan);
    const report = await runLoop({ goal: "update tracked.txt", workspace: ws, workerA: a, workerB: b, codeIndex: false });

    expect(gitDirty(ws)).not.toEqual([]);
    expect(report.taskResults[0].status).toBe("done");
    expect(exitCodeFor(report)).toBe(0);
  });

  test("gitDirty is undefined outside a repository: no witness is not a verdict", async () => {
    const plain = await mkdtemp(join(tmpdir(), "proof-nogit-"));
    expect(gitDirty(plain)).toBeUndefined();
  });
});

describe("hole 4: two concurrent runs never overwrite each other's spilled tool output", () => {
  test("same workspace, same call ids, two big outputs: two files, each with its own bytes", async () => {
    const ws = await makeWorkspace("proof-spill-");
    const task = (id: string, from: number, to: number): { plan: WorkerMessage["tasks"]; a: Scripted; b: Scripted } => {
      const plan: WorkerMessage["tasks"] = [
        { id, assignee: "worker_a", instruction: "print a lot", allowedTools: ["read_file", "run_command"], maxSteps: 2 },
      ];
      return {
        plan,
        a: new Scripted(`s-a-${id}`, plan, { [id]: [{ text: "printing", toolCalls: [{ tool: "run_command", args: { argv: ["seq", String(from), String(to)] } }] }] }),
        b: new Scripted(`s-b-${id}`, plan),
      };
    };
    // Both runs plan a single task for worker_a, so both produce the call id
    // `worker_a-run_command-1` — the exact collision that made one run read the other's bytes.
    const one = task("solo", 1, 4000);
    const two = task("solo", 900001, 904000);
    const [r1, r2] = await Promise.all([
      runLoop({ goal: "print the first range", workspace: ws, workerA: one.a, workerB: one.b, codeIndex: false }),
      runLoop({ goal: "print the second range", workspace: ws, workerA: two.a, workerB: two.b, codeIndex: false }),
    ]);

    const pathOf = (r: typeof r1) => r.executedTools.find((t) => t.tool === "run_command" && t.outputPath)?.outputPath;
    const p1 = pathOf(r1);
    const p2 = pathOf(r2);
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1).not.toBe(p2);

    const body1 = await readFile(join(ws, p1!), "utf8");
    const body2 = await readFile(join(ws, p2!), "utf8");
    expect(body1.length).toBeGreaterThan(TOOL_OUTPUT_INLINE_MAX);
    expect(body2.length).toBeGreaterThan(TOOL_OUTPUT_INLINE_MAX);
    // Each file holds its OWN run's output, whole, with nothing of the neighbour's.
    expect(body1).toContain("\n4000\n");
    expect(body1).not.toContain("900001");
    expect(body2).toContain("\n904000\n");
    expect(body2).not.toContain("\n4000\n");
  });
});
