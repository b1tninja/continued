import { describe, expect, it } from "vitest";
import { loadCorpus } from "../llm/toolDialects/corpus/corpus";
import {
  detectToolDialectLeak,
  isLeakedToolCall,
  leakHintText,
  leakNoticeText,
  providerRecoversText,
} from "./toolDialectLeak";

const corpus = new Map(loadCorpus().map((f) => [f.id, f]));
const text = (id: string) => corpus.get(id)!.text;

describe("detectToolDialectLeak", () => {
  it("sees Hermes JSON and GLM markup written as text", () => {
    expect(
      detectToolDialectLeak({ content: text("hermes-canonical") }),
    ).toEqual({ dialect: "hermes-json" });
    expect(detectToolDialectLeak({ content: text("glm47-canonical") })).toEqual(
      { dialect: "glm-xml" },
    );
  });

  it("sees Harmony, Mistral and DeepSeek calls written as text", () => {
    for (const [id, dialect] of [
      ["harmony-commentary-call", "harmony"],
      ["mistral-v3-tool-calls-json", "mistral"],
      ["devstral-args-marker", "mistral"],
      ["deepseek-v32-dsml-canonical", "dsml"],
      ["deepseek-v4-dsml-tool-calls-block", "dsml"],
      ["deepseek-v31-canonical", "deepseek-v31"],
    ] as const) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toEqual({
        dialect,
      });
    }
  });

  it("sees the Kimi and MiniMax forms written as text", () => {
    for (const [id, dialect] of [
      ["kimi-k2-canonical", "kimi-tokens"],
      ["kimi-k3-canonical", "kimi-xtml"],
      ["minimax-m2-canonical", "minimax-xml"],
      ["minimax-m3-canonical", "minimax-ns-xml"],
    ] as const) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toEqual({
        dialect,
      });
    }
  });

  it("does not offer recovery for a fenced Kimi K3 or MiniMax M3 example", () => {
    for (const id of [
      "neg-kimi-k3-fenced-example",
      "neg-minimax-m3-fenced-example",
    ]) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toBeUndefined();
    }
  });

  it("sees the Group C forms written as text", () => {
    for (const [id, dialect] of [
      ["granite-canonical", "granite-tokens"],
      ["lfm-canonical", "lfm-tokens"],
      ["hy3-canonical", "hy3-tags"],
      ["solar-canonical", "solar-tokens"],
      ["longcat-canonical", "longcat-json"],
      ["olmo-canonical", "olmo-function-calls"],
      ["seed-canonical", "seed-xml"],
      ["cohere-canonical", "cohere-action"],
    ] as const) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toEqual({
        dialect,
      });
    }
  });

  it("does not offer recovery for a fenced Kimi K3 or MiniMax M3 example", () => {
    for (const id of [
      "neg-kimi-k3-fenced-example",
      "neg-minimax-m3-fenced-example",
    ]) {
      expect(detectToolDialectLeak({ content: text(id) }), id).toBeUndefined();
    }
  });

  it("sees qwen markup written as text", () => {
    expect(
      detectToolDialectLeak({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
      }),
    ).toEqual({ dialect: "qwen-xml" });
  });

  it("ignores markup inside a code fence or inline code", () => {
    for (const id of [
      "neg-fenced-example-qwen-call",
      "neg-prose-mentions-qwen-tags",
    ]) {
      expect(detectToolDialectLeak({ content: text(id) })).toBeUndefined();
    }
  });

  it("ignores a reply that also has structured calls", () => {
    expect(
      detectToolDialectLeak({
        content: "ok",
        toolCalls: [{ id: "1", name: "read", arguments: "{}" }],
      }),
    ).toBeUndefined();
  });

  it("stays quiet once toolDialect is set, except auto", () => {
    const content = text("qwen3-coder-30b-bedrock-function-xml-as-text");
    expect(detectToolDialectLeak({ content, current: "off" })).toBeUndefined();
    expect(detectToolDialectLeak({ content, current: "auto" })).toBeDefined();
  });

  it("covers Bedrock and the OpenAI-compatible adapter, and words the notice as agreed", () => {
    expect(providerRecoversText("bedrock")).toBe(true);
    expect(providerRecoversText("openai")).toBe(true);
    expect(providerRecoversText("lmstudio")).toBe(true);
    expect(providerRecoversText("anthropic")).toBe(false);
    expect(providerRecoversText(undefined)).toBe(false);
    // Ollama's IDE path is native chat; the CLI goes through the adapter.
    expect(providerRecoversText("ollama")).toBe(false);
    expect(providerRecoversText("ollama", "cli")).toBe(true);
    expect(leakNoticeText("qwen-xml")).toBe(
      "This model typed a tool request as plain text, so it did not run. Let Continue read that format for this model?",
    );
    expect(leakHintText("m", "qwen-xml")).toContain("toolDialect: qwen-xml");
  });
});

/** Failure modes of a negative that is still a call written as text. */
const DECLINED_CALL = new Set([
  "argument-type-mismatch",
  "malformed",
  "truncated",
  "prose-around-call",
  "undeclared-argument",
  "one-bad-call",
  "string-arguments",
  "bad-constrain",
]);

describe("isLeakedToolCall", () => {
  const tools = (id: string) => corpus.get(id)!.tools.map((t) => t.name);
  const leak = (id: string, extra?: { toolCalls?: never }) =>
    isLeakedToolCall({
      content: text(id),
      knownTools: tools(id),
      ...extra,
    });

  it("counts the shapes that models write as text", () => {
    for (const id of [
      "qwen3-coder-30b-bedrock-function-xml-as-text",
      "qwen3-coder-canonical",
      "hermes-canonical",
      "glm47-canonical",
      "llama33-bedrock-json-text-single",
      "nova-python-call-syntax",
      "deepseek-v32-dsml-canonical",
      "mistral-v3-tool-calls-json",
      "devstral-args-marker",
      "harmony-commentary-call",
      "deepseek-v31-canonical",
      "llama3-python-tag-builtin",
      "granite-canonical",
      "lfm-canonical",
      "hy3-canonical",
      "solar-canonical",
      "longcat-canonical",
      "olmo-canonical",
      "seed-canonical",
      "cohere-canonical",
    ]) {
      expect(leak(id), id).toBe(true);
    }
  });

  it("does not count negatives, fenced examples or inline mentions", () => {
    for (const f of corpus.values()) {
      if (!f.id.startsWith("neg-")) continue;
      // Recovery leaves a malformed or refused call as text, but it is still
      // a call written as text, so the nudge applies (next test).
      if (DECLINED_CALL.has(f.failureMode)) continue;
      expect(leak(f.id), f.id).toBe(false);
    }
  });

  it("counts a malformed, truncated or partly bad call: strict recovery declines it, the nudge does not", () => {
    for (const f of corpus.values()) {
      if (!f.id.startsWith("neg-") || !DECLINED_CALL.has(f.failureMode)) {
        continue;
      }
      // The TOOLCALL form has no fingerprint in the classifier yet.
      if (f.dialect === "toolcall-json") continue;
      expect(leak(f.id), f.id).toBe(true);
    }
  });

  it("counts a call whose argument has the wrong type: recovery declines it, the nudge does not", () => {
    for (const f of corpus.values()) {
      if (f.failureMode !== "argument-type-mismatch") continue;
      expect(leak(f.id), f.id).toBe(true);
    }
  });

  it("counts a call that recovery declined because prose came before or after it (Q28): the turn must not end silently", () => {
    const declined = [...corpus.values()].filter((f) =>
      f.provenance.note.includes("Declined by owner rule"),
    );
    expect(declined.length).toBeGreaterThan(5);
    // Not every declined dialect is classified by the nudge yet (the Kimi,
    // DeepSeek V3.1 and Harmony shapes); the ones that are must stay counted.
    const counted = declined.filter((f) => leak(f.id));
    for (const id of [
      "qwen3-coder-prose-then-call",
      "qwen3-coder-prose-after-call",
      "qwen3-coder-two-calls-with-prose-between",
      "qwen3-coder-missing-open-tag-ollama-16686",
      "qwen3-coder-30b-bedrock-function-xml-as-text",
      "mistral-v3-parallel-and-prose",
    ]) {
      expect(
        counted.map((f) => f.id),
        id,
      ).toContain(id);
    }
  });

  it("counts a declined call of the Kimi, DeepSeek and Harmony shapes, whose tool name follows `functions.` or a separator", () => {
    const declined: [string, (t: string) => string][] = [
      // truncated, undeclared argument, prose around: recovery refuses each.
      ["kimi-k2-canonical", (t) => t.slice(0, t.length - 12)],
      ["kimi-k2-canonical", (t) => `Reading it. ${t}`],
      ["harmony-commentary-call", (t) => t.slice(0, t.length - 8)],
      ["harmony-commentary-call", (t) => `${t} Done.`],
      ["deepseek-v32-dsml-canonical", (t) => `Sure.\n\n${t}`],
      ["deepseek-v32-dsml-canonical", (t) => t.slice(0, t.length - 20)],
      ["deepseek-v31-canonical", (t) => `Sure. ${t}`],
      ["deepseek-v31-canonical", (t) => t.slice(0, t.length - 30)],
    ];
    for (const [id, make] of declined) {
      const content = make(text(id));
      expect(
        isLeakedToolCall({ content, knownTools: tools(id) }),
        `${id}: ${content}`,
      ).toBe(true);
    }
  });

  it("needs a tool that was actually offered", () => {
    expect(
      isLeakedToolCall({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
        knownTools: ["something_else"],
      }),
    ).toBe(false);
    expect(
      isLeakedToolCall({
        content: text("qwen3-coder-30b-bedrock-function-xml-as-text"),
      }),
    ).toBe(false);
  });

  it("does not count a reply that also made a structured call", () => {
    expect(
      isLeakedToolCall({
        content: text("qwen3-coder-canonical"),
        knownTools: tools("qwen3-coder-canonical"),
        toolCalls: [{ name: "read", arguments: "{}" }],
      }),
    ).toBe(false);
  });

  it("does not count plain prose", () => {
    expect(
      isLeakedToolCall({
        content: "Let me read the file next.",
        knownTools: ["read"],
      }),
    ).toBe(false);
  });
});
