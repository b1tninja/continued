import { promptCacheMinTokens } from "@continuedev/llm-info";

/**
 * Minimum prompt length, in tokens, for a cache checkpoint to take effect.
 * Below it the request succeeds, the prefix is not cached, and no error is
 * returned: "If you add a cache checkpoint before the total prompt prefix meets
 * the minimum number of tokens, your inference still succeeds, but your prefix
 * isn't cached" (AWS Bedrock prompt caching, checked 2026-11-04). The minimum
 * counts the whole prefix before the checkpoint, across tools, system and
 * messages.
 *
 * The numbers live in the prompt cache table in @continuedev/llm-info
 * (`PROMPT_CACHE_RULES`), one row per model and provider with its source and
 * date: the AWS and Anthropic tables for Claude (they agree except for Opus
 * 4.7, so each provider gets its own vendor's number), the AWS table for
 * Nova, and Google's "Min token limit" table for Gemini's implicit caching.
 */

/**
 * The smallest prompt a cache checkpoint can take effect on for this model, or
 * undefined when the model is not in the vendors' tables (so nothing is claimed).
 */
export function minCacheableTokens(
  model: string,
  provider: string,
): number | undefined {
  return promptCacheMinTokens(model, provider);
}
