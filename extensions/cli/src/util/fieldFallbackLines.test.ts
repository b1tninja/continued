import { describe, expect, it } from "vitest";

import { fieldFallbackLines } from "./fieldFallbackLines.js";

describe("fieldFallbackLines", () => {
  const at = 1;
  it("says nothing when nothing fell back", () => {
    expect(fieldFallbackLines([])).toEqual([]);
  });

  it("writes one line per model and field, with the provider's first line and the config advice", () => {
    const lines = fieldFallbackLines([
      {
        provider: "bedrock",
        model: "us.openai.gpt-6.1-sol",
        field: "cachePoint",
        error: "This model doesn't support the cachePoint field.\nMore text",
        at,
      },
      {
        provider: "bedrock",
        model: "us.openai.gpt-6.1-sol",
        field: "cachePoint",
        error: "This model doesn't support the cachePoint field.",
        at,
      },
      {
        provider: "bedrock",
        model: "qwen.qwen3-coder-30b-a3b-v1:0",
        field: "stopSequences",
        error: "This model doesn't support the stopSequences field.",
        at,
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Sent without prompt cache points");
    expect(lines[0]).toContain("us.openai.gpt-6.1-sol");
    expect(lines[0]).not.toContain("More text");
    expect(lines[0]).toContain("promptCaching: false");
    expect(lines[1]).toContain("Sent without stop sequences");
    expect(lines[1]).toContain("remove `stop`");
  });
});
