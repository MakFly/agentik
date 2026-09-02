// bun run bench/ablation/report.ts — leave-one-out: what each lever costs when removed.
import { readdirSync, readFileSync } from "node:fs";
const dir = new URL("runs/", import.meta.url).pathname;
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const LABEL: Record<string, string> = {
  opt: "all levers on", noL1: "− final-message budget", noL5: "− batch independent calls",
  noL2: "− toolless synthesis", noL3: "− per-phase effort",
};
interface Row { wall: number[]; cost: number[]; out: number[]; inv: number[]; done: number[] }
const V = new Map<string, Row>();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const v = f.split("-")[0];
  const r = JSON.parse(readFileSync(dir + f, "utf8"));
  const row = V.get(v) ?? { wall: [], cost: [], out: [], inv: [], done: [] };
  V.set(v, row);
  row.wall.push((r.durationMs ?? 0) / 1000);
  row.cost.push(r.usage?.costUsd ?? 0);
  row.out.push((r.usage?.outputTokens ?? 0) / 1000);
  row.inv.push(r.usage?.invocations ?? 0);
  row.done.push((r.taskResults ?? []).filter((t: any) => t.status === "done").length);
}
const base = V.get("opt");
const order = ["opt", ...[...V.keys()].filter((k) => k !== "opt").sort()];
console.log("median over the repetitions; Δ = what REMOVING that lever costs vs all levers on\n");
console.log("variant".padEnd(28) + "n".padEnd(4) + "wall s".padEnd(10) + "cost $".padEnd(10) + "out k".padEnd(9) + "inv".padEnd(6) + "Δwall".padEnd(9) + "Δcost".padEnd(9) + "done");
for (const v of order) {
  const r = V.get(v)!;
  const d = (x: number[], y: number[]) => (base && v !== "opt" ? `${(((med(x) - med(y)) / med(y)) * 100).toFixed(0)}%` : "—");
  console.log(
    (LABEL[v] ?? v).padEnd(28) + String(r.wall.length).padEnd(4) +
    med(r.wall).toFixed(1).padEnd(10) + med(r.cost).toFixed(4).padEnd(10) +
    med(r.out).toFixed(1).padEnd(9) + med(r.inv).toFixed(0).padEnd(6) +
    d(r.wall, base!.wall).padEnd(9) + d(r.cost, base!.cost).padEnd(9) +
    `${med(r.done).toFixed(0)}/2`,
  );
}
