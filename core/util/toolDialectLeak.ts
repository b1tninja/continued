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
  stripCode,
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

function mentionsTool(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(?<![\w.-])${escaped}(?![\w-])`).test(text);
}

function jsonNamesTool(text: string, known: string[]): boolean {
  try {
    const name = (JSON.parse(text.trim()) as { name?: unknown }).name;
    return typeof name === "string" && known.includes(name);
  } catch {
    return false;
  }
}

/**
 * Whether a reply is a tool call written as text, whatever the provider and
 * whatever `toolDialect` says: the turn that reply ends has done nothing, and
 * the harness nudges the model to call the tool (core/util/turnEnd.ts, H13).
 * Nothing is parsed and nothing runs. Conservative on purpose: a reply with
 * structured calls is not a leak; only a markup shape the classifier accepts
 * counts; the markup must sit outside code fences and inline code (an example
 * is not a call); and it must name a tool that was actually offered.
 */
export function isLeakedToolCall(args: {
  content: string | null | undefined;
  toolCalls?: ToolCallLike[];
  knownTools?: string[];
}): boolean {
  const known = args.knownTools ?? [];
  if (known.length === 0 || (args.toolCalls?.length ?? 0) > 0) return false;
  const c = classifyToolReply({
    content: args.content,
    toolCalls: args.toolCalls,
    knownTools: known,
  });
  if (
    c.dialect === "native-structured" ||
    c.dialect === "prose" ||
    c.dialect === "unknown"
  ) {
    return false;
  }
  const { outside } = stripCode(args.content ?? "");
  // A whole reply that is one JSON object naming an offered tool is below the
  // classifier's bar on its own (an object with a name is common), but the
  // offered-tool check makes it safe here.
  if (c.confidence < ACCEPT_THRESHOLD) {
    return c.confidence >= 0.7 && jsonNamesTool(outside, known);
  }
  return known.some((name) => mentionsTool(outside, name));
}
