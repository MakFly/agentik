import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  approveSkill,
  draftSkill,
  shouldDraftSkill,
  slugifySkillName,
  updateSkill,
  upsertSkill,
} from "../src/skill-factory.ts";
import { makeWorkspace } from "./helpers.ts";

describe("Hermes-style skill draft / approve / update", () => {
  test("non-trivial completed run should draft; secrets-free slug", () => {
    expect(
      shouldDraftSkill({
        status: "completed",
        executedTools: [],
        artifacts: ["src/a.ts", ".agentik/ops-status.json"],
      }),
    ).toBe(true);
    expect(shouldDraftSkill({ status: "rejected", executedTools: [], artifacts: ["x"] })).toBe(false);
    expect(slugifySkillName("Export CSV leads")).toBe("export-csv-leads");
  });

  test("draft then approve then update writes shipped SKILL.md", async () => {
    const home = await makeWorkspace("skill-fac-");
    const drafted = await draftSkill({
      name: "export-csv-leads",
      goal: "Export CSV on the leads list",
      steps: ["write_file -> src/export.ts", "run_command"],
      artifacts: ["src/export.ts"],
      home,
    });
    expect(drafted.path).toContain("pending/skills/export-csv-leads/SKILL.md");
    const pending = await readFile(drafted.path, "utf8");
    expect(pending).toContain("name: export-csv-leads");
    expect(pending).toContain("Export CSV on the leads list");

    const approved = await approveSkill("export-csv-leads", { home, linkHarness: false });
    expect("path" in approved).toBe(true);
    if ("path" in approved) {
      expect(approved.path).toContain("skills/export-csv-leads/SKILL.md");
      expect(existsSync(approved.path)).toBe(true);
    }

    const updated = await updateSkill(
      "export-csv-leads",
      { goal: "Export CSV + UTF-8 BOM", steps: ["write header", "stream rows"] },
      { home },
    );
    expect("path" in updated).toBe(true);
    if ("path" in updated) {
      const body = await readFile(updated.path, "utf8");
      expect(body).toContain("UTF-8 BOM");
      expect(body).toContain("stream rows");
    }
  });

  test("upsertSkill writes straight to skills/ (no pending, no approve)", async () => {
    const home = await makeWorkspace("skill-upsert-");
    const first = await upsertSkill({
      name: "ship-csv",
      goal: "Ship CSV",
      steps: ["write_file"],
      artifacts: ["src/a.ts"],
      home,
      linkHarness: false,
    });
    expect(first.action).toBe("created");
    expect(first.path).toContain("skills/ship-csv/SKILL.md");
    expect(existsSync(join(home, "pending/skills/ship-csv/SKILL.md"))).toBe(false);
    const second = await upsertSkill({
      name: "ship-csv",
      goal: "Ship CSV with BOM",
      steps: ["write header"],
      home,
      linkHarness: false,
    });
    expect(second.action).toBe("updated");
  });
});
