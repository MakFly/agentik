import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOwnership, describeOwnership, gitDirty } from "../src/artifacts.ts";
import { formatReport, runLoop } from "../src/loop.ts";
import { newRunId, readRun, writeRun } from "../src/runs.ts";
import type { Backend, CompleteRequest, WorkerMessage } from "../src/types.ts";

/**
 * Who owns the dirty files at the end of a run.
 *
 * The case that matters is the incident the owner lived through: a file that was ALREADY carrying
 * somebody else's uncommitted paragraph when the run started, and that the run then edited. File
 * level possession says "the run touched it, it is the run's"; committing on that basis is how a
 * third party's work gets carried into a commit. The classifier must call that file `contaminated`
 * and never `ours`.
 *
 * The git repository lives in `os.tmpdir()`, never under `<repo>/.tmp/`: git resolves the hooks of
 * a directory inside this checkout to THIS repository's `.git/hooks`.
 */

describe("classifyOwnership", () => {
  test("the incident: a file already dirty before the run and edited by it is contaminated, never ours", () => {
    const before = [" M src/sessions.ts", "?? notes.md"];
    const after = [" M src/sessions.ts", "?? notes.md", "?? src/repo-lock.ts"];
    const o = classifyOwnership(before, after, ["src/sessions.ts", "src/repo-lock.ts"]);

    expect(o.contaminated).toEqual(["src/sessions.ts"]);
    expect(o.ours).toEqual(["src/repo-lock.ts"]);
    expect(o.ours).not.toContain("src/sessions.ts");
    // Dirty before, never claimed by the run: somebody else's business.
    expect(o.foreign).toEqual(["notes.md"]);
    expect(o.witness).toBe(true);
  });

  test("an already-dirty file the run never claimed stays foreign, even with the same status", () => {
    const o = classifyOwnership([" M a.ts", " M b.ts"], [" M a.ts", " M b.ts"], ["a.ts"]);
    expect(o.contaminated).toEqual(["a.ts"]);
    expect(o.foreign).toEqual(["b.ts"]);
    expect(o.ours).toEqual([]);
  });

  test("a status that moved is a claim on its own: `??` staged into `A ` is contamination", () => {
    // No `touched` at all: the only witness is git, and it says the entry changed during the run.
    const o = classifyOwnership(["?? draft.md"], ["A  draft.md"], []);
    expect(o.contaminated).toEqual(["draft.md"]);
    expect(o.ours).toEqual([]);
    expect(o.foreign).toEqual([]);
  });

  test("a file that was dirty and is not any more is foreign unless the run claims it", () => {
    const committed = classifyOwnership([" M a.ts", " M b.ts"], [" M b.ts"], []);
    expect(committed.foreign).toEqual(["a.ts", "b.ts"]);
    expect(committed.ours).toEqual([]);
    const mine = classifyOwnership([" M a.ts"], [], ["a.ts"]);
    expect(mine.contaminated).toEqual(["a.ts"]);
  });

  test("a rename is two porcelain entries with -z: the bare source path is still a path", () => {
    // `git status --porcelain -z` emits `R  new` then a separate entry holding the old name.
    const o = classifyOwnership([], ["R  new.ts", "old.ts"], []);
    expect(o.ours).toEqual(["new.ts", "old.ts"]);
  });

  test("an artifact given as an absolute path still matches its porcelain entry", () => {
    const o = classifyOwnership([" M src/loop.ts"], [" M src/loop.ts"], ["/home/kev/lab/agentik/src/loop.ts"]);
    expect(o.contaminated).toEqual(["src/loop.ts"]);
  });

  test("no witness is not innocence: outside a repository every list is empty and says so", () => {
    const none = classifyOwnership(undefined, undefined, ["src/whatever.ts"]);
    expect(none.witness).toBe(false);
    expect(none.ours).toEqual([]);
    expect(none.contaminated).toEqual([]);
    expect(none.foreign).toEqual([]);
    expect(describeOwnership(none)).toContain("absence of evidence");
    // Half a witness is no witness: a run that started outside git and ended inside it proves nothing.
    expect(classifyOwnership([" M a.ts"], undefined).witness).toBe(false);
    expect(classifyOwnership(undefined, [" M a.ts"]).witness).toBe(false);
  });

  test("a clean checkout that stays clean owns nothing", () => {
    const o = classifyOwnership([], [], ["src/loop.ts"]);
    expect(o).toMatchObject({ ours: [], contaminated: [], foreign: [], witness: true });
    expect(describeOwnership(o)).toBe("ours: [] / contaminated: [] / foreign: []");
  });
});

describe("classifyOwnership over real `git status` output", () => {
  /**
   * The same incident against real git: a third party's edit is already in the checkout, then the
   * "run" edits that very file and creates one of its own. Parsing is exercised on git's real
   * porcelain bytes, not on a hand-written fixture.
   */
  test("a real checkout: a third party's file edited by the run comes out contaminated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ak-ownership-"));
    try {
      const git = async (...args: string[]) => {
        const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
      };
      await git("init", "-q", "-b", "main", ".");
      await git("config", "user.email", "test@agentik.local");
      await git("config", "user.name", "agentik test");
      await writeFile(join(dir, "shared.ts"), "committed line\n");
      await writeFile(join(dir, "untouched.ts"), "committed line\n");
      await git("add", "-A");
      await git("commit", "-qm", "base");

      // Before the run: somebody else's uncommitted work is already here.
      await writeFile(join(dir, "shared.ts"), "committed line\nsomebody else's paragraph\n");
      await writeFile(join(dir, "their-draft.md"), "a third party's untracked draft\n");
      const before = gitDirty(dir);
      expect(before).toBeDefined();
      expect(before!.length).toBe(2);

      // The run: it edits the shared file and writes one of its own.
      await writeFile(join(dir, "shared.ts"), "committed line\nsomebody else's paragraph\nthe run's line\n");
      await writeFile(join(dir, "mine.ts"), "the run's file\n");
      const after = gitDirty(dir);

      const o = classifyOwnership(before, after, ["shared.ts", "mine.ts"]);
      expect(o.witness).toBe(true);
      expect(o.ours).toEqual(["mine.ts"]);
      expect(o.contaminated).toEqual(["shared.ts"]);
      expect(o.foreign).toEqual(["their-draft.md"]);
      // `untouched.ts` was never dirty: it is in no list at all.
      expect([...o.ours, ...o.contaminated, ...o.foreign]).not.toContain("untouched.ts");
      expect(describeOwnership(o)).toBe("ours: [mine.ts] / contaminated: [shared.ts] / foreign: [their-draft.md]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("outside a repository gitDirty gives no witness, and the classification says so", async () => {
    const plain = await mkdtemp(join(tmpdir(), "ak-ownership-plain-"));
    try {
      await writeFile(join(plain, "a.txt"), "x\n");
      const o = classifyOwnership(gitDirty(plain), gitDirty(plain), ["a.txt"]);
      expect(o.witness).toBe(false);
      expect(describeOwnership(o)).toContain("not proof that nothing moved");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Same shape as the `Scripted` backend of tests/proof.test.ts. */
class Scripted implements Backend {
  seen: CompleteRequest[] = [];
  constructor(
    readonly id: string,
    private readonly plan: WorkerMessage["tasks"],
    private readonly acts: Record<string, WorkerMessage[]> = {},
  ) {}
  async complete(req: CompleteRequest): Promise<WorkerMessage> {
    this.seen.push(req);
    if (req.phase === "plan") return { text: "plan", tasks: this.plan };
    if (req.phase === "synthesize") return { text: "synthesis" };
    const id = req.task?.id ?? "?";
    const n = this.seen.filter((r) => r.phase === "act" && r.task?.id === id).length;
    return this.acts[id]?.[n - 1] ?? { text: `${id} finished`, toolCalls: [] };
  }
}

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
}

describe("a whole run carries its ownership witness", () => {
  /**
   * The witness is taken by `runLoop` at the start of the RUN — not per task, and whether or not
   * any task is mutating — and again at the report. Here a third party's edit is in the checkout
   * before the run starts, and the run edits that same file: the report must say `contaminated`,
   * and the run file must keep both snapshots for whoever comes to stage the work later.
   */
  test("gitDirty before and after land in RunReport.ownership, in the run file, and in the report text", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ak-ownership-run-"));
    const home = await mkdtemp(join(tmpdir(), "ak-ownership-home-"));
    try {
      git(ws, "init", "-q", "-b", "main");
      await writeFile(join(ws, "shared.txt"), "committed\n");
      git(ws, "add", "-A");
      git(ws, "commit", "-qm", "base");
      // Somebody else's uncommitted work, already there when the run starts.
      await writeFile(join(ws, "shared.txt"), "committed\nsomebody else's paragraph\n");

      const plan: WorkerMessage["tasks"] = [
        { id: "impl", assignee: "worker_a", instruction: "edit shared.txt and add mine.txt", allowedTools: ["read_file", "write_file"], maxSteps: 3 },
      ];
      const a = new Scripted("s-a", plan, {
        impl: [
          {
            text: "writing",
            toolCalls: [
              { tool: "write_file", args: { path: "shared.txt", content: "committed\nsomebody else's paragraph\nthe run's line\n" } },
              { tool: "write_file", args: { path: "mine.txt", content: "the run's file\n" } },
            ],
          },
          { text: "done", toolCalls: [] },
        ],
      });
      const b = new Scripted("s-b", plan);
      const report = await runLoop({ goal: "edit shared.txt and add mine.txt", workspace: ws, workerA: a, workerB: b, codeIndex: false });

      const own = report.ownership!;
      expect(own.witness).toBe(true);
      // The start-of-run snapshot saw the third party's edit and nothing else.
      expect(own.before).toEqual([" M shared.txt"]);
      expect(own.after).toContain("?? mine.txt");
      expect(own.ours).toEqual(["mine.txt"]);
      expect(own.contaminated).toEqual(["shared.txt"]);
      expect(own.foreign).toEqual([]);
      // Printed by `agentik run` and, through the stored report, by `agentik runs show`.
      const text = formatReport(report);
      expect(text).toContain("ownership: 1 ours · 1 contaminated · 0 foreign");
      expect(text).toContain("CONTAMINATED (this run + work that was already there): shared.txt");

      // The run file keeps both snapshots next to the artifact snapshot.
      const id = newRunId();
      await writeRun({ id, at: new Date().toISOString(), goal: "g", workspace: ws, profile: "default", status: report.status, exitCode: 0, backend: "mock", workers: 2, durationMs: report.durationMs, report }, { home });
      const rec = await readRun(id, { home });
      expect(Array.isArray(rec)).toBe(false);
      const stored = (rec as { report: typeof report }).report.ownership!;
      expect(stored.before).toEqual([" M shared.txt"]);
      expect(stored.contaminated).toEqual(["shared.txt"]);
      expect(stored.ours).toEqual(["mine.txt"]);
    } finally {
      await rm(ws, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("outside a git repository the run still reports, with witness false", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ak-ownership-nogit-"));
    try {
      const plan: WorkerMessage["tasks"] = [
        { id: "impl", assignee: "worker_a", instruction: "write mine.txt", allowedTools: ["read_file", "write_file"], maxSteps: 3 },
      ];
      const a = new Scripted("s-a", plan, {
        impl: [
          { text: "writing", toolCalls: [{ tool: "write_file", args: { path: "mine.txt", content: "x\n" } }] },
          { text: "done", toolCalls: [] },
        ],
      });
      const b = new Scripted("s-b", plan);
      const report = await runLoop({ goal: "write mine.txt", workspace: ws, workerA: a, workerB: b, codeIndex: false });
      expect(report.ownership!.witness).toBe(false);
      expect(report.ownership!.ours).toEqual([]);
      expect(formatReport(report)).toContain("ownership: no git witness");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  }, 30_000);
});
