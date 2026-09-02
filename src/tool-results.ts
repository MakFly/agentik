import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectInjection } from "./injection.ts";
import { memoryContentProblem } from "./memory-store.ts";
import type { InjectionFinding } from "./types.ts";

/**
 * Tool output that does not fit the context goes to disk, not into the prompt.
 *
 * A worker that runs `bun test` on a real repo gets 50k of output; sending it whole to every
 * subsequent model call is what made `agentik run` unusable past the demo. Above the cap the
 * full body is written to `<workspace>/.agentik/tool-results/<callId>.txt` (secrets masked line
 * by line, the same scan as memory) and the envelope carries the head, a pointer the worker can
 * page with `read_file {path, offset, limit}`, and the tail. Injection detection runs on the FULL
 * body: an attacker who pads a page so the payload lands in the omitted middle gains nothing.
 */

export const TOOL_OUTPUT_INLINE_MAX = 8000;
export const TOOL_OUTPUT_HEAD = 3000;
export const TOOL_OUTPUT_TAIL = 2000;
export const TOOL_RESULTS_DIR = ".agentik/tool-results";

export interface SpilledToolResult {
  /** What goes into the envelope: the whole output, or head + pointer + tail. */
  inline: string;
  /** Workspace-relative path of the full body, when spilled. */
  outputPath?: string;
  truncated: boolean;
  /** Detection over the full body (not only the inline part). */
  injection: InjectionFinding;
}

/** A line that reads as a secret or an injection is replaced, the rest is kept byte for byte. */
export function maskLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const problem = memoryContentProblem(line);
      return problem ? `[BLOCKED: ${problem}]` : line;
    })
    .join("\n");
}

function safeCallId(callId: string): string {
  return callId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "call";
}

export async function spillToolResult(
  workspace: string,
  callId: string,
  output: string,
  origin: string,
  opts: { inlineMax?: number } = {},
): Promise<SpilledToolResult> {
  const injection = detectInjection(output, "tool_output", origin);
  const max = opts.inlineMax ?? TOOL_OUTPUT_INLINE_MAX;
  if (output.length <= max) return { inline: output, truncated: false, injection };
  const rel = `${TOOL_RESULTS_DIR}/${safeCallId(callId)}.txt`;
  await mkdir(join(workspace, TOOL_RESULTS_DIR), { recursive: true });
  await writeFile(join(workspace, rel), maskLines(output), "utf8");
  const omitted = output.length - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL;
  const inline = [
    output.slice(0, TOOL_OUTPUT_HEAD),
    `…[${omitted} chars omitted — full output in ${rel}; read_file {"path":"${rel}","offset":${TOOL_OUTPUT_HEAD},"limit":${max}} to page it]…`,
    output.slice(output.length - TOOL_OUTPUT_TAIL),
  ].join("\n");
  return { inline, outputPath: rel, truncated: true, injection };
}
