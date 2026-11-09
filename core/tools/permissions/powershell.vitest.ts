import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import { commandCandidates } from "./candidates";
import { evaluateToolPolicyWithRules } from "./evaluate";
import {
  canonicalCmdlet,
  checkReadCmdlet,
  isPowerShellAlias,
  isReadCmdlet,
  resolveParameter,
} from "./powershell";

describe("canonicalCmdlet", () => {
  it.each([
    ["rm", "remove-item"],
    ["RM", "remove-item"],
    ["del", "remove-item"],
    ["ri", "remove-item"],
    ["ls", "get-childitem"],
    ["gci", "get-childitem"],
    ["cat", "get-content"],
    ["type", "get-content"],
    ["cp", "copy-item"],
    ["mv", "move-item"],
    ["kill", "stop-process"],
    ["sort", "sort-object"],
    ["curl", "invoke-webrequest"],
    ["iex", "invoke-expression"],
    ["cd", "set-location"],
  ])("%s is %s", (word, cmdlet) => {
    expect(canonicalCmdlet(word)).toBe(cmdlet);
  });

  it("a Verb-Noun name stands for itself, in any case", () => {
    expect(canonicalCmdlet("Remove-Item")).toBe("remove-item");
    expect(canonicalCmdlet("GET-CHILDITEM")).toBe("get-childitem");
  });

  it("a program or a script is not a cmdlet", () => {
    for (const w of ["git", "node", "find", "date", ".\\build", "a-b-c"]) {
      expect(canonicalCmdlet(w)).toBeUndefined();
    }
  });

  it("knows what is an alias", () => {
    expect(isPowerShellAlias("rm")).toBe(true);
    expect(isPowerShellAlias("Remove-Item")).toBe(false);
  });
});

describe("resolveParameter", () => {
  it("takes any unambiguous prefix, in any case", () => {
    expect(resolveParameter("get-childitem", "-Rec")).toEqual({
      ok: true,
      name: "Recurse",
      value: undefined,
    });
    expect(resolveParameter("get-childitem", "-RECURSE")).toMatchObject({
      name: "Recurse",
    });
  });

  it("takes the colon form", () => {
    expect(resolveParameter("get-content", "-Path:a.txt")).toEqual({
      ok: true,
      name: "Path",
      value: "a.txt",
    });
  });

  it("an ambiguous prefix is an error, as in PowerShell", () => {
    // Recurse and ReadOnly
    expect(resolveParameter("get-childitem", "-r")).toMatchObject({
      ok: false,
      why: expect.stringContaining("ambiguous"),
    });
  });

  it("a parameter the cmdlet does not have is not resolved", () => {
    expect(resolveParameter("get-childitem", "-Nope")).toMatchObject({
      ok: false,
      why: expect.stringContaining("not recognised"),
    });
  });

  it("the common parameters and their short names are known to every cmdlet", () => {
    expect(resolveParameter("get-date", "-ErrorAction")).toMatchObject({
      name: "ErrorAction",
    });
    expect(resolveParameter("get-date", "-ea")).toMatchObject({
      name: "ErrorAction",
    });
    expect(resolveParameter("get-date", "-wa")).toMatchObject({
      name: "WarningAction",
    });
  });

  it("a word that is not a parameter is not one", () => {
    for (const w of ["-1", "-", "a.txt", "--x"]) {
      expect(resolveParameter("get-content", w)).toBeUndefined();
    }
  });
});

describe("checkReadCmdlet", () => {
  it("passes a call whose every parameter the cmdlet has", () => {
    expect(
      checkReadCmdlet("get-childitem", ["src", "-Recurse", "-Force"]),
    ).toBeUndefined();
  });

  it("refuses a cmdlet that is not known to read, whatever its parameters", () => {
    expect(isReadCmdlet("remove-item")).toBe(false);
    expect(checkReadCmdlet("remove-item", ["x"])).toContain("not a known read");
  });

  it("refuses the stop-parsing symbol", () => {
    expect(checkReadCmdlet("select-string", ["--%", "x"])).toContain("--%");
  });
});

describe("a rule on a cmdlet sees its aliases", () => {
  const terminal = {
    group: "Built-In",
    readonly: false,
    evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, args.command as string),
  };
  const refused = (command: string, deny: string) =>
    evaluateToolPolicyWithRules({
      tool: terminal as any,
      toolName: "run_terminal_command",
      basePolicy: "allowedWithoutPermission",
      parsedArgs: { command },
      permissions: { deny: [deny] },
    }).policy === "disabled";

  it("candidates carry the cmdlet next to the alias", () => {
    const c = commandCandidates("rm -r x");
    expect(c).toContain("rm -r x");
    expect(c).toContain("Remove-Item -r x");
  });

  it.each([
    "rm -rf build",
    "del build",
    "ri build",
    "rd build",
    "Remove-Item build",
  ])("a deny rule on Remove-Item refuses %s", (command) => {
    expect(refused(command, "runTerminalCommand(Remove-Item*)")).toBe(true);
  });

  it("and a deny rule on rm refuses Remove-Item's other names only through the cmdlet", () => {
    expect(refused("rm x", "runTerminalCommand(rm*)")).toBe(true);
    expect(refused("Get-ChildItem", "runTerminalCommand(Remove-Item*)")).toBe(
      false,
    );
  });
});
