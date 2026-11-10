/**
 * Tool-dialect presets: one row per model family saying how the family does
 * tool calls, so picking a model needs no hand-set `toolDialect`. Types and
 * lookup live here; the rows are in toolDialectPresetTable.ts (data only).
 *
 * Pure and GUI-safe: it imports nothing from `@continuedev/openai-adapters`
 * (the recovery parsers live there and are selected by the `toolDialect`
 * value a row names). Evidence: plans/tool-dialect-reference.md and
 * plans/live-tool-call-findings.md. Presets only ever produce hints and
 * enable tools for families the live run proved; they never turn text
 * recovery on by themselves.
 */
import type { ToolDialectSetting } from "@continuedev/config-yaml";
import { TOOL_DIALECT_PRESETS } from "./toolDialectPresetTable.js";

/** The text a family writes when no server turns its calls into structured ones. */
export type TextDialect =
  | "qwen-xml" // <tool_call><function=NAME><parameter=KEY>
  | "hermes-json" // <tool_call>{"name":..,"arguments":..}</tool_call>
  | "glm-xml" // <tool_call>NAME<arg_key>..</arg_key><arg_value>..</arg_value>
  | "pythonic" // [name(arg=1)] or name(arg=1)
  | "llama-json" // {"name":..,"parameters":{..}}
  | "toolcall-json" // <TOOLCALL>[{"name":..,"arguments":..}]</TOOLCALL>
  | "harmony" // gpt-oss: <|channel|>commentary to=functions.NAME ...
  | "kimi-tokens" // <|tool_call_begin|>functions.NAME:IDX<|tool_call_argument_begin|>
  | "minimax-xml" // <minimax:tool_call><invoke name=..>
  | "dsml" // DeepSeek V3.2 full-width-bar DSML
  | "deepseek-tokens" // DeepSeek V3/V3.1/R1 tool-call tokens
  | "mistral" // [TOOL_CALLS]...
  | "gemma4" // <|tool_call>call:NAME{..}<tool_call|>
  | "none"; // no text dialect: native only, or no tool format at all

/** Does Bedrock Converse hand back structured calls for the family? */
export type NativeOnConverse = "all" | "most" | "none" | "unmeasured";

/** Whether tools are offered to the family on Bedrock. */
export type ToolsOnBedrock =
  /** measured: structured calls come back */
  | "yes"
  /** measured: refused, or no tool format */
  | "no"
  /** only when the model's `toolDialect` names the recoverable dialect */
  | "with-recovery"
  /** not measured: the older name list in toolSupport.ts decides */
  | "unmeasured";

export type ParserBasis =
  /** read on the vendor's model card or deployment guide */
  | "model-card"
  /** named for this family in the vLLM tool-calling docs */
  | "vllm-docs"
  /** the parser name exists in vLLM's registry; its pairing with this family was not read */
  | "registered-only";

/**
 * How to ASK for calls when native tools are absent or their calls are not
 * parsed: `native` (send tools as usual), `codeblock` (the generic framework in
 * core/tools/systemMessageTools), or the family's own form, named as its
 * dialect. Data only: nothing reads this field to change what is sent. It is
 * the hook for a later measured experiment.
 */
export type PromptStyle =
  | "native"
  | "codeblock"
  | "qwen-xml"
  | "hermes-json"
  | "glm-xml"
  | "pythonic"
  | "llama-json"
  | "toolcall-json";

export interface ServerParser {
  /** vLLM `--tool-call-parser` value. */
  vllm: string;
  basis: ParserBasis;
  note?: string;
}

export interface DialectPreset {
  id: string;
  label: string;
  /** Tested against the lower-cased id: Bedrock ids, Ollama/HF names, OpenRouter slugs. */
  match: RegExp[];
  bedrockTools: ToolsOnBedrock;
  nativeOnConverse: NativeOnConverse;
  /** What the live Bedrock run saw, when it measured the family. */
  measured?: string;
  /** What the family's own template writes. */
  textDialect: TextDialect;
  /** How to ask for calls without working native tools, and what that rests on. */
  promptStyle: { style: PromptStyle; evidence: string };
  /** What a live run actually leaked into text, when that differs or is known. */
  observedLeak?: string;
  /** The `toolDialect` value that recovers this family's text calls, when code exists. */
  recoverWith?: ToolDialectSetting;
  /** Reasoning tag pair to strip from visible text. */
  thinkingTags?: [open: string, close: string];
  /** Set only where verified; omitted otherwise. */
  serverParser?: ServerParser;
  source: string[];
  /** Date the sources were read, YYYY-MM-DD. */
  readOn: string;
  /** What could not be sourced for this row. */
  unverified?: string[];
}

export { TOOL_DIALECT_PRESETS };

/** The first preset whose pattern matches the model id, name or slug. */
export function resolveToolDialectPreset(
  modelIdOrName: string | null | undefined,
): DialectPreset | undefined {
  if (!modelIdOrName) return undefined;
  const id = modelIdOrName.toLowerCase();
  return TOOL_DIALECT_PRESETS.find((p) => p.match.some((re) => re.test(id)));
}

export interface ToolDialectHint {
  /** The dialect to show or probe for. */
  dialect: ToolDialectSetting | TextDialect;
  from: "setting" | "preset" | "none";
  preset?: DialectPreset;
}

/**
 * The dialect to display or probe for. An explicit `toolDialect` wins; `auto`
 * or no setting reads the preset. Nothing here changes what is recovered:
 * recovery follows the `toolDialect` setting and the environment variable.
 */
export function toolDialectHint(
  modelIdOrName: string | null | undefined,
  setting?: ToolDialectSetting,
): ToolDialectHint {
  const preset = resolveToolDialectPreset(modelIdOrName);
  if (setting && setting !== "auto") {
    return { dialect: setting, from: "setting", preset };
  }
  if (!preset) return { dialect: "auto", from: "none" };
  return { dialect: preset.textDialect, from: "preset", preset };
}

/** One-line description of a preset for a result line or a log. */
export function describePreset(p: DialectPreset): string {
  const recover = p.recoverWith
    ? `recoverable with toolDialect: ${p.recoverWith}`
    : "no recovery built";
  return `${p.label}: text dialect ${p.textDialect} (${recover})`;
}

/**
 * Whether tools are offered on Bedrock under the preset rule, or undefined
 * when the preset has no measured answer and the older name list decides.
 */
export function presetBedrockTools(
  modelIdOrName: string,
  toolDialect?: ToolDialectSetting,
): boolean | undefined {
  const preset = resolveToolDialectPreset(modelIdOrName);
  switch (preset?.bedrockTools) {
    case "yes":
      return true;
    case "no":
      return false;
    case "with-recovery":
      return !!preset.recoverWith && toolDialect === preset.recoverWith;
    default:
      return undefined;
  }
}
