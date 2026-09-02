// bun run bench/v2/report.ts — per-phase medians over the repetitions of each variant.
import { readdirSync, readFileSync } from "node:fs";
const dir = new URL("runs/", import.meta.url).pathname;
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const spread = (xs: number[], d = 1) =>
  xs.length ? `${med(xs).toFixed(d)} [${Math.min(...xs).toFixed(d)}–${Math.max(...xs).toFixed(d)}]` : "—";

interface Row { wall: number[]; cost: number[]; out: number[]; cached: number[]; inv: number[]; calls: number[]; refused: number[]; done: number[]; plan: number[]; act: number[]; synth: number[]; lastText: number[] }
const empty = (): Row => ({ wall: [], cost: [], out: [], cached: [], inv: [], calls: [], refused: [], done: [], plan: [], act: [], synth: [], lastText: [] });
const variants = new Map<string, Row>();

for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const variant = f.split("-")[0];
  const r = JSON.parse(readFileSync(dir + f, "utf8"));
  const row = variants.get(variant) ?? empty();
  variants.set(variant, row);
  row.wall.push((r.durationMs ?? 0) / 1000);
  row.cost.push(r.usage?.costUsd ?? 0);
  row.out.push((r.usage?.outputTokens ?? 0) / 1000);
  row.cached.push((r.usage?.cachedInputTokens ?? 0) / 1000);
  row.inv.push(r.usage?.invocations ?? 0);
  const tasks = r.taskResults ?? [];
  row.calls.push(tasks.reduce((n: number, t: any) => n + (t.evidence?.calls?.length ?? 0), 0));
  row.refused.push((r.blockedTools ?? []).length);
  row.done.push(tasks.filter((t: any) => t.status === "done").length);
  const by = (p: string) => (r.workersInvoked ?? []).filter((w: any) => w.phase === p);
  row.plan.push(by("plan").reduce((n: number, w: any) => n + w.durationMs, 0) / 1000);
  row.synth.push(by("synthesize").reduce((n: number, w: any) => n + w.durationMs, 0) / 1000);
  // ACT is parallel: the run's wall clock spent in ACT is the longest task, not the sum.
  row.act.push(Math.max(0, ...tasks.map((t: any) => (t.durationMs ?? 0) / 1000)));
  // The final ACT message of each task: paid in full, then truncated to TASK_SUMMARY_MAX.
  const lastPerTask = new Map<string, number>();
  for (const w of by("act")) lastPerTask.set(w.taskId, w.usage?.outputTokens ?? 0);
  row.lastText.push([...lastPerTask.values()].reduce((a, b) => a + b, 0) / 1000);
}

const names = [...variants.keys()].sort();
const rows: [string, keyof Row, number][] = [
  ["wall clock s", "wall", 1], ["cost $", "cost", 4], ["output tokens k", "out", 1],
  ["cached in k", "cached", 1], ["invocations", "inv", 0], ["gated calls", "calls", 0],
  ["refused calls", "refused", 0], ["tasks done", "done", 0],
  ["phase plan s", "plan", 1], ["phase act s (longest task)", "act", 1], ["phase synth s", "synth", 1],
];
const w0 = 28, w = 24;
console.log("median [min–max] over the repetitions\n");
console.log("".padEnd(w0) + names.map((n) => `${n} (n=${variants.get(n)!.wall.length})`.padEnd(w)).join(""));
for (const [label, key, d] of rows) console.log(label.padEnd(w0) + names.map((n) => spread(variants.get(n)![key], d).padEnd(w)).join(""));
if (names.length === 2) {
  const [a, b] = names.map((n) => variants.get(n)!);
  const pct = (x: number[], y: number[]) => `${(((med(y) - med(x)) / med(x)) * 100).toFixed(0)}%`;
  console.log(`\n${names[1]} vs ${names[0]}: wall ${pct(a.wall, b.wall)} · cost ${pct(a.cost, b.cost)} · output tokens ${pct(a.out, b.out)}`);
}
