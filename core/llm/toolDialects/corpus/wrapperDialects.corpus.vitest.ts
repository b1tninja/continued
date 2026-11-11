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
interface Row {
  dialect: string;
}
interface Module {
  WRAPPER_ROWS: Row[];
  WrapperRecovery: new (tools: unknown[], row: Row) => Recovery;
}

/**
 * The wrapper dialects live in packages/openai-adapters and are loaded by
 * absolute path at run time, as qwenXml.corpus.vitest.ts does: core must not
 * depend on the adapters package.
 */
const MODULE = path.resolve(
  __dirname,
  "../../../../packages/openai-adapters/src/dialects/wrapperDialects.ts",
);

let mod: Module;

function parserFor(row: Row): CorpusParser {
  return ({ chunks, tools }) => {
    const parser = new mod.WrapperRecovery(tools, row);
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
}

const DIALECTS = [
  "granite-tokens",
  "lfm-tokens",
  "hy3-tags",
  "solar-tokens",
  "longcat-json",
  "olmo-function-calls",
  "seed-xml",
  "cohere-action",
];

describe("the wrapper dialects against the corpus", () => {
  beforeAll(async () => {
    mod = (await import(/* @vite-ignore */ MODULE)) as Module;
  });

  it("has a row for every dialect under test", () => {
    expect(mod.WRAPPER_ROWS.map((r) => r.dialect)).toEqual(DIALECTS);
  });

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      let report: ReturnType<typeof runCorpus>;
      beforeAll(() => {
        const row = mod.WRAPPER_ROWS.find((r) => r.dialect === dialect)!;
        report = runCorpus(parserFor(row), {
          dialects: [dialect],
          negativesFromAllDialects: true,
        });
      });

      it("has positives and negatives of its own", () => {
        const own = report.results.filter((r) => r.outcome !== "skipped");
        expect(own.length).toBeGreaterThan(20);
      });

      it("gets every must case right, under every chunking", () => {
        expect(failures(report, "must")).toEqual([]);
        expect(report.chunkSensitive).toEqual([]);
      });

      it("recovers the should cases too", () => {
        expect(failures(report, "should")).toEqual([]);
      });
    });
  }
});
