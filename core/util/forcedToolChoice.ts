/**
 * The first consumer of the constraint facts (Track PL, PL7): whether a forced
 * (named) tool choice may be sent to a surface. Opt-in: with the environment
 * variable unset nothing is read and every request is byte-identical to before.
 * With it set, a surface whose facts say a named choice is not supported (the
 * Claude 5.5 generation answers HTTP 400) gets the request without it, which
 * the API reads as `auto`: a degradation, allowed from a declared or measured
 * fact (`actionAllowed("disableTools")`), never from a derived one.
 */
import {
  actionAllowed,
  resolveFact,
  surfaceFamily,
  type SurfaceQuery,
} from "./surfaceFacts.js";

export const SURFACE_FACTS_ENV = "CONTINUE_SURFACE_FACTS";

export function surfaceFactsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[SURFACE_FACTS_ENV];
  return v === "1" || v === "true";
}

/** True unless the opt-in is on and a fact allowed to disable says named is refused. */
export function namedToolChoiceAllowed(
  query: SurfaceQuery,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!surfaceFactsEnabled(env)) return true;
  const fact = resolveFact("toolChoice", query);
  if (fact.value?.named !== false) return true;
  return !actionAllowed("disableTools", fact);
}

/** The Anthropic Messages surface for a model id, with its named generation. */
export function anthropicSurface(modelId: string | undefined): SurfaceQuery {
  return {
    provider: "anthropic",
    api: "messages",
    modelFamily: surfaceFamily(undefined, modelId),
  };
}
