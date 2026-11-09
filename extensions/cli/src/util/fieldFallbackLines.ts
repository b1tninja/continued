import {
  type FieldFallback,
  fieldFallbackAdvice,
  fieldFallbacks,
} from "@continuedev/openai-adapters";

/**
 * The exit summary's lines about request fields a model refused during this
 * run and the adapter sent without (the request-field policy,
 * plans/ROADMAP.md C58): one line per model and field, however many requests
 * fell back, each with the config line that makes it permanent.
 */
export function fieldFallbackLines(
  list: readonly FieldFallback[] = fieldFallbacks(),
): string[] {
  const seen = new Map<string, FieldFallback>();
  for (const fallback of list) {
    seen.set(`${fallback.model}\u0000${fallback.field}`, fallback);
  }
  return [...seen.values()].map((fallback) => {
    const what =
      fallback.field === "cachePoint"
        ? "prompt cache points"
        : "stop sequences";
    return `Sent without ${what}: ${fallback.model} refused them (${firstLine(fallback.error)}). ${fieldFallbackAdvice(fallback.field)}`;
  });
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
