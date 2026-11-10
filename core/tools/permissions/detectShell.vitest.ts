import { describe, expect, it } from "vitest";
import { detectCommandShell, mismatchedShell } from "./detectShell";

type Row = [command: string, likely: string[], confidence?: string];

/** Text, the shells it is written for (as a set, best first), and optionally how sure. */
const CORPUS: Row[] = [
  // PowerShell
  [
    "Get-ChildItem -Path . -Recurse | Where-Object { $_.Length -gt 1kb }",
    ["powershell"],
    "high",
  ],
  ["$env:PATH = 'C:\\tools;' + $env:PATH", ["powershell"], "high"],
  ["Write-Host 'hi'", ["powershell"]],
  ["if ($x -eq $null) { Remove-Item -Force $f }", ["powershell"], "high"],
  ["[System.IO.Path]::GetTempPath()", ["powershell"]],
  ["$h = @{ a = 1 }", ["powershell"]],
  ["Get-Content a.txt `\n  | Select-String foo", ["powershell"], "high"],
  ["Start-Process -FilePath node -ArgumentList app.js", ["powershell"], "high"],
  // bash and zsh
  ["export FOO=1 && echo $FOO", ["bash", "zsh", "sh"], "high"],
  ["for f in *.ts; do echo $f; done", ["bash", "zsh", "sh"], "high"],
  ["ls -la 2>/dev/null", ["bash", "zsh", "sh"], "high"],
  ["cat <<EOF\nhi\nEOF", ["bash", "zsh", "sh"], "high"],
  ["echo ${HOME:-/tmp}", ["bash", "zsh", "sh"]],
  ["sudo apt-get install -y jq", ["bash", "zsh", "sh"], "medium"],
  ["#!/bin/bash\necho hi", ["bash", "zsh", "sh"], "high"],
  ["rm -rf build && mkdir -p build", ["bash", "zsh", "sh"]],
  // sh versus bash
  ["if [[ -n $x ]]; then echo y; fi", ["bash", "zsh"], "high"],
  ['grep foo <<< "$x"', ["bash", "zsh"]],
  ["echo {a,b}.txt; arr=(1 2 3)", ["bash", "zsh"]],
  ["if [ -f x ]; then echo y; fi", ["bash", "zsh", "sh"], "high"],
  // zsh only
  ["setopt extendedglob; echo *(.)", ["zsh"], "high"],
  ["print ${(f)$(cat x)}", ["zsh"]],
  ["autoload -U compinit && compinit", ["zsh"]],
  ["ls **/*(.)", ["zsh"]],
  // cmd
  ["echo %USERPROFILE%", ["cmd"], "high"],
  ["if exist build rmdir /s /q build", ["cmd"], "high"],
  ["dir /b C:\\temp", ["cmd"]],
  ["set FOO=bar & echo done", ["cmd"]],
  ["@echo off\r\ncall build.bat", ["cmd"], "high"],
];

describe("detectCommandShell", () => {
  it.each(CORPUS)("%j", (command, likely, confidence) => {
    const d = detectCommandShell(command);
    expect([...d.likely].sort()).toEqual([...likely].sort());
    if (confidence) expect(d.confidence).toBe(confidence);
    expect(d.evidence.length).toBeGreaterThan(0);
  });

  it("says nothing for text every shell reads the same", () => {
    for (const c of ["git status", "node app.js", "npm test", "cd src", ""]) {
      const d = detectCommandShell(c);
      expect(d.likely, c).toEqual([]);
      expect(d.confidence).toBe("low");
    }
  });

  it("does not take bash's -eq in [ ] for PowerShell", () => {
    expect(detectCommandShell("[ $a -eq 1 ] && echo y").likely).not.toContain(
      "powershell",
    );
  });

  it("is not fooled by a keyword inside a quoted string alone being mild", () => {
    // `Get-Date` alone is a PowerShell cmdlet; a Unix command with a dash is not
    expect(detectCommandShell("git-lfs install").likely).toEqual([]);
    expect(detectCommandShell("docker-compose up").likely).toEqual([]);
  });

  it("never throws", () => {
    expect(() =>
      detectCommandShell(undefined as unknown as string),
    ).not.toThrow();
    expect(() =>
      detectCommandShell("\u0000`$(" + "(".repeat(5000)),
    ).not.toThrow();
  });
});

describe("mismatchedShell", () => {
  it("is true only for another family with real evidence", () => {
    const ps = detectCommandShell("Get-ChildItem | Where-Object { $_ }");
    expect(mismatchedShell(ps, "bash")).toBe(true);
    expect(mismatchedShell(ps, "powershell")).toBe(false);
    const sh = detectCommandShell("export A=1 && ls -la 2>/dev/null");
    expect(mismatchedShell(sh, "powershell")).toBe(true);
    expect(mismatchedShell(sh, "zsh")).toBe(false);
    expect(
      mismatchedShell(detectCommandShell("git status"), "powershell"),
    ).toBe(false);
  });
});
