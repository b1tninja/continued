import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus";
import { failures, runCorpus, type CorpusParser } from "./runCorpus";

type RecoveryEvent =
  | { type: "text"; text: string }
  | {
      type: "call";
      call: { name: string; arguments: Record<string, unknown> };
    };
interface Recovery {
  push(chunk: string): RecoveryEvent[];
  end(): RecoveryEvent[];
}

/**
 * The recovery lives in packages/openai-adapters and is loaded by absolute
 * path at run time, as qwenXml.corpus.vitest.ts does: core must not depend on
 * the adapters package.
 */
const MINIMAXXML = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/minimaxXml.ts",
);
type RecoveryClass = new (tools: unknown[]) => Recovery;
let MinimaxXmlRecovery: RecoveryClass;

/**
 * Fixtures written for a looser reading than this parser takes (strict: the whole
 * reply is calls, after an optional think block). They stay in the corpus for
 * other parsers.
 */
const NOT_STRICT: Record<string, string> = {
  "minimax-m2-think-then-call":
    "reasoning that ends with a bare close tag has no opening marker to hold the reply on",
};

const minimaxXml: CorpusParser = ({ chunks, tools }) => {
  const parser = new MinimaxXmlRecovery(tools);
  const events = chunks.flatMap((c) => parser.push(c));
  events.push(...parser.end());
  return {
    calls: events.flatMap((e) =>
      e.type === "call"
        ? [{ name: e.call.name, arguments: e.call.arguments }]
        : [],
    ),
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
  };
};

describe("MinimaxXmlRecovery against the corpus", () => {
  let report: ReturnType<typeof runCorpus>;

  beforeAll(async () => {
    const loaded = (await import(/* @vite-ignore */ MINIMAXXML)) as {
      MinimaxXmlRecovery: RecoveryClass;
    };
    MinimaxXmlRecovery = loaded.MinimaxXmlRecovery;
    report = runCorpus(minimaxXml, {
      dialects: ["minimax-xml"],
      negativesFromAllDialects: true,
      fixtures: loadCorpus().filter((f) => !(f.id in NOT_STRICT)),
    });
  });

  it("gets every must case right, under every chunking", () => {
    expect(failures(report, "must")).toEqual([]);
    expect(report.chunkSensitive).toEqual([]);
  });

  it("recovers the should cases too", () => {
    expect(failures(report, "should")).toEqual([]);
  });
});
