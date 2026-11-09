import { MODEL_USES, PICKER_USES } from "./modelUse";

/**
 * Checks on the raw `modeModels:` of a config against its `models:`, for what
 * the CLI skips without a word. Pure: names in, warnings out, so core (at
 * config load) and the CLI (at start) report the same text.
 */

/** A model as `models:` lists it. */
export interface CheckedModel {
  name?: string;
  model?: string;
  provider: string;
  roles?: string[];
}

/** One entry of `modeModels:` as written. */
export interface CheckedModeModel {
  model?: string;
  models?: string[];
  reasoningEffort?: string;
}

export interface ModeModelsWarning {
  use: string;
  message: string;
}

/**
 * Providers whose adapter in the CLI ignores `reasoning_effort` in the request
 * body. OpenAI-compatible providers and bedrock apply it (ModelService
 * `withReasoningEffort`).
 *
 * This table must change when H1 (Anthropic thinking in the CLI, see
 * plans/ROADMAP.md Track H) lands: remove `anthropic` then.
 */
export const PROVIDERS_IGNORING_REASONING_EFFORT: ReadonlySet<string> = new Set(
  ["anthropic"],
);

const nameOf = (m: CheckedModel) => m.name ?? m.model;
const isChat = (m: CheckedModel) =>
  m.roles === undefined || m.roles.includes("chat");

/**
 * `modeModels` names that match no model, or (for every use but `reviewer`,
 * which may name any model) a model without the chat role. The CLI ignores
 * such an entry (`modelIndexForUse` returns -1).
 */
export function unusableModeModelNames(
  modeModels: Record<string, CheckedModeModel | undefined> | undefined,
  models: CheckedModel[],
): ModeModelsWarning[] {
  const warnings: ModeModelsWarning[] = [];
  for (const use of MODEL_USES) {
    const entry = modeModels?.[use];
    if (!entry) continue;
    const picker = (PICKER_USES as readonly string[]).includes(use);
    const names = [
      ...(entry.model !== undefined ? [entry.model] : []),
      ...(picker ? (entry.models ?? []) : []),
    ];
    for (const name of new Set(names)) {
      const found = models.find((m) => nameOf(m) === name);
      if (!found) {
        warnings.push({
          use,
          message: `modeModels.${use}: no model named "${name}", so the entry is ignored.`,
        });
      } else if (use !== "reviewer" && !isChat(found)) {
        warnings.push({
          use,
          message: `modeModels.${use}: "${name}" is not a chat model (its roles are ${(found.roles ?? []).join(", ") || "none"}), so the entry is ignored.`,
        });
      }
    }
  }
  return warnings;
}

/**
 * `reasoningEffort` on an entry whose model's provider does not apply it in
 * the CLI. Not checked for `reviewer`, which the CLI never gives an effort.
 */
export function ignoredReasoningEffort(
  modeModels: Record<string, CheckedModeModel | undefined> | undefined,
  models: CheckedModel[],
): ModeModelsWarning[] {
  const warnings: ModeModelsWarning[] = [];
  for (const use of MODEL_USES) {
    const entry = modeModels?.[use];
    if (!entry?.reasoningEffort || use === "reviewer") continue;
    const name = entry.model ?? entry.models?.[0];
    const found = models.find((m) => nameOf(m) === name);
    if (found && PROVIDERS_IGNORING_REASONING_EFFORT.has(found.provider)) {
      warnings.push({
        use,
        message: `modeModels.${use}: reasoningEffort "${entry.reasoningEffort}" is ignored by the CLI for provider "${found.provider}". Set the effort in the model's own options or pick a catalog variant.`,
      });
    }
  }
  return warnings;
}

/** Every check, for a surface that reports both (the CLI). */
export function checkModeModels(
  modeModels: Record<string, CheckedModeModel | undefined> | undefined,
  models: CheckedModel[],
): ModeModelsWarning[] {
  return [
    ...unusableModeModelNames(modeModels, models),
    ...ignoredReasoningEffort(modeModels, models),
  ];
}
