import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
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
const GLMXML = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/glmXml.ts",
);
type RecoveryClass = new (tools: unknown[]) => Recovery;
let GlmXmlRecovery: RecoveryClass;

const glmXml: CorpusParser = ({ chunks, tools }) => {
  const parser = new GlmXmlRecovery(tools);
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

describe("GlmXmlRecovery against the corpus", () => {
  let report: ReturnType<typeof runCorpus>;

  beforeAll(async () => {
    const loaded = (await import(/* @vite-ignore */ GLMXML)) as {
      GlmXmlRecovery: RecoveryClass;
    };
    GlmXmlRecovery = loaded.GlmXmlRecovery;
    report = runCorpus(glmXml, {
      dialects: ["glm-xml"],
      negativesFromAllDialects: true,
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
