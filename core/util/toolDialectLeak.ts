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
};

/** Only the Bedrock handlers recover calls from text. */
export function providerRecoversText(provider: string | undefined): boolean {
  return provider === "bedrock";
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
