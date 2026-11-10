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
 * The recovery lives in packages/openai-adapters. It is loaded by absolute path
 * at run time, not imported, so core's tsc program (and the dist layout the CLI
 * resolves `core/*` against) does not grow to include another package. Core
 * must not depend on the adapters package.
 */
const QWEN_XML = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/qwenXml.ts",
);
type RecoveryClass = new (tools: unknown[]) => Recovery;
let QwenXmlRecovery: RecoveryClass;

/** The Qwen XML recovery, as a corpus parser. */
const qwenXml: CorpusParser = ({ chunks, tools }) => {
  const parser = new QwenXmlRecovery(tools);
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

/**
 * Wanted recoveries the parser does not make today. Each is a finding, not an
 * accepted behaviour. Empty since the parser began choosing a closing tag by
 * structure (a value may quote `</function>` or `</parameter>`); when a new
 * gap is found it goes here and the test says so when it is fixed.
 */
const KNOWN_SHOULD_GAPS: string[] = [];

describe("QwenXmlRecovery against the corpus", () => {
  let report: ReturnType<typeof runCorpus>;

  beforeAll(async () => {
    const loaded = (await import(/* @vite-ignore */ QWEN_XML)) as {
      QwenXmlRecovery: RecoveryClass;
    };
    QwenXmlRecovery = loaded.QwenXmlRecovery;
    report = runCorpus(qwenXml, {
      dialects: ["qwen-xml"],
      negativesFromAllDialects: true,
    });
  });

  it("runs every stream of the qwen-xml fixtures and every negative", () => {
    expect(report.results.length).toBeGreaterThan(150);
    expect(report.summary.skipped).toBe(0);
  });

  it("gets every must case right, under every chunking", () => {
    expect(failures(report, "must")).toEqual([]);
  });

  it("gives the same answer however the text is chunked", () => {
    expect(report.chunkSensitive).toEqual([]);
  });

  it("recovers the missing-opener calls reported on Ollama, llama.cpp and vLLM", () => {
    const missing = report.results.filter((r) =>
      /missing-open|ollama-1[68]|llamacpp-30118|hf-discussion-19|roo-12185/.test(
        r.fixture,
      ),
    );
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.filter((r) => r.outcome === "fail")).toEqual([]);
  });

  it("misses exactly the known should cases", () => {
    expect(failures(report, "should").map((f) => f.fixture)).toEqual(
      KNOWN_SHOULD_GAPS,
    );
  });
});
