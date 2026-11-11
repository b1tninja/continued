import { describe, expect, test } from "vitest";
import { detectToolDialectLeak } from "./toolDialectLeak.js";
import { hintFromOllamaShow, OLLAMA_PARSERS } from "./toolDialectMetadata.js";
import { probeToolDialect } from "./toolDialectProbe.js";
import glmOcr from "./fixtures/ollama-show/glm-ocr.json";
import qwen36 from "./fixtures/ollama-show/qwen3.6-27b.json";
import qwenEmbedding from "./fixtures/ollama-show/qwen3-embedding-8b.json";

/*
 * The three JSON fixtures are real POST /api/show bodies from a local Ollama
 * (2026-11-10), with the license text, tokenizer arrays, blob path and
 * timestamp removed. The rest are synthesised from the same shape.
 */
describe("Ollama /api/show with a renderer and parser", () => {
  test("qwen3.6:27b: template is only {{ .Prompt }}, parser decides", () => {
    expect(qwen36.template).toBe("{{ .Prompt }}");
    const h = hintFromOllamaShow(qwen36, "some-alias");
    expect(h.signal?.dialect).toBe("qwen-xml");
    expect(h.basis).toBe("ollama-parser");
    expect(h.serverParses).toBe(true);
    expect(h.toolsAdvertised).toBe(true);
    expect(h.evidence.join("\n")).toContain("tools and thinking");
    expect(h.evidence.join("\n")).toContain('renderer "qwen3.5"');
  });

  test("glm-ocr: parser glm-ocr maps to glm-xml", () => {
    const h = hintFromOllamaShow(glmOcr);
    expect(h.signal?.dialect).toBe("glm-xml");
    expect(h.serverParses).toBe(true);
  });

  test("template-only model with a <tool_call> template (qwen3-embedding)", () => {
    const h = hintFromOllamaShow(qwenEmbedding, "qwen3-embedding:8b");
    expect(h.basis).toBe("chat-template");
    expect(h.signal?.dialect).toBe("hermes-json");
    expect(h.serverParses).toBeUndefined();
    expect(h.toolsAdvertised).toBe(true);
  });

  test("unverified parser name maps nothing and falls back to the name", () => {
    const h = hintFromOllamaShow(
      { parser: "brand-new", renderer: "brand-new", template: "{{ .Prompt }}" },
      "glm-4.9",
    );
    expect(h.basis).toBe("model-name");
    expect(h.signal?.dialect).toBe("glm-xml");
    expect(h.serverParses).toBeUndefined();
    expect(h.evidence.join("\n")).toContain("not in the verified table");
  });

  test("unverified parser and unknown name: no signal", () => {
    const h = hintFromOllamaShow({ parser: "brand-new" }, "mystery");
    expect(h.signal).toBeUndefined();
    expect(h.serverParses).toBeUndefined();
  });

  test("known parser without a dialect still means the server parses", () => {
    const h = hintFromOllamaShow({ parser: "gemma4" }, "gemma4:e4b");
    expect(h.signal).toBeUndefined();
    expect(h.serverParses).toBe(true);
  });

  test("renderer without parser: name fallback, server does not parse", () => {
    const h = hintFromOllamaShow(
      {
        renderer: "qwen3.5",
        template: "{{ .Prompt }}",
        capabilities: ["tools"],
      },
      "qwen3.6:latest",
    );
    expect(h.signal?.dialect).toBe("qwen-xml");
    expect(h.basis).toBe("model-name");
    expect(h.serverParses).toBeUndefined();
  });

  test("Llama template without tool markup, no parser", () => {
    const h = hintFromOllamaShow(
      { template: "{{ .System }}{{ .Prompt }}", capabilities: ["completion"] },
      "llama3.2",
    );
    expect(h.signal).toBeUndefined();
    expect(h.toolsAdvertised).toBe(false);
    expect(h.serverParses).toBeUndefined();
  });

  test("an inherited key is not a parser name", () => {
    expect(hintFromOllamaShow({ parser: "constructor" }).serverParses).toBe(
      undefined,
    );
  });

  test("every table entry carries its source note", () => {
    for (const e of Object.values(OLLAMA_PARSERS)) {
      expect(e.note.length).toBeGreaterThan(10);
    }
  });
});

describe("serverParses is respected", () => {
  const leaked = {
    content:
      "<tool_call>\n<function=read_file>\n<parameter=path>a</parameter>\n</function>\n</tool_call>",
  };
  test("leak detection fires without it and not with it", () => {
    expect(detectToolDialectLeak(leaked)?.dialect).toBe("qwen-xml");
    expect(
      detectToolDialectLeak({ ...leaked, serverParses: true }),
    ).toBeUndefined();
  });

  test("probe drops the preset and records the flag", async () => {
    const send = async () => ({ content: "hello" });
    const r = await probeToolDialect(send, "qwen3-coder:30b", {
      serverParses: true,
    });
    expect(r.serverParses).toBe(true);
    expect(r.preset).toBeUndefined();
  });
});
