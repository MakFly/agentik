import { describe, expect, test } from "bun:test";
import { foreignWorkerArgs } from "../src/backends.ts";
import { main } from "../src/cli.ts";
import { parseForeignHarness, parseSlotHarnesses } from "../src/foreign-harness.ts";

describe("foreign harness routing (shipped parseForeignHarness / foreignWorkerArgs)", () => {
  test("user phrasing sous grok / sous codex / sous claude selects that headless harness", () => {
    expect(
      parseForeignHarness("les subagents doivent être run sous grok quand je suis en harness claude"),
    ).toBe("grok");
    expect(parseForeignHarness("run the subagents sous codex")).toBe("codex");
    expect(parseForeignHarness("workers under cc")).toBe("codex");
    expect(parseForeignHarness("spawn agents via cla")).toBe("claude");
    expect(parseForeignHarness("Fais cette feature : bouton Export CSV")).toBeNull();
  });

  test("per-slot 'Korben sous grok, Leeloo sous codex' maps to worker_a / worker_b", () => {
    const slots = parseSlotHarnesses("Korben sous grok, Leeloo sous codex");
    expect(slots.worker_a).toBe("grok");
    expect(slots.worker_b).toBe("codex");
  });

  test("headless worker args are non-interactive, yolo, and keep tools (no TUI)", () => {
    const grok = foreignWorkerArgs("grok", "implement the feature", "/proj");
    expect(grok.bin).toBe("grok");
    expect(grok.args).toContain("--yolo");
    expect(grok.args).toContain("--single");
    expect(grok.args).toContain("--no-subagents");
    expect(grok.args).toContain("--no-plan");
    expect(grok.args).toContain("--cwd");
    expect(grok.args.includes("--disallowed-tools")).toBe(false);

    const codex = foreignWorkerArgs("codex", "verify", "/proj");
    expect(codex.bin).toBe("codex");
    expect(codex.args[0]).toBe("exec");
    expect(codex.args).toContain("--yolo");
    expect(codex.args).toContain("--cd");

    const claude = foreignWorkerArgs("claude", "debug", "/proj");
    expect(claude.bin).toBe("claude");
    expect(claude.args).toContain("-p");
    expect(claude.args).toContain("--dangerously-skip-permissions");
    expect(claude.args.includes("--restricted")).toBe(false);
    expect(claude.args[claude.args.indexOf("--disallowedTools") + 1]).toBe("Agent");
  });

  test("agentik spawn without --harness exits 2 (shipped CLI)", async () => {
    const code = await main(["spawn", "implement the thing"]);
    expect(code).toBe(2);
  });
});
