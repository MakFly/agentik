import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { detectInjection } from "./injection.ts";
import { wrapUntrusted } from "./trust.ts";
import type {
  BlastRadius,
  FetchImpl,
  ToolCall,
  ToolResult,
  ToolSpec,
} from "./types.ts";

export const TOOL_CATALOG: ToolSpec[] = [
  { name: "read_file", blastRadius: "low", description: "Read a workspace file" },
  { name: "write_file", blastRadius: "medium", description: "Write a workspace file" },
  {
    name: "run_command",
    blastRadius: "medium",
    description: "Run a debug/build command in the workspace (destructive argv upgraded to high)",
  },
  {
    name: "sandbox_ops",
    blastRadius: "medium",
    description: "Representative sandbox admin/ops (workspace status artifact)",
  },
  {
    name: "research_fetch",
    blastRadius: "low",
    description: "Fetch a URL and record origin; body is untrusted data",
  },
  {
    name: "server_admin",
    blastRadius: "high",
    description: "Remote/server mutation (gated; sandbox simulation only)",
  },
  {
    name: "fs_destructive",
    blastRadius: "high",
    description: "Destructive filesystem mutation",
  },
  {
    name: "credential_use",
    blastRadius: "high",
    description: "Use or export credentials",
  },
];

const HIGH_CMD =
  /\b(rm\s+-[a-zA-Z]*f|sudo|mkfs|dd\s+if=|shutdown|reboot|drop\s+database|chmod\s+777|curl[^\n]*\|\s*(ba)?sh|wipe|mkfs\.\w+)\b/i;

export function specFor(name: string): ToolSpec | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

export function blastForCall(tool: string, args: Record<string, unknown>): BlastRadius {
  const spec = specFor(tool);
  const base = spec?.blastRadius ?? "high";
  if (tool === "run_command") {
    const blob = JSON.stringify(args);
    if (HIGH_CMD.test(blob)) return "high";
  }
  return base;
}

export function resolveSafe(workspace: string, rel: string): string {
  const root = resolve(workspace);
  const full = resolve(root, rel);
  const relToRoot = relative(root, full);
  if (relToRoot.startsWith("..") || resolve(root, relToRoot) !== full) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return full;
}

export interface ToolHost {
  workspace: string;
  fetchImpl?: FetchImpl;
  onRetrieved?: (url: string, body: string) => void;
}

export async function executeTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  switch (call.tool) {
    case "read_file":
      return readFileTool(call, host);
    case "write_file":
      return writeFileTool(call, host);
    case "run_command":
      return runCommandTool(call, host);
    case "sandbox_ops":
      return sandboxOpsTool(call, host);
    case "research_fetch":
      return researchFetchTool(call, host);
    case "server_admin":
      return serverAdminTool(call, host);
    case "fs_destructive":
    case "credential_use":
      return {
        callId: call.id,
        ok: false,
        output: `${call.tool} is high-blast-radius and has no unattended executor; refused even after routing`,
      };
    default:
      return { callId: call.id, ok: false, output: `unknown tool ${call.tool}` };
  }
}

async function readFileTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const rel = String(call.args.path ?? "");
  const full = resolveSafe(host.workspace, rel);
  const body = await readFile(full, "utf8");
  const env = wrapUntrusted(body, `file:${rel}`, "retrieved");
  return {
    callId: call.id,
    ok: true,
    output: env.body,
    artifact: rel,
  };
}

async function writeFileTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const rel = String(call.args.path ?? "");
  const content = String(call.args.content ?? "");
  const full = resolveSafe(host.workspace, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return {
    callId: call.id,
    ok: true,
    output: `wrote ${rel} (${content.length} bytes)`,
    artifact: rel,
  };
}

async function runCommandTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const argv = Array.isArray(call.args.argv)
    ? (call.args.argv as unknown[]).map(String)
    : String(call.args.cmd ?? "pwd").split(/\s+/);
  if (argv.length === 0) {
    return { callId: call.id, ok: false, output: "empty command" };
  }
  if (blastForCall("run_command", call.args) === "high") {
    return {
      callId: call.id,
      ok: false,
      output: "command classified as high-blast-radius; not executed",
    };
  }
  const proc = Bun.spawn(argv, {
    cwd: host.workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  const output = `exit ${exit}\n${stdout}${stderr ? "\nstderr:\n" + stderr : ""}`;
  const env = wrapUntrusted(output, `tool:run_command`, "tool_output");
  void detectInjection(env.body, "tool_output", env.origin);
  return { callId: call.id, ok: exit === 0, output: env.body };
}

async function sandboxOpsTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const action = String(call.args.action ?? "workspace_status");
  const dir = join(host.workspace, ".agentik");
  await mkdir(dir, { recursive: true });
  const entries = await listShallow(host.workspace);
  const st = await stat(host.workspace);
  const report = {
    action,
    workspace: host.workspace,
    generatedAt: new Date().toISOString(),
    dirMtimeMs: st.mtimeMs,
    entries: entries.slice(0, 50),
    entryCount: entries.length,
    note: "sandbox ops only; no remote host mutation",
  };
  const rel = ".agentik/ops-status.json";
  await writeFile(join(host.workspace, rel), JSON.stringify(report, null, 2), "utf8");
  return {
    callId: call.id,
    ok: true,
    output: `sandbox ops ${action}: ${entries.length} entries`,
    artifact: rel,
  };
}

async function researchFetchTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  const url = String(call.args.url ?? "");
  if (!url) return { callId: call.id, ok: false, output: "missing url" };
  if (!host.fetchImpl) {
    return { callId: call.id, ok: false, output: "no fetch implementation bound" };
  }
  const page = await host.fetchImpl(url);
  host.onRetrieved?.(page.url, page.body);
  const env = wrapUntrusted(page.body, page.url, "retrieved");
  const flagged = env.injection?.detected ? " flagged_injection" : "";
  return {
    callId: call.id,
    ok: true,
    output: `retrieved ${page.url} (${page.body.length} bytes)${flagged}`,
    artifact: page.url,
  };
}

async function serverAdminTool(call: ToolCall, host: ToolHost): Promise<ToolResult> {
  // Even when the orchestrator approved, this never talks to a real remote host.
  // It writes a sandbox receipt so the loop has an observable artifact.
  const dir = join(host.workspace, ".agentik");
  await mkdir(dir, { recursive: true });
  const rel = ".agentik/admin-action.json";
  const receipt = {
    approved: true,
    simulated: true,
    action: call.args.action ?? "unspecified",
    target: call.args.target ?? "sandbox",
    at: new Date().toISOString(),
    note: "No remote/server mutation was performed. High-blast tools stay local receipts.",
  };
  await writeFile(join(host.workspace, rel), JSON.stringify(receipt, null, 2), "utf8");
  return {
    callId: call.id,
    ok: true,
    output: "sandbox admin receipt written (no remote mutation)",
    artifact: rel,
  };
}

async function listShallow(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("*");
  const names: string[] = [];
  for await (const p of glob.scan({ cwd: dir, dot: true, onlyFiles: false })) {
    names.push(p);
  }
  return names.sort();
}

export function defaultFetchImpl(): FetchImpl {
  return async (url: string) => {
    const res = await fetch(url);
    const body = await res.text();
    return { url: res.url || url, body };
  };
}
