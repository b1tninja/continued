import type { ILLM } from "../../../..";
import { assembleGuidance, type EffectiveGuidance } from "../guidance";
import { parseReviewerReply } from "../parse";
import {
  buildReviewMessages,
  newNonce,
  reviewerPromptVersion,
} from "../prompt";
import { findReviewerAddressedText } from "../reviewerAddressed";
import { reviewCompletionOptions, ReviewerReasoning } from "../review";
import type {
  CaseEnvironment,
  GuidanceFile,
  LabelledCase,
  ReviewDataset,
} from "./reviewEvalDataset";

/** The only thing the runner needs from a model; tests pass a scripted fake. */
export type ReviewerClient = Pick<ILLM, "chat">;

/** One reviewer configuration: the model is the client, the rest is here. */
export interface ReviewerConfig {
  /** Shown in reports. */
  label: string;
  /** Prompt guidance to try; absent is the built-in prompt alone. */
  guidance?: GuidanceFile;
  /**
   * Opaque id of a per-reviewer-model profile (a later slice). The runner only
   * carries it into the result; it does not interpret it.
   */
  profile?: string;
  reasoning?: ReviewerReasoning;
  /**
   * The deterministic check for text addressed to the reviewer, which in
   * production runs before the model. On unless `false`; a hit is an ask
   * and costs no call. Off only to measure the model and prompt alone.
   */
  prefilter?: boolean;
}

export interface CaseOutcome {
  id: string;
  decision: "allow" | "ask" | "deny";
  category?: string;
  reason: string;
  /** The reply could not be read; failed closed to ask. */
  formatFailure: boolean;
  /** The call failed or timed out (not a format problem); failed closed to ask. */
  error?: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Size of the assembled messages, for cost planning. */
  promptChars: number;
}

export interface RunResult {
  config: ReviewerConfig;
  /** What the reviewer was told, as the audit trail records it in production. */
  promptVersion: string;
  outcomes: CaseOutcome[];
}

export interface RunOptions {
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Guidance goes through the same validation production uses
 * (`assembleGuidance`). An entry that is refused is an error, not a dropped
 * line: a run without a "never" the person wrote would measure a looser
 * reviewer than the one that ships.
 */
export function resolveGuidance(config: Pick<ReviewerConfig, "guidance">): {
  guidance: EffectiveGuidance;
  errors: string[];
} {
  const { guidance, errors } = assembleGuidance(config.guidance);
  return { guidance, errors };
}

function validGuidance(
  config: Pick<ReviewerConfig, "guidance">,
): EffectiveGuidance {
  const { guidance, errors } = resolveGuidance(config);
  if (errors.length > 0) {
    throw new Error(`The guidance was refused. ${errors.join(" ")}`);
  }
  return guidance;
}

function merged(
  base: CaseEnvironment,
  over: CaseEnvironment | undefined,
): CaseEnvironment {
  return { ...base, ...(over ?? {}) };
}

/** The exact messages the reviewer would receive for one case. */
export function messagesFor(
  c: LabelledCase,
  dataset: Pick<ReviewDataset, "environment">,
  config: Pick<ReviewerConfig, "guidance">,
  nonce: string = newNonce(),
) {
  const env = merged(dataset.environment, c.environment);
  const environment: Record<string, unknown> = {};
  const settingsEnv: {
    trustedDomains?: string[];
    productionMarkers?: string[];
  } = {};
  if (env.os) environment.os = env.os;
  if (env.workspaceDirs) environment.workspaceDirs = env.workspaceDirs;
  if (env.gitRemotes) environment.gitRemotes = env.gitRemotes;
  if (env.trustedDomains) settingsEnv.trustedDomains = env.trustedDomains;
  if (env.productionMarkers) {
    settingsEnv.productionMarkers = env.productionMarkers;
  }
  return buildReviewMessages({
    toolName: c.tool,
    args: c.args,
    history: {
      userMessages: c.history.userMessages,
      toolCalls: c.history.toolCalls ?? [],
    },
    environment,
    settings: {
      environment: settingsEnv,
    },
    guidance: validGuidance(config),
    nonce,
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String(p.text) : "",
      )
      .join("");
  }
  return "";
}

function tokens(raw: unknown) {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as Record<string, any>;
  const num = (...vals: unknown[]) =>
    vals.find((v): v is number => typeof v === "number");
  return {
    inputTokens: num(u.promptTokens, u.prompt_tokens, u.input_tokens),
    outputTokens: num(u.completionTokens, u.completion_tokens, u.output_tokens),
    cacheReadTokens: num(
      u.promptTokensDetails?.cachedTokens,
      u.prompt_tokens_details?.cached_tokens,
      u.cacheReadTokens,
      u.cache_read_input_tokens,
    ),
  };
}

const failedClosed = (why: string) => ({
  decision: "ask" as const,
  reason: why,
});

async function runOne(
  client: ReviewerClient,
  c: LabelledCase,
  dataset: ReviewDataset,
  config: ReviewerConfig,
  opts: RunOptions,
): Promise<CaseOutcome> {
  if (config.prefilter !== false && findReviewerAddressedText(c.args).length) {
    return {
      id: c.id,
      decision: "ask",
      category: "reviewer-addressed-text",
      reason: "Text in the call addresses the reviewer (pre-filter).",
      formatFailure: false,
      ms: 0,
      promptChars: 0,
    };
  }
  const messages = messagesFor(c, dataset, config);
  const promptChars = messages.reduce(
    (n, m) => n + messageText(m.content).length,
    0,
  );
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  const t0 = Date.now();
  try {
    const reply = await client.chat(
      messages,
      controller.signal,
      reviewCompletionOptions(config.reasoning),
    );
    const ms = Date.now() - t0;
    const parsed = parseReviewerReply(messageText(reply?.content));
    return {
      id: c.id,
      decision: parsed.decision,
      category: parsed.category,
      reason: parsed.reason,
      formatFailure: parsed.unusable === true,
      ms,
      promptChars,
      ...tokens((reply as { usage?: unknown } | undefined)?.usage),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      id: c.id,
      ...failedClosed(`The reviewer call failed: ${why}`),
      category: "reviewer-unavailable",
      formatFailure: false,
      error: why,
      ms: Date.now() - t0,
      promptChars,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Ask the reviewer about every case: the real messages from
 * `buildReviewMessages`, the strict verdict parser, nothing else in between
 * (the rules engine is not run; this measures the model and its prompt).
 * Results keep the dataset's order. Never throws for one bad case.
 */
export async function runReviewEval(
  client: ReviewerClient,
  dataset: ReviewDataset,
  config: ReviewerConfig,
  opts: RunOptions = {},
): Promise<RunResult> {
  const { cases } = dataset;
  const promptVersion = reviewerPromptVersion(
    validGuidance(config),
    config.profile,
  );
  const outcomes: CaseOutcome[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      outcomes[i] = await runOne(client, cases[i], dataset, config, opts);
      opts.onProgress?.(++done, cases.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker),
  );
  return { config, promptVersion, outcomes };
}

export interface CostPlan {
  calls: number;
  configs: number;
  /** About four characters a token; an estimate, not a tokenizer count. */
  estInputTokens: number;
  /** Upper bound: every reply up to the reviewer's reply budget. */
  maxOutputTokens: number;
  concurrency: number;
}

/** What a real run would send, computed without calling anything. */
export function planCost(
  dataset: ReviewDataset,
  configs: Pick<ReviewerConfig, "guidance">[],
  concurrency = 4,
): CostPlan {
  let chars = 0;
  for (const config of configs) {
    for (const c of dataset.cases) {
      for (const m of messagesFor(c, dataset, config, "0".repeat(16))) {
        chars += messageText(m.content).length;
      }
    }
  }
  const calls = dataset.cases.length * configs.length;
  return {
    calls,
    configs: configs.length,
    estInputTokens: Math.ceil(chars / 4),
    maxOutputTokens: calls * reviewCompletionOptions().maxTokens,
    concurrency,
  };
}
