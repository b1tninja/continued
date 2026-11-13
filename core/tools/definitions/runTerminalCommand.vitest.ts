import { describe, expect, it } from "vitest";

import { platformInfo } from "./runTerminalCommand";

describe("platformInfo", () => {
  it("tells the model Windows PowerShell 5.1 rejects && and ||", () => {
    const text = platformInfo("win32", "x64");
    expect(text).toContain("Windows PowerShell 5.1");
    expect(text).toContain("not && or ||");
    expect(text).toContain("powershell.exe");
  });

  it("leaves the other platforms' sentence as it was", () => {
    // The shell is the host's $SHELL, which may hold spaces: do not pin it
    expect(platformInfo("linux", "arm64")).toMatch(
      /^Choose terminal commands and scripts optimized for linux and arm64 and shell .+\.$/,
    );
    expect(platformInfo("darwin", "arm64")).toContain("optimized for darwin");
  });
});
