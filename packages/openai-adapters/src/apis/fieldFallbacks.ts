import type { BedrockRefusableField } from "@continuedev/llm-info";

/**
 * What the request-field policy learned at runtime (plans/ROADMAP.md C58):
 * a provider refused an optional field for a model, the request was sent
 * again without it and succeeded, and the model is remembered for the rest of
 * this process. In memory only, never saved: a persisted "model X refuses Y"
 * would outlive the day the provider adds support and could pin a transient
 * error as a fact. The client (the CLI) subscribes to tell the user once,
 * with the config line that makes the choice permanent and explicit.
 */
export interface FieldFallback {
  provider: "bedrock";
  model: string;
  field: BedrockRefusableField;
  /** The provider's message, for the notice and the log. */
  error: string;
  at: number;
}

const MAX_FALLBACKS = 50;
const fallbacks: FieldFallback[] = [];
const listeners = new Set<(fallback: FieldFallback) => void>();

/** Fields each model refused this process, applied before the next request. */
const refusedByModel = new Map<string, Set<BedrockRefusableField>>();

export function refusedFields(
  model: string,
): ReadonlySet<BedrockRefusableField> {
  return refusedByModel.get(model) ?? new Set();
}

export function rememberRefusedField(
  model: string,
  field: BedrockRefusableField,
): void {
  const set = refusedByModel.get(model) ?? new Set();
  set.add(field);
  refusedByModel.set(model, set);
}

export function recordFieldFallback(fallback: FieldFallback): void {
  rememberRefusedField(fallback.model, fallback.field);
  fallbacks.push(fallback);
  if (fallbacks.length > MAX_FALLBACKS) fallbacks.shift();
  for (const listener of listeners) {
    try {
      listener(fallback);
    } catch {
      // a listener's failure is not the request's
    }
  }
}

/** Every fallback this process made, oldest first. */
export function fieldFallbacks(): readonly FieldFallback[] {
  return fallbacks;
}

/** Called for each fallback as it happens; returns the unsubscribe. */
export function onFieldFallback(
  listener: (fallback: FieldFallback) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The config.yaml change that makes the fallback permanent for the model. */
export function fieldFallbackAdvice(field: BedrockRefusableField): string {
  switch (field) {
    case "cachePoint":
      return "To stop sending cache points to this model, set `defaultCompletionOptions.promptCaching: false` on it in config.yaml.";
    case "stopSequences":
      return "To stop sending stop sequences to this model, remove `stop` from its `defaultCompletionOptions` in config.yaml.";
  }
}

/** One line for the user: what was dropped, that the request went through, and the config line. */
export function formatFieldFallback(fallback: FieldFallback): string {
  const what =
    fallback.field === "cachePoint" ? "prompt cache points" : "stop sequences";
  return (
    `${fallback.model} refused ${what}; the request was sent again without them ` +
    `and will be for the rest of this run. ${fieldFallbackAdvice(fallback.field)}`
  );
}

/** Tests only: forget every fallback and every remembered refusal. */
export function resetFieldFallbacksForTests(): void {
  fallbacks.length = 0;
  refusedByModel.clear();
  listeners.clear();
}
