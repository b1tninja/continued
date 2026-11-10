import { setTerminalEnvironmentSettings } from "core/util/terminalEnvironment.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => ({ value: undefined as any }));
vi.mock("core/util/userTerminalSettings.js", () => ({
  readUserTerminalSettings: () => user.value,
}));

import { terminalEnvCommand } from "./terminalEnv.js";

const env = { PATH: "/bin", GITHUB_TOKEN: "secret-value", EDITOR: "vim" };

function run(e: Record<string, string> = env) {
  const lines: string[] = [];
  const code = terminalEnvCommand("show", (l) => lines.push(l), e);
  return { code, text: lines.join("\n") };
}

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  user.value = undefined;
});

describe("continuous terminal-env show", () => {
  it("prints the default mode and removed names, never values", () => {
    const { code, text } = run();
    expect(code).toBe(0);
    expect(text).toContain("Mode: scrub (from the default)");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).not.toContain("secret-value");
  });

  it("reports the user config as the source", () => {
    user.value = { environment: "inherit" };
    const { text } = run();
    expect(text).toContain("Mode: inherit (from your config.yaml)");
    expect(text).toContain("Nothing is removed");
  });

  it("reports the environment variable as the source", () => {
    const { text } = run({ ...env, CONTINUE_TERMINAL_ENV: "allowlist" });
    expect(text).toContain("CONTINUE_TERMINAL_ENV");
  });

  it("rejects an unknown action", () => {
    expect(terminalEnvCommand("nope", () => {})).toBe(1);
  });
});
