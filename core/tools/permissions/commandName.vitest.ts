import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { hiddenCommandName } from "./commandName";
import { floorMustRefuse } from "./evaluate";

/** Commands whose program is named by a variable: they must ask. */
const HIDDEN: [shell: ShellKind, command: string][] = [
  ["powershell", "& $exe --version"],
  ["powershell", "&$exe"],
  ["powershell", ". $script"],
  ["powershell", String.raw`& "$dir\tool.exe" arg`],
  ["powershell", String.raw`& "$env:ProgramFiles\x\tool.exe"`],
  ["powershell", "& ($cmd) arg"],
  ["powershell", ". (Join-Path $root 'a.ps1')"],
  ["powershell", "$r = & $cmd arg"],
  ["powershell", "git status; & $cmd"],
  ["powershell", "Get-ChildItem | ForEach-Object { & $_.FullName }"],
  ["powershell", "if ($ok) { & $tool }"],
  ["bash", "$cmd args"],
  ["bash", "${prog} args"],
  ["bash", '"$cmd" args'],
  ["bash", '"$@"'],
  ["bash", "A=1 $cmd"],
  ["bash", "$HOME/bin/tool x"],
  ["bash", "echo hi; $cmd"],
  ["bash", "ls | $cmd"],
  ["bash", "for f in a b; do $f; done"],
  ["bash", "if true; then $cmd; fi"],
  ["zsh", "$cmd args"],
  ["sh", "$cmd args"],
  ["unknown", "$cmd args"],
];

/** Commands that use a variable but do not take the program from it. */
const FINE: [shell: ShellKind, command: string][] = [
  ["powershell", "$env:NAME"],
  ["powershell", "$env:NODE_ENV = 'test'; npm test"],
  ["powershell", "$x = Get-Date; Write-Output $x"],
  ["powershell", "$x=1; foo $x"],
  ["powershell", "foreach ($f in $files) { git add $f }"],
  ["powershell", "Get-ChildItem | ForEach-Object { $_.Name }"],
  ["powershell", "Get-ChildItem | ForEach-Object { $n = $_.Name; $n.Length }"],
  [
    "powershell",
    "Get-Process | Where-Object { $_.CPU -gt 1 } | Select-Object Name",
  ],
  ["powershell", "$ErrorActionPreference = 'Stop'; npm test"],
  ["powershell", "if ($LASTEXITCODE -ne 0) { exit 1 }"],
  ["powershell", "Set-Location $dir; npm test"],
  ["powershell", String.raw`& C:\tools\tool.exe --x`],
  ["powershell", String.raw`& "C:\Program Files\Git\bin\git.exe" status`],
  ["powershell", String.raw`& 'C:\tools\a b.exe' $arg`],
  ["powershell", "& git status $branch"],
  ["powershell", String.raw`. .\script.ps1`],
  ["powershell", ". ./env.ps1 $arg"],
  ["powershell", "& { $a = 1; Write-Output $a }"],
  ["powershell", "cmd /c echo $x"],
  ["powershell", "git add @args"],
  ["powershell", "$h = @{ a = 1; b = $x }; $h.a"],
  ["powershell", "$PSScriptRoot"],
  ["powershell", 'Write-Output "& $x"'],
  ["powershell", "Write-Output '& $x'"],
  ["powershell", "$s = @'\n& $x\n$y = 1\n'@\nWrite-Output $s"],
  ["powershell", "# & $x\nGet-Date"],
  ["powershell", "npm test && echo $x"],
  ["powershell", "$a = ${env:ProgramFiles}"],
  ["powershell", "$(Get-Date).Year"],
  ["cmd", "$x args"],
  ["cmd", "echo %PATH%"],
  ["bash", "echo $x"],
  ["bash", "export A=$x"],
  ["bash", "A=$x git status"],
  ["bash", 'git commit -m "$msg"'],
  ["bash", "echo '$cmd args'"],
  ["bash", "echo $(( $a + 1 ))"],
  ["bash", "(( $a < 3 )) && echo ok"],
  ["bash", "cat file 2>&$fd"],
  ["bash", "for f in $list; do echo $f; done"],
  ["bash", "# $cmd\nls"],
  ["bash", "cat <<'EOF'\n$cmd\nEOF"],
  ["bash", "ls -la ${HOME}"],
  ["bash", String.raw`$'\x67it' status`],
];

describe("a variable where the command name is", () => {
  it.each(HIDDEN)("%s: asks for %j", (shell, command) => {
    expect(hiddenCommandName(command, shell), command).toBeDefined();
  });

  it.each(FINE)("%s: leaves %j alone", (shell, command) => {
    expect(hiddenCommandName(command, shell), command).toBeUndefined();
  });

  it("is never a refusal on its own", () => {
    for (const [shell, command] of HIDDEN) {
      expect(floorMustRefuse(command, shell), command).toBe(false);
    }
  });

  it("reads an unknown shell as bash and as PowerShell", () => {
    expect(hiddenCommandName("& $exe")).toBeDefined();
    expect(hiddenCommandName("$cmd args")).toBeDefined();
    expect(hiddenCommandName("echo $x")).toBeUndefined();
  });
});

describe("brace expansion and $IFS", () => {
  it("still refuse in the POSIX shells and when the shell is unknown", () => {
    for (const shell of ["bash", "zsh", "sh", "unknown", undefined] as const) {
      expect(floorMustRefuse("{git,push} origin", shell)).toBe(true);
      expect(floorMustRefuse("git${IFS}push", shell)).toBe(true);
    }
  });

  it("are ordinary text in PowerShell and cmd", () => {
    expect(
      floorMustRefuse(
        "Get-Process | Where-Object { $_.Id -in 1,2 }",
        "powershell",
      ),
    ).toBe(false);
    expect(floorMustRefuse("echo {a,b}", "cmd")).toBe(false);
    expect(floorMustRefuse("echo $IFS", "powershell")).toBe(false);
  });
});
