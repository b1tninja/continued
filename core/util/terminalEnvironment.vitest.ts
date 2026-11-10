import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTerminalEnvironmentMode,
  setTerminalEnvironmentSettings,
  TERMINAL_ENV_NOTICE,
  terminalEnvironment,
} from "./terminalEnvironment";

const posix = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  LANG: "en_US.UTF-8",
  TERM: "xterm",
  TMPDIR: "/tmp",
  WSLENV: "FOO/p",
  EDITOR: "vim",
  ANTHROPIC_API_KEY: "sk-ant",
  AWS_SECRET_ACCESS_KEY: "aws",
  GITHUB_TOKEN: "ghp",
};

const windows = {
  Path: "C:\Windows",
  USERPROFILE: "C:\Users\me",
  TEMP: "C:\Temp",
  SystemRoot: "C:\Windows",
  ComSpec: "C:\Windows\System32\cmd.exe",
  PATHEXT: ".EXE;.CMD",
  LANG: "en_US",
  OPENAI_API_KEY: "sk",
  azure_client_secret: "s",
};

afterEach(() => {
  setTerminalEnvironmentSettings(undefined);
  vi.unstubAllEnvs();
});

describe("terminalEnvironment", () => {
  it("scrubs by default and keeps the basics", () => {
    const env = terminalEnvironment(posix, { platform: "linux" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
      TMPDIR: "/tmp",
      WSLENV: "FOO/p",
      EDITOR: "vim",
    });
  });

  it("keeps the Windows basics and matches secret names case-insensitively", () => {
    const env = terminalEnvironment(windows, { platform: "win32" });
    expect(Object.keys(env).sort()).toEqual(
      [
        "ComSpec",
        "LANG",
        "PATHEXT",
        "Path",
        "SystemRoot",
        "TEMP",
        "USERPROFILE",
      ].sort(),
    );
  });

  it("inherit is a copy of the base, byte for byte", () => {
    setTerminalEnvironmentSettings({ environment: "inherit" });
    const env = terminalEnvironment({ ...posix, UNSET: undefined });
    expect(env).toEqual(posix);
  });

  it("passEnv keeps an exact name that would be removed", () => {
    setTerminalEnvironmentSettings({ passEnv: ["GITHUB_TOKEN"] });
    const env = terminalEnvironment(posix, { platform: "linux" });
    expect(env.GITHUB_TOKEN).toBe("ghp");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("allowlist keeps the basics, WSL names and allow entries only", () => {
    setTerminalEnvironmentSettings({
      environment: "allowlist",
      allow: ["EDITOR"],
    });
    const env = terminalEnvironment(
      { ...posix, RANDOM_THING: "x" },
      { platform: "linux" },
    );
    expect(Object.keys(env).sort()).toEqual(
      ["EDITOR", "HOME", "LANG", "PATH", "TERM", "TMPDIR", "WSLENV"].sort(),
    );
  });

  it("CONTINUE_TERMINAL_ENV overrides config.yaml", () => {
    setTerminalEnvironmentSettings({ environment: "inherit" });
    vi.stubEnv("CONTINUE_TERMINAL_ENV", "scrub");
    expect(getTerminalEnvironmentMode()).toBe("scrub");
    vi.stubEnv("CONTINUE_TERMINAL_ENV", "allowlist");
    expect(getTerminalEnvironmentMode()).toBe("allowlist");
    vi.stubEnv("CONTINUE_TERMINAL_ENV", "bogus");
    expect(getTerminalEnvironmentMode()).toBe("inherit");
  });

  it("the tool notice is one static sentence naming passEnv", () => {
    expect(TERMINAL_ENV_NOTICE).toContain("terminal.passEnv");
  });
});
