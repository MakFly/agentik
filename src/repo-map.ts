import { splitIdent } from "./code-chunker.ts";
import { hasIndex, indexKey, openIndex } from "./code-index.ts";
import { agentikHome } from "./home.ts";
import { fold, tokenize } from "./sessions.ts";

/**
 * Aider-style repository map from the code index: the files that matter most for a goal, each
 * with its exported symbols, inside a character budget. Rank = PageRank over the import graph
 * (a file many others import ranks high) × a bonus when a goal term appears in the path or a
 * symbol. Paths and identifiers ONLY — never a body line, never a comment — so the map can sit in
 * a planner's context without carrying a payload from the workspace.
 */

export const CODE_MAP_BUDGET = 1500;
export const HOT_SPOT_LINES = 700;
const PAGERANK_ITERATIONS = 20;
const DAMPING = 0.85;
const LINE_MAX = 140;

interface FileRow {
  id: number;
  path: string;
  lines: number;
}

/** Goal terms that can match a path or a symbol: tokens and their camel/snake parts, folded. */
export function mapTerms(goal: string | undefined): string[] {
  if (!goal) return [];
  const out = new Set<string>();
  for (const t of tokenize(goal)) {
    const f = fold(t);
    if (f.length >= 3) out.add(f);
    for (const p of splitIdent(t)) {
      const fp = fold(p);
      if (fp.length >= 3) out.add(fp);
    }
  }
  return [...out];
}

export function pageRank(ids: number[], edges: Array<[number, number]>): Map<number, number> {
  const n = ids.length;
  const rank = new Map<number, number>();
  if (n === 0) return rank;
  const out = new Map<number, number[]>();
  for (const id of ids) {
    rank.set(id, 1 / n);
    out.set(id, []);
  }
  for (const [from, to] of edges) if (out.has(from) && rank.has(to)) out.get(from)!.push(to);
  for (let it = 0; it < PAGERANK_ITERATIONS; it++) {
    const next = new Map<number, number>();
    let sink = 0;
    for (const id of ids) if (out.get(id)!.length === 0) sink += rank.get(id)!;
    const base = (1 - DAMPING) / n + (DAMPING * sink) / n;
    for (const id of ids) next.set(id, base);
    for (const id of ids) {
      const targets = out.get(id)!;
      if (!targets.length) continue;
      const share = (DAMPING * rank.get(id)!) / targets.length;
      for (const t of targets) next.set(t, next.get(t)! + share);
    }
    for (const [id, r] of next) rank.set(id, r);
  }
  return rank;
}

/**
 * The map for a goal, or undefined when the workspace has no index. `budgetChars` bounds the
 * whole block; a file line is cut at LINE_MAX; files over HOT_SPOT_LINES are listed last.
 */
export async function repoMap(
  home: string | undefined,
  workspace: string,
  opts: { goal?: string; budgetChars?: number } = {},
): Promise<string | undefined> {
  const h = agentikHome(home);
  if (!hasIndex(h, workspace)) return undefined;
  const { root } = indexKey(workspace);
  const db = openIndex(h, root);
  if (!db) return undefined;
  try {
    const files = db.query<FileRow, []>("SELECT id, path, lines FROM code_files ORDER BY path").all();
    if (!files.length) return undefined;
    const edges = db.query<{ from_id: number; to_id: number }, []>("SELECT from_id, to_id FROM code_edges").all().map((e) => [e.from_id, e.to_id] as [number, number]);
    const symbols = new Map<number, string[]>();
    for (const r of db.query<{ file_id: number; symbol: string }, []>("SELECT file_id, symbol FROM code_chunks WHERE exported = 1 AND symbol != '' ORDER BY file_id, start").all()) {
      let list = symbols.get(r.file_id);
      if (!list) symbols.set(r.file_id, (list = []));
      if (!list.includes(r.symbol)) list.push(r.symbol);
    }
    const chunks = db.query<{ n: number }, []>("SELECT count(*) AS n FROM code_chunks").get()?.n ?? 0;
    const terms = mapTerms(opts.goal);
    const pr = pageRank(files.map((f) => f.id), edges);
    const maxPr = Math.max(...pr.values(), 1e-9);
    const scored = files.map((f) => {
      const p = fold(f.path);
      const syms = symbols.get(f.id) ?? [];
      let hits = 0;
      for (const t of terms) {
        if (p.includes(t)) hits += 1;
        if (syms.some((s) => fold(s).includes(t))) hits += 1;
      }
      return { f, syms, score: (pr.get(f.id)! / maxPr) * (1 + hits) + hits };
    });
    scored.sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path));
    const budget = opts.budgetChars ?? CODE_MAP_BUDGET;
    const header = `CODE MAP (this repository: ${files.length} files, ${chunks} chunks; top by imports × goal terms)`;
    const out: string[] = [header];
    let used = header.length + 1;
    const hot = files.filter((f) => f.lines > HOT_SPOT_LINES).sort((a, b) => b.lines - a.lines);
    const hotLine = hot.length ? cut(`hot spots (>${HOT_SPOT_LINES} lines): ${hot.map((f) => `${f.path} (${f.lines})`).join(", ")}`, LINE_MAX) : undefined;
    const reserve = hotLine ? hotLine.length + 1 : 0;
    for (const { f, syms } of scored) {
      const line = cut(`- ${f.path} (${f.lines}L)${syms.length ? `: ${syms.join(", ")}` : ""}`, LINE_MAX);
      if (used + line.length + 1 + reserve > budget) break;
      out.push(line);
      used += line.length + 1;
    }
    if (hotLine) out.push(hotLine);
    return `${out.join("\n")}\n`;
  } finally {
    db.close();
  }
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
