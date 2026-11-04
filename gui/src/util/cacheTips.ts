import type { ModelDescription } from "core";
import { bedrockRegionalPriceFactor } from "core/llm/utils/calculateRequestCost";
import {
  configEnablesPromptCaching,
  configTtlPolicy,
  modelSupportsOneHourCache,
  modelSupportsPromptCacheControl,
  type PromptCacheSetting,
} from "./promptCache";

/**
 * Advice about the model and cache settings in use. Each tip comes from a
 * vendor's documentation (named in the comment on the rule), says what to
 * change, and says when the advice does not apply.
 */
export interface CacheTip {
  /** Stable, used to remember a dismissal. */
  id: string;
  severity: "warning" | "info";
  title: string;
  body: string;
  /** A model ID to try, shown so it can be copied into config.yaml. */
  suggestion?: string;
}

/** `us.anthropic.claude-sonnet-4-6` -> `global.anthropic.claude-sonnet-4-6`. */
export function globalModelId(modelId: string): string {
  return modelId.replace(/^(us|eu|apac|jp|au|ca)\./i, "global.");
}

/** The key under which a dismissal is stored. */
export function cacheTipKey(modelTitle: string, tipId: string): string {
  return `${modelTitle}::${tipId}`;
}

export function cacheTips(
  model: ModelDescription | null | undefined,
  setting: PromptCacheSetting | undefined,
): CacheTip[] {
  if (!model) return [];
  const tips: CacheTip[] = [];

  // Anthropic's pricing page: "Regional and multi-region endpoints include a
  // 10 percent premium over global endpoints" (Sonnet 4.5, Haiku 4.5, Opus 4.5
  // and later). On Bedrock the endpoint type is the model ID's prefix.
  if (model.provider?.toLowerCase() === "bedrock") {
    const factor = bedrockRegionalPriceFactor(model.model);
    if (factor > 1) {
      const percent = Math.round((factor - 1) * 100);
      tips.push({
        id: "regional-premium",
        severity: "warning",
        title: `Regional endpoints cost ${percent}% more`,
        body:
          `This model ID uses a regional endpoint, which Anthropic prices ${percent}% above a global one, ` +
          `on input, output and cache reads and writes. If your data does not have to stay in that geography, ` +
          `try the global ID if one exists for this model. Global endpoints can route a request to any region, ` +
          `so keep the regional one when data residency matters.`,
        suggestion: globalModelId(model.model),
      });
    }
  }

  // AWS Bedrock prompt caching guide: only the models in its table take a
  // 1-hour `ttl`; sending one to the others "can result in a
  // ValidationException", so Continued sends the 5-minute default instead.
  if (modelSupportsPromptCacheControl(model)) {
    const on =
      setting === undefined
        ? configEnablesPromptCaching(model)
        : setting !== "off";
    const policy = setting ?? configTtlPolicy(model);
    if (on && !modelSupportsOneHourCache(model)) {
      if (policy === "1h") {
        tips.push({
          id: "one-hour-unavailable",
          severity: "warning",
          title: "1 hour is not available for this model",
          body: "Bedrock lists a 1-hour cache only for some models, and this is not one of them. Requests use the 5-minute lifetime instead, so a pause longer than 5 minutes rewrites the whole conversation.",
        });
      } else if (policy === "auto") {
        tips.push({
          id: "one-hour-unavailable",
          severity: "info",
          title: "Auto stays at 5 minutes for this model",
          body: "Auto moves to a 1-hour cache after a pause or several requests, but Bedrock lists a 1-hour cache only for some models and this is not one of them.",
        });
      }
    }
  }

  return tips;
}
