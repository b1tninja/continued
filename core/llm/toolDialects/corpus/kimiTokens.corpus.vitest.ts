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
const KIMITOKENS = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/kimiTokens.ts",
);
type RecoveryClass = new (tools: unknown[]) => Recovery;
let KimiTokensRecovery: RecoveryClass;

/**
 * Fixtures written for a looser reading than this parser takes (strict: the whole
 * reply is calls, after an optional think block). They stay in the corpus for
 * other parsers.
 */
const NOT_STRICT: Record<string, string> = {
  "kimi-k2-parallel":
    "prose before the section; this parser refuses a reply that is not only the section",
};

const kimiTokens: CorpusParser = ({ chunks, tools }) => {
  const parser = new KimiTokensRecovery(tools);
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

describe("KimiTokensRecovery against the corpus", () => {
  let report: ReturnType<typeof runCorpus>;

  beforeAll(async () => {
    const loaded = (await import(/* @vite-ignore */ KIMITOKENS)) as {
      KimiTokensRecovery: RecoveryClass;
    };
    KimiTokensRecovery = loaded.KimiTokensRecovery;
    report = runCorpus(kimiTokens, {
      dialects: ["kimi-tokens"],
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
