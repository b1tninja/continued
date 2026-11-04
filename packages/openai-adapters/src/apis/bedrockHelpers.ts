/**
 * Pure helpers for the Bedrock adapter. Keep in sync with
 * core/llm/llms/bedrockHelpers.ts (core cannot import this package's sources).
 */

/** Geographic prefixes Bedrock uses for cross-region inference profile IDs. */
export const INFERENCE_PROFILE_PREFIXES = [
  "us",
  "us-gov",
  "eu",
  "apac",
  "jp",
  "au",
  "ca",
  "global",
] as const;

export type CrossRegionInference =
  "auto" | "us" | "us-gov" | "eu" | "apac" | "jp" | "au" | "ca" | "global";

/** Map an AWS region (e.g. eu-west-1) to the matching inference profile prefix. */
export function inferenceProfilePrefixForRegion(
  region: string | undefined,
): string | undefined {
  if (!region) return undefined;
  if (region.startsWith("us-gov-")) return "us-gov";
  if (region.startsWith("us-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return undefined;
}

/**
 * Apply the `crossRegionInference` setting to a model ID, e.g.
 * `anthropic.claude-sonnet-4-20250514-v1:0` -> `us.anthropic.claude-sonnet-4-20250514-v1:0`.
 *
 * IDs that already carry a prefix, and ARNs (inference profile / imported
 * model ARNs), are returned untouched so existing configs keep working.
 */
export function applyCrossRegionInference(
  modelId: string,
  setting: string | undefined,
  region: string | undefined,
): string {
  if (!setting) return modelId;
  if (modelId.startsWith("arn:")) return modelId;
  if (INFERENCE_PROFILE_PREFIXES.some((p) => modelId.startsWith(`${p}.`))) {
    return modelId;
  }
  const prefix =
    setting === "auto" ? inferenceProfilePrefixForRegion(region) : setting;
  if (!prefix) return modelId;
  return `${prefix}.${modelId}`;
}

/**
 * Turn common, cryptic AWS failures into a one-line next step.
 * Returns undefined when we have no useful advice.
 */
export function getBedrockErrorHint(
  error: unknown,
  ctx: { profile?: string; region?: string; usedProfile?: boolean },
): string | undefined {
  const err = error as { name?: string; message?: string } | undefined;
  const text = `${err?.name ?? ""} ${err?.message ?? ""}`;
  const profileArg = ctx.profile ? ` --profile ${ctx.profile}` : "";

  if (
    /sso/i.test(text) &&
    /(expired|invalid|refresh|login|token)/i.test(text)
  ) {
    return `Your AWS SSO session has expired or is missing. Run \`aws sso login${profileArg}\` and try again.`;
  }
  if (
    /ExpiredToken|security token included in the request is expired/i.test(text)
  ) {
    return "Your AWS credentials have expired. Refresh them (for SSO: `aws sso login`) or update the access key / session token in your config.";
  }
  if (
    /CredentialsProviderError|Could not load credentials|Missing credentials/i.test(
      text,
    )
  ) {
    return (
      "No AWS credentials found. Configure one of: `apiKey` (Bedrock API key, or the " +
      "AWS_BEARER_TOKEN_BEDROCK env var), `profile` (a profile from ~/.aws/config, " +
      "including SSO profiles), `accessKeyId` + `secretAccessKey` (+ `sessionToken` " +
      "for temporary credentials), or the standard AWS_* environment variables."
    );
  }
  if (
    /on-demand throughput isn.t supported|inference profile/i.test(text) &&
    /ValidationException|invocation/i.test(text)
  ) {
    return "This model needs an inference profile. Set `crossRegionInference: auto` (or us / eu / apac / global), or use the profile ID such as `us.anthropic.claude-...`.";
  }
  if (
    /AccessDeniedException/i.test(text) &&
    /model|bedrock:Invoke/i.test(text)
  ) {
    return `Access denied. Make sure the model is enabled for your account in the Bedrock console${
      ctx.region ? ` (region ${ctx.region})` : ""
    } and that your IAM identity allows bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream.`;
  }
  return undefined;
}

/** The fields of Bedrock's `TokenUsage` that the adapter reads. */
export interface BedrockTokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/**
 * Map the usage in a Converse stream's `metadata` event to the OpenAI usage
 * shape, with the cache fields named as the Anthropic adapter names them.
 * With caching on, Bedrock's `inputTokens` counts only tokens that were
 * neither read from nor written to the cache, the same meaning as Anthropic's
 * `input_tokens`, so `prompt_tokens` keeps that meaning on both adapters.
 */
export function bedrockUsageToCompletionUsage(usage: BedrockTokenUsageLike): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: {
    cached_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
} {
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheWriteInputTokens ?? 0;
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: read,
      cache_read_tokens: read,
      cache_write_tokens: write,
    },
  };
}

/** Which parts of a request get a cache point. */
export interface BedrockCacheParts {
  tools: boolean;
  system: boolean;
  conversation: boolean;
}

/**
 * Decide which parts of a request get cache points. Keep in sync with
 * `resolveCacheParts` in core/llm/llms/anthropicCache.ts.
 *
 * An explicit `promptCaching: false` turns everything off, even when
 * `cacheBehavior` says otherwise. `true` caches the tools, the system prompt
 * and the conversation (up to four cache points: tools, system and the last
 * two user messages). When it is unset, only `cacheBehavior` applies, and with
 * nothing set no cache points are sent.
 */
export function resolveBedrockCacheParts(
  requested: boolean | undefined,
  behavior:
    { cacheSystemMessage?: boolean; cacheConversation?: boolean } | undefined,
  hasSystem: boolean,
): BedrockCacheParts {
  if (requested === false) {
    return { tools: false, system: false, conversation: false };
  }
  if (requested === true) {
    return { tools: true, system: hasSystem, conversation: true };
  }
  return {
    tools: false,
    system: !!(behavior?.cacheSystemMessage && hasSystem),
    conversation: !!behavior?.cacheConversation,
  };
}
