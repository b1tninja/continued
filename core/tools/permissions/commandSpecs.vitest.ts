import { describe, expect, it } from "vitest";
import {
  COMMAND_SPECS,
  effectsOfCommand,
  lintCommandSpecs,
  type Effect,
} from "./commandSpecs";
import { matchTerminalCommand, parseRule, type ParsedRule } from "./rules";

const effects = (command: string): Effect[] =>
  [...effectsOfCommand(command)].sort();

describe("effectsOfCommand", () => {
  it("reads the subcommand after global flags", () => {
    expect(effects("git push origin main")).toEqual(["network", "write"]);
    expect(effects("git -C repo -c a=b push")).toEqual(["network", "write"]);
    expect(effects("git status")).toEqual([]);
    expect(effects("git log --oneline")).toEqual([]);
    expect(effects("git clean -fd")).toEqual(["delete", "write"]);
  });

  it("knows package managers", () => {
    expect(effects("npm install left-pad")).toEqual([
      "exec",
      "network",
      "write",
    ]);
    expect(effects("pnpm test")).toEqual(["exec"]);
    expect(effects("npm ls")).toEqual([]);
    expect(effects("pip install requests")).toEqual([
      "exec",
      "network",
      "write",
    ]);
  });

  it("knows file commands and their flags", () => {
    expect(effects("rm -rf build")).toEqual(["delete"]);
    expect(effects("mv a b")).toEqual(["delete", "write"]);
    expect(effects("sed -i s/a/b/ f")).toEqual(["write"]);
    expect(effects("sed s/a/b/ f")).toEqual([]);
    expect(effects("find . -name x -delete")).toEqual(["delete"]);
    expect(effects("find . -exec rm {} ;")).toEqual(["exec"]);
    expect(effects("curl -o out.bin https://x.test")).toEqual([
      "network",
      "write",
    ]);
    expect(effects("curl https://x.test")).toEqual(["network"]);
  });

  it("drops directories and .exe, and ignores case", () => {
    expect(effects("/usr/bin/git push")).toEqual(["network", "write"]);
    expect(effects("GIT.EXE push")).toEqual(["network", "write"]);
    expect(effects("C:\\Program Files\\Git\\git.exe push")).toEqual([]);
    expect(effects("C:\\tools\\git.exe push")).toEqual(["network", "write"]);
  });

  it("resolves PowerShell aliases to their cmdlet", () => {
    expect(effects("rm -Recurse x")).toEqual(["delete"]);
    expect(effects("Remove-Item x")).toEqual(["delete"]);
    expect(effects("iwr https://x.test")).toEqual(["network"]);
  });

  it("says nothing about a program it does not know", () => {
    expect(effects("frobnicate --all")).toEqual([]);
    expect(effects("")).toEqual([]);
  });
});

describe("effect rules", () => {
  const rule = (pattern: string, decision: "deny" | "ask" = "deny") =>
    parseRule(`runTerminalCommand(${pattern})`, decision) as ParsedRule;

  it("deny effect:network refuses any program that reaches the network", () => {
    const rules = [rule("effect:network")];
    for (const command of [
      "curl https://x.test",
      "git push",
      "npm install",
      "/usr/bin/curl x",
      "echo hi && wget http://x",
      "bash -c 'curl x'",
    ]) {
      expect(matchTerminalCommand(rules, command)?.decision, command).toBe(
        "deny",
      );
    }
    expect(matchTerminalCommand(rules, "git status")).toBeUndefined();
    expect(matchTerminalCommand(rules, "ls -la")).toBeUndefined();
  });

  it("takes several effects and ask rules", () => {
    const rules = [rule("effect:delete,exec", "ask")];
    expect(matchTerminalCommand(rules, "rm -rf x")?.decision).toBe("ask");
    expect(matchTerminalCommand(rules, "make build")?.decision).toBe("ask");
    expect(matchTerminalCommand(rules, "git log")).toBeUndefined();
  });

  it("an unknown effect name matches nothing", () => {
    expect(
      matchTerminalCommand([rule("effect:telepathy")], "rm -rf x"),
    ).toBeUndefined();
  });

  it("an allow rule on an effect never allows anything", () => {
    const allow = parseRule(
      "runTerminalCommand(effect:network)",
      "allow",
    ) as ParsedRule;
    expect(
      matchTerminalCommand([allow], "curl https://x.test"),
    ).toBeUndefined();
  });

  it("a deny on a literal pattern still works beside effect rules", () => {
    const rules = [rule("effect:network"), rule("terraform apply*")];
    expect(matchTerminalCommand(rules, "terraform apply")?.decision).toBe(
      "deny",
    );
  });
});

describe("the spec table", () => {
  it("passes its own linter", () => {
    expect(lintCommandSpecs()).toEqual([]);
  });

  it("has a spec for the commands the plan names first", () => {
    for (const name of [
      "git",
      "npm",
      "pnpm",
      "yarn",
      "pip",
      "uv",
      "cargo",
      "go",
      "docker",
      "kubectl",
      "gh",
      "curl",
      "rm",
      "mv",
      "cp",
      "mkdir",
      "touch",
      "tee",
      "dd",
      "find",
      "sed",
    ]) {
      expect(COMMAND_SPECS[name], name).toBeDefined();
    }
  });
});
