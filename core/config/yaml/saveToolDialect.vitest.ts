import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { editYamlText } from "../../util/yamlEdit";
import { applyToolDialect } from "./saveToolDialect";

const SRC = `# my config
name: Local
version: 1.0.0
schema: v1
models:
  - name: Qwen
    provider: bedrock
    model: qwen.qwen3-coder
  - name: Other # keep
    provider: openai
    model: gpt
`;

describe("applyToolDialect", () => {
  it("sets the key on the named model only and keeps comments", () => {
    const { text } = editYamlText<any>(SRC, (c) =>
      applyToolDialect(c, "Qwen", "qwen-xml"),
    );
    const parsed = YAML.parse(text!);
    expect(parsed.models[0].toolDialect).toBe("qwen-xml");
    expect(parsed.models[1].toolDialect).toBeUndefined();
    expect(text).toContain("# keep");
  });

  it("leaves the config alone when no model has that name", () => {
    const config = YAML.parse(SRC);
    expect(applyToolDialect(config, "Nope", "off")).toBe(config);
  });
});
