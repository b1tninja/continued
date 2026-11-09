import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../../util/shell";
import { keyOf, scan } from "./verdictHarness";
import { casesFor, VERDICT_CASES } from "./verdicts";

const SHELLS: ShellKind[] = ["bash", "zsh", "sh", "powershell", "cmd"];

/**
 * Where a scanner disagrees with what is true of a command (plans/command-analysis.md,
 * P0). The first list must stay empty: a scanner that vouches for a command that
 * is not read-only is a bug. The others are known gaps, kept exact so that a fix
 * flips a test and a regression shows as a new entry. Each is a target of a
 * later step of the plan: P2 (a POSIX parser), P3 (PowerShell), P4 (cmd), P7
 * (wrappers).
 */
const KNOWN_PROTECT_GAPS: string[] = [];
const KNOWN_RESOLVE_GAPS: string[] = [];

describe("the corpus", () => {
  it("has at least 50 cases for each of bash, zsh, PowerShell and cmd", () => {
    for (const shell of ["bash", "zsh", "powershell", "cmd"] as const) {
      expect(casesFor(shell).length).toBeGreaterThanOrEqual(50);
    }
  });

  it("has no command twice for the same shell", () => {
    const seen = new Set<string>();
    for (const shell of SHELLS) {
      for (const k of casesFor(shell)) {
        const key = keyOf(shell, k);
        expect(seen.has(key), `${key} is listed twice`).toBe(false);
        seen.add(key);
      }
    }
  });

  it("every case says why", () => {
    for (const k of VERDICT_CASES) expect(k.why.length).toBeGreaterThan(0);
  });
});

describe("the read-only classifier", () => {
  it.each(SHELLS)(
    "never vouches for a command that is not read-only (%s)",
    (shell) => {
      const unsound = casesFor(shell)
        .filter((k) => scan(k, shell).vouched && k.verdict !== "reads")
        .map((k) => `${keyOf(shell, k)}  (${k.verdict}: ${k.why})`);
      expect(unsound).toEqual([]);
    },
  );

  it("vouches for most of the plain reads in each shell it parses", () => {
    const rates = Object.fromEntries(
      (["bash", "zsh", "sh", "powershell"] as const).map((shell) => {
        const reads = casesFor(shell).filter((k) => k.verdict === "reads");
        const vouched = reads.filter((k) => scan(k, shell).vouched);
        return [shell, vouched.length / reads.length];
      }),
    );
    for (const rate of Object.values(rates)) {
      expect(rate).toBeGreaterThan(0.5);
    }
  });

  it("in cmd vouches only for cmd's own commands", () => {
    const own = new Set([
      "dir",
      "type",
      "cd",
      "chdir",
      "echo",
      "ver",
      "vol",
      "path",
      "set",
    ]);
    const vouchedNames = casesFor("cmd")
      .filter((k) => scan(k, "cmd").vouched)
      .map((k) => k.command.split(" ")[0].toLowerCase());
    expect(vouchedNames.length).toBeGreaterThan(5);
    for (const name of vouchedNames) expect(own.has(name), name).toBe(true);
  });
});

describe("the protected-path scan", () => {
  it("finds what the corpus says it should, apart from the known gaps", () => {
    const gaps = new Set<string>();
    for (const shell of SHELLS) {
      for (const k of casesFor(shell)) {
        if (!k.protects) continue;
        if (scan(k, shell).protectsFound !== k.protects) {
          gaps.add(
            `${keyOf(shell, k)}  (wanted ${k.protects}, found ${scan(k, shell).protectsFound})`,
          );
        }
      }
    }
    expect([...gaps].sort()).toEqual([...KNOWN_PROTECT_GAPS].sort());
  });
});

describe("the text a deny or ask rule is tried against", () => {
  it("names the resolved program and subcommand, apart from the known gaps", () => {
    const gaps = new Set<string>();
    for (const shell of SHELLS) {
      for (const k of casesFor(shell)) {
        if (!k.resolves) continue;
        if (!scan(k, shell).resolvesOk) {
          gaps.add(`${keyOf(shell, k)}  (wanted ${k.resolves})`);
        }
      }
    }
    expect([...gaps].sort()).toEqual([...KNOWN_RESOLVE_GAPS].sort());
  });
});
