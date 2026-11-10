/**
 * Recovery of tool calls a model wrote as text (plans/tool-dialects.md): the
 * one switch both Bedrock handlers (this package and core/llm/llms) use, so
 * the setting and the parsers exist once. Off unless asked for.
 */
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

/** The recovery stage for this model and setting, or undefined when off. */
export function createTextToolRecovery(
  model: string,
  tools: DialectTool[],
  body?: unknown,
  env?: Record<string, string | undefined>,
): TextToolRecovery | undefined {
  const settings = recoverySettings(body, env);
  if (settings.has("qwen-xml") && /qwen/i.test(model)) {
    return new QwenXmlRecovery(tools);
  }
  if (settings.has("pythonic") && /nova/i.test(model)) {
    return new PythonicRecovery(tools);
  }
  if (settings.has("llama-json") && /llama/i.test(model)) {
    return new LlamaJsonRecovery(tools);
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
  if (settings.has("qwen-xml") && /qwen/i.test(model)) {
    return recoverQwenXmlFromText(text, tools);
  }
  if (settings.has("pythonic") && /nova/i.test(model)) {
    return recoverPythonicFromText(text, tools);
  }
  if (settings.has("llama-json") && /llama/i.test(model)) {
    return recoverLlamaJsonFromText(text, tools);
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
