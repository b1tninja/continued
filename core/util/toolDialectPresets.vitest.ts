import { describe, expect, it } from "vitest";
import { bedrockSupportsTools } from "../llm/toolSupport.js";
import { TOOL_DIALECT_PRESETS } from "./toolDialectPresetTable.js";
import {
  describePreset,
  presetBedrockTools,
  resolveToolDialectPreset,
  toolDialectHint,
  type NativeOnConverse,
  type TextDialect,
  type ToolsOnBedrock,
} from "./toolDialectPresets.js";

/**
 * Every model of plans/live-tool-call-findings.md, with the id it was sent
 * under, the preset it must resolve to and what that run observed.
 */
const LIVE: [
  id: string,
  preset: string,
  native: NativeOnConverse,
  tools: ToolsOnBedrock,
  text: TextDialect,
][] = [
  [
    "meta.llama3-3-70b-instruct-v1:0",
    "llama-3.3",
    "none",
    "with-recovery",
    "llama-json",
  ],
  [
    "us.meta.llama4-maverick-17b-instruct-v1:0",
    "llama-4",
    "most",
    "yes",
    "pythonic",
  ],
  ["deepseek.v3.2", "deepseek-v3.2", "all", "yes", "dsml"],
  [
    "moonshot.kimi-k2-thinking",
    "kimi-k2-thinking",
    "all",
    "yes",
    "kimi-tokens",
  ],
  ["qwen.qwen3-coder-30b-a3b-v1:0", "qwen3-coder", "most", "yes", "qwen-xml"],
  ["google.gemma-3-27b-it", "gemma-3", "none", "no", "none"],
  ["amazon.nova-pro-v1:0", "nova", "all", "yes", "pythonic"],
  ["amazon.nova-2-lite-v1:0", "nova", "all", "yes", "pythonic"],
  ["zai.glm-4.7", "glm-4.7", "all", "yes", "glm-xml"],
  ["zai.glm-5", "glm-5", "all", "yes", "glm-xml"],
  ["mistral.devstral-2-123b", "mistral", "all", "yes", "mistral"],
  ["mistral.mistral-large-3-675b-instruct", "mistral", "all", "yes", "mistral"],
  ["moonshotai.kimi-k2.5", "kimi-k2", "all", "yes", "kimi-tokens"],
  ["moonshotai.kimi-k3", "kimi-k3", "all", "yes", "kimi-tokens"],
  ["moonshotai.kimi-k3.1", "kimi-k3", "all", "yes", "kimi-tokens"],
  ["minimax.minimax-m2", "minimax-m2", "all", "yes", "minimax-xml"],
  ["minimax.minimax-m2.5", "minimax-m2", "all", "yes", "minimax-xml"],
  ["nvidia.nemotron-super-3-120b", "nemotron-3", "all", "yes", "qwen-xml"],
  ["nvidia.nemotron-nano-3-30b", "nemotron-3", "all", "yes", "qwen-xml"],
  ["qwen.qwen3-32b-v1:0", "qwen3", "all", "yes", "hermes-json"],
  ["qwen.qwen3-coder-next", "qwen3-coder", "most", "yes", "qwen-xml"],
  ["openai.gpt-oss-20b-1:0", "gpt-oss", "all", "yes", "harmony"],
  ["openai.gpt-oss-120b-1:0", "gpt-oss", "all", "yes", "harmony"],
  ["qwen3.8-flash", "qwen3", "all", "yes", "hermes-json"],
  ["qwen3.6:35b", "qwen3", "all", "yes", "hermes-json"],
  ["deepseek.r1-v1:0", "deepseek-r1", "none", "no", "deepseek-tokens"],
];

describe("tool dialect presets", () => {
  it.each(LIVE)(
    "%s maps to the preset the run observed",
    (id, preset, native, tools, text) => {
      const p = resolveToolDialectPreset(id);
      expect(p?.id).toBe(preset);
      expect(p?.nativeOnConverse).toBe(native);
      expect(p?.bedrockTools).toBe(tools);
      expect(p?.textDialect).toBe(text);
    },
  );

  it("resolves Ollama, Hugging Face and OpenRouter spellings", () => {
    const id = (name: string) => resolveToolDialectPreset(name)?.id;
    expect(id("qwen3-coder:30b")).toBe("qwen3-coder");
    expect(id("Qwen/Qwen3-Coder-30B-A3B-Instruct")).toBe("qwen3-coder");
    expect(id("nvidia/nemotron-3-super-120b-a12b")).toBe("nemotron-3");
    expect(id("moonshotai/kimi-k2-thinking")).toBe("kimi-k2-thinking");
    expect(id("z-ai/glm-4.6")).toBe("glm-4.5-4.6");
    expect(id("minimax/minimax-m2")).toBe("minimax-m2");
    expect(id("deepseek/deepseek-chat-v3.1")).toBe("deepseek-v3");
    expect(id("openai/gpt-oss-120b")).toBe("gpt-oss");
    expect(id("meta-llama/llama-3.1-70b-instruct")).toBe("llama-3.1-3.2");
  });

  it("tells the Nemotron generations apart", () => {
    const id = (name: string) => resolveToolDialectPreset(name)?.id;
    expect(id("nvidia/Llama-3_3-Nemotron-Super-49B-v1_5")).toBe(
      "llama-nemotron",
    );
    expect(id("nvidia/NVIDIA-Nemotron-Nano-9B-v2")).toBe("nemotron-h");
    expect(id("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16")).toBe("nemotron-3");
    expect(id("nvidia/Nemotron-H-8B-Reasoning-128K")).toBe("nemotron-h");
  });

  it("does not match unrelated names", () => {
    expect(resolveToolDialectPreset("innovator-7b")).toBeUndefined();
    expect(resolveToolDialectPreset("")).toBeUndefined();
    expect(resolveToolDialectPreset(undefined)).toBeUndefined();
  });

  it("keeps ids unique and every row sourced and dated", () => {
    const ids = TOOL_DIALECT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of TOOL_DIALECT_PRESETS) {
      expect(p.source.length, p.id).toBeGreaterThan(0);
      expect(p.readOn, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.match.length, p.id).toBeGreaterThan(0);
      if (p.serverParser?.basis === "registered-only") {
        expect(p.serverParser.note, p.id).toBeTruthy();
      }
    }
  });

  it("gives every row a prompt style with its evidence", () => {
    for (const p of TOOL_DIALECT_PRESETS) {
      const { style, evidence } = p.promptStyle;
      expect(evidence.length, p.id).toBeGreaterThan(10);
      // A family's own form must be the form its template writes.
      if (style !== "native" && style !== "codeblock") {
        expect(style, p.id).toBe(p.textDialect);
      }
      // Codeblock rows are a fallback nobody has measured: they must say so.
      if (style === "codeblock") expect(evidence, p.id).toMatch(/untested/i);
    }
    expect(
      resolveToolDialectPreset("google.gemma-3-27b-it")?.promptStyle.style,
    ).toBe("codeblock");
    expect(
      resolveToolDialectPreset("meta.llama3-3-70b-instruct-v1:0")?.promptStyle
        .style,
    ).toBe("llama-json");
  });

  it("only offers a recovery dialect that code exists for", () => {
    const built = [
      "qwen-xml",
      "pythonic",
      "llama-json",
      "hermes-json",
      "glm-xml",
    ];
    for (const p of TOOL_DIALECT_PRESETS) {
      if (p.recoverWith) expect(built, p.id).toContain(p.recoverWith);
    }
    for (const id of [
      "kimi-k3",
      "minimax-m2",
      "deepseek-v3.2",
      "gpt-oss",
      "nemotron-h",
      "llama-nemotron",
    ]) {
      expect(
        TOOL_DIALECT_PRESETS.find((p) => p.id === id)?.recoverWith,
        id,
      ).toBeUndefined();
    }
  });

  it("records Nemotron 3 as the Qwen3-Coder markup with the qwen3_coder parser", () => {
    const p = resolveToolDialectPreset("nvidia.nemotron-super-3-120b");
    expect(p?.textDialect).toBe("qwen-xml");
    expect(p?.recoverWith).toBe("qwen-xml");
    expect(p?.serverParser).toMatchObject({
      vllm: "qwen3_coder",
      basis: "model-card",
    });
  });
});

describe("toolDialectHint", () => {
  it("reads the preset for auto and for no setting", () => {
    expect(toolDialectHint("zai.glm-4.7").dialect).toBe("glm-xml");
    expect(toolDialectHint("zai.glm-4.7", "auto")).toMatchObject({
      dialect: "glm-xml",
      from: "preset",
    });
    expect(toolDialectHint("unknown-model")).toEqual({
      dialect: "auto",
      from: "none",
    });
  });

  it("lets an explicit setting win", () => {
    expect(toolDialectHint("zai.glm-4.7", "off")).toMatchObject({
      dialect: "off",
      from: "setting",
    });
  });

  it("describes a preset in one line", () => {
    const p = resolveToolDialectPreset("qwen3-coder");
    expect(p && describePreset(p)).toContain("qwen-xml");
  });
});

describe("Bedrock tool support from the presets", () => {
  it.each([
    "moonshotai.kimi-k3",
    "moonshot.kimi-k2-thinking",
    "moonshotai.kimi-k2.5",
    "zai.glm-4.7",
    "zai.glm-5",
    "minimax.minimax-m2.5",
    "nvidia.nemotron-super-3-120b",
    "mistral.devstral-2-123b",
  ])("turns tools on for %s", (id) => {
    expect(bedrockSupportsTools(id)).toBe(true);
  });

  it("keeps the earlier answers", () => {
    expect(
      bedrockSupportsTools("anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toBe(true);
    expect(bedrockSupportsTools("anthropic.claude-instant-v1")).toBe(false);
    expect(bedrockSupportsTools("deepseek.r1-v1:0")).toBe(false);
    expect(bedrockSupportsTools("us.deepseek.r1-v1:0")).toBe(false);
    expect(bedrockSupportsTools("google.gemma-3-27b-it")).toBe(false);
    expect(bedrockSupportsTools("meta.llama4-maverick-17b-instruct-v1:0")).toBe(
      true,
    );
    expect(bedrockSupportsTools("amazon.nova-pro-v1:0")).toBe(true);
    expect(bedrockSupportsTools("something.unknown-model")).toBe(false);
  });

  it("offers Llama 3.x tools only with llama-json recovery", () => {
    const id = "meta.llama3-3-70b-instruct-v1:0";
    expect(bedrockSupportsTools(id)).toBe(false);
    expect(bedrockSupportsTools(id, "auto")).toBe(false);
    expect(bedrockSupportsTools(id, "off")).toBe(false);
    expect(bedrockSupportsTools(id, "llama-json")).toBe(true);
    expect(presetBedrockTools(id, "qwen-xml")).toBe(false);
  });
});
