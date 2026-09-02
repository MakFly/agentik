/**
 * Dependency-driven scheduler for bounded tasks. Pure: it knows nothing about models, tools or
 * the orchestrator; it is handed `run(task, deps)` and decides only WHEN to call it.
 *
 * Concurrency model (read this before touching the loop):
 *   - one JavaScript thread; runs interleave only at the `await`s inside `run` (backend calls,
 *     tool executions). Every mutation of shared state in the loop (executed[], blocked[],
 *     artifacts[], claims, the orchestrator's approvals and events) is synchronous between two
 *     awaits, so no two runs ever write it "at the same time";
 *   - a task is READY when every task it depends on is `done` and no other run of the same key
 *     (the worker role) is in flight: **one run in flight per role**, whatever `concurrency` says;
 *   - at most `concurrency` runs in flight; the next ready task starts as soon as one finishes
 *     (`Promise.race`), never later;
 *   - a task whose dependency ended other than `done` is `blocked` synthetically, without a call;
 *   - ids are unique (the plan schema guarantees it); results come back in plan order;
 *   - `shouldStop()` is polled before every start: an override stops new starts, the runs in
 *     flight finish on their own.
 */

export interface DagTask {
  id: string;
  dependsOn?: string[];
}

export interface DagResult {
  status: "done" | "stalled" | "blocked" | "failed";
}

export interface RunDagOptions<T extends DagTask, R extends DagResult> {
  /** Max runs in flight (≥ 1). */
  concurrency: number;
  /** Two tasks with the same key never run at the same time (the worker role). */
  keyOf: (task: T) => string;
  run: (task: T, deps: R[]) => Promise<R>;
  /** A result for a task whose dependencies did not finish `done`, with no call. */
  blocked: (task: T, missing: string[]) => R;
  /** Polled before each start; true stops new starts (runs in flight finish). */
  shouldStop?: () => boolean;
  /** A result for a task never started because the run was stopped. */
  skipped?: (task: T) => R;
}

export async function runDag<T extends DagTask, R extends DagResult>(tasks: T[], opts: RunDagOptions<T, R>): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const results = new Map<string, R>();
  const inFlight = new Map<string, Promise<void>>();
  const busyKeys = new Set<string>();
  const pending = [...tasks];

  const depsOf = (t: T) => (t.dependsOn ?? []).map((id) => results.get(id));
  const ready = (t: T) => (t.dependsOn ?? []).every((id) => results.has(id)) && !busyKeys.has(opts.keyOf(t));

  while (pending.length || inFlight.size) {
    // Start everything that can start, up to the cap.
    let started = true;
    while (started && inFlight.size < concurrency && pending.length && !opts.shouldStop?.()) {
      started = false;
      const idx = pending.findIndex(ready);
      if (idx < 0) break;
      const [task] = pending.splice(idx, 1);
      const deps = depsOf(task);
      const missing = (task.dependsOn ?? []).filter((_, i) => !deps[i] || deps[i]!.status !== "done");
      if (missing.length) {
        results.set(task.id, opts.blocked(task, missing));
        started = true;
        continue;
      }
      const key = opts.keyOf(task);
      busyKeys.add(key);
      const p = opts
        .run(task, deps as R[])
        .then((r) => {
          results.set(task.id, r);
        })
        .finally(() => {
          busyKeys.delete(key);
          inFlight.delete(task.id);
        });
      inFlight.set(task.id, p);
      started = true;
    }
    if (inFlight.size) {
      await Promise.race(inFlight.values());
      continue;
    }
    if (opts.shouldStop?.()) break;
    if (pending.length && !pending.some(ready)) {
      // Nothing ready and nothing in flight: the graph is stuck (a cycle the schema let through).
      for (const t of pending.splice(0)) results.set(t.id, opts.blocked(t, (t.dependsOn ?? []).filter((id) => !results.has(id))));
    }
  }
  for (const t of pending) if (opts.skipped) results.set(t.id, opts.skipped(t));
  return tasks.filter((t) => results.has(t.id)).map((t) => results.get(t.id)!);
}
