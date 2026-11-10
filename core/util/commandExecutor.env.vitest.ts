import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn,
}));

import { getCommandExecutor } from "./commandExecutor";
import { setTerminalEnvironmentSettings } from "./terminalEnvironment";

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  vi.unstubAllEnvs();
  spawn.mockReset();
});

describe("command executor environment", () => {
  it("does not hand the host's secrets to a local command", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("PATH", "/usr/bin");
    getCommandExecutor({ platform: "linux", env: {} }).spawn("ls");
    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("inherit passes the host's environment on", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    setTerminalEnvironmentSettings({ environment: "inherit" });
    getCommandExecutor({ platform: "linux", env: {} }).spawn("ls");
    expect(spawn.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("a caller's own env is not touched", () => {
    getCommandExecutor({ platform: "linux", env: {} }).spawn("ls", {
      env: { CANARY_TOKEN: "c" },
    });
    expect(spawn.mock.calls[0][2].env).toEqual({ CANARY_TOKEN: "c" });
  });

  it("WSL keeps WSLENV and the basics in allowlist mode", () => {
    vi.stubEnv("WSLENV", "FOO/p");
    vi.stubEnv("GITHUB_TOKEN", "ghp");
    vi.stubEnv("SystemRoot", "C:\Windows");
    setTerminalEnvironmentSettings({ environment: "allowlist" });
    getCommandExecutor({
      platform: "win32",
      terminalShell: { kind: "wsl" },
      wslDistros: [{ name: "Ubuntu", state: "Running", version: 2 } as never],
    }).spawn("ls");
    const env = spawn.mock.calls[0][2].env;
    expect(env.WSLENV).toBe("FOO/p");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});
