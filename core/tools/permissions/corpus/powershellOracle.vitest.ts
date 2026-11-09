import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanCommand } from "../shellScan";
import { casesFor } from "./verdicts";

/**
 * PowerShell's own parser as the oracle for our PowerShell scanner
 * (plans/command-analysis.md, I3, decision D2): the scanner is a strict subset
 * we run on every command, and this checks, on a machine that has PowerShell,
 * that for every command the scanner understands PowerShell's parser sees the
 * same commands and words. Skipped elsewhere; Windows CI is the home of it.
 */
const POWERSHELL = process.platform === "win32" ? "powershell.exe" : undefined;

const SCRIPT = `
param($In, $Out)
# 5.1 hands a top-level JSON array back as one object: unroll it
$cmds = @(Get-Content -Raw -Encoding UTF8 $In | ConvertFrom-Json | ForEach-Object { $_ })
$res = foreach ($c in $cmds) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($c, [ref]$tokens, [ref]$errors)
  $cas = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)
  $list = foreach ($ca in $cas) {
    $words = foreach ($e in $ca.CommandElements) {
      if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) { [string]$e.Value }
      elseif ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        if ($e.Argument) { '-' + $e.ParameterName + ':' + $e.Argument.Extent.Text } else { '-' + $e.ParameterName }
      }
      elseif ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) { [string]$e.Extent.Text }
      else { '<<' + $e.GetType().Name + '>>' }
    }
    [pscustomobject]@{ words = @($words) }
  }
  [pscustomobject]@{ command = $c; errors = @($errors).Count; commands = @($list) }
}
ConvertTo-Json -Depth 6 -InputObject @($res) | Set-Content -Encoding UTF8 $Out
`;

interface Oracle {
  command: string;
  errors: number;
  commands: { words: string | string[] }[];
}

let dir = "";
let oracle = new Map<string, Oracle>();

const EXTRA = [
  "Get-Content 'it''s.txt'",
  'Get-Content "a b.txt"',
  "Get-Content a.txt | Select-Object -First 5",
  "ls -Recurse:$false",
  "Get-ChildItem -Rec src; Get-Date",
  "Get-Content C:\\src\\a.ts",
  "Get-Content 'a b' 'c d'",
  "git log --oneline -5",
  "git diff HEAD~1 -- src",
  "rg --files -g '*.ts'",
  "Get-Content a.txt 2>&1",
  "ls > $null",
  "ls 2>$null",
];

beforeAll(() => {
  if (!POWERSHELL) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-oracle-"));
  const commands = [
    ...new Set([...casesFor("powershell").map((k) => k.command), ...EXTRA]),
  ];
  const input = path.join(dir, "in.json");
  const output = path.join(dir, "out.json");
  const script = path.join(dir, "oracle.ps1");
  fs.writeFileSync(input, JSON.stringify(commands), "utf-8");
  fs.writeFileSync(script, SCRIPT, "utf-8");
  const r = spawnSync(
    POWERSHELL,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-In",
      input,
      "-Out",
      output,
    ],
    { encoding: "utf-8", timeout: 120_000 },
  );
  if (r.status !== 0)
    throw new Error(`the oracle failed: ${r.stderr || r.stdout}`);
  const parsed = JSON.parse(
    fs.readFileSync(output, "utf-8").replace(/^\uFEFF/, ""),
  ) as Oracle[];
  oracle = new Map(parsed.map((o) => [o.command, o]));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const wordsOf = (o: Oracle) =>
  o.commands.map((c) => (Array.isArray(c.words) ? c.words : [c.words]));

const NUMBER = /^-?\d+(\.\d+)?$/;

describe.skipIf(!POWERSHELL)(
  "PowerShell's parser reads what our scanner reads",
  () => {
    it("the oracle answered for every command", () => {
      const wanted = new Set([
        ...casesFor("powershell").map((k) => k.command),
        ...EXTRA,
      ]);
      expect([...wanted].filter((c) => !oracle.has(c))).toEqual([]);
    });

    it("agrees on the commands and words of everything the scanner understands", () => {
      const disagreements: string[] = [];
      let compared = 0;
      for (const [command, o] of oracle) {
        const ours = scanCommand(command, "powershell");
        if (!ours.ok) continue;
        compared++;
        if (o.errors > 0) {
          disagreements.push(`${command}: PowerShell reports a syntax error`);
          continue;
        }
        const theirs = wordsOf(o);
        const mine = ours.graph.commands.map((c) => c.words);
        const same =
          theirs.length === mine.length &&
          theirs.every(
            (words, i) =>
              words.length === mine[i].length &&
              words.every(
                (w, k) =>
                  w === mine[i][k] ||
                  // a number is a constant to PowerShell, not a string
                  (NUMBER.test(mine[i][k]) && NUMBER.test(w)),
              ),
          );
        if (!same) {
          disagreements.push(
            `${command}: ours ${JSON.stringify(mine)} theirs ${JSON.stringify(theirs)}`,
          );
        }
      }
      expect(compared).toBeGreaterThan(60);
      expect(disagreements).toEqual([]);
    });

    it("and what PowerShell reads as an expansion, the scanner does not understand", () => {
      for (const [command, o] of oracle) {
        const theirs = wordsOf(o).flat();
        if (!theirs.some((w) => w.startsWith("<<"))) continue;
        // a word PowerShell sees as a variable, a subexpression or the like
        expect(scanCommand(command, "powershell").ok, command).toBe(false);
      }
    });
  },
);

it("is documented as skipped off Windows", () => {
  expect(typeof POWERSHELL === "string" || POWERSHELL === undefined).toBe(true);
});
