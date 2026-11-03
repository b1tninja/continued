import type { ModelDescription } from "core";
import {
  findAnthropicPricing,
  type ModelPricing,
} from "core/llm/utils/calculateRequestCost";
import {
  AUTO_ESCALATE_MAX_GAP_MS,
  AUTO_ESCALATE_MIN_GAP_MS,
  modelSupportsOneHourCache,
  modelSupportsPromptCacheControl,
  promptCacheStatus,
  PROMPT_CACHE_TTL_MS,
  type PromptCacheKey,
  type PromptCacheSessionState,
  type PromptCacheSetting,
  type PromptCacheTtl,
} from "./promptCache";

/**
 * Rules for when the app warns about a cost the user may not expect. Every
 * threshold is here so they can be tuned in one place. The reasoning behind
 * them is in plans/cache-safeguards.md.
 */

/** A notice or confirmation needs at least this much extra cost at stake. */
export const NOTICE_MIN_EXTRA_USD = 0.25;
/** The same bar in tokens, for models with no price in the table. */
export const NOTICE_MIN_TOKENS_UNPRICED = 100_000;
/** The context meter shows from this size, whatever share of the window it is. */
export const CONTEXT_METER_TOKENS = 200_000;
/** A model with a long-context price tier is flagged this far below its limit. */
export const LONG_CONTEXT_WARN_FRACTION = 0.8;

/** What a request would cost beyond a cache hit for the same prompt. */
export interface CacheLoss {
  tokens: number;
  /** Undefined when the model has no price in the table. */
  extraUsd?: number;
}

/** Extra dollars to write `tokens` to the cache instead of reading them. */
export function missExtraUsd(
  pricing: ModelPricing,
  tokens: number,
  ttl: PromptCacheTtl,
): number {
  const write = ttl === "1h" ? pricing.cacheWrite1h : pricing.cacheWrite;
  return (tokens / 1_000_000) * (write - pricing.cacheRead);
}

function lossOf(
  model: ModelDescription,
  tokens: number,
  ttl: PromptCacheTtl,
): CacheLoss {
  const pricing = findAnthropicPricing(model.model, tokens);
  return {
    tokens,
    extraUsd: pricing ? missExtraUsd(pricing, tokens, ttl) : undefined,
  };
}

/** Whether a loss is big enough to interrupt the user about. */
export function isSignificantLoss(loss: CacheLoss | undefined): boolean {
  if (!loss) return false;
  return loss.extraUsd !== undefined
    ? loss.extraUsd >= NOTICE_MIN_EXTRA_USD
    : loss.tokens >= NOTICE_MIN_TOKENS_UNPRICED;
}

/**
 * What changing something that invalidates the cache (the model, the mode's
 * system prompt and tools) would cost right now. Undefined when nothing is at
 * stake: caching is off, the cache is cold, or the size is not known yet.
 */
export function warmCacheLoss(
  model: ModelDescription,
  setting: PromptCacheSetting | undefined,
  state: PromptCacheSessionState,
  now: number,
  /** The model the prompt would be sent to next, if not `model`. */
  target: ModelDescription = model,
): CacheLoss | undefined {
  if (!modelSupportsPromptCacheControl(model)) return undefined;
  const status = promptCacheStatus(model, setting, state, now);
  if (!status.on || !status.warm || !state.lastInputTokens) return undefined;
  return lossOf(target, state.lastInputTokens, status.ttl);
}

export interface ColdResume extends CacheLoss {
  /** Time since the last request started. */
  idleMs: number;
}

/**
 * The cost of sending the next message when the cache has expired: the whole
 * conversation is written again instead of read. Undefined while the cache is
 * warm or off, before any request, or when the amount is below the bar.
 */
export function coldResume(
  model: ModelDescription,
  setting: PromptCacheSetting | undefined,
  state: PromptCacheSessionState,
  now: number,
): ColdResume | undefined {
  if (!modelSupportsPromptCacheControl(model)) return undefined;
  const status = promptCacheStatus(model, setting, state, now);
  if (!status.on || status.warm) return undefined;
  if (state.lastRequestAt === undefined || !state.lastInputTokens) {
    return undefined;
  }
  const idleMs = now - state.lastRequestAt;

  // Auto moves to 1 hour on this very request after a pause 1 hour covers.
  let ttl = status.ttl;
  if (
    setting === "auto" &&
    idleMs > AUTO_ESCALATE_MIN_GAP_MS &&
    idleMs <= AUTO_ESCALATE_MAX_GAP_MS
  ) {
    ttl = "1h";
  }
  if (ttl === "1h" && !modelSupportsOneHourCache(model)) ttl = "5m";

  const loss = lossOf(model, state.lastInputTokens, ttl);
  return isSignificantLoss(loss) ? { ...loss, idleMs } : undefined;
}

/** A short stable hash, enough to tell whether a string changed. */
function hashString(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * What the cached prefix is made of. The API caches tools, then the system
 * prompt, then messages, so a change to the model, the tools or the system
 * prompt rebuilds everything after it.
 */
export function promptCacheKey(
  model: ModelDescription,
  toolNames: string[],
  systemMessage: string | undefined,
): PromptCacheKey {
  return {
    model: `${model.provider}/${model.model}`,
    tools: hashString(toolNames.join("\u0000")),
    system: hashString(systemMessage ?? ""),
  };
}

/** The parts of the key that differ, as words for a message. */
export function keyChanges(
  before: PromptCacheKey | undefined,
  after: PromptCacheKey,
): string[] {
  if (!before) return [];
  const changes: string[] = [];
  if (before.model !== after.model) changes.push("the model");
  if (before.tools !== after.tools) changes.push("the tools");
  if (before.system !== after.system) changes.push("the system prompt");
  return changes;
}

export const MISS_MIN_PREFIX_TOKENS = 50_000;
/** The miss notice appears after this many unseen misses in a session. */
export const MISS_NOTICE_AFTER = 3;
/**
 * A draft this big (typed, pasted or as code blocks) gets a notice before it
 * is sent: about 120 KB of text at 4 characters per token. It is sent again
 * with every later message, so a big paste is a cost the user can avoid
 * before it is incurred. The size is a guess; tune it from real use.
 */
export const LARGE_MESSAGE_TOKENS = 30_000;
/** A request that read less than this share of the previous prompt missed. */
export const MISS_READ_SHARE = 0.5;

export interface CacheMissReport {
  /** Cache read and previous prompt size, in tokens. */
  readTokens: number;
  expectedTokens: number;
  /** Empty when nothing the app controls changed: the cause is unknown. */
  causes: string[];
}

/**
 * Whether a request that should have read the previous request's cache mostly
 * did not. "Should have" means: caching on, the previous request was inside
 * its lifetime, the prompt only grew, and it was big enough to matter.
 */
export function detectCacheMiss(args: {
  before: PromptCacheSessionState;
  key: PromptCacheKey;
  requestAt: number;
  readTokens: number;
  totalInputTokens: number;
}): CacheMissReport | undefined {
  const { before, key, requestAt, readTokens, totalInputTokens } = args;
  const expected = before.lastInputTokens;
  if (!expected || expected < MISS_MIN_PREFIX_TOKENS) return undefined;
  if (before.lastRequestAt === undefined) return undefined;
  const lifetime = PROMPT_CACHE_TTL_MS[before.lastTtl ?? "5m"];
  if (requestAt - before.lastRequestAt > lifetime) return undefined;
  // A shorter prompt means history was cut or compacted: a new prefix by design.
  if (totalInputTokens < expected - 1000) return undefined;
  if (readTokens >= expected * MISS_READ_SHARE) return undefined;
  const causes = keyChanges(before.lastKey, key);
  return { readTokens, expectedTokens: expected, causes };
}
