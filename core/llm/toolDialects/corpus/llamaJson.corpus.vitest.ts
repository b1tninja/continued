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
const LLAMA_JSON = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/llamaJson.ts",
);
type RecoveryClass = new (tools: unknown[]) => Recovery;
let LlamaJsonRecovery: RecoveryClass;

const llamaJson: CorpusParser = ({ chunks, tools }) => {
  const parser = new LlamaJsonRecovery(tools);
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

describe("LlamaJsonRecovery against the corpus", () => {
  let report: ReturnType<typeof runCorpus>;

  beforeAll(async () => {
    const loaded = (await import(/* @vite-ignore */ LLAMA_JSON)) as {
      LlamaJsonRecovery: RecoveryClass;
    };
    LlamaJsonRecovery = loaded.LlamaJsonRecovery;
    report = runCorpus(llamaJson, {
      dialects: ["llama-json"],
      negativesFromAllDialects: true,
    });
  });

  it("gets every must case right, under every chunking", () => {
    expect(failures(report, "must")).toEqual([]);
    expect(report.chunkSensitive).toEqual([]);
  });

  it("recovers the calls Bedrock returned as text on 2026-11-10", () => {
    const live = report.results.filter((r) =>
      /^llama33-bedrock-json-(text-single|array-of-strings)$/.test(r.fixture),
    );
    expect(live.length).toBeGreaterThanOrEqual(6);
    expect(live.filter((r) => r.outcome !== "pass")).toEqual([]);
  });

  it("makes the integer of the Llama 3.3 call that sent a string (Q16, opt-in)", () => {
    const live = report.results.filter(
      (r) => r.fixture === "llama33-bedrock-json-integer-as-string",
    );
    expect(live.length).toBeGreaterThanOrEqual(3);
    expect(live.filter((r) => r.outcome !== "pass")).toEqual([]);
  });

  it("leaves the live replies that are not valid calls as text", () => {
    const refused = report.results.filter((r) =>
      /wrapped-values|^neg-llama-json-/.test(r.fixture),
    );
    expect(refused.length).toBeGreaterThanOrEqual(15);
    expect(refused.filter((r) => r.outcome === "fail")).toEqual([]);
  });

  it("keeps the digits of a string parameter a string", () => {
    const kept = report.results.filter(
      (r) => r.fixture === "llama33-json-string-param-keeps-digits",
    );
    expect(kept.length).toBeGreaterThanOrEqual(3);
    expect(kept.filter((r) => r.outcome !== "pass")).toEqual([]);
  });
});
