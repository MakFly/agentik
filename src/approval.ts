import { memoryApply } from "./memory-store.ts";
import {
  listPending,
  readPending,
  removePending,
  type PendingKind,
  type PendingMemoryOp,
  type PendingSkillOp,
} from "./pending.ts";
import { applySkillCreate, applySkillPatch } from "./skill-ops.ts";

/**
 * `agentik memory|skills approve <id|all>` and `reject <id|all>`.
 *
 * Approval replays the staged operation as it was staged, through the same code the
 * reviewer would have run — and against the store as it is *now*: an add that no longer fits
 * under the cap is refused with the cap message and stays pending, so the human can
 * consolidate and approve again. Rejection just deletes the staged file.
 */
export interface ApprovalOutcome {
  id: string;
  ok: boolean;
  message: string;
}

async function idsFor(kind: PendingKind, selector: string, home?: string): Promise<string[] | { error: string }> {
  if (selector === "all") return (await listPending<{ id: string }>(kind, { home })).map((p) => p.id);
  const one = await readPending<{ id: string }>(kind, selector, { home });
  if (!one) return { error: `no pending ${kind === "memory" ? "memory" : "skill"} op #${selector}` };
  return [one.id];
}

export async function approveMemory(selector: string, opts?: { home?: string }): Promise<ApprovalOutcome[] | { error: string }> {
  const ids = await idsFor("memory", selector, opts?.home);
  if ("error" in ids) return ids;
  const out: ApprovalOutcome[] = [];
  for (const id of ids) {
    const entry = await readPending<PendingMemoryOp>("memory", id, { home: opts?.home });
    if (!entry) continue;
    const res = await memoryApply(entry.target, entry.ops, { home: opts?.home, bypassApproval: true });
    if (res.ok) await removePending("memory", id, { home: opts?.home });
    out.push({ id, ok: res.ok, message: res.ok ? `${res.message} (${res.usage.used}/${res.usage.cap} chars)` : `${res.message} — still pending` });
  }
  return out;
}

export async function approveSkillOps(selector: string, opts?: { home?: string }): Promise<ApprovalOutcome[] | { error: string }> {
  const ids = await idsFor("skills", selector, opts?.home);
  if ("error" in ids) return ids;
  const out: ApprovalOutcome[] = [];
  for (const id of ids) {
    const entry = await readPending<PendingSkillOp>("skills", id, { home: opts?.home });
    if (!entry) continue;
    const res =
      entry.action === "patch"
        ? await applySkillPatch(entry.name, entry.args, { home: opts?.home })
        : entry.action === "create"
          ? await applySkillCreate(entry.name, entry.args, { home: opts?.home, by: "reviewer" })
          : { ok: false, output: `unknown action ${String(entry.action)}` };
    if (res.ok) await removePending("skills", id, { home: opts?.home });
    out.push({ id, ok: res.ok, message: res.ok ? res.output : `${res.output} — still pending` });
  }
  return out;
}

export async function rejectPending(kind: PendingKind, selector: string, opts?: { home?: string }): Promise<ApprovalOutcome[] | { error: string }> {
  const ids = await idsFor(kind, selector, opts?.home);
  if ("error" in ids) return ids;
  const out: ApprovalOutcome[] = [];
  for (const id of ids) {
    const removed = await removePending(kind, id, { home: opts?.home });
    out.push({ id, ok: removed, message: removed ? "rejected" : "not found" });
  }
  return out;
}

export function formatPendingMemory(list: PendingMemoryOp[]): string {
  if (!list.length) return "(no pending memory ops)";
  return list.map((p) => `#${p.id}  ${p.target}  ${p.at}\n    ${p.preview}`).join("\n");
}

export function formatPendingSkills(list: PendingSkillOp[]): string {
  if (!list.length) return "(no pending skill ops)";
  return list
    .map((p) => {
      const detail =
        p.action === "create"
          ? `description: ${String(p.args.description ?? "")}`
          : `old: "${String(p.args.old_string ?? "").slice(0, 60)}" -> new: "${String(p.args.new_string ?? "").slice(0, 60)}"`;
      return `#${p.id}  ${p.action} ${p.name}  ${p.at}\n    ${detail}`;
    })
    .join("\n");
}
