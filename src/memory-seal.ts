import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";

/**
 * Tamper-evident memory. `memory/.seal.json` maps every memory file (`MEMORY.md`, `USER.md`,
 * `projects/<slug>/MEMORY.md`) to the sha256 of what agentik last wrote there. A file whose
 * content no longer matches was modified out of band — by a worker with a shell, by a stray
 * script — and is shown as `[BLOCKED: modified out of band]` until a human runs
 * `agentik memory reseal`; every agentik write to it is refused meanwhile, so the reviewer's
 * next write cannot launder the foreign entry. A file with no seal yet (first run, a fresh
 * home) is accepted and sealed silently.
 *
 * Limits, stated: this is tamper-EVIDENT, not tamper-proof. There is no HMAC because the key
 * would live in the same home as the files; a process that can edit MEMORY.md can edit the
 * seal. It catches mistakes and unprivileged prompt-injected writes, not a root attacker.
 *
 * Writes to the seal are serialized (module mutex) and atomic (tmp + rename): the three
 * snapshots of `buildContext` run in Promise.all.
 */

export type SealStatus = "sealed" | "unsealed" | "diverged";

export const SEAL_FILE = ".seal.json";

let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export function sealPath(home?: string): string {
  return join(memoryPaths(agentikHome(home)).memoryDir, SEAL_FILE);
}

/** The seal key of a memory file: its path relative to `memory/`. */
export function sealKey(file: string, home?: string): string {
  return relative(memoryPaths(agentikHome(home)).memoryDir, file).split("\\").join("/");
}

export function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readSeal(home?: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(sealPath(home), "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeSeal(seal: Record<string, string>, home?: string): Promise<void> {
  const path = sealPath(home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(seal, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Record `content` as the sealed state of `key`. */
export function sealContent(key: string, content: string, home?: string): Promise<void> {
  return locked(async () => {
    const seal = await readSeal(home);
    seal[key] = digest(content);
    await writeSeal(seal, home);
  });
}

/** Seal a file as it is on disk (a rename, a migration, a human `reseal`); absent file → entry removed. */
export function sealFile(file: string, home?: string): Promise<SealStatus> {
  return locked(async () => {
    const seal = await readSeal(home);
    const key = sealKey(file, home);
    if (!existsSync(file)) {
      delete seal[key];
      await writeSeal(seal, home);
      return "unsealed";
    }
    seal[key] = digest(await readFile(file, "utf8"));
    await writeSeal(seal, home);
    return "sealed";
  });
}

export function unsealFile(file: string, home?: string): Promise<void> {
  return locked(async () => {
    const seal = await readSeal(home);
    delete seal[sealKey(file, home)];
    await writeSeal(seal, home);
  });
}

/**
 * Compare a file's content with its seal. `unsealed` (no entry) is accepted AND sealed here, so a
 * home that predates the seal is not flagged on its first read.
 */
export function checkSeal(file: string, content: string, home?: string): Promise<SealStatus> {
  return locked(async () => {
    const seal = await readSeal(home);
    const key = sealKey(file, home);
    const have = seal[key];
    const now = digest(content);
    if (have === undefined) {
      seal[key] = now;
      await writeSeal(seal, home);
      return "unsealed";
    }
    return have === now ? "sealed" : "diverged";
  });
}

export const DIVERGED_BODY = "[BLOCKED: modified out of band — agentik memory reseal to accept]";
