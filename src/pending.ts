import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import type { MemoryOperation, MemoryTarget } from "./memory-store.ts";

/**
 * Staged writes. When `writeApproval` is on, nothing reaches MEMORY.md / USER.md / a skill
 * until a human approves it; the write is a JSON file here instead. The reviewer sees a
 * success (it did its job: it decided), the human sees a queue.
 *
 *   pending/memory/<id>.json      { id, target, ops, at, preview }
 *   pending/skills-ops/<id>.json  { id, action, name, args, at }
 *
 * `pending/skills/<name>/SKILL.md` is a different thing: a human draft (`agentik skill draft`).
 */
export type PendingKind = "memory" | "skills";

export interface PendingMemoryOp {
  id: string;
  target: MemoryTarget;
  ops: MemoryOperation[];
  at: string;
  preview: string;
}

export interface PendingSkillOp {
  id: string;
  action: "patch" | "create";
  name: string;
  args: Record<string, unknown>;
  at: string;
}

const ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;

export function isPendingId(s: string): boolean {
  return ID_RE.test(s);
}

export function newPendingId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${stamp}-${rand}`;
}

function dirFor(kind: PendingKind, home?: string): string {
  const paths = memoryPaths(agentikHome(home));
  return kind === "memory" ? paths.pendingMemoryOps : paths.pendingSkillOps;
}

export async function stagePending<T extends { id: string }>(
  kind: PendingKind,
  entry: T,
  opts?: { home?: string },
): Promise<string> {
  if (!isPendingId(entry.id)) throw new Error(`invalid pending id ${entry.id}`);
  const dir = dirFor(kind, opts?.home);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${entry.id}.json`);
  await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return path;
}

export async function listPending<T extends { id: string }>(kind: PendingKind, opts?: { home?: string }): Promise<T[]> {
  const dir = dirFor(kind, opts?.home);
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, f), "utf8")) as T;
      if (raw && typeof raw === "object" && typeof raw.id === "string") out.push(raw);
    } catch {
      /* a corrupt file is skipped, never deleted */
    }
  }
  return out;
}

export async function readPending<T extends { id: string }>(
  kind: PendingKind,
  id: string,
  opts?: { home?: string },
): Promise<T | undefined> {
  if (!isPendingId(id)) return undefined;
  try {
    return JSON.parse(await readFile(join(dirFor(kind, opts?.home), `${id}.json`), "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function removePending(kind: PendingKind, id: string, opts?: { home?: string }): Promise<boolean> {
  if (!isPendingId(id)) return false;
  try {
    await rm(join(dirFor(kind, opts?.home), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function pendingCounts(opts?: { home?: string }): Promise<{ memory: number; skills: number }> {
  const [m, s] = await Promise.all([listPending("memory", opts), listPending("skills", opts)]);
  return { memory: m.length, skills: s.length };
}
