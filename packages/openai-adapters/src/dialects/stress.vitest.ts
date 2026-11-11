import { describe, expect, it } from "vitest";
import { recoverGlmXmlFromText, renderGlmXmlCall } from "./glmXml.js";
import {
  recoverHermesJsonFromText,
  renderHermesJsonCall,
} from "./hermesJson.js";
import {
  recoverKimiTokensFromText,
  renderKimiTokensCalls,
} from "./kimiTokens.js";
import { recoverKimiXtmlFromText, renderKimiXtmlCalls } from "./kimiXtml.js";
import { recoverLlamaJsonFromText, renderLlamaJsonCall } from "./llamaJson.js";
import { recoverMinimaxNsFromText, renderMinimaxNsCalls } from "./minimaxNs.js";
import {
  recoverMinimaxXmlFromText,
  renderMinimaxXmlCalls,
} from "./minimaxXml.js";
import { recoverPythonicFromText, renderPythonicCall } from "./pythonic.js";
import {
  recoverQwenXmlFromText,
  renderQwenXmlCall,
  type RecoveredCall,
} from "./qwenXml.js";
import {
  recoverToolcallJsonFromText,
  renderToolcallJsonCalls,
} from "./toolcallJson.js";

/**
 * Every dialect parser must take a very long reply (thousands of calls, or
 * megabytes of prose) without throwing and in roughly linear time: a parser
 * that recurses per call overflows the stack, and one that rescans per
 * character stalls the stream.
 */
const tools = [
  {
    name: "t",
    parameters: { properties: { p: { type: "string" } }, required: ["p"] },
  },
];
const call = (i: number) => ({ name: "t", arguments: { p: `v${i}` } });
const many = (n: number) => Array.from({ length: n }, (_, i) => call(i));
const join = (render: (c: ReturnType<typeof call>) => string) => (n: number) =>
  many(n).map(render).join("\n");

type Recover = (
  text: string,
  tools: { name: string; parameters?: unknown }[],
) => { text: string; calls: RecoveredCall[] };

const dialects: Array<[string, Recover, (n: number) => string, string]> = [
  ["qwen-xml", recoverQwenXmlFromText, join(renderQwenXmlCall), "<tool_call>"],
  ["glm-xml", recoverGlmXmlFromText, join(renderGlmXmlCall), "<tool_call>"],
  [
    "hermes-json",
    recoverHermesJsonFromText,
    join(renderHermesJsonCall),
    "<tool_call>",
  ],
  [
    "kimi-tokens",
    recoverKimiTokensFromText,
    (n) => renderKimiTokensCalls(many(n)),
    "<|tool_calls_section_begin|>",
  ],
  [
    "kimi-xtml",
    recoverKimiXtmlFromText,
    (n) => renderKimiXtmlCalls(many(n)),
    "<tool_call>",
  ],
  [
    "minimax-xml",
    recoverMinimaxXmlFromText,
    (n) => renderMinimaxXmlCalls(many(n)),
    "<minimax:tool_call>",
  ],
  [
    "minimax-ns-xml",
    recoverMinimaxNsFromText,
    (n) => renderMinimaxNsCalls(many(n)),
    "<minimax:tool_call>",
  ],
  [
    "toolcall-json",
    recoverToolcallJsonFromText,
    (n) => renderToolcallJsonCalls(many(n)),
    "<TOOLCALL>",
  ],
  ["llama-json", recoverLlamaJsonFromText, join(renderLlamaJsonCall), "{"],
  ["pythonic", recoverPythonicFromText, join(renderPythonicCall), "["],
];

// Generous: a quadratic parser on these inputs takes minutes, not seconds.
const BOUND_MS = 10000;

function timed<T>(fn: () => T): { out: T; ms: number } {
  const t = Date.now();
  const out = fn();
  return { out, ms: Date.now() - t };
}

describe.each(dialects)("%s stress", (_name, recover, build, start) => {
  it("takes 5,000 calls without throwing, in bounded time", () => {
    const text = build(5000);
    const { out, ms } = timed(() => recover(text, tools));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(out.text.length + out.calls.length).toBeGreaterThan(0);
  });

  it("takes 5 MB of prose, with or without a start marker, in bounded time", () => {
    const prose = "The quick brown fox, jumps; over (the) lazy dog.\n".repeat(
      110_000,
    );
    for (const text of [prose, start + prose]) {
      const { out, ms } = timed(() => recover(text, tools));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(out.calls).toEqual([]);
      expect(out.text).toBe(text);
    }
  });
});

it("qwen-xml recovers all of 5,000 calls", () => {
  const r = recoverQwenXmlFromText(join(renderQwenXmlCall)(5000), tools);
  expect(r.calls).toHaveLength(5000);
  expect(r.text).toBe("");
});
