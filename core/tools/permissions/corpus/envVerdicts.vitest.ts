import { describe, expect, it } from "vitest";
import type { ShellKind } from "../../../util/shell";
import { envAssignmentHit } from "../envAssignments";
import { ENV_CASES } from "./envVerdicts";
import { keyOf, scan } from "./verdictHarness";

/**
 * The labelled environment-assignment cases (envVerdicts.ts): what the
 * assignment scan says, that no case is vouched as read-only unless it is one,
 * and that a rule written as text still sees the program after the
 * assignments.
 */
const rows = ENV_CASES.flatMap((k) =>
  k.shells.map((shell) => [shell, k] as const),
);

describe("the environment-assignment corpus", () => {
  it("has no command twice for the same shell", () => {
    const seen = new Set<string>();
    for (const [shell, k] of rows) {
      const key = keyOf(shell, k);
      expect(seen.has(key), `${key} is listed twice`).toBe(false);
      seen.add(key);
    }
  });

  it("covers every shell family and every label", () => {
    for (const shell of ["bash", "powershell", "cmd"] as ShellKind[]) {
      expect(rows.filter(([s]) => s === shell).length).toBeGreaterThan(10);
    }
    for (const env of ["dangerous", "sensitive", "none"]) {
      expect(ENV_CASES.filter((k) => k.env === env).length).toBeGreaterThan(8);
    }
  });

  it("the scan says what each case is labelled", () => {
    const wrong = rows
      .filter(([shell, k]) => {
        const hit = envAssignmentHit(k.command, shell);
        return (hit?.severity ?? "none") !== k.env;
      })
      .map(([shell, k]) => `${keyOf(shell, k)} (wanted ${k.env})`);
    expect(wrong).toEqual([]);
  });

  it("never vouches for a command with an environment prefix, unless it only reads", () => {
    const unsound = rows
      .filter(([shell, k]) => scan(k, shell).vouched && k.verdict !== "reads")
      .map(([shell, k]) => `${keyOf(shell, k)} (${k.verdict}: ${k.why})`);
    expect(unsound).toEqual([]);
  });

  it("a rule written as text sees the program after the assignments", () => {
    const gaps = rows
      .filter(([shell, k]) => k.resolves && !scan(k, shell).resolvesOk)
      .map(([shell, k]) => `${keyOf(shell, k)} (wanted ${k.resolves})`);
    expect(gaps).toEqual([]);
  });

  it("the reason never holds a value", () => {
    for (const [shell, k] of rows) {
      const hit = envAssignmentHit(k.command, shell);
      if (!hit) continue;
      expect(hit.reason).toContain(hit.name === "?" ? "name" : hit.name);
      expect(hit.reason).not.toMatch(/\/tmp|C:\/|http:|--require|evil/);
    }
  });
});
