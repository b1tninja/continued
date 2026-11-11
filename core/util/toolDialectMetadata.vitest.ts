import { describe, expect, test } from "vitest";
import {
  dialectFromModelName,
  hintFromLlamaCppProps,
  hintFromLmStudioModels,
  hintFromOllamaShow,
  hintFromOpenAiModels,
} from "./toolDialectMetadata.js";

/*
 * Every JSON body here is SYNTHESISED from the response shape the vendor
 * documents (llama.cpp tools/server README, Ollama docs/api.md, LM Studio REST
 * docs, read 2026-11-10); none was captured from a running server. Template
 * strings are the literals quoted from the Hugging Face templates in
 * toolDialectDetect.fixtures.ts.
 */
const QWEN_CODER_TEMPLATE =
  "{{- '\\n<tool_call>\\n<function=' + tool_call.name + '>\\n' }}{{- '<parameter=' + args_name + '>\\n' }}";
const GLM_TEMPLATE =
  "{{ '\\n<tool_call>' + tc.name }}<arg_key>{{ k }}</arg_key>";

describe("dialectFromModelName", () => {
  test.each([
    ["Qwen3-Coder-30B-A3B-Instruct-AWQ", "qwen-xml"],
    ["qwen3-coder:30b", "qwen-xml"],
    ["Qwen3-Next-80B-A3B", "qwen-xml"],
    ["Qwen3-32B", "hermes-json"],
    ["qwen2.5-72b-instruct", "hermes-json"],
    ["zai-org/GLM-4.5-Air", "glm-xml"],
    ["moonshotai/Kimi-K2-Instruct", "kimi-tokens"],
    ["openai/gpt-oss-120b", "harmony"],
    ["deepseek-ai/DeepSeek-V3.2", "dsml"],
    ["Devstral-Small", "mistral"],
  ])("%s", (name, dialect) => {
    expect(dialectFromModelName(name)?.dialect).toBe(dialect);
  });

  test.each(["llama-3.3-70b", "my-company-coder-v7", "gemma-3-27b", "", null])(
    "no hint for %s",
    (name) => {
      expect(dialectFromModelName(name as string | null)).toBeUndefined();
    },
  );
});

describe("llama.cpp /props", () => {
  test("template wins over the file name", () => {
    const h = hintFromLlamaCppProps({
      chat_template: QWEN_CODER_TEMPLATE,
      model_path: "/models/my-finetune.gguf",
    });
    expect(h.signal?.dialect).toBe("qwen-xml");
    expect(h.basis).toBe("chat-template");
  });
  test("falls back to the model path", () => {
    const h = hintFromLlamaCppProps({
      chat_template: "{{ messages }}",
      model_path: "/m/GLM-4.5-Air-Q4_K_M.gguf",
    });
    expect(h.signal?.dialect).toBe("glm-xml");
    expect(h.basis).toBe("model-name");
  });
  test("junk input gives no signal and does not throw", () => {
    expect(hintFromLlamaCppProps(null).signal).toBeUndefined();
    expect(hintFromLlamaCppProps("x").signal).toBeUndefined();
  });
});

describe("Ollama /api/show", () => {
  test("template and tools capability", () => {
    const h = hintFromOllamaShow({
      template: GLM_TEMPLATE,
      capabilities: ["completion", "tools"],
      details: { family: "glm4moe" },
    });
    expect(h.signal?.dialect).toBe("glm-xml");
    expect(h.toolsAdvertised).toBe(true);
  });
  test("no tools capability is recorded, not a dialect", () => {
    const h = hintFromOllamaShow(
      { template: "{{ .Prompt }}", capabilities: ["completion"] },
      "llama3:8b",
    );
    expect(h.signal).toBeUndefined();
    expect(h.toolsAdvertised).toBe(false);
  });
  test("architecture string as a last resort", () => {
    const h = hintFromOllamaShow({
      template: "",
      model_info: { "general.architecture": "qwen3" },
    });
    expect(h.signal?.dialect).toBe("hermes-json");
  });
});

describe("LM Studio and /v1/models", () => {
  const lm = {
    object: "list",
    data: [
      { id: "qwen/qwen3-coder-30b", type: "llm", arch: "qwen3_moe" },
      { id: "some-model", type: "llm", arch: "llama" },
    ],
  };
  test("finds the entry by id", () => {
    expect(
      hintFromLmStudioModels(lm, "qwen/qwen3-coder-30b").signal?.dialect,
    ).toBe("qwen-xml");
    expect(hintFromLmStudioModels(lm, "some-model").signal).toBeUndefined();
    expect(hintFromLmStudioModels(lm, "absent").evidence[0]).toMatch(
      /not in the listing/,
    );
  });
  test("vLLM renamed model recovered from root; owned_by ignored", () => {
    const list = {
      data: [
        {
          id: "prod-coder",
          root: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
          owned_by: "kimi-k2",
        },
      ],
    };
    expect(hintFromOpenAiModels(list, "prod-coder").signal?.dialect).toBe(
      "qwen-xml",
    );
  });
  test("gateway with an opaque id gives nothing", () => {
    expect(
      hintFromOpenAiModels({ data: [{ id: "gw-1" }] }, "gw-1").signal,
    ).toBeUndefined();
  });
});
