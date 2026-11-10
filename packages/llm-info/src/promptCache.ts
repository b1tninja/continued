/**
 * What each model's prompt cache can do, per provider, in one table. Every
 * consumer (core's Bedrock provider and its cache helpers, the openai-adapters
 * Bedrock adapter, the chat window, the CLI) reads this table, so a new model
 * is one row here. Each row names its source and the date it was read; add
 * nothing without a vendor source.
 *
 * Sources:
 *  - AWS: docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html,
 *    "Supported models, Regions, and explicit caching limits" (read
 *    2026-11-04 for Claude, 2026-11-08 for Nova and OpenAI).
 *  - Anthropic: platform.claude.com/docs/en/build-with-claude/prompt-caching
 *    (read 2026-11-04).
 *  - Google: ai.google.dev/gemini-api/docs/caching, "Min token limit" (read
 *    2026-11-04).
 *
 * The AWS and Anthropic tables agree except for Claude Opus 4.7 (Anthropic
 * 2,048, AWS 4,096), so each provider gets its own vendor's number. A model
 * neither table lists claims no minimum (undefined), takes the provider's
 * default lifetime only, and on Bedrock still takes cache points if it is a
 * Claude model: Bedrock accepts them on every Claude model.
 */

export type CacheLifetime = "5m" | "1h" | "30m";

/** Which parts of a request accept a cache point on this model. */
export interface PromptCacheFields {
  tools: boolean;
  system: boolean;
  messages: boolean;
}

export interface PromptCacheRule {
  /** Provider IDs this row is for, or "*" for any provider not matched by an earlier row. */
  provider: string | string[];
  /** Tested against `promptCacheModelKey(model)`. */
  match: RegExp;
  /** Fields that take a cache point; undefined when the model takes none. */
  fields?: PromptCacheFields;
  /** Tokens the whole prefix before a checkpoint must reach, or undefined when the vendor does not say. */
  minTokens?: number;
  maxCheckpoints?: number;
  /** Lifetimes a cache point may ask for; the provider's default is first. Empty when there are no cache points. */
  lifetimes: CacheLifetime[];
  /** The most tokens the provider caches for one request, when it says. */
  maxCachedTokens?: number;
  /** Caching the provider does without a cache point, and whether usage reports it. */
  implicit?: { reportedInUsage: boolean };
  source: "aws" | "anthropic" | "google";
  checked: string;
}

const ALL: PromptCacheFields = { tools: true, system: true, messages: true };
const SYSTEM_AND_MESSAGES: PromptCacheFields = {
  tools: false,
  system: true,
  messages: true,
};

/** A later minor version (`-6` in `claude-sonnet-5-6`) is not this model. */
const NOT_NEXT_MINOR = "(?!-\\d{1,2}(?:-|$))";

/**
 * Reduce the model ID formats of Anthropic, Bedrock (`us.anthropic.claude-...-v1:0`),
 * Vertex (`claude-...@20250929`) and dotted names (`claude-sonnet-4.5`) to the
 * dash form (`claude-sonnet-4-5`). Returns undefined for non-Claude IDs.
 */
export function normalizeClaudeModelId(model: string): string | undefined {
  let id = model.toLowerCase();
  const claudeAt = id.indexOf("claude");
  if (claudeAt === -1) return undefined;
  id = id.slice(claudeAt);
  id = id.replace(/@.*$/, "").replace(/-v\d+(:\d+)?$/, "");
  id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  return id;
}

/**
 * `us.amazon.nova-2-lite-v1:0` -> `nova-2-lite`, for the four Nova models the
 * AWS table lists; undefined for anything else, including Nova Premier and the
 * other Nova 2 models (`nova-2-pro` does not match `nova-pro`).
 */
export function normalizeNovaModelId(model: string): string | undefined {
  return model
    .match(/(?:^|\.)amazon\.(nova-(?:2-lite|pro|lite|micro))-v\d/i)?.[1]
    ?.toLowerCase();
}

/**
 * The key the table's `match` patterns are tested against: a Claude ID in
 * its dash form, a Nova ID as `nova-...`, otherwise the lower-cased ID
 * without a `models/` prefix or a Bedrock vendor and region prefix
 * (`us.openai.gpt-6.1-sol` -> `gpt-6.1-sol`).
 */
export function promptCacheModelKey(model: string): string {
  return (
    normalizeClaudeModelId(model) ??
    normalizeNovaModelId(model) ??
    model
      .toLowerCase()
      .replace(/^models\//, "")
      .replace(
        /^(?:[a-z-]+\.)*?(?:openai|amazon|anthropic|xai|meta|mistral|cohere|qwen|deepseek)\./,
        "",
      )
  );
}

const CLAUDE_5X = /^claude-(?:opus-5|sonnet-5-5|haiku-5|fable|mythos)/;
const CLAUDE_OPUS_4_7 = /^claude-opus-4-7/;
const CLAUDE_OPUS_4_5_6 = /^claude-opus-4-[56]/;
const CLAUDE_HAIKU_4_5 = /^claude-haiku-4-5/;
const CLAUDE_1024_WITH_1H = new RegExp(
  `^claude-(?:opus-4-8|sonnet-4-6|sonnet-5${NOT_NEXT_MINOR})`,
);
/** Sonnet 5 later minors: AWS lists "5 minutes, 1 hour" for the Sonnet 5 row, so the lifetime carries; a minimum is not claimed. */
const CLAUDE_SONNET_5_LATER = /^claude-sonnet-5-\d/;
const CLAUDE_1024_NO_1H = new RegExp(
  `^claude-(?:opus-4-1|sonnet-4-[5]|opus-4${NOT_NEXT_MINOR}|sonnet-4${NOT_NEXT_MINOR})`,
);
const CLAUDE_ANY = /^claude-/;

/**
 * First matching row wins, so rows go from specific to general and Bedrock
 * rows come before the any-provider Claude rows.
 */
export const PROMPT_CACHE_RULES: PromptCacheRule[] = [
  // --- Claude on Bedrock: the Claude rows of the AWS table ------------------
  {
    provider: "bedrock",
    match: CLAUDE_5X,
    fields: ALL,
    minTokens: 512,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "aws",
    checked: "2026-11-04",
  },
  {
    provider: "bedrock",
    match: CLAUDE_OPUS_4_7,
    fields: ALL,
    minTokens: 4096,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "aws",
    checked: "2026-11-04",
  },
  {
    provider: "bedrock",
    match: CLAUDE_OPUS_4_5_6,
    fields: ALL,
    minTokens: 4096,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "aws",
    checked: "2026-11-04",
  },
  {
    provider: "bedrock",
    match: CLAUDE_HAIKU_4_5,
    fields: ALL,
    minTokens: 4096,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "aws",
    checked: "2026-11-04",
  },
  {
    provider: "bedrock",
    match: CLAUDE_1024_WITH_1H,
    fields: ALL,
    minTokens: 1024,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "aws",
    checked: "2026-11-04",
  },
  {
    provider: "bedrock",
    match: CLAUDE_SONNET_5_LATER,
    fields: ALL,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "aws",
    checked: "2026-11-04",
  },
  // Not in the AWS table (Sonnet 4.5, Sonnet 4, Opus 4 and 4.1): Anthropic's
  // 1,024 minimum is used, and an unlisted model gets the default lifetime,
  // because a `ttl` it does not take can raise a ValidationException.
  {
    provider: "bedrock",
    match: CLAUDE_1024_NO_1H,
    fields: ALL,
    minTokens: 1024,
    maxCheckpoints: 4,
    lifetimes: ["5m"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "bedrock",
    match: CLAUDE_ANY,
    fields: ALL,
    maxCheckpoints: 4,
    lifetimes: ["5m"],
    source: "aws",
    checked: "2026-11-04",
  },
  // --- Amazon Nova on Bedrock: the Nova rows of the AWS table ----------------
  // Checkpoints in `system` and `messages` only (a cache point in the tool
  // list is refused, seen live 2026-11-04); "1K" minimum; 5 minutes only; at
  // most 20K tokens cached. Nova's implicit reuse "isn't reported in the cache
  // usage fields and isn't billed as cache reads". Confirmed live 2026-11-08
  // on Nova 2 Lite: write 3,123, then read 3,022.
  {
    provider: "bedrock",
    match: /^nova-(?:2-lite|pro|lite|micro)$/,
    fields: SYSTEM_AND_MESSAGES,
    minTokens: 1024,
    maxCheckpoints: 4,
    lifetimes: ["5m"],
    maxCachedTokens: 20_000,
    implicit: { reportedInUsage: false },
    source: "aws",
    checked: "2026-11-08",
  },
  // --- OpenAI on Bedrock: cache by themselves; Converse takes no cache point --
  // GPT-5.6 and later: explicit breakpoints exist through the Responses API
  // only ("Converse doesn't support explicit caching for this model"), a
  // 1,024-token minimum, "30m is the only supported value". Earlier GPT
  // models: implicit, 1,024 minimum, no write fee. Both report cache reads.
  {
    provider: "bedrock",
    match: /^gpt-(?:5\.6|6)/,
    minTokens: 1024,
    lifetimes: [],
    implicit: { reportedInUsage: true },
    source: "aws",
    checked: "2026-11-08",
  },
  {
    provider: "bedrock",
    match: /^gpt-/,
    minTokens: 1024,
    lifetimes: [],
    implicit: { reportedInUsage: true },
    source: "aws",
    checked: "2026-11-08",
  },
  // --- Claude on Anthropic (and any other provider that carries Claude) ------
  // Anthropic accepts a 1-hour lifetime on every model that supports caching.
  {
    provider: "*",
    match: CLAUDE_5X,
    fields: ALL,
    minTokens: 512,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "*",
    match: CLAUDE_OPUS_4_7,
    fields: ALL,
    minTokens: 2048,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "*",
    match: CLAUDE_OPUS_4_5_6,
    fields: ALL,
    minTokens: 4096,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "*",
    match: CLAUDE_HAIKU_4_5,
    fields: ALL,
    minTokens: 4096,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "*",
    match: CLAUDE_1024_WITH_1H,
    fields: ALL,
    minTokens: 1024,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "*",
    match: CLAUDE_1024_NO_1H,
    fields: ALL,
    minTokens: 1024,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  {
    provider: "*",
    match: CLAUDE_ANY,
    fields: ALL,
    maxCheckpoints: 4,
    lifetimes: ["5m", "1h"],
    source: "anthropic",
    checked: "2026-11-04",
  },
  // --- Gemini API: implicit caching with a minimum; reported in usage --------
  // Only the models Google's table lists; Flash-Lite and anything newer than
  // the table are not claimed.
  {
    provider: "gemini",
    match: /^gemini-2\.5-(?:flash|pro)(?!-lite)/,
    minTokens: 2048,
    lifetimes: [],
    implicit: { reportedInUsage: true },
    source: "google",
    checked: "2026-11-04",
  },
  {
    provider: "gemini",
    match: /^gemini-(?:3\.1-pro|3\.6-flash|3\.8-flash|4(?:-|$))/,
    minTokens: 4096,
    lifetimes: [],
    implicit: { reportedInUsage: true },
    source: "google",
    checked: "2026-11-04",
  },
];

function rowIsFor(rule: PromptCacheRule, provider: string): boolean {
  if (rule.provider === "*") return true;
  const providers = Array.isArray(rule.provider)
    ? rule.provider
    : [rule.provider];
  return providers.includes(provider);
}

/** The table row for this model on this provider, or undefined when none claims it. */
export function promptCacheRule(
  model: string,
  provider: string,
): PromptCacheRule | undefined {
  const key = promptCacheModelKey(model);
  const id = provider.toLowerCase();
  return PROMPT_CACHE_RULES.find(
    (rule) => rowIsFor(rule, id) && rule.match.test(key),
  );
}

/** Fields that take a cache point, or undefined when the model takes none. */
export function promptCacheFields(
  model: string,
  provider: string,
): PromptCacheFields | undefined {
  return promptCacheRule(model, provider)?.fields;
}

/** The vendor's minimum prefix for a checkpoint, or undefined when it says nothing. */
export function promptCacheMinTokens(
  model: string,
  provider: string,
): number | undefined {
  return promptCacheRule(model, provider)?.minTokens;
}

/** Whether a cache point on this model may ask for `lifetime`. */
export function promptCacheSupportsLifetime(
  model: string,
  provider: string,
  lifetime: CacheLifetime,
): boolean {
  return (
    promptCacheRule(model, provider)?.lifetimes.includes(lifetime) ?? false
  );
}
