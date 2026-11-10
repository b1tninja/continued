import { describe, expect, it } from "vitest";
import { isPosixShell, resolveShell, shellKindOf } from "./shell";

describe("shellKindOf", () => {
  it.each([
    ["/bin/bash", "bash"],
    ["/usr/local/bin/bash", "bash"],
    ["/bin/zsh", "zsh"],
    ["/bin/sh", "sh"],
    ["/bin/dash", "sh"],
    ["powershell.exe", "powershell"],
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "powershell",
    ],
    ["pwsh", "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", "cmd"],
    ["CMD.EXE", "cmd"],
    ["/usr/bin/fish", "unknown"],
    ["/bin/ksh", "unknown"],
    ["nu", "unknown"],
    ["", "unknown"],
  ])("%s is %s", (executable, kind) => {
    expect(shellKindOf(executable)).toBe(kind);
  });

  it("an undefined executable is unknown", () => {
    expect(shellKindOf(undefined)).toBe("unknown");
  });
});

describe("resolveShell", () => {
  it("is Windows PowerShell on Windows, whatever SHELL says", () => {
    const shell = resolveShell({
      platform: "win32",
      env: { SHELL: "/usr/bin/bash" },
    });
    expect(shell.kind).toBe("powershell");
    expect(shell.executable).toBe("powershell.exe");
    expect(shell.args("ls")).toEqual([
      "-NoLogo",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "ls",
    ]);
    expect(shell.runsProfile).toBe(true);
  });

  it("is the login shell elsewhere, so zsh on a Mac", () => {
    const shell = resolveShell({
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
    });
    expect(shell.kind).toBe("zsh");
    expect(shell.args("ls")).toEqual(["-l", "-c", "ls"]);
  });

  it("is bash when SHELL is not set", () => {
    const shell = resolveShell({ platform: "linux", env: {} });
    expect(shell.kind).toBe("bash");
    expect(shell.executable).toBe("/bin/bash");
  });

  it("a shell it does not parse is unknown, and keeps its path", () => {
    const shell = resolveShell({
      platform: "linux",
      env: { SHELL: "/usr/bin/fish" },
    });
    expect(shell.kind).toBe("unknown");
    expect(shell.executable).toBe("/usr/bin/fish");
  });
});

describe("isPosixShell", () => {
  it("is true for bash, zsh and sh, and nothing else", () => {
    expect(["bash", "zsh", "sh"].every((k) => isPosixShell(k as never))).toBe(
      true,
    );
    for (const k of ["powershell", "cmd", "unknown", undefined]) {
      expect(isPosixShell(k as never)).toBe(false);
    }
  });
});
