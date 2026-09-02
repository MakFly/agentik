// bun run bench/index-ab/compare.ts — side-by-side of no-index.json vs index.json
import { readFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const load = (n: string) => JSON.parse(readFileSync(`${dir}${n}.json`, "utf8"));
const rows: [string, (r: any) => unknown][] = [
  ["status", (r) => r.status],
  ["exit", (r) => r.exitCode],
  ["duration s", (r) => ((r.durationMs ?? 0) / 1000).toFixed(1)],
  ["tokens in", (r) => r.usage?.inputTokens],
  ["  cached in", (r) => r.usage?.cachedInputTokens],
  ["tokens out", (r) => r.usage?.outputTokens],
  ["cost $", (r) => r.usage?.costUsd?.toFixed?.(4)],
  ["invocations", (r) => r.usage?.invocations],
  ["tool calls", (r) => r.taskResults?.reduce((n: number, t: any) => n + (t.evidence?.calls?.length ?? 0), 0)],
  ["search_code", (r) => r.taskResults?.reduce((n: number, t: any) => n + (t.evidence?.calls?.filter((c: any) => c.tool === "search_code").length ?? 0), 0)],
  ["read_file", (r) => r.taskResults?.reduce((n: number, t: any) => n + (t.evidence?.calls?.filter((c: any) => c.tool === "read_file").length ?? 0), 0)],
  ["run_command", (r) => r.taskResults?.reduce((n: number, t: any) => n + (t.evidence?.calls?.filter((c: any) => c.tool === "run_command").length ?? 0), 0)],
  ["shaped chars", (r) => r.shaping?.savedChars],
  ["code index", (r) => r.codeIndex ? `${r.codeIndex.files} files` : "off"],
  ["plan source", (r) => r.planSource],
  ["tasks", (r) => r.taskResults?.map((t: any) => `${t.taskId}:${t.status}`).join(" ")],
];
const a = load("no-index"), b = load("index");
const pad = (s: unknown, n: number) => String(s ?? "—").padEnd(n);
console.log(`${pad("", 14)}${pad("no-index", 22)}index`);
for (const [k, f] of rows) console.log(`${pad(k, 14)}${pad(f(a), 22)}${f(b)}`);
