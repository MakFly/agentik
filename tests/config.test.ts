import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { ConfigError, formatConfigError, parseConfig, readConfig } from "../src/config.ts";
import { makeWorkspace } from "./helpers.ts";

async function homeWithBody(body: string, prefix = "cfg-"): Promise<string> {
  const home = await makeWorkspace(prefix);
  await writeFile(join(home, "config.json"), body, "utf8");
  return home;
}

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { chunks.push(a.map(String).join(" ") + "\n"); };
  try {
    return { code: await fn(), err: chunks.join("") };
  } finally {
    console.error = orig;
  }
}

describe("config.json is read strictly", () => {
  test("valid shapes: camelCase, snake_case, partial, empty object", () => {
    expect(parseConfig("{}")).toEqual({ memory: { writeApproval: false }, skills: { writeApproval: false } });
    expect(parseConfig('{"memory":{"writeApproval":true}}').memory.writeApproval).toBe(true);
    expect(parseConfig('{"skills":{"write_approval":true}}').skills.writeApproval).toBe(true);
    expect(parseConfig('{"memory":{"writeApproval":true,"write_approval":true}}').memory.writeApproval).toBe(true);
  });

  const bad: Array<[string, string, RegExp]> = [
    ["invalid JSON", "{not json", /invalid JSON/],
    ["array top level", "[]", /top level must be an object, got an array/],
    ["null", "null", /top level must be an object/],
    ["unknown top-level key", '{"memroy":{"writeApproval":true}}', /unknown key "memroy" \(known: memory \| skills\)/],
    ["unknown section key", '{"memory":{"approval":true}}', /unknown key memory\.approval/],
    ["section not an object", '{"memory":true}', /memory must be an object, got true/],
    ["string instead of boolean", '{"memory":{"writeApproval":"true"}}', /memory\.writeApproval must be true or false, got "true"/],
    ["number instead of boolean", '{"skills":{"write_approval":1}}', /skills\.write_approval must be true or false, got 1/],
    ["camel and snake disagree", '{"memory":{"writeApproval":true,"write_approval":false}}', /disagree/],
  ];
  for (const [label, body, re] of bad) {
    test(`refused: ${label}`, () => {
      expect(() => parseConfig(body, "/x/config.json")).toThrow(ConfigError);
      try {
        parseConfig(body, "/x/config.json");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).message).toMatch(re);
        expect((err as ConfigError).path).toBe("/x/config.json");
        expect(formatConfigError(err as ConfigError)).toContain("fix or delete the file (defaults are all off)");
      }
    });
  }

  test("readConfig: absent → defaults; symlink → refused; invalid → ConfigError with the path", async () => {
    const none = await makeWorkspace("cfg-none-");
    expect(await readConfig({ home: none })).toEqual({ memory: { writeApproval: false }, skills: { writeApproval: false } });

    const linked = await makeWorkspace("cfg-link-");
    await writeFile(join(linked, "real.json"), "{}", "utf8");
    await symlink(join(linked, "real.json"), join(linked, "config.json"));
    await expect(readConfig({ home: linked })).rejects.toThrow(/symlink/);

    const broken = await homeWithBody('{"memory":{"writeApproval":"true"}}', "cfg-broken-");
    try {
      await readConfig({ home: broken });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).path).toBe(join(broken, "config.json"));
    }
  });
});

describe("CLI preflight: a broken config.json fails closed", () => {
  test("memory hot / skills list / harvest / spawn exit 2 with the path and the fix", async () => {
    const home = await homeWithBody('{"memory":{"writeApproval":"true"}}', "cfg-cli-");
    const ws = await makeWorkspace("cfg-ws-");
    for (const argv of [
      ["memory", "hot", "--agentik-home", home],
      ["skills", "list", "--agentik-home", home],
      ["harvest", "did the thing", "--workspace", ws, "--agentik-home", home],
      ["spawn", "--harness", "claude", "--workspace", ws, "--agentik-home", home, "x"],
      ["run", "do it", "--backend", "mock", "--workspace", ws, "--agentik-home", home],
    ]) {
      const { code, err } = await captureStderr(() => main(argv));
      expect(code).toBe(2);
      expect(err).toContain(join(home, "config.json"));
      expect(err).toContain('got "true"');
      expect(err).toContain("fix or delete the file (defaults are all off)");
    }
    // harvest in error wrote no session
    expect(existsSync(join(home, "sessions.sqlite"))).toBe(false);
  });

  test("context stays available: it never writes, a broken config must not hide the memory", async () => {
    const root = await makeWorkspace("cfg-ctx-");
    const home = join(root, "home");
    await Bun.write(join(home, "config.json"), "{oops");
    const hot = await captureStderr(() => main(["memory", "hot", "--agentik-home", home]));
    expect(hot.code).toBe(2);
    expect(hot.err).toContain("invalid JSON");
    const ctx = await captureStderr(() => main(["context", "x", "--workspace", root, "--agentik-home", home]));
    expect(ctx.code).toBe(0);
  });
});
