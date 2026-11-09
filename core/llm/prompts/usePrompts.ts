import type { ModeModelsConfig, ModelUse } from "../..";
import { USE_FALLBACK } from "../../util/modelUse";
import {
  ACT_TURN_TAIL,
  actTurn,
  actTurnFor,
  actTurnShort,
  IDE_TURN_TOOL_NAMES,
  PLAN_TURN_TAIL,
  planTurn,
  planTurnFor,
  planTurnShort,
  promptProfile,
  PromptProfile,
  TurnToolNames,
} from "./turns";

/**
 * Which system prompt a use gets (`modeModels.<use>.prompt`). The model and
 * the prompt are one decision: a small model on Loop items wants the short
 * turn text, a strong one planning wants the full text, and a team may want
 * its own text for a use. Design: plans/policy-areas.md, docs/reference.mdx.
 */

/** The two built-in texts a use can ask for by name. */
export const PROMPT_PROFILES: readonly PromptProfile[] = ["full", "short"];

/**
 * A use's prompt, resolved: one of the built-in profiles, or the text of a
 * prompt block from `prompts:` in config.yaml, which replaces the turn text.
 */
export type PromptChoice =
  | { profile: PromptProfile; text?: undefined }
  | { profile?: undefined; text: string };

export function isPromptProfile(value: unknown): value is PromptProfile {
  return typeof value === "string" && PROMPT_PROFILES.includes(value as never);
}

/**
 * The prompt choice for a use from the resolved `modeModels`: the use's own
 * `prompt`, else its fallback's (`loop` → `agent`, `replan` → `plan`). The
 * prompt falls back on its own, so a `loop` entry that only names a model
 * still takes the agent entry's prompt. Undefined means the model's prompt
 * profile decides (core/llm/prompts/turns.ts).
 */
export function promptChoiceFor(
  modeModels: ModeModelsConfig | undefined,
  use: ModelUse,
): PromptChoice | undefined {
  if (!modeModels) return undefined;
  const fallback = USE_FALLBACK[use];
  const entries = [modeModels[use], fallback && modeModels[fallback]];
  for (const entry of entries) {
    if (!entry?.prompt) continue;
    if (entry.promptText !== undefined) return { text: entry.promptText };
    if (isPromptProfile(entry.prompt)) return { profile: entry.prompt };
  }
  return undefined;
}

/**
 * The same choice read from a config that is not resolved yet (the CLI reads
 * `modeModels` as written): a profile name as is, a block name looked up in
 * `prompts`. An unknown name is ignored, as resolveModeModels reports it.
 */
export function promptChoiceFromRaw(
  rawModeModels: unknown,
  prompts: readonly { name: string; prompt: string }[] | undefined,
  use: ModelUse,
): PromptChoice | undefined {
  if (!rawModeModels || typeof rawModeModels !== "object") return undefined;
  const raw = rawModeModels as Record<string, { prompt?: unknown } | undefined>;
  const fallback = USE_FALLBACK[use];
  for (const key of [use, fallback]) {
    const prompt = key ? raw[key]?.prompt : undefined;
    if (typeof prompt !== "string" || !prompt) continue;
    if (isPromptProfile(prompt)) return { profile: prompt };
    const block = prompts?.find((p) => p.name === prompt);
    if (block) return { text: block.prompt };
  }
  return undefined;
}

/** Which turn text a use is built on. */
export function turnKindForUse(use: ModelUse): "chat" | "plan" | "act" {
  if (use === "chat") return "chat";
  if (use === "plan" || use === "replan") return "plan";
  return "act";
}

/**
 * The act turn's text for a model and a choice: the block's text, the named
 * profile, or the profile the model id selects.
 */
export function actTurnTextFor(
  model: string | undefined,
  choice: PromptChoice | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  if (choice?.text !== undefined) return choice.text;
  if (choice?.profile === "short") return actTurnShort(names);
  if (choice?.profile === "full") return actTurn(names);
  return actTurnFor(model, names);
}

/** The plan turn's text for a model and a choice (see actTurnTextFor). */
export function planTurnTextFor(
  model: string | undefined,
  choice: PromptChoice | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  if (choice?.text !== undefined) return choice.text;
  if (choice?.profile === "short") return planTurnShort(names);
  if (choice?.profile === "full") return planTurn(names);
  return planTurnFor(model, names);
}

/*
 * The tail: a one-line reminder on the newest user message of a request
 * (`modeModels.<use>.tail`). A per-use addition on the same model goes here
 * and not in the system prompt: a prompt cache matches on the longest shared
 * prefix and the system prompt comes first, so swapping it per use throws
 * away the whole conversation's cache, while a line on the newest message
 * leaves the system prompt and the history before it byte-identical. Small
 * models (Nova 2 Lite, Qwen3 Coder) were seen to stop after announcing a
 * step; the tail keeps the turn's rule close without touching the prefix.
 */

/** `modeModels.<use>.tail` as written: on, off or a text (a boolean too, from a YAML 1.1 parser). */
export type TurnTailSetting = "on" | "off" | boolean | string;

/**
 * The tail setting for a use: its own, else its fallback's (`loop` → `agent`,
 * `replan` → `plan`), like the prompt. Undefined when neither sets one.
 */
function tailSettingFor(
  entries: readonly ({ tail?: TurnTailSetting } | undefined)[],
): TurnTailSetting | undefined {
  for (const entry of entries) {
    if (entry?.tail !== undefined) return entry.tail;
  }
  return undefined;
}

/**
 * The built-in line of a use's turn kind: the act line for Agent and Loop
 * items, the plan line for Plan and re-plans. Chat has none, so `on` adds
 * nothing there; a text does.
 */
export function builtInTailFor(
  use: ModelUse,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string | undefined {
  const kind = turnKindForUse(use);
  if (kind === "act") return ACT_TURN_TAIL;
  if (kind === "plan") return PLAN_TURN_TAIL(names);
  return undefined;
}

/**
 * The text to append to the newest user message of a request for a use, or
 * undefined for none. The setting is the use's own `tail`, else its
 * fallback's. Without one: on for Loop items (a small model on an item is the
 * case the line was written for) and wherever the turn text is the `short`
 * profile, by the use's prompt choice or, failing that, the model id; off
 * elsewhere. `on` is the built-in line of the turn kind; a text is used as
 * given. The reviewer and subagents never get one.
 */
export function tailFor(
  modeModels: ModeModelsConfig | undefined,
  use: ModelUse,
  modelId: string | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
  choice: PromptChoice | undefined = promptChoiceFor(modeModels, use),
): string | undefined {
  if (use === "reviewer" || use === "subagent") return undefined;
  const fallback = USE_FALLBACK[use];
  const setting = tailSettingFor([
    modeModels?.[use],
    fallback ? modeModels?.[fallback] : undefined,
  ]);
  return tailText(setting, use, modelId, names, choice);
}

/**
 * The same from a config that is not resolved yet (the CLI reads
 * `modeModels` as written). `prompts` resolves a block name for the default.
 */
export function tailFromRaw(
  rawModeModels: unknown,
  prompts: readonly { name: string; prompt: string }[] | undefined,
  use: ModelUse,
  modelId: string | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string | undefined {
  if (use === "reviewer" || use === "subagent") return undefined;
  const raw =
    rawModeModels && typeof rawModeModels === "object"
      ? (rawModeModels as Record<string, { tail?: unknown } | undefined>)
      : undefined;
  const fallback = USE_FALLBACK[use];
  const entries = [use, fallback].map((key) => {
    const tail = key ? raw?.[key]?.tail : undefined;
    return typeof tail === "string" || typeof tail === "boolean"
      ? { tail }
      : undefined;
  });
  return tailText(
    tailSettingFor(entries),
    use,
    modelId,
    names,
    promptChoiceFromRaw(rawModeModels, prompts, use),
  );
}

function tailText(
  setting: TurnTailSetting | undefined,
  use: ModelUse,
  modelId: string | undefined,
  names: TurnToolNames,
  choice: PromptChoice | undefined,
): string | undefined {
  if (setting === "off" || setting === false) return undefined;
  if (setting === undefined) {
    const profile =
      choice?.text !== undefined
        ? undefined
        : (choice?.profile ?? promptProfile(modelId));
    if (use !== "loop" && profile !== "short") return undefined;
    return builtInTailFor(use, names);
  }
  if (setting === "on" || setting === true) return builtInTailFor(use, names);
  return setting.trim() || undefined;
}

/**
 * The messages with the tail appended to the newest user message, and to
 * that one only: every message before it, the system message first of all,
 * is returned as it is, so the request's prefix is the same with or without
 * the tail. A string content gets the line after a blank line; a list of
 * parts gets one more text part. Without a tail, or without a user message,
 * the same array comes back.
 */
export function withTurnTail<M extends { role: string; content?: unknown }>(
  messages: readonly M[],
  tail: string | undefined,
): M[] {
  if (!tail) return messages as M[];
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      index = i;
      break;
    }
  }
  if (index === -1) return messages as M[];
  const newest = messages[index];
  const { content } = newest;
  let appended: M;
  if (typeof content === "string") {
    appended = { ...newest, content: content ? `${content}\n\n${tail}` : tail };
  } else if (Array.isArray(content)) {
    appended = {
      ...newest,
      content: [...content, { type: "text", text: tail }],
    };
  } else {
    return messages as M[];
  }
  return [...messages.slice(0, index), appended, ...messages.slice(index + 1)];
}
