import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readEntries } from "../src/memory-store.ts";
import { migrateLegacyMemory, searchSessions, sweepLegacySessionLines } from "../src/sessions.ts";
import { makeWorkspace } from "./helpers.ts";

describe("legacy `(session)` lines appended after the one-shot migration", () => {
  test("are swept out of HOT on the next open, into sessions.sqlite, without touching real entries", async () => {
    const home = await makeWorkspace("sweep-");
    await mkdir(join(home, "memory"), { recursive: true });
    // The one-shot migration already ran…
    await writeFile(join(home, "memory/.migrated-v1"), "{}", "utf8");
    // …then an older client appended two session lines in the middle of a §-separated file.
    await writeFile(
      join(home, "memory/MEMORY.md"),
      [
        "grok is only available until 2026-11-16.",
        "- (session) session: pour que compute n'affiche qu'en mode dev [completed] artifacts=a.ts,b.ts",
        "- (session) session: reco backoffice admin [completed] artifacts=none",
        "§",
        "Merging a worktree branch must run from the main checkout.",
        "",
      ].join("\n"),
      "utf8",
    );
    const res = await migrateLegacyMemory({ home });
    expect(res.ran).toBe(true);
    expect(res.fromHot).toBe(2);
    expect(await readEntries("memory", home)).toEqual([
      "grok is only available until 2026-11-16.",
      "Merging a worktree branch must run from the main checkout.",
    ]);
    const hits = await searchSessions("backoffice", { home, all: true });
    expect(hits.some((h) => h.goal.includes("reco backoffice admin"))).toBe(true);
    const drawer = await searchSessions("compute", { home, all: true });
    expect(drawer[0]?.artifacts).toEqual(["a.ts", "b.ts"]);
    // Second open: nothing to sweep, file untouched, no extra backup.
    expect(await sweepLegacySessionLines(home)).toBe(0);
    const files = (await import("node:fs/promises")).readdir(join(home, "memory"));
    expect((await files).filter((f) => f.includes(".bak.")).length).toBe(1);
  });

  test("a clean file is a no-op", async () => {
    const home = await makeWorkspace("sweep-clean-");
    await mkdir(join(home, "memory"), { recursive: true });
    await writeFile(join(home, "memory/.migrated-v1"), "{}", "utf8");
    await writeFile(join(home, "memory/MEMORY.md"), "Just a fact.\n", "utf8");
    expect((await migrateLegacyMemory({ home })).ran).toBe(false);
    expect(await readFile(join(home, "memory/MEMORY.md"), "utf8")).toBe("Just a fact.\n");
  });
});
