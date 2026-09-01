import { mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { MockBackend } from "../src/backends.ts";
import type { Backend } from "../src/types.ts";

export async function makeWorkspace(prefix: string): Promise<string> {
  const root = join(import.meta.dir, "..", ".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

export function pair(opts?: ConstructorParameters<typeof MockBackend>[0]): {
  workerA: Backend;
  workerB: Backend;
} {
  return {
    workerA: new MockBackend({ id: "mock-a", ...opts }),
    workerB: new MockBackend({ id: "mock-b", ...opts }),
  };
}

const LETTERS = ["a", "b", "c", "d", "e"] as const;

export function crew(
  n: number,
  opts?: ConstructorParameters<typeof MockBackend>[0],
): {
  workerA: Backend;
  workerB: Backend;
  workers: Backend[];
} {
  const count = Math.min(5, Math.max(1, Math.floor(n)));
  const workers = Array.from(
    { length: count },
    (_, i) => new MockBackend({ id: `mock-${LETTERS[i]}`, ...opts }),
  );
  return {
    workerA: workers[0],
    workerB: workers[1] ?? workers[0],
    workers,
  };
}
