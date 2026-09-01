import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOT_CAP, recall, retainNote } from "../src/memory.ts";
import { makeWorkspace } from "./helpers.ts";

describe("memory HOT (shipped retainNote / recall)", () => {
  test("retain writes HOT MEMORY.md and recall finds it", async () => {
    const home = await makeWorkspace("mem-hot-");
    const r = await retainNote("this repo uses bun test not jest", { home, kind: "fact" });
    expect(r.layer).toBe("hot");
    const body = await readFile(r.path, "utf8");
    expect(body).toContain("bun test");
    const hits = await recall("bun test", { home });
    expect(hits.some((h) => h.includes("bun test"))).toBe(true);
  });

  test("secrets are rejected", async () => {
    const home = await makeWorkspace("mem-secret-");
    const secret = await retainNote("api_key=sk-live-not-a-real-key", { home });
    expect(secret.layer).toBe("rejected");
    expect(secret.reason).toMatch(/secret/);
    expect(existsSync(join(home, "memory", "MEMORY.md"))).toBe(false);
  });

  test("the cap forces consolidation: a full HOT rejects the note and nothing is written elsewhere", async () => {
    const home = await makeWorkspace("mem-cap-");
    let last = await retainNote("seed", { home });
    for (let i = 0; i < 80 && last.layer === "hot"; i++) {
      last = await retainNote(`lesson ${i} about the memory cap and consolidation`, { home, kind: "lesson" });
    }
    expect(last.layer).toBe("rejected");
    expect(last.path).toBe(join(home, "memory", "MEMORY.md"));
    expect(last.reason).toMatch(new RegExp(`^MEMORY\\.md at \\d+/${HOT_CAP} chars — consolidate \\(replace/remove\\) before adding$`));
    const hot = await readFile(last.path, "utf8");
    expect(hot.length).toBeLessThanOrEqual(HOT_CAP);
    expect(hot).not.toContain(last.reason);
    // No WARM overflow: no notes.sqlite, no sessions row, nothing but MEMORY.md under memory/.
    const files = (await readdir(join(home, "memory"))).filter((f) => f !== ".migrated-v1");
    expect(files).toEqual(["MEMORY.md"]);
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(false);
    // A subsequent, shorter note still fits and is accepted.
    const short = await retainNote("ok", { home });
    expect(short.layer).toBe("hot");
  });
});
