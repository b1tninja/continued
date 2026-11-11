import * as path from "node:path";
import { describe, expect, it } from "vitest";
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
type RecoveryClass = new (tools: unknown[]) => Recovery;

const DIALECT_DIR = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects",
);

/**
 * The Harmony, Mistral, DeepSeek and Llama (pythonic) recoveries live in
 * packages/openai-adapters and are loaded by absolute path at run time, as
 * qwenXml.corpus.vitest.ts does: core must not depend on the adapters package.
 */
const DIALECTS: {
  file: string;
  className: string;
  /** The corpus dialect names this parser is scored against. */
  dialects: string[];
  /** should-fixtures this parser declines on purpose, with the reason. */
  declines?: Record<string, string>;
}[] = [
  { file: "harmony.ts", className: "HarmonyRecovery", dialects: ["harmony"] },
  {
    file: "mistral.ts",
    className: "MistralRecovery",
    dialects: ["mistral"],
  },
  { file: "dsml.ts", className: "DsmlRecovery", dialects: ["dsml"] },
  {
    file: "deepseekV31.ts",
    className: "DeepseekV31Recovery",
    dialects: ["deepseek-v31"],
  },
  {
    file: "deepseekR1.ts",
    className: "DeepseekR1Recovery",
    dialects: ["deepseek-r1"],
  },
  {
    file: "pythonic.ts",
    className: "PythonicRecovery",
    dialects: ["pythonic"],
    declines: {
      "pythonic-raw-newline-in-string-vllm-61954":
        "a raw newline inside a quoted string is refused on purpose (pythonic.ts)",
    },
  },
];

describe.each(DIALECTS)("$className against the corpus", (d) => {
  let report: ReturnType<typeof runCorpus>;
  let Recovery: RecoveryClass;

  const parser: CorpusParser = ({ chunks, tools }) => {
    const parse = new Recovery(tools);
    const events = chunks.flatMap((c) => parse.push(c));
    events.push(...parse.end());
    return {
      calls: events.flatMap((e) =>
        e.type === "call"
          ? [{ name: e.call.name, arguments: e.call.arguments }]
          : [],
      ),
      text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    };
  };

  it("gets every must case right, under every chunking, and recovers the should cases", async () => {
    const loaded = (await import(
      /* @vite-ignore */ path.join(DIALECT_DIR, d.file)
    )) as Record<string, RecoveryClass>;
    Recovery = loaded[d.className];
    report = runCorpus(parser, {
      dialects: d.dialects,
      negativesFromAllDialects: true,
    });
    expect(failures(report, "must")).toEqual([]);
    expect(report.chunkSensitive).toEqual([]);
    expect(
      failures(report, "should").filter(
        (f) => !(f.fixture in (d.declines ?? {})),
      ),
    ).toEqual([]);
    expect(report.summary.must.pass).toBeGreaterThan(0);
  });
});
