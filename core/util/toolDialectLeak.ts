/**
 * Spotting a tool call a model wrote as text in a reply that was seen live.
 * Only warns: the caller shows a notice and never turns recovery on by itself.
 * Markup inside a code fence is a mention and does not count
 * (classifyToolReply). Design: plans/tool-dialect-detection.md, sections 3 and 5.
 */
import type { ToolDialectSetting } from "@continuedev/config-yaml";
import {
  ACCEPT_THRESHOLD,
  classifyToolReply,
  type ToolCallLike,
} from "./toolDialectDetect.js";

/** The dialects the recovery switch can turn into calls, as `toolDialect` values. */
const RECOVERABLE: Record<string, ToolDialectSetting> = {
  "qwen-xml": "qwen-xml",
  pythonic: "pythonic",
  "llama-json": "llama-json",
  "hermes-json": "hermes-json",
  "glm-xml": "glm-xml",
};

/**
 * Providers whose chat stream goes through the OpenAI-compatible adapter
 * (packages/openai-adapters, apis/OpenAI.ts), which recovers calls from text
 * when asked. The IDE reaches it for these providers; Ollama's IDE path is its
 * own native chat and does not (the CLI reaches it for Ollama too).
 */
const OPENAI_COMPATIBLE = new Set([
  "openai",
  "lmstudio",
  "llama.cpp",
  "llamafile",
  "vllm",
  "text-gen-webui",
  "msty",
]);

/**
 * Whether this provider recovers calls from text: the Bedrock handlers and
 * the OpenAI-compatible adapter. `surface` is where the request is made.
 */
export function providerRecoversText(
  provider: string | undefined,
  surface: "ide" | "cli" = "ide",
): boolean {
  if (!provider) return false;
  return (
    provider === "bedrock" ||
    OPENAI_COMPATIBLE.has(provider) ||
    (surface === "cli" && provider === "ollama")
  );
}

export interface ToolDialectLeak {
  dialect: ToolDialectSetting;
}

/**
 * The dialect a reply leaked, or undefined: no markup, markup only in a code
 * fence, structured calls present, a dialect recovery cannot handle, or the
 * model already has a `toolDialect` set.
 */
export function detectToolDialectLeak(args: {
  content: string | null | undefined;
  toolCalls?: ToolCallLike[];
  knownTools?: string[];
  current?: ToolDialectSetting;
}): ToolDialectLeak | undefined {
  if (args.current && args.current !== "auto") return undefined;
  const c = classifyToolReply({
    content: args.content,
    toolCalls: args.toolCalls,
    knownTools: args.knownTools,
  });
  const dialect = RECOVERABLE[c.dialect];
  if (!dialect || c.confidence < ACCEPT_THRESHOLD) return undefined;
  return { dialect };
}

/** The notice's text. */
export function leakNoticeText(dialect: string): string {
  return `This model wrote a tool call as text (looks like ${dialect}). Turn on recovery for this model?`;
}

/** The CLI's one-line hint. */
export function leakHintText(model: string, dialect: string): string {
  return `${model} wrote a tool call as text (looks like ${dialect}). To recover such calls, set \`toolDialect: ${dialect}\` on the model in config.yaml.`;
}
