import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { agentikHome, memoryPaths } from "./home.ts";
import { withHomeLock } from "./home-lock.ts";

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
 * Writes to the seal are atomic (tmp + rename) and serialized by the `memory` home lock
 * (`src/home-lock.ts`), which is the same lock every MEMORY.md write takes — so a seal update and
 * the file update it describes cannot interleave with another process's pair. `.seal.json` is
 * itself a read-modify-write JSON map: before the lock, two processes sealing two different keys
 * at the same time each wrote back the map as they had read it, and one key silently vanished
 * (a missing key reads as `unsealed`, which is accepted silently — tamper-evidence lost without a
 * word). The module promise chain this replaces only ordered the three snapshots of one
 * `buildContext`; it did nothing against a second agentik process.
 */

export type SealStatus = "sealed" | "unsealed" | "diverged";

export const SEAL_FILE = ".seal.json";

function locked<T>(home: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withHomeLock("memory", fn, { home });
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
  return locked(home, async () => {
    const seal = await readSeal(home);
    seal[key] = digest(content);
    await writeSeal(seal, home);
  });
}

/** Seal a file as it is on disk (a rename, a migration, a human `reseal`); absent file → entry removed. */
export function sealFile(file: string, home?: string): Promise<SealStatus> {
  return locked(home, async () => {
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
  return locked(home, async () => {
    const seal = await readSeal(home);
    delete seal[sealKey(file, home)];
    await writeSeal(seal, home);
  });
}

/**
 * Compare a file's content with its seal. `unsealed` (no entry) is accepted AND sealed here, so a
 * home that predates the seal is not flagged on its first read.
 *
 * The happy comparison is a read, and reads are not locked: `memorySnapshot` runs three of these
 * on every `agentik context` and must not pay for a lock to say "sealed". The two branches that
 * conclude anything else take the lock and re-check inside it:
 *
 *   - no entry yet: seal it, but re-read first, so it cannot clobber a concurrent seal of another
 *     key (`.seal.json` is one JSON map for every memory file);
 *   - mismatch: a writer holds the lock across `writeFile` + `sealContent`, but a *reader* can
 *     still land between those two and see a new file against an old digest. That was a false
 *     "modified out of band" — a refused write, exit 3, and a bogus incident, all reproduced by 8
 *     concurrent `memory retain`. So a mismatch is confirmed under the lock, against the file as
 *     it is once every writer has finished. A real out-of-band edit still mismatches there;
 *     only the race resolves.
 */
export async function checkSeal(file: string, content: string, home?: string): Promise<SealStatus> {
  const key = sealKey(file, home);
  const now = digest(content);
  const have = (await readSeal(home))[key];
  if (have === now) return "sealed";
  return locked(home, async () => {
    const seal = await readSeal(home);
    if (seal[key] === undefined) {
      seal[key] = now;
      await writeSeal(seal, home);
      return "unsealed";
    }
    // Whatever is on disk now is what the seal describes, or does not.
    let current = content;
    try {
      current = await readFile(file, "utf8");
    } catch {
      /* gone since the caller read it: judge on what the caller saw */
    }
    return seal[key] === digest(current) ? "sealed" : "diverged";
  });
}

export const DIVERGED_BODY = "[BLOCKED: modified out of band — agentik memory reseal to accept]";
