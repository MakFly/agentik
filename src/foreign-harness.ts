import { CREW_NAMES, normalizeWorkerRole, type WorkerRole } from "./types.ts";

export type ForeignHarness = "claude" | "grok" | "codex";

const HARNESS_WORD: Array<{ re: RegExp; id: ForeignHarness }> = [
  { re: /\bcodex\b|\bcc\b/, id: "codex" },
  { re: /\bgrok\b/, id: "grok" },
  { re: /\bclaude\b|\bcla\b/, id: "claude" },
];

function harnessIn(text: string): ForeignHarness | null {
  const t = text.toLowerCase();
  for (const { re, id } of HARNESS_WORD) {
    if (re.test(t)) return id;
  }
  return null;
}

/**
 * Detects "run subagents sous grok / under codex / avec cla" in the user goal.
 * A bare mention of a model with no routing intent returns null.
 */
export function parseForeignHarness(text: string): ForeignHarness | null {
  const t = text.toLowerCase();
  const routed =
    /\b(sous|via|avec|under|using|sur)\s+(grok|codex|cc|claude|cla)\b/.test(t) ||
    /\b(subagents?|workers?|agents?|harness)\b[\s\S]{0,48}\b(grok|codex|cc|claude|cla)\b/.test(t) ||
    /\b(grok|codex|claude|cla|cc)\b[\s\S]{0,48}\b(subagents?|workers?|harness|non[- ]interactive)\b/.test(
      t,
    ) ||
    /\brun\s+(sous|under|on|via)\s+(grok|codex|claude|cla|cc)\b/.test(t);
  if (!routed) return null;
  const m = t.match(
    /\b(?:sous|via|avec|under|using|sur|on)\s+(grok|codex|cc|claude|cla)\b/g,
  );
  if (m && m.length > 0) {
    return harnessIn(m[m.length - 1]);
  }
  return harnessIn(t);
}

export function parseSlotHarnesses(text: string): Partial<Record<WorkerRole, ForeignHarness>> {
  const out: Partial<Record<WorkerRole, ForeignHarness>> = {};
  const re =
    /\b([A-Za-z][A-Za-z]+(?:\s+[A-Za-z]+)?)\s+(?:sous|via|under|on|avec)\s+(grok|codex|cc|claude|cla)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const role = normalizeWorkerRole(m[1]);
    const h = harnessIn(m[2]);
    if (h) out[role] = h;
  }
  return out;
}

export function crewNameForRole(role: WorkerRole): string {
  return CREW_NAMES[role].fifthElement;
}
