import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { commandCandidates } from "./candidates";
import { matchTerminalCommand } from "./rules";
import { parsePermissions } from "./names";

/**
 * Regression tests for the ways public write-ups got a command past an
 * allowlist or a deny rule in other coding agents (plans/command-shell-dialects.md,
 * section 3). Each names the class, not the product: the class is what recurs.
 * A deny rule on `git push` must refuse all of these.
 */
const denyPush = parsePermissions({ deny: ["runTerminalCommand(git push*)"] });

const CLASSES: [name: string, shell: ShellKind, command: string][] = [
  ["command substitution", "bash", "echo $(git push origin main)"],
  ["backtick substitution", "bash", "echo `git push origin main`"],
  ["substitution in double quotes", "zsh", 'echo "$(git push origin main)"'],
  [
    "substitution as an argument of an allowed command",
    "bash",
    "ls $(git push)",
  ],
  ["nested substitution", "bash", "echo $(echo $(git push))"],
  ["process substitution", "bash", "cat <(git push)"],
  ["substitution in a heredoc body", "bash", "cat <<EOF\n$(git push)\nEOF"],
  ["substitution inside arithmetic", "bash", "echo $(( $(git push) ))"],
  ["brace expansion", "bash", "{git,push}"],
  ["brace expansion in zsh", "zsh", "{git,push} origin"],
  ["environment prefix and export", "bash", "export A=push && git $A"],
  ["$IFS as the separator", "bash", "git${IFS}push"],
  ["blank padding", "bash", "git      \t   push"],
  ["quote splitting", "bash", "g\"\"it pu''sh"],
  ["ANSI-C quoting", "bash", "$'\\x67it' push"],
  ["a shell inside a shell", "bash", "bash -c 'git push'"],
  ["a shell inside PowerShell", "powershell", "bash -c 'git push'"],
  ["PowerShell subexpression", "powershell", "echo $(git push)"],
  ["PowerShell subexpression in a string", "powershell", 'echo "$(git push)"'],
  ["PowerShell array subexpression", "powershell", "echo @(git push)"],
  ["PowerShell backtick-escaped name", "powershell", "g`it push"],
  ["PowerShell Invoke-Expression", "powershell", "iex 'git push'"],
  ["PowerShell from bash", "bash", "pwsh -Command 'git push'"],
  ["cmd for /f", "cmd", "for /f %i in ('git push') do @echo %i"],
  ["cmd from PowerShell", "powershell", "cmd /c git push"],
  ["zsh =cmd", "zsh", "=git push"],
  ["zsh glob qualifier", "zsh", "ls *(e:'git push':)"],
  [
    "a command that is not in the shell's own dialect",
    "powershell",
    "ls -la; echo `git push`",
  ],
];

describe("deny rule bypass classes", () => {
  it.each(CLASSES)("%s (%s)", (_name, shell, command) => {
    expect(
      commandCandidates(command, shell).some((c) => c.startsWith("git push")),
      command,
    ).toBe(true);
    expect(matchTerminalCommand(denyPush, command, shell)?.decision).toBe(
      "deny",
    );
    // and with no shell known, the union reads it the same way
    expect(matchTerminalCommand(denyPush, command)?.decision).toBe("deny");
  });

  it("refuses ${(e)} in zsh to be vouched: any rule fails closed", () => {
    expect(
      matchTerminalCommand(denyPush, "echo ${(e)x}", "zsh")?.decision,
    ).toBe("deny");
  });
});
