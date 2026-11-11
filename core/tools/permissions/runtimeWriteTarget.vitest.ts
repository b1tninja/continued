import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../util/shell";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { DEFAULT_POLICY_LEVELS } from "./policy";
import { runtimeWriteTarget } from "./runtimeWriteTarget";

const ASK = "allowedWithPermission" as const;
const RUN = "allowedWithoutPermission" as const;

describe("a write target with a run-time part is found", () => {
  const hits: [ShellKind | undefined, string][] = [
    ["powershell", "Remove-Item $dir\\x"],
    ["powershell", "rm $env:USERPROFILE\\.continuous\\config.yaml"],
    ["powershell", "del *.yaml"],
    ["powershell", "ri -Recurse -Force $p"],
    ["powershell", "Set-Content -Path $f -Value hi"],
    ["powershell", "Set-Content -Pa:$f hi"],
    ["powershell", "Set-Content $f hi"],
    ["powershell", "Out-File -FilePath $env:TEMP\\x"],
    ["powershell", "'hi' | Out-File $f"],
    ["powershell", "Copy-Item a $dest"],
    ["powershell", "cp a $dest"],
    ["powershell", "mv a* b"],
    ["powershell", "Move-Item -Destination $d a"],
    ["powershell", "ren a $n"],
    ["powershell", "icm { 1 }; rm $x"],
    ["powershell", "echo hi > $env:APPDATA\\x"],
    ["powershell", "echo hi >> $f"],
    ["powershell", "echo hi 2> $f"],
    ["powershell", "echo hi *> $f"],
    ["powershell", "New-Item -ItemType File -Path $f"],
    ["powershell", "mkdir $d"],
    ["powershell", "rm $d; $d = 'x'"],
    ["powershell", "$d = 'x'; $d = Get-Location; rm $d"],
    ["powershell", "$d = 'x'; $d += 'y'; rm $d"],
    ["powershell", "$d = 'x'; foreach ($d in $l) { rm $d }"],
    ["powershell", "$d = 'x'; Set-Variable d y; rm $d"],
    ["powershell", "$d = 'x'; $e = 1; rm $d$e"],
    ["powershell", "$p = '~/.continuous/config.yaml'; rm $p"],
    [
      "powershell",
      "Get-ChildItem | ForEach-Object { Remove-Item $_.FullName }",
    ],
    ["powershell", "if ($ok) { rm $x } else { rm y }"],
    ["powershell", "try { del $x } catch { }"],
    ["powershell", "Set-Content (Join-Path $a b) x"],
    ["powershell", "Set-Content (Join-Path a b) x"],
    ["powershell", '$p = "$HOME/x"; rm $p'],
    ["bash", "D=x; D=y; rm $D"],
    ["bash", "D=~/.continuous/config.yaml; rm $D"],
    ["bash", "D=$(pwd); rm $D"],
    ["bash", "rm -rf $DIR"],
    ["bash", "rm -rf ${DIR}/x"],
    ["bash", "rm -rf *.log"],
    ["bash", "rm -rf ?.log"],
    ["bash", "rm -rf `pwd`/x"],
    ["bash", "rm -rf $(pwd)/x"],
    ["bash", "echo hi > $HOME/.continuous/config.yaml"],
    ["bash", "echo hi > ~/.c*/config.yaml"],
    ["bash", "cp a $d"],
    ["bash", "mv a b*"],
    ["bash", "touch $f"],
    ["bash", "mkdir -p $d"],
    ["bash", "sudo rm $x"],
    ["bash", "env A=1 rm $x"],
    ["bash", "echo hi | tee $f"],
    ["bash", "dd if=a of=$f"],
    ["bash", "cd ~/.continuous && rm config.yaml"],
    ["bash", "cd ~ && touch .bashrc"],
    ["bash", "cd $HOME/.continuous; echo x > config.yaml"],
    ["bash", "cd ~/.continuous; sed -i s/a/b/ config.yaml; tee out"],
    ["powershell", "cd ~\\.continuous; Set-Content config.yaml x"],
    [
      "powershell",
      "Set-Location $env:USERPROFILE\\.continuous; rm config.yaml",
    ],
    ["powershell", "sl $HOME; Remove-Item .continuerc.json"],
    ["powershell", "pushd ~; del x"],
    ["cmd", "del %USERPROFILE%\\x"],
    ["cmd", "cd %USERPROFILE%\\.continuous & del config.yaml"],
    [undefined, "rm $x"],
    [undefined, "Remove-Item $x"],
  ];

  it.each(hits)("%s: %j", (shell, command) => {
    expect(runtimeWriteTarget(command, shell)).toBeDefined();
  });
});

describe("a write target that is written out, or a command that writes nothing, is not", () => {
  const clean: [ShellKind | undefined, string][] = [
    ["powershell", "Remove-Item build\\out.txt"],
    ["powershell", "rm -Recurse -Force .\\dist"],
    ["powershell", "Set-Content out.txt $text"],
    ["powershell", "Set-Content -Path out.txt -Value $text"],
    ["powershell", 'Set-Content out.txt -Value "$a $b"'],
    ["powershell", "Out-File -FilePath out.txt -Encoding $enc"],
    ["powershell", "'hi' | Out-File out.txt"],
    ["powershell", "Copy-Item a b"],
    ["powershell", "Write-Output $x"],
    ["powershell", "Get-ChildItem $dir"],
    ["powershell", "gci *.ts | Select-Object -First 3"],
    ["powershell", "$x = 1; Write-Output $x"],
    ["powershell", "git add $f"],
    ["powershell", "npm test"],
    ["powershell", "python $script"],
    ["powershell", "echo hi > out.txt"],
    ["powershell", "foreach ($f in $l) { Write-Output $f }"],
    ["powershell", "Get-ChildItem | ForEach-Object { Write-Output $_.Name }"],
    ["powershell", "if ($ok) { rm build } else { Set-Content out.txt $x }"],
    ["powershell", "cmd1 2>&1"],
    ["powershell", "cmd1 > $null"],
    ["powershell", "cd ~\\proj; Get-ChildItem"],
    ["powershell", "Set-Location $env:USERPROFILE; Get-ChildItem"],
    ["powershell", "cd ~; rm C:\\x\\y"],
    ["powershell", "cd ~; rm ~\\x"],
    ["bash", "rm -rf build"],
    ["bash", "rm -rf ./dist /tmp/x"],
    ["bash", "echo $HOME"],
    ["bash", "ls *.log"],
    ["bash", "grep -r $x ."],
    ["bash", "cat $f > out.txt"],
    ["bash", "cd ~ && ls"],
    ["bash", "cd ~/proj && git status"],
    ["bash", "cd /tmp && rm x"],
    ["bash", 'git commit -m "$msg"'],
    ["bash", "dd if=$in of=out.img"],
    ["bash", "command 2>/dev/null"],
    ["bash", "echo hi >/dev/null"],
    ["bash", "echo hi 2>&1"],
    [undefined, "echo hi"],
  ];

  it.each(clean)("%s: %j", (shell, command) => {
    expect(runtimeWriteTarget(command, shell)).toBeUndefined();
  });

  it("names the word in the reason", () => {
    expect(runtimeWriteTarget("rm -rf $DIR/x", "bash")).toContain("$DIR/x");
    expect(runtimeWriteTarget("cd ~/a && rm b", "bash")).toContain("home");
    expect(
      runtimeWriteTarget(`rm ${"a".repeat(200)}*`, "bash")!.length,
    ).toBeLessThan(150);
  });
});

describe("at YOLO such a command asks, and nothing loosens it", () => {
  const terminalTool = {
    group: "Built-In",
    evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, args.command as string),
  };
  const run = (
    command: string,
    shell: ShellKind,
    tools: "yolo" | "permissive" | "automatic" | "cautious",
    extra: Record<string, unknown> = {},
  ) =>
    evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command },
      permissions: undefined,
      shell,
      approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools } },
      ...extra,
    });

  const cases: [ShellKind, string][] = [
    ["powershell", "Remove-Item $dir\\x"],
    ["powershell", "rm *.yaml"],
    ["powershell", "icm { 1 }; Set-Content $f x"],
    ["bash", "rm -rf $DIR"],
    ["bash", "cd ~/work && rm notes.txt"],
    ["bash", "echo x > $HOME/notes.txt"],
  ];

  it.each(cases)("%s: %j asks at YOLO, with a reason", (shell, command) => {
    const r = run(command, shell, "yolo");
    expect(r.policy).toBe(ASK);
    expect(r.source).toBe("floor");
    expect(r.reason).toContain("built when it runs");
  });

  it.each(cases)(
    "%s: %j asks at YOLO whatever allow rule is written",
    (shell, command) => {
      const r = run(command, shell, "yolo", {
        permissions: { allow: ["runTerminalCommand(*)"] },
      });
      expect(r.policy).toBe(ASK);
    },
  );

  it.each(cases)(
    "%s: %j is not asked again at a lower level",
    (shell, command) => {
      for (const level of ["permissive", "automatic", "cautious"] as const) {
        const r = run(command, shell, level);
        expect(r.reason ?? "", level).not.toContain("built when it runs");
      }
    },
  );

  it("a floor rule still refuses it, and a refusal is not turned into an ask", () => {
    const r = run("rm $x; git push origin main", "bash", "yolo", {
      approval: {
        levels: { ...DEFAULT_POLICY_LEVELS, tools: "yolo" },
        floor: ["runTerminalCommand(git push*)"],
      },
    });
    expect(r.policy).toBe("disabled");
    expect(r.source).toBe("floor");
    expect(r.reason).not.toContain("built when it runs");
  });

  it("a deny rule, which YOLO reaches past, leaves the command asking rather than running", () => {
    const r = run("rm $x; git push origin main", "bash", "yolo", {
      permissions: { deny: ["runTerminalCommand(git push*)"] },
    });
    expect(r.policy).toBe(ASK);
  });

  it("a command with a written-out target still runs at YOLO", () => {
    for (const [shell, command] of [
      ["powershell", "Remove-Item build\\out.txt"],
      ["bash", "rm -rf build"],
      ["powershell", "Set-Content out.txt $text"],
    ] as [ShellKind, string][]) {
      expect(run(command, shell, "yolo").policy, command).toBe(RUN);
    }
  });

  it("never turns an ask or a refusal into a run", () => {
    for (const [shell, command] of cases) {
      for (const tools of [
        "yolo",
        "permissive",
        "automatic",
        "cautious",
      ] as const) {
        const without = run(command.replace(/\$|\*/g, "x"), shell, tools);
        const withIt = run(command, shell, tools);
        const rank = {
          disabled: 0,
          allowedWithPermission: 1,
          allowedWithoutPermission: 2,
        };
        expect(
          rank[withIt.policy as keyof typeof rank],
          `${tools} ${command}`,
        ).toBeLessThanOrEqual(rank[without.policy as keyof typeof rank]);
      }
    }
  });
});
