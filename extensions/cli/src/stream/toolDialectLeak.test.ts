import type { ModelConfig } from "@continuedev/config-yaml";
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

  it("prints one line once per model for text outside a fence", () => {
    const print = vi.fn();
    const args = { model: model(), toolCalls: [], callbacks: undefined, print };
    hintToolDialectLeak({ ...args, content: leaked });
    hintToolDialectLeak({ ...args, content: leaked });
    expect(print).toHaveBeenCalledTimes(1);
    expect(print.mock.calls[0][0]).toContain("toolDialect: qwen-xml");
  });

  it("uses the status callback when there is one", () => {
    const onStatusMessage = vi.fn();
    hintToolDialectLeak({
      model: model(),
      content: leaked,
      toolCalls: [],
      callbacks: { onStatusMessage },
    });
    expect(onStatusMessage).toHaveBeenCalledTimes(1);
  });

  it("says nothing for a fenced mention, a set toolDialect or another provider", () => {
    const print = vi.fn();
    const base = { toolCalls: [], callbacks: undefined, print };
    hintToolDialectLeak({ ...base, model: model(), content: fenced });
    hintToolDialectLeak({
      ...base,
      model: model({ toolDialect: "qwen-xml" }),
      content: leaked,
    });
    hintToolDialectLeak({
      ...base,
      model: model({ provider: "openai" }),
      content: leaked,
    });
    expect(print).not.toHaveBeenCalled();
  });
});
