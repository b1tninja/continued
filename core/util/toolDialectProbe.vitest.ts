import { describe, expect, it } from "vitest";
import { loadCorpus } from "../llm/toolDialects/corpus/corpus";
import { PROBE_TEXTS, PROBE_TOOL_NAME } from "./toolDialectDetect";
import { probeToolDialect } from "./toolDialectProbe";

const corpus = new Map(loadCorpus().map((f) => [f.id, f]));
const text = (id: string) => corpus.get(id)!.text;

const probe = (reply: Parameters<typeof probeToolDialect>[0]) =>
  probeToolDialect(reply).then((r) => r.label);

const good = [
  {
    id: "a",
    name: PROBE_TOOL_NAME,
    arguments: JSON.stringify({ text: PROBE_TEXTS[0], count: 1 }),
  },
  {
    id: "b",
    name: PROBE_TOOL_NAME,
    arguments: JSON.stringify({ text: PROBE_TEXTS[1], count: 2 }),
  },
];

describe("tool-call probe result line", () => {
  it("sends one request with the fake tool at temperature 0", async () => {
    const seen: any[] = [];
    await probeToolDialect(async (req) => {
      seen.push(req);
      return { content: "ok" };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].params.temperature).toBe(0);
    expect(seen[0].tools.map((t: any) => t.function.name)).toEqual([
      PROBE_TOOL_NAME,
    ]);
  });

  it("native: structured calls", async () => {
    expect(await probe(async () => ({ content: "", toolCalls: good }))).toBe(
      "Tool calls: native",
    );
  });

  it("native with altered arguments says so", async () => {
    const bad = [{ ...good[0], arguments: '{"text":"say hi","count":1}' }];
    expect(await probe(async () => ({ content: "", toolCalls: bad }))).toBe(
      "Tool calls: native (arguments came back altered)",
    );
  });

  it("written as text (qwen-xml), from the corpus golden text", async () => {
    expect(
      await probe(async () => ({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
      })),
    ).toBe("Tool calls: written as text (qwen-xml)");
  });

  it("written as text (pythonic) when the name is the probe tool", async () => {
    expect(
      await probe(async () => ({
        content: `[${PROBE_TOOL_NAME}(text="x", count=1)]`,
      })),
    ).toBe("Tool calls: written as text (pythonic)");
  });

  it("not supported: plain prose", async () => {
    expect(
      await probe(async () => ({ content: "I cannot call tools, sorry." })),
    ).toBe("Tool calls: not supported");
  });

  it("not supported: the server refuses the tools parameter", async () => {
    expect(
      await probe(async () => {
        throw new Error("This model doesn't support tool use");
      }),
    ).toBe("Tool calls: not supported");
  });

  it("unknown: empty reply, advisory markup, timeout, other errors", async () => {
    expect(await probe(async () => ({ content: "" }))).toBe(
      "Tool calls: unknown",
    );
    expect(
      await probe(async () => ({ content: text("llama3-json-canonical") })),
    ).toBe("Tool calls: unknown");
    expect(
      await probe(async () => {
        throw new Error("timeout");
      }),
    ).toBe("Tool calls: unknown");
  });

  it("a mention inside a code fence is not a dialect", async () => {
    expect(
      await probe(async () => ({
        content: text("neg-fenced-example-qwen-call"),
      })),
    ).toBe("Tool calls: not supported");
  });
});
