import type { Usage } from "core/index.js";
import { totalInputTokens } from "core/llm/utils/cacheStats.js";

/**
 * What the session's prompt cache did, counted per request as it happens.
 * Kept apart from the session's token totals on purpose: those add up the
 * provider's own counts, and a Claude request's `promptTokens` leaves out the
 * cache while a GPT request's includes it, so a hit share taken from the sums
 * of a mixed session would be wrong. In memory only; counts, no content.
 */
interface CacheTally {
  requests: number;
  inputTokens: number;
  readTokens: number;
  writeTokens: number;
}

const EMPTY: CacheTally = {
  requests: 0,
  inputTokens: 0,
  readTokens: 0,
  writeTokens: 0,
};
let tally: CacheTally = { ...EMPTY };

export function resetCacheTally(): void {
  tally = { ...EMPTY };
}

export function getCacheTally(): Readonly<CacheTally> {
  return { ...tally };
}

/** Add one finished request. `usage.promptTokens` is the provider's own count. */
export function recordCacheTally(
  provider: string,
  model: string,
  usage: Usage,
): void {
  const total = totalInputTokens(provider, model, usage);
  if (!(total > 0)) return;
  const d = usage.promptTokensDetails;
  tally.requests += 1;
  tally.inputTokens += total;
  tally.readTokens += d?.cachedTokens ?? 0;
  tally.writeTokens += d?.cacheWriteTokens ?? 0;
}

const n = (value: number) => value.toLocaleString("en-US");

/**
 * One line for the end of a session, or undefined when no request read or
 * wrote the cache (nothing to report, and no point suggesting it was used).
 * It does not say whether a miss happened: the CLI does not check for those.
 */
export function formatCacheTally(
  t: Readonly<CacheTally> = tally,
): string | undefined {
  if (t.requests === 0 || t.inputTokens <= 0) return undefined;
  if (t.readTokens === 0 && t.writeTokens === 0) return undefined;
  const share = Math.round((t.readTokens / t.inputTokens) * 100);
  const requests = `${n(t.requests)} request${t.requests === 1 ? "" : "s"}`;
  return (
    `Prompt cache: ${requests}, ${share}% of input read from the cache ` +
    `(${n(t.readTokens)} of ${n(t.inputTokens)} tokens), ` +
    `${n(t.writeTokens)} tokens written`
  );
}
