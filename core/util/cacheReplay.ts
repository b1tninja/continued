import type { ChatMessage, MessageContent } from "..";
import {
  estimateTokens,
  maskOldToolResults,
  type MaskOptions,
} from "./contextAgeing";

/**
 * Replay harness, offline half (plans/memory-ageing.md, row V0b).
 *
 * Takes a recorded conversation, rebuilds the request the chat would have sent
 * at each assistant turn, optionally runs an ageing policy over it, and
 * simulates a prompt cache over the sequence of requests: how many input
 * tokens were read from the cache, how many were written, and how often an
 * earlier cached prefix stopped matching (a rebuild). No model is called and
 * nothing is read from the network.
 *
 * The cost model follows plans/prompt-caching-sim.mjs: prices are multiples of
 * the base input price (5 minute write 1.25, 1 hour write 2, read 0.1), output
 * tokens are ignored, the whole request is cacheable, and the cache is alive
 * when the gap since the previous request is within the lifetime. These are
 * the sim's assumptions, not measurements; validate against the real cache
 * ledger on one live session per provider before trusting a table.
 *
 * Task success (the online half of V0b) needs a model and is not here.
 */

export const REPLAY_WRITE_5M = 1.25;
export const REPLAY_WRITE_1H = 2.0;
export const REPLAY_READ = 0.1;
export const REPLAY_TTL_5M_SECONDS = 300;
export const REPLAY_DEFAULT_GAP_SECONDS = 30;
/** Characters counted for an image part (about 1,000 tokens). */
export const REPLAY_IMAGE_CHARS = 4000;
/** Per-message framing, in characters. */
export const REPLAY_MESSAGE_OVERHEAD_CHARS = 16;

export interface ReplayContext {
  requestIndex: number;
  /** Estimated tokens of the request before the policy ran. */
  tokens: number;
  /** True when the previous request's cache would still be alive. */
  cacheAlive: boolean;
}

export interface ReplayPolicy {
  name: string;
  /** Called once per request, in order. May keep state between calls. */
  apply(messages: ChatMessage[], context: ReplayContext): ChatMessage[];
  /** Tool results the policy has masked so far. */
  maskedCount(): number;
}

export interface ReplayOptions {
  /** Seconds between request starts: one number, or one per request. */
  gapSeconds?: number | number[];
  /** Cache lifetime. Default 300 (5 minutes). */
  ttlSeconds?: number;
  /** Write multiplier. Default 1.25 for a 5 minute lifetime, 2 for 1 hour. */
  writeMultiplier?: number;
}

export interface ReplayRequest {
  index: number;
  messages: number;
  tokens: number;
  cacheAlive: boolean;
  cacheRead: number;
  cacheWrite: number;
  /** Cached tokens from the previous request that no longer match (cache alive only). */
  rebuiltTokens: number;
  rebuild: boolean;
  coldStart: boolean;
  cost: number;
}

export interface ReplaySummary {
  policy: string;
  requests: number;
  inputTokens: number;
  peakTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Warm-cache requests where a previously cached prefix changed. */
  rebuilds: number;
  rebuiltTokens: number;
  /** Requests after the first that found the cache expired. */
  coldRequests: number;
  /** Cost in units of the base input price per token. */
  cost: number;
  /** cacheRead / inputTokens, 0 when there is no input. */
  readShare: number;
  masked: number;
}

export interface ReplayResult {
  summary: ReplaySummary;
  perRequest: ReplayRequest[];
}

function contentChars(content: MessageContent): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const part of content) {
    if (part.type === "text") n += part.text.length;
    else n += REPLAY_IMAGE_CHARS;
  }
  return n;
}

export function messageChars(message: ChatMessage): number {
  let n = REPLAY_MESSAGE_OVERHEAD_CHARS + contentChars(message.content);
  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      n +=
        (call.function?.name?.length ?? 0) +
        (call.function?.arguments?.length ?? 0);
    }
  }
  return n;
}

export function messageTokens(message: ChatMessage): number {
  return estimateTokens(messageChars(message));
}

/** What makes two messages the same bytes on the wire. Metadata and usage are not sent. */
function signature(message: ChatMessage): string {
  return JSON.stringify([
    message.role,
    message.content,
    message.role === "assistant" ? message.toolCalls : undefined,
    message.role === "tool" ? message.toolCallId : undefined,
  ]);
}

/**
 * Accepts what a saved session looks like: an array of chat messages, an array
 * of history items (`{ message }`), or a session object with `history`.
 */
export function normalizeHistory(input: unknown): ChatMessage[] {
  const list = Array.isArray(input)
    ? input
    : input &&
        typeof input === "object" &&
        Array.isArray((input as any).history)
      ? (input as any).history
      : undefined;
  if (!list)
    throw new Error(
      "Expected an array of messages or a session with a history array",
    );
  return list.map((item: any) => {
    const m =
      item && typeof item === "object" && "message" in item
        ? item.message
        : item;
    if (!m || typeof m.role !== "string")
      throw new Error("Entry without a role");
    return m as ChatMessage;
  });
}

/**
 * The request the chat sends at each assistant turn: every message before an
 * assistant message (the first message is never a request point).
 */
export function requestPoints(history: ChatMessage[]): number[] {
  const points: number[] = [];
  history.forEach((m, i) => {
    if (i > 0 && m.role === "assistant") points.push(i);
  });
  return points;
}

function gapAt(gap: number | number[] | undefined, k: number): number {
  if (Array.isArray(gap))
    return gap[k] ?? gap[gap.length - 1] ?? REPLAY_DEFAULT_GAP_SECONDS;
  return gap ?? REPLAY_DEFAULT_GAP_SECONDS;
}

export function replayHistory(
  history: ChatMessage[],
  policy: ReplayPolicy,
  options: ReplayOptions = {},
): ReplayResult {
  const ttl = options.ttlSeconds ?? REPLAY_TTL_5M_SECONDS;
  const write =
    options.writeMultiplier ??
    (ttl > REPLAY_TTL_5M_SECONDS ? REPLAY_WRITE_1H : REPLAY_WRITE_5M);
  const perRequest: ReplayRequest[] = [];
  let prevSigs: string[] = [];
  let prevTotal = 0;

  requestPoints(history).forEach((end, k) => {
    const raw = history.slice(0, end);
    const cacheAlive = k > 0 && gapAt(options.gapSeconds, k) <= ttl;
    const rawTokens = raw.reduce((s, m) => s + messageTokens(m), 0);
    const messages = policy.apply(raw, {
      requestIndex: k,
      tokens: rawTokens,
      cacheAlive,
    });
    const tokens = messages.map(messageTokens);
    const sigs = messages.map(signature);
    const total = tokens.reduce((s, t) => s + t, 0);

    let common = 0;
    let commonTokens = 0;
    while (
      common < sigs.length &&
      common < prevSigs.length &&
      sigs[common] === prevSigs[common]
    ) {
      commonTokens += tokens[common];
      common++;
    }
    const cacheRead = cacheAlive ? commonTokens : 0;
    const cacheWrite = total - cacheRead;
    const rebuiltTokens = cacheAlive ? prevTotal - commonTokens : 0;
    perRequest.push({
      index: k,
      messages: messages.length,
      tokens: total,
      cacheAlive,
      cacheRead,
      cacheWrite,
      rebuiltTokens,
      rebuild: cacheAlive && rebuiltTokens > 0,
      coldStart: k === 0,
      cost: cacheRead * REPLAY_READ + cacheWrite * write,
    });
    prevSigs = sigs;
    prevTotal = total;
  });

  const inputTokens = perRequest.reduce((s, r) => s + r.tokens, 0);
  const cacheRead = perRequest.reduce((s, r) => s + r.cacheRead, 0);
  return {
    perRequest,
    summary: {
      policy: policy.name,
      requests: perRequest.length,
      inputTokens,
      peakTokens: perRequest.reduce((s, r) => Math.max(s, r.tokens), 0),
      cacheRead,
      cacheWrite: perRequest.reduce((s, r) => s + r.cacheWrite, 0),
      rebuilds: perRequest.filter((r) => r.rebuild).length,
      rebuiltTokens: perRequest.reduce((s, r) => s + r.rebuiltTokens, 0),
      coldRequests: perRequest.filter((r) => !r.cacheAlive && !r.coldStart)
        .length,
      cost: perRequest.reduce((s, r) => s + r.cost, 0),
      readShare: inputTokens === 0 ? 0 : cacheRead / inputTokens,
      masked: policy.maskedCount(),
    },
  };
}

// ---- policies. Each factory returns fresh state, so build one per replay. ----

/** The control: send everything. */
export function policyNone(): ReplayPolicy {
  return { name: "none", apply: (m) => m, maskedCount: () => 0 };
}

/**
 * Negative control: mask on every request. The keep window slides each turn,
 * so a result that was whole in the last request is a stub in this one, and
 * the cached prefix changes every time.
 */
export function policyMaskEveryRequest(
  options: MaskOptions = {},
): ReplayPolicy {
  let masked = 0;
  return {
    name: `mask-every-request(keep ${options.keepRecent ?? "default"})`,
    apply(messages) {
      const outcome = maskOldToolResults(messages, options);
      masked = Math.max(
        masked,
        outcome.messages.filter(
          (m) => m.role === "tool" && m.metadata?.maskedResult,
        ).length,
      );
      return outcome.messages;
    },
    maskedCount: () => masked,
  };
}

export interface BatchedMaskOptions extends MaskOptions {
  /** Run a batch when the request would exceed this many tokens. */
  triggerTokens: number;
  /** Only run a batch when the cache is cold (a rebuild is free then). Default false. */
  onlyWhenCold?: boolean;
}

/**
 * Mask in batches: when the trigger is crossed, mask every eligible result at
 * once and keep exactly those stubs from then on, so the prefix changes once
 * per batch and is stable between batches.
 */
export function policyMaskBatched(options: BatchedMaskOptions): ReplayPolicy {
  const stubbed = new Map<string, ChatMessage>();
  const view = (messages: ChatMessage[]) =>
    messages.map((m) =>
      m.role === "tool" ? (stubbed.get(m.toolCallId) ?? m) : m,
    );
  return {
    name: `mask-batched(trigger ${options.triggerTokens}, keep ${options.keepRecent ?? "default"}${options.onlyWhenCold ? ", cold only" : ""})`,
    apply(messages, context) {
      let current = view(messages);
      const tokens = current.reduce((s, m) => s + messageTokens(m), 0);
      const allowed = !options.onlyWhenCold || !context.cacheAlive;
      if (allowed && tokens >= options.triggerTokens) {
        const outcome = maskOldToolResults(current, options);
        for (const item of outcome.masked) {
          stubbed.set(item.toolCallId, outcome.messages[item.index]);
        }
        current = outcome.messages;
      }
      return current;
    },
    maskedCount: () => stubbed.size,
  };
}

export function compareReplayPolicies(
  history: ChatMessage[],
  policies: Array<() => ReplayPolicy>,
  options: ReplayOptions = {},
): ReplaySummary[] {
  return policies.map(
    (make) => replayHistory(history, make(), options).summary,
  );
}

export function formatReplayReport(rows: ReplaySummary[]): string {
  const base = rows[0]?.cost ?? 0;
  const header =
    "| Policy | Requests | Input tokens | Peak | Cache read | Cache write | Read share | Rebuilds | Rebuilt tokens | Cold | Masked | Cost | vs first |";
  const rule =
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const lines = rows.map((r) => {
    const delta =
      base === 0 ? "n/a" : `${(((r.cost - base) / base) * 100).toFixed(1)}%`;
    return `| ${r.policy} | ${r.requests} | ${r.inputTokens} | ${r.peakTokens} | ${r.cacheRead} | ${r.cacheWrite} | ${(r.readShare * 100).toFixed(1)}% | ${r.rebuilds} | ${r.rebuiltTokens} | ${r.coldRequests} | ${r.masked} | ${r.cost.toFixed(0)} | ${delta} |`;
  });
  return [header, rule, ...lines].join("\n");
}

// ---- synthetic history, for tests and for a run with no recorded session ----

export interface SyntheticOptions {
  /** Number of assistant turns (each makes one tool call). Default 60. */
  turns?: number;
  /** Seed for the size sequence. Default 1. */
  seed?: number;
  /** Share of tool results that are large (about 20,000 chars). Default 0.15. */
  largeShare?: number;
}

/** Deterministic long agent session: user task, then turns of assistant call + tool result. */
export function syntheticHistory(
  options: SyntheticOptions = {},
): ChatMessage[] {
  const turns = options.turns ?? 60;
  const largeShare = options.largeShare ?? 0.15;
  let state = (options.seed ?? 1) >>> 0 || 1;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const history: ChatMessage[] = [
    { role: "user", content: "Fix the failing test in the package." },
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    history.push({
      role: "assistant",
      content: `Step ${i}: looking at the code.`,
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: i % 3 === 0 ? "read_file" : "run_terminal_command",
            arguments: JSON.stringify({ n: i }),
          },
        },
      ],
    });
    const chars = rand() < largeShare ? 20000 : 300 + Math.floor(rand() * 2500);
    history.push({ role: "tool", toolCallId: id, content: "x".repeat(chars) });
  }
  history.push({ role: "assistant", content: "Done." });
  return history;
}
