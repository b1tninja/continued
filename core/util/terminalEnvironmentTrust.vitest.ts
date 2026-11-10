import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";
import {
  getTerminalEnvironmentMode,
  getTerminalEnvironmentStatus,
  previewTerminalEnvironment,
  resolveTerminalSettings,
  setTerminalEnvironmentSettings,
  terminalEnvironment,
} from "./terminalEnvironment";
import {
  applyTerminalSettings,
  readUserTerminalSettings,
  sanitizeTerminalSettings,
} from "./userTerminalSettings";

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  vi.unstubAllEnvs();
});

const host = { PATH: "/bin", GITHUB_TOKEN: "t", EDITOR: "vim" };

describe("resolveTerminalSettings: who may loosen", () => {
  it("ignores inherit from a non-user source and says so", () => {
    const r = resolveTerminalSettings(undefined, { environment: "inherit" });
    expect(r.settings).toBeUndefined();
    expect(r.notices).toHaveLength(1);
    expect(getTerminalEnvironmentMode({})).toBe("scrub");
    expect(terminalEnvironment(host)).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("honours inherit from the user's own config", () => {
    const r = resolveTerminalSettings({ environment: "inherit" }, undefined);
    expect(r.notices).toEqual([]);
    expect(terminalEnvironment(host)).toHaveProperty("GITHUB_TOKEN");
    expect(getTerminalEnvironmentStatus({}).source).toBe("user-config");
  });

  it("ignores passEnv and allow from a non-user source", () => {
    const r = resolveTerminalSettings(undefined, {
      passEnv: ["GITHUB_TOKEN"],
      allow: ["EDITOR"],
    });
    expect(r.notices).toHaveLength(2);
    expect(terminalEnvironment(host)).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("keeps the user's passEnv when an assistant sends its own", () => {
    resolveTerminalSettings(
      { passEnv: ["GITHUB_TOKEN"] },
      { passEnv: ["EDITOR"] },
    );
    expect(terminalEnvironment(host)).toHaveProperty("GITHUB_TOKEN");
    expect(getTerminalEnvironmentStatus({}).passEnv).toEqual(["GITHUB_TOKEN"]);
  });

  it("takes a tighter mode from anywhere", () => {
    const r = resolveTerminalSettings(undefined, { environment: "allowlist" });
    expect(r.notices).toEqual([]);
    expect(getTerminalEnvironmentMode({})).toBe("allowlist");
    expect(getTerminalEnvironmentStatus({}).source).toBe("assistant-config");
  });

  it("does not let an assistant loosen a user's allowlist to scrub", () => {
    const r = resolveTerminalSettings(
      { environment: "allowlist" },
      { environment: "scrub" },
    );
    expect(getTerminalEnvironmentMode({})).toBe("allowlist");
    expect(r.notices).toHaveLength(1);
  });

  it("lets the environment variable win and reports it", () => {
    resolveTerminalSettings({ environment: "scrub" }, undefined);
    const status = getTerminalEnvironmentStatus({
      CONTINUE_TERMINAL_ENV: "inherit",
    });
    expect(status).toMatchObject({ mode: "inherit", source: "env" });
  });
});

describe("previewTerminalEnvironment", () => {
  it("lists names removed by scrub, none for inherit", () => {
    const env = { ...host, DB: "" };
    expect(previewTerminalEnvironment(env, "scrub").removed).toEqual([
      "GITHUB_TOKEN",
    ]);
    expect(previewTerminalEnvironment(env, "inherit").removed).toEqual([]);
    expect(previewTerminalEnvironment(env, "allowlist").removed).toContain(
      "EDITOR",
    );
  });

  it("honours passEnv and credential URLs", () => {
    const env = { GITHUB_TOKEN: "t", REPO: "https://u:p@h/x" };
    const p = previewTerminalEnvironment(env, "scrub", {
      passEnv: ["GITHUB_TOKEN"],
    });
    expect(p.kept).toEqual(["GITHUB_TOKEN"]);
    expect(p.removed).toEqual(["REPO"]);
  });
});

describe("user settings file", () => {
  it("reads only the user's terminal block and drops bad fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "term-env-"));
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(
      file,
      YAML.stringify({
        terminal: { environment: "bogus", passEnv: ["A", 3, " "] },
      }),
    );
    expect(readUserTerminalSettings(file)).toEqual({ passEnv: ["A"] });
    expect(readUserTerminalSettings(path.join(dir, "none.yaml"))).toBe(
      undefined,
    );
    expect(sanitizeTerminalSettings("x")).toBeUndefined();
    fs.rmSync(dir, { recursive: true });
  });

  it("applies and removes fields", () => {
    const c: any = { name: "n", version: "1" };
    const a: any = applyTerminalSettings(c, {
      environment: "inherit",
      passEnv: ["A"],
    });
    expect(a.terminal).toEqual({ environment: "inherit", passEnv: ["A"] });
    const b: any = applyTerminalSettings(a, {
      environment: undefined,
      passEnv: [],
    });
    expect(b.terminal).toBeUndefined();
  });
});
