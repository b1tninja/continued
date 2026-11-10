import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { commandCandidateSet, commandCandidates } from "./candidates";
import { extractSubstitutions, scanSubstitutions } from "./substitutions";

type Row = [command: string, expected: string[]];

const BASH: Row[] = [
  ["echo $(rm x)", ["rm x"]],
  ["echo `rm x`", ["rm x"]],
  ["echo $(a $(b))", ["a $(b)", "b"]],
  ["echo `a \\`b\\``", ["a `b`", "b"]],
  ['echo "$(rm x)"', ["rm x"]],
  ['echo "`rm x`"', ["rm x"]],
  ["echo '$(rm x)'", []],
  ["echo '`rm x`'", []],
  ["echo \\$(rm x)", []],
  ["echo \\`rm x\\`", []],
  ["echo $((1+2))", []],
  ["echo $(( $(rm x) + 1 ))", ["rm x"]],
  ["echo $((a * (b + c)))", []],
  ["diff <(rm x) >(tee y)", ["rm x", "tee y"]],
  ['echo "<(rm x)"', []],
  ["echo $(echo ')' ; rm x)", ["echo ')' ; rm x"]],
  ["echo $'$(rm x)'", []],
  ["echo $'it\\'s' $(rm x)", ["rm x"]],
  ["echo hi # $(rm x)\necho ok", []],
  ["cat <<'EOF'\n$(rm x)\nEOF", []],
  ["cat <<EOF\n$(rm x)\nit's\nEOF", ["rm x"]],
  ["cat <<EOF\n`rm x`\nEOF", ["rm x"]],
  ["cat <<-'EOF'\n\t$(rm x)\n\tEOF", []],
  // an apostrophe that never closes is not a quote: what follows is still read
  ["echo don't $(rm x)", ["rm x"]],
  ["echo $(rm x", ["rm x"]],
  ["echo $(a; b)$(c)", ["a; b", "c"]],
];

const POWERSHELL: Row[] = [
  ["echo $(rm x)", ["rm x"]],
  ["echo @(rm x)", ["rm x"]],
  ['echo "$(rm x)"', ["rm x"]],
  ["echo $(a $(b))", ["a $(b)", "b"]],
  // the backtick is the escape character
  ["echo `rm x`", []],
  ['echo "`$(rm x)"', []],
  ["echo `$(rm x)", []],
  ['echo "a`nb"', []],
  ["echo `$HOME `n", []],
  ["Get-ChildItem `\n  -Path .", []],
  ["echo '$(rm x)'", []],
  ["echo 'it''s $(rm x)'", []],
  ["echo \\$(rm x)", ["rm x"]],
  ["echo $((1+2))", ["(1+2)"]],
  ["echo @'\n$(rm x)\n'@", []],
  ['echo @"\n$(rm x)\n"@', ["rm x"]],
  ["echo <# $(rm x) #> ok", []],
  // curly quotes quote in PowerShell
  ["echo ‘$(rm x)’", []],
  ["diff <(rm x)", []],
  ["echo $(rm x", ["rm x"]],
];

const CMD: Row[] = [
  ["echo $(rm x)", []],
  ["echo `rm x`", []],
  ["echo %PATH%", []],
  ["for /f %i in ('dir /b') do echo %i", ["dir /b"]],
];

const ZSH: Row[] = [
  ["echo $(rm x)", ["rm x"]],
  ["echo `rm x`", ["rm x"]],
  ["cat =(rm x)", ["rm x"]],
  ["ls *(e:'rm x':)", ["'rm x'"]],
  ["echo ${(e)x}", []],
];

describe("extractSubstitutions per shell", () => {
  it.each([
    ["bash", BASH],
    ["sh", BASH],
    ["zsh", BASH],
    ["powershell", POWERSHELL],
    ["cmd", CMD],
    ["zsh", ZSH],
  ] as [ShellKind, Row[]][])("%s", (shell, rows) => {
    for (const [command, expected] of rows) {
      expect(
        extractSubstitutions(command, shell),
        `${shell}: ${command}`,
      ).toEqual(expected);
    }
  });

  it("with no shell is the union, so nothing a shell reads is missed", () => {
    for (const rows of [BASH, POWERSHELL]) {
      for (const [command, expected] of rows) {
        const got = extractSubstitutions(command);
        for (const e of expected) {
          expect(got, command).toContain(e);
        }
      }
    }
    expect(extractSubstitutions("echo `rm x`")).toEqual(["rm x"]);
    expect(extractSubstitutions("echo @(rm x)")).toEqual(["rm x"]);
  });

  it("flags zsh code the text does not show", () => {
    expect(scanSubstitutions("echo ${(e)x}", "zsh").dynamic).toHaveLength(1);
    expect(scanSubstitutions("echo ${(e)x}", "bash").dynamic).toEqual([]);
    expect(scanSubstitutions("ls *(+fn)", "zsh").dynamic).toHaveLength(1);
  });

  it("does not run away on deep nesting", () => {
    const deep = "$(".repeat(80) + "rm x" + ")".repeat(80);
    expect(scanSubstitutions(deep, "bash").dynamic.length).toBeGreaterThan(0);
  });
});

describe("commandCandidates read the substitution in the shell's grammar", () => {
  const has = (cmd: string, shell: ShellKind | undefined, want: string) =>
    expect(commandCandidates(cmd, shell)).toContain(want);
  const lacks = (cmd: string, shell: ShellKind | undefined, want: string) =>
    expect(commandCandidates(cmd, shell)).not.toContain(want);

  it("finds a command hidden in a substitution in each shell", () => {
    has("echo $(git push)", "bash", "git push");
    has("echo `git push`", "zsh", "git push");
    has('echo "$(git push)"', "powershell", "git push");
    has("echo @(git push)", "powershell", "git push");
    has("diff <(git push) b", "bash", "git push");
    has("echo $(( $(git push) ))", "bash", "git push");
  });

  it("does not make a PowerShell escape or a quoted or escaped form into a substitution", () => {
    // `ls` alone is a candidate only when the body was read as a command
    has("echo $(ls; git push)", "bash", "ls");
    has('echo "$(ls; git push)"', "powershell", "ls");
    lacks('echo "`$(ls; git push)"', "powershell", "ls");
    lacks("echo '$(ls; git push)'", "bash", "ls");
    lacks("echo '$(ls; git push)'", "powershell", "ls");
  });

  it("reads a PowerShell escape inside a command name", () => {
    has("g`it push", "powershell", "git push");
  });

  it("reads text for another shell both ways, so it cannot look safe in one", () => {
    // bash text sent to PowerShell: both grammars are read
    has("export A=1 && echo `git push`", "powershell", "git push");
    has("ls -la 2>/dev/null && echo $(git push)", "powershell", "git push");
    // PowerShell text sent to bash
    has(
      "Get-ChildItem | Where-Object { $_ } ; echo $(git push)",
      "bash",
      "git push",
    );
  });

  it("keeps the union when the shell is not known", () => {
    has("echo `git push`", undefined, "git push");
    has("echo `git push`", "unknown", "git push");
  });

  it("fails closed on code the text does not show", () => {
    expect(commandCandidateSet("echo ${(e)x}", "zsh").truncated).toBe(true);
    expect(commandCandidateSet("echo ${x}", "zsh").truncated).toBe(false);
  });

  it("reads zsh's =cmd as the command", () => {
    has("=git push", "zsh", "git push");
  });
});
