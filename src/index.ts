export { runLoop, formatReport, type LoopConfig } from "./loop.ts";
export { Orchestrator, resetIdsForTests } from "./orchestrator.ts";
export { detectInjection, isGoalHijack, INJECTION_RULES } from "./injection.ts";
export { wrapUntrusted, wrapTrusted, renderEnvelope } from "./trust.ts";
export { normalizeClaims, retrieveSource } from "./sources.ts";
export { executeTool, TOOL_CATALOG, blastForCall, specFor } from "./tools.ts";
export {
  MockBackend,
  ClaudeBackend,
  GrokBackend,
  CodexBackend,
  resolveBackends,
  makeBackend,
  parseWorkerMessage,
  unwrapGrok,
  unwrapClaude,
  unwrapCodex,
  decodeGrokStdout,
  decodeClaudeStdout,
  decodeCodexStdout,
  grokCliArgs,
  claudeCliArgs,
  codexCliArgs,
  foreignWorkerArgs,
} from "./backends.ts";
export { parseForeignHarness, parseSlotHarnesses } from "./foreign-harness.ts";
export { classifyGoal, buildPlan } from "./plan.ts";
export { retainNote, recall, readHot } from "./memory.ts";
export { draftSkill, approveSkill, updateSkill, upsertSkill, shouldDraftSkill, slugifySkillName } from "./skill-factory.ts";
export { reviewAfterRun, recallBeforeRun, keywordsFromGoal } from "./review.ts";
export {
  MAX_SUBAGENTS,
  SUBAGENT_ROLES,
  CREW_NAMES,
  FRANCHISE_LABELS,
  clampSubagentCount,
  normalizeWorkerRole,
} from "./types.ts";
export { main as cliMain } from "./cli.ts";
