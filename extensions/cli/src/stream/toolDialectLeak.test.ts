import type { ModelConfig } from "@continuedev/config-yaml";
import qwenEmbedding from "core/util/fixtures/ollama-show/qwen3-embedding-8b.json";
import qwen36 from "core/util/fixtures/ollama-show/qwen3.6-27b.json";
import { resetOllamaShowCache } from "core/util/ollamaShowHint.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hintToolDialectLeak,
  resetToolDialectHints,
} from "./toolDialectLeak.js";

const leaked =
  "I will read it.\n\n<tool_call>\n<function=Read>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>";
const fenced =
  "Example:\n\n```xml\n<tool_call>\n<function=Read>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>\n```\n";

const model = (extra: object = {}) =>
  ({
    name: "Qwen",
    provider: "bedrock",
    model: "qwen",
    ...extra,
  }) as ModelConfig;

describe("CLI tool dialect hint", () => {
  beforeEach(() => resetToolDialectHints());

  it("prints one line once per model for text outside a fence", async () => {
    const print = vi.fn();
    const args = { model: model(), toolCalls: [], callbacks: undefined, print };
    await hintToolDialectLeak({ ...args, content: leaked });
    await hintToolDialectLeak({ ...args, content: leaked });
    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toContain("toolDialect: qwen-xml");
  });

  it("uses the status callback when there is one", async () => {
    const onStatusMessage = vi.fn();
    await hintToolDialectLeak({
      model: model(),
      content: leaked,
      toolCalls: [],
      callbacks: { onStatusMessage },
    });
    expect(onStatusMessage).toHaveBeenCalledTimes(1);
  });

  it("says nothing for a fenced mention, a set toolDialect or another provider", async () => {
    const print = vi.fn();
    const base = { toolCalls: [], callbacks: undefined, print };
    await hintToolDialectLeak({ ...base, model: model(), content: fenced });
    await hintToolDialectLeak({
      ...base,
      model: model({ toolDialect: "qwen-xml" }),
      content: leaked,
    });
    await hintToolDialectLeak({
      ...base,
      model: model({ provider: "anthropic" }),
      content: leaked,
    });
    expect(print).not.toHaveBeenCalled();
  });

  const ollama = () =>
    model({ provider: "ollama", model: "qwen3.6:27b", name: "Q" });
  const show = (body: object) =>
    vi.fn(async () => ({ ok: true, json: async () => body }));

  it("is silent when Ollama's parser already handles the model", async () => {
    resetOllamaShowCache();
    const print = vi.fn();
    const fetchFn = show(qwen36);
    await hintToolDialectLeak({
      model: ollama(),
      content: leaked,
      toolCalls: [],
      callbacks: undefined,
      print,
      fetchFn,
    });
    expect(print).not.toHaveBeenCalled();
  });

  it("keeps the hint for a template-only Ollama model and when /api/show fails", async () => {
    resetOllamaShowCache();
    const print = vi.fn();
    const base = {
      content: leaked,
      toolCalls: [],
      callbacks: undefined,
      print,
    };
    await hintToolDialectLeak({
      ...base,
      model: ollama(),
      fetchFn: show(qwenEmbedding),
    });
    expect(print).toHaveBeenCalledTimes(1);
    resetToolDialectHints();
    resetOllamaShowCache();
    await hintToolDialectLeak({
      ...base,
      model: ollama(),
      fetchFn: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    expect(print).toHaveBeenCalledTimes(2);
  });
});
