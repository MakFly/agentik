import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { recall, retainNote } from "../src/memory.ts";
import { makeWorkspace } from "./helpers.ts";

describe("memory HOT/WARM (shipped retainNote / recall)", () => {
  test("retain writes HOT MEMORY.md and recall finds it", async () => {
    const home = await makeWorkspace("mem-hot-");
    const r = await retainNote("this repo uses bun test not jest", { home, kind: "fact" });
    expect(r.layer).toBe("hot");
    const body = await readFile(r.path, "utf8");
    expect(body).toContain("bun test");
    const hits = await recall("bun test", { home });
    expect(hits.some((h) => h.includes("bun test"))).toBe(true);
  });

  test("secrets are rejected and overflow goes to WARM sqlite", async () => {
    const home = await makeWorkspace("mem-warm-");
    const secret = await retainNote("api_key=sk-live-not-a-real-key", { home });
    expect(secret.layer).toBe("rejected");
    let last = await retainNote("seed", { home });
    for (let i = 0; i < 80; i++) {
      last = await retainNote(`lesson ${i} about sqlite fts overflow`, { home, kind: "lesson" });
      if (last.layer === "warm") break;
    }
    expect(last.layer).toBe("warm");
    const hits = await recall("sqlite", { home });
    expect(hits.some((h) => h.includes("sqlite"))).toBe(true);
  });
});
