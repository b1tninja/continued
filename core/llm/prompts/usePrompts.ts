import type { ModeModelsConfig, ModelUse } from "../..";
import { USE_FALLBACK } from "../../util/modelUse";
import {
  actTurn,
  actTurnFor,
  actTurnShort,
  IDE_TURN_TOOL_NAMES,
  planTurn,
  planTurnFor,
  planTurnShort,
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
