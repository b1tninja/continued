import path from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";

import {
  dialectArms,
  dialectArmsLines,
  fillFromState,
  readJson,
  recoveredCalls,
} from "../src/common.mjs";

/**
 * Tier 0 of the model benchmark: the leak and recovery columns per dialect
 * arm (the runner's --dialect option), on fixture histories. The histories are
 * shaped like the logged ones (a leaked Qwen reply with no call; calls the
 * adapter made from text, whose ids begin `recovered_`), not captured output.
 *
 * Run from extensions/cli: npx vitest run --dir ../../bench/tier0
 */
const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const history = (name: string) =>
  readJson(path.join(fixtures, `dialect-history-${name}.json`));

describe("recovered calls in a history", () => {
  it("counts the calls with a recovered id and no others", () => {
    expect(recoveredCalls(history("recovered"))).toBe(2);
    expect(recoveredCalls(history("leaked"))).toBe(0);
    expect(recoveredCalls(undefined)).toBe(0);
  });

  it("fills a result with both counts", () => {
    const leaked = fillFromState(
      {},
      { session: { history: history("leaked") } },
      {},
    );
    expect(leaked.textLeaks).toHaveLength(1);
    expect(leaked.recovered).toBe(0);
    const fixed = fillFromState(
      {},
      { session: { history: history("recovered") } },
      {},
    );
    expect(fixed.textLeaks).toEqual([]);
    expect(fixed.recovered).toBe(2);
  });
});

describe("dialectArms", () => {
  const record = (dialect: string | undefined, over: object = {}) => ({
    modelRow: "qwen3coder",
    dialect,
    textLeaks: 0,
    recovered: 0,
    ...over,
  });

  it("makes one arm per model row and dialect, with n, totals and run counts", () => {
    const arms = dialectArms([
      record("off", { textLeaks: 2 }),
      record("off", { textLeaks: 1 }),
      record("off"),
      record("qwen-xml", { recovered: 3 }),
      record("qwen-xml"),
      { ...record("off"), modelRow: "nova2lite", textLeaks: 4 },
    ]);
    expect(arms).toEqual([
      {
        modelRow: "nova2lite",
        dialect: "off",
        n: 1,
        textLeaks: 4,
        runsWithLeak: 1,
        recovered: 0,
        runsWithRecovered: 0,
      },
      {
        modelRow: "qwen3coder",
        dialect: "off",
        n: 3,
        textLeaks: 3,
        runsWithLeak: 2,
        recovered: 0,
        runsWithRecovered: 0,
      },
      {
        modelRow: "qwen3coder",
        dialect: "qwen-xml",
        n: 2,
        textLeaks: 0,
        runsWithLeak: 0,
        recovered: 3,
        runsWithRecovered: 1,
      },
    ]);
  });

  it("puts records without a dialect (older folders) in an unset arm", () => {
    expect(dialectArms([record(undefined)])[0]).toMatchObject({
      dialect: "unset",
      n: 1,
    });
  });

  it("renders a table with n in every row, or nothing for no records", () => {
    const lines = dialectArmsLines([
      record("off", { textLeaks: 2 }),
      record("qwen-xml", { recovered: 1 }),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("| qwen3coder | off | 1 | 2 (1 of 1) | 0 (0 of 1) |");
    expect(lines[3]).toBe(
      "| qwen3coder | qwen-xml | 1 | 0 (0 of 1) | 1 (1 of 1) |",
    );
    expect(dialectArmsLines([])).toEqual([]);
  });
});
