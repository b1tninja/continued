/**
 * Recovery of tool calls a model wrote as text (plans/tool-dialects.md): the
 * one switch both Bedrock handlers (this package and core/llm/llms) use, so
 * the setting and the parsers exist once. Off unless asked for.
 */
import { MAX_HELD_CHARS } from "./heldRecovery.js";
import { recordRecovery } from "./recoveryStats.js";
import { DeepseekR1Recovery } from "./deepseekR1.js";
import { DeepseekV31Recovery } from "./deepseekV31.js";
import { DsmlRecovery } from "./dsml.js";
import { GlmXmlRecovery, recoverGlmXmlFromText } from "./glmXml.js";
import { HarmonyRecovery } from "./harmony.js";
import { HermesJsonRecovery, recoverHermesJsonFromText } from "./hermesJson.js";
import { KimiTokensRecovery } from "./kimiTokens.js";
import { KimiXtmlRecovery } from "./kimiXtml.js";
import { LlamaJsonRecovery, recoverLlamaJsonFromText } from "./llamaJson.js";
import { MinimaxNsRecovery } from "./minimaxNs.js";
import { MinimaxXmlRecovery } from "./minimaxXml.js";
import { MistralRecovery } from "./mistral.js";
import { PythonicRecovery, recoverPythonicFromText } from "./pythonic.js";
import { WRAPPER_ROWS, WrapperRecovery } from "./wrapperDialects.js";
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
  /**
   * The hold that began or ended since this was last called, once each: a
   * `"start"` after the push that began holding text, an `"end"` after the
   * `end()` that judged it, whatever the outcome (released as text, recovered
   * as calls, refused). Undefined when nothing changed. Call it after every
   * `push` and `end`; a stage that never holds text has none.
   */
  takeHoldSignal?(): HoldPhase | undefined;
  /** Whether the hold cap released held text since this was last called. */
  takeCapReleased?(): boolean;
}

/** A held reply began (`start`) or was judged (`end`). */
export type HoldPhase = "start" | "end";

/**
 * Wraps a stage for one model and dialect. It counts outcomes
 * (recoveryStats.ts) and is the one place a recovery failure is contained: a
 * stage that throws, in `push` or `end`, must never end the turn or lose the
 * reply, so the text it had not yet released goes out as text, the failure is
 * counted as a recovery error, and the stage is not used again. Held text is
 * also capped (MAX_HELD_CHARS) for stages that do not cap it themselves.
 */
class CountedRecovery implements TextToolRecovery {
  private pendingHold: HoldPhase | undefined;
  /** Input the stage has taken but not yet released as text. */
  private unreleased = "";
  /** Set after a stage failure: from then on text passes straight through. */
  private broken = false;
  /** Set when the hold cap was hit: text passes through until `end`. */
  private capped = false;

  constructor(
    private readonly inner: TextToolRecovery,
    private readonly model: string,
    private readonly dialect: string,
  ) {}

  private text(text: string): RecoveryEvent[] {
    return text ? [{ type: "text", text }] : [];
  }

  /** Release everything not yet released, and stop using the stage. */
  private failOpen(): RecoveryEvent[] {
    const out = this.text(this.unreleased);
    this.unreleased = "";
    this.broken = true;
    this.pendingHold = "end";
    recordRecovery(this.model, this.dialect, { recoveryErrors: 1 });
    return out;
  }

  private settle(events: RecoveryEvent[]): void {
    for (const e of events) {
      if (e.type === "text") {
        this.unreleased = this.unreleased.slice(e.text.length);
      }
    }
    if (events.some((e) => e.type === "call")) this.unreleased = "";
  }

  private countCap(): void {
    this.pendingHold = "end";
    recordRecovery(this.model, this.dialect, {
      held: 1,
      releasedAsText: 1,
      releasedAtCap: 1,
    });
  }

  push(chunk: string): RecoveryEvent[] {
    if (this.broken || this.capped) return this.text(chunk);
    const wasHolding = this.isHolding();
    this.unreleased += chunk;
    let events: RecoveryEvent[];
    try {
      events = this.inner.push(chunk);
      this.settle(events);
    } catch {
      return this.failOpen();
    }
    if (!wasHolding && this.isHolding()) this.pendingHold = "start";
    if (this.inner.takeCapReleased?.()) {
      this.countCap();
    } else if (
      !this.inner.takeCapReleased &&
      this.isHolding() &&
      this.unreleased.length > MAX_HELD_CHARS
    ) {
      events = [...events, ...this.text(this.unreleased)];
      this.unreleased = "";
      this.capped = true;
      this.countCap();
    }
    return events;
  }

  isHolding(): boolean {
    return !this.broken && !this.capped && (this.inner.isHolding?.() ?? false);
  }

  takeHoldSignal(): HoldPhase | undefined {
    const phase = this.pendingHold;
    this.pendingHold = undefined;
    return phase;
  }

  end(): RecoveryEvent[] {
    if (this.broken) return [];
    const held = this.isHolding();
    let events: RecoveryEvent[];
    try {
      events = this.inner.end();
    } catch {
      return this.failOpen();
    }
    if (this.capped) {
      // The held text went out when the cap was hit; the stage's copy is dropped.
      this.capped = false;
      return [];
    }
    this.unreleased = "";
    if (held) {
      this.pendingHold = "end";
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
  for (const row of WRAPPER_ROWS) {
    if (wants(settings, row.dialect, model, row.nameRe)) {
      return { dialect: row.dialect, stage: new WrapperRecovery(tools, row) };
    }
  }
  return chooseOtherRecovery(model, tools, settings);
}

/** The stages for the Harmony, Mistral and DeepSeek forms. */
function chooseOtherRecovery(
  model: string,
  tools: DialectTool[],
  settings: Set<string>,
): { dialect: string; stage: TextToolRecovery } | undefined {
  if (wants(settings, "harmony", model, /gpt-oss/i)) {
    return { dialect: "harmony", stage: new HarmonyRecovery(tools) };
  }
  if (
    wants(settings, "mistral", model, /mistral|mixtral|devstral|magistral/i)
  ) {
    return { dialect: "mistral", stage: new MistralRecovery(tools) };
  }
  if (wants(settings, "dsml", model, /deepseek/i)) {
    return { dialect: "dsml", stage: new DsmlRecovery(tools) };
  }
  if (wants(settings, "deepseek-v31", model, /deepseek/i)) {
    return { dialect: "deepseek-v31", stage: new DeepseekV31Recovery(tools) };
  }
  if (wants(settings, "deepseek-r1", model, /deepseek/i)) {
    return { dialect: "deepseek-r1", stage: new DeepseekR1Recovery(tools) };
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
