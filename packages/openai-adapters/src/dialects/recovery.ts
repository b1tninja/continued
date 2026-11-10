/**
 * Recovery of tool calls a model wrote as text (plans/tool-dialects.md): the
 * one switch both Bedrock handlers (this package and core/llm/llms) use, so
 * the setting and the parsers exist once. Off unless asked for.
 */
import { GlmXmlRecovery, recoverGlmXmlFromText } from "./glmXml.js";
import { HermesJsonRecovery, recoverHermesJsonFromText } from "./hermesJson.js";
import { LlamaJsonRecovery, recoverLlamaJsonFromText } from "./llamaJson.js";
import { PythonicRecovery, recoverPythonicFromText } from "./pythonic.js";
import {
  type DialectTool,
  QwenXmlRecovery,
  type RecoveredCall,
  RECOVER_TEXT_TOOL_CALLS_ENV,
  RECOVER_TEXT_TOOL_CALLS_FIELD,
  recoverQwenXmlFromText,
  type RecoveryEvent,
} from "./qwenXml.js";

/** A stream-safe recovery stage for one text block. */
export interface TextToolRecovery {
  push(chunk: string): RecoveryEvent[];
  end(): RecoveryEvent[];
}

/** The dialect the request or environment asks for, if any. */
export function recoverySetting(
  body?: unknown,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const asked =
    (body as Record<string, unknown> | undefined)?.[
      RECOVER_TEXT_TOOL_CALLS_FIELD
    ] ?? env[RECOVER_TEXT_TOOL_CALLS_ENV];
  return typeof asked === "string" ? asked : undefined;
}

/** The dialects asked for: the setting is one name or a comma-separated list. */
export function recoverySettings(
  body?: unknown,
  env?: Record<string, string | undefined>,
): Set<string> {
  return new Set(
    (recoverySetting(body, env) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Whether `dialect` is asked for and applies to `model`. A plain name applies
 * to models whose id matches `nameRe`; `force:<name>` (what a model's
 * `toolDialect` config sets) applies whatever the model is called.
 */
function wants(
  settings: Set<string>,
  dialect: string,
  model: string,
  nameRe: RegExp,
): boolean {
  return (
    settings.has(`force:${dialect}`) ||
    (settings.has(dialect) && nameRe.test(model))
  );
}

/** The recovery stage for this model and setting, or undefined when off. */
export function createTextToolRecovery(
  model: string,
  tools: DialectTool[],
  body?: unknown,
  env?: Record<string, string | undefined>,
): TextToolRecovery | undefined {
  const settings = recoverySettings(body, env);
  if (wants(settings, "qwen-xml", model, /qwen/i)) {
    return new QwenXmlRecovery(tools);
  }
  if (wants(settings, "pythonic", model, /nova/i)) {
    return new PythonicRecovery(tools);
  }
  if (wants(settings, "llama-json", model, /llama/i)) {
    return new LlamaJsonRecovery(tools);
  }
  if (wants(settings, "hermes-json", model, /qwen|hermes/i)) {
    return new HermesJsonRecovery(tools);
  }
  if (wants(settings, "glm-xml", model, /glm/i)) {
    return new GlmXmlRecovery(tools);
  }
  return undefined;
}

/** One-shot form for a complete reply. */
export function recoverFromText(
  model: string,
  text: string,
  tools: DialectTool[],
  body?: unknown,
  env?: Record<string, string | undefined>,
): { text: string; calls: RecoveredCall[] } {
  const settings = recoverySettings(body, env);
  if (wants(settings, "qwen-xml", model, /qwen/i)) {
    return recoverQwenXmlFromText(text, tools);
  }
  if (wants(settings, "pythonic", model, /nova/i)) {
    return recoverPythonicFromText(text, tools);
  }
  if (wants(settings, "llama-json", model, /llama/i)) {
    return recoverLlamaJsonFromText(text, tools);
  }
  if (wants(settings, "hermes-json", model, /qwen|hermes/i)) {
    return recoverHermesJsonFromText(text, tools);
  }
  if (wants(settings, "glm-xml", model, /glm/i)) {
    return recoverGlmXmlFromText(text, tools);
  }
  return { text, calls: [] };
}

/** The tools of a Bedrock Converse `toolConfig`, as the dialects see them. */
export function dialectToolsFromConverse(
  toolConfig:
    | {
        tools?: ReadonlyArray<{
          toolSpec?: { name?: string; inputSchema?: { json?: unknown } };
        }>;
      }
    | undefined,
): DialectTool[] {
  const out: DialectTool[] = [];
  for (const t of toolConfig?.tools ?? []) {
    const spec = t.toolSpec;
    if (spec?.name) {
      out.push({ name: spec.name, parameters: spec.inputSchema?.json });
    }
  }
  return out;
}

/** A recovered call's id: Bedrock's id pattern, new for each call. */
export function recoveredCallId(index: number): string {
  return `recovered_${index}_${Math.random().toString(36).slice(2, 10)}`;
}
