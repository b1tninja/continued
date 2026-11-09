import type { ConfigYaml } from "@continuedev/config-yaml";
import { MODEL_USES, PROMPT_USES } from "../../util/modelUse";
import { editConfigFile } from "../../util/paths";

/** Every use the Models tab can write; the list uses are chat, plan and agent. */
const MODES = MODEL_USES;

/**
 * One use's change from the Models tab. Fields left out are kept as they are
 * in config.yaml. `null` for `model`, `reasoningEffort`, `prompt` or `tail`
 * removes that field.
 */
export interface ModeModelChange {
  /** Default model when switching into the mode (by name). `null` removes it. */
  model?: string | null;
  /** Models offered in the mode (by name). `[]` removes the list. Chat, plan and agent only. */
  models?: string[];
  reasoningEffort?: "off" | "low" | "medium" | "high" | null;
  /**
   * Which system prompt the use gets: `full`, `short` or a prompt block's
   * name. Chat, plan, agent, loop and replan only.
   */
  prompt?: string | null;
  /**
   * The reminder on the use's user messages: `on`, `off` or a short text.
   * Chat, plan, agent, loop and replan only.
   */
  tail?: string | null;
}

const LIST_USES: readonly string[] = ["chat", "plan", "agent"];
const TURN_USES: readonly string[] = PROMPT_USES;

/** A mode set to `null` has its entry removed; modes not present are untouched. */
export type ModeModelsInput = Partial<
  Record<(typeof MODES)[number], ModeModelChange | null>
>;

export type ModeModelsUpdate = ModeModelsInput;

/**
 * Apply the Models-tab selection to a config.yaml object.
 *
 * Each mode in `update` either carries a default `model`, a `models` list, an
 * optional `reasoningEffort`, `prompt` and `tail`, or is `null` to remove the
 * mode's entry. Modes not mentioned are left exactly as they are. Within a
 * mode, fields the update does not mention (for example a hand-written
 * `reasoningEffort`) are kept; `models: []` removes the list, and `null`
 * removes a single field. `prompt` and `tail` are written for the turn uses
 * (chat, plan, agent, loop, replan) only; a mode keeps its entry on either of
 * them alone.
 *
 * Names are written as given. Whether they exist is checked when the config is
 * loaded (`resolveModeModels`), which reports unknown names without failing.
 */
export function applyModeModelsUpdate(
  config: ConfigYaml,
  update: ModeModelsUpdate,
): ConfigYaml {
  const next: Record<string, any> = { ...(config.modeModels ?? {}) };

  for (const mode of MODES) {
    if (!(mode in update)) continue;
    const change = update[mode];
    if (change === null || change === undefined) {
      delete next[mode];
      continue;
    }

    const entry: Record<string, any> = { ...(next[mode] ?? {}) };
    const models = dedupe(change.models);

    if (change.model === null) delete entry.model;
    else if (change.model !== undefined) entry.model = change.model;
    if (!LIST_USES.includes(mode)) {
      // A single-model use: a list means nothing there, so none is written
      // and `models` does not keep an entry alive.
      delete entry.models;
    } else if (change.models !== undefined) {
      if (models.length > 0) entry.models = models;
      else delete entry.models;
    }
    if (change.reasoningEffort !== undefined) {
      if (change.reasoningEffort === null) delete entry.reasoningEffort;
      else entry.reasoningEffort = change.reasoningEffort;
    }
    if (TURN_USES.includes(mode)) {
      if (change.prompt === null) delete entry.prompt;
      else if (change.prompt !== undefined) entry.prompt = change.prompt;
      if (change.tail === null) delete entry.tail;
      else if (change.tail !== undefined) entry.tail = change.tail;
    }

    // The schema needs `model`, a non-empty `models`, a `prompt` or a `tail`;
    // an entry with none would make the whole config invalid, so drop it
    // instead.
    if (
      entry.model === undefined &&
      !(entry.models?.length > 0) &&
      entry.prompt === undefined &&
      entry.tail === undefined
    ) {
      delete next[mode];
    } else {
      next[mode] = entry;
    }
  }

  const result: Record<string, any> = { ...config };
  if (Object.keys(next).length > 0) result.modeModels = next;
  else delete result.modeModels;
  return result as ConfigYaml;
}

function dedupe(names: string[] | undefined): string[] {
  const seen: string[] = [];
  for (const name of names ?? []) {
    if (typeof name === "string" && name !== "" && !seen.includes(name)) {
      seen.push(name);
    }
  }
  return seen;
}

/**
 * Write the update to the selected config, keeping comments and key order.
 * Returns false when the selected config is not a local YAML file, so
 * the caller can say so instead of silently doing nothing.
 */
export function saveModeModels(update: ModeModelsUpdate): boolean {
  let edited = false;
  editConfigFile(
    // config.json has no modeModels; leave it untouched.
    (config) => config,
    (config) => {
      edited = true;
      return applyModeModelsUpdate(config, update);
    },
  );
  return edited;
}
