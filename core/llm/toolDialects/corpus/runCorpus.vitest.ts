import { describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus";
import {
  diffResult,
  failures,
  runCorpus,
  type CorpusParser,
} from "./runCorpus";

describe("runCorpus", () => {
  const corpus = loadCorpus();

  it("passes a parser that returns each fixture's expected result", () => {
    const oracle: CorpusParser = ({ fixture }) => fixture.expected;
    const report = runCorpus(oracle);
    expect(report.summary.must.fail + report.summary.should.fail).toBe(0);
    expect(report.summary.either.fail).toBe(0);
    expect(report.results.length).toBe(
      corpus.reduce((n, f) => n + f.streams.length, 0),
    );
  });

  it("reports a parser that finds nothing as failing every positive", () => {
    const blind: CorpusParser = ({ fixture }) => ({
      calls: [],
      text: fixture.text,
    });
    const report = runCorpus(blind);
    const positives = corpus.filter(
      (f) => f.kind === "positive" && f.policy === "must",
    );
    expect(failures(report, "must").map((f) => f.fixture)).toEqual(
      positives.map((f) => f.id),
    );
  });

  it("flags a parser whose answer depends on the chunking", () => {
    const fussy: CorpusParser = ({ chunks, fixture }) =>
      chunks.length > 1
        ? { calls: [], text: "" }
        : { calls: fixture.expected.calls, text: fixture.expected.text };
    const report = runCorpus(fussy);
    expect(report.chunkSensitive.length).toBeGreaterThan(0);
  });

  it("skips fixtures the parser declines and filters by dialect", () => {
    const decline: CorpusParser = () => undefined;
    const report = runCorpus(decline, { dialects: ["harmony"] });
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.summary.skipped).toBe(report.results.length);
    expect(report.results.every((r) => r.fixture.includes("harmony"))).toBe(
      true,
    );
  });

  it("describes a difference and nothing for a match", () => {
    const a = { calls: [{ name: "x", arguments: { b: 1, a: 2 } }], text: "t" };
    expect(
      diffResult(a, {
        calls: [{ name: "x", arguments: { a: 2, b: 1 } }],
        text: "t",
      }),
    ).toBeUndefined();
    expect(diffResult(a, { calls: [], text: "t" })).toContain("calls:");
  });
});
