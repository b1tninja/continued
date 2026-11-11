/**
 * Recovery of tool calls a model wrote as text (plans/tool-dialects.md): the
 * one switch both Bedrock handlers (this package and core/llm/llms) use, so
 * the setting and the parsers exist once. Off unless asked for.
 */
import { recordRecovery } from "./recoveryStats.js";
import { GlmXmlRecovery, recoverGlmXmlFromText } from "./glmXml.js";
import { HermesJsonRecovery, recoverHermesJsonFromText } from "./hermesJson.js";
import { KimiTokensRecovery } from "./kimiTokens.js";
import { KimiXtmlRecovery } from "./kimiXtml.js";
import { LlamaJsonRecovery, recoverLlamaJsonFromText } from "./llamaJson.js";
import { MinimaxNsRecovery } from "./minimaxNs.js";
import { MinimaxXmlRecovery } from "./minimaxXml.js";
import { PythonicRecovery, recoverPythonicFromText } from "./pythonic.js";
import { ToolcallJsonRecovery } from "./toolcallJson.js";
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
  /** Whether a block is held right now (so `end` judges it). */
  isHolding?(): boolean;
}

/** Counts a stage's outcomes (recoveryStats.ts); behaviour is unchanged. */
class CountedRecovery implements TextToolRecovery {
  constructor(
    private readonly inner: TextToolRecovery,
    private readonly model: string,
    private readonly dialect: string,
  ) {}

  push(chunk: string): RecoveryEvent[] {
    return this.inner.push(chunk);
  }

  isHolding(): boolean {
    return this.inner.isHolding?.() ?? false;
  }

  end(): RecoveryEvent[] {
    const held = this.isHolding();
    const events = this.inner.end();
    if (held) {
      const recovered = events.filter((e) => e.type === "call").length;
      recordRecovery(this.model, this.dialect, {
        held: 1,
        recovered,
        releasedAsText: recovered === 0 ? 1 : 0,
      });
    }
    return events;
  }
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

/** The recovery stage and its dialect for this model and setting. */
function chooseRecovery(
  model: string,
  tools: DialectTool[],
  body?: unknown,
  env?: Record<string, string | undefined>,
): { dialect: string; stage: TextToolRecovery } | undefined {
  const settings = recoverySettings(body, env);
  if (wants(settings, "qwen-xml", model, /qwen/i)) {
    return { dialect: "qwen-xml", stage: new QwenXmlRecovery(tools) };
  }
  if (wants(settings, "pythonic", model, /nova/i)) {
    return { dialect: "pythonic", stage: new PythonicRecovery(tools) };
  }
  if (wants(settings, "llama-json", model, /llama/i)) {
    return { dialect: "llama-json", stage: new LlamaJsonRecovery(tools) };
  }
  if (wants(settings, "hermes-json", model, /qwen|hermes/i)) {
    return { dialect: "hermes-json", stage: new HermesJsonRecovery(tools) };
  }
  if (wants(settings, "glm-xml", model, /glm/i)) {
    return { dialect: "glm-xml", stage: new GlmXmlRecovery(tools) };
  }
  if (wants(settings, "kimi-tokens", model, /kimi|moonshot/i)) {
    return { dialect: "kimi-tokens", stage: new KimiTokensRecovery(tools) };
  }
  if (wants(settings, "kimi-xtml", model, /kimi|moonshot/i)) {
    return { dialect: "kimi-xtml", stage: new KimiXtmlRecovery(tools) };
  }
  if (wants(settings, "minimax-xml", model, /minimax/i)) {
    return { dialect: "minimax-xml", stage: new MinimaxXmlRecovery(tools) };
  }
  if (wants(settings, "minimax-ns-xml", model, /minimax/i)) {
    return { dialect: "minimax-ns-xml", stage: new MinimaxNsRecovery(tools) };
  }
  if (wants(settings, "toolcall-json", model, /nemotron/i)) {
    return { dialect: "toolcall-json", stage: new ToolcallJsonRecovery(tools) };
  }
  return undefined;
}

/** The recovery stage for this model and setting, or undefined when off. */
export function createTextToolRecovery(
  model: string,
  tools: DialectTool[],
  body?: unknown,
  env?: Record<string, string | undefined>,
): TextToolRecovery | undefined {
  const chosen = chooseRecovery(model, tools, body, env);
  return chosen
    ? new CountedRecovery(chosen.stage, model, chosen.dialect)
    : undefined;
}

/** One-shot form for a complete reply. */
export function recoverFromText(
  model: string,
  text: string,
  tools: DialectTool[],
  body?: unknown,
  env?: Record<string, string | undefined>,
): { text: string; calls: RecoveredCall[] } {
  const stage = createTextToolRecovery(model, tools, body, env);
  if (!stage) return { text, calls: [] };
  const events = [...stage.push(text), ...stage.end()];
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
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

/** What every recovered call's id begins with. */
export const RECOVERED_CALL_ID_PREFIX = "recovered_";

/** Whether a tool call id is one recovery made (not one the model sent). */
export function isRecoveredCallId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(RECOVERED_CALL_ID_PREFIX);
}

/** A recovered call's id: Bedrock's id pattern, new for each call. */
export function recoveredCallId(index: number): string {
  return `${RECOVERED_CALL_ID_PREFIX}${index}_${Math.random().toString(36).slice(2, 10)}`;
}
