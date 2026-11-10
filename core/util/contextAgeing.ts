import type { ChatMessage, ToolResultChatMessage } from "..";

/**
 * Masking of old tool results (plans/memory-ageing.md, row VA1).
 *
 * Pure functions over a list of chat messages. Nothing here is wired into a
 * request path: no caller exists yet, so no request changes. The replay
 * harness (cacheReplay.ts) is what decides whether the policy pays for itself.
 *
 * Masking replaces the body of an old tool result with a one-line stub that
 * names the tool, the size and a recall handle. The full body is returned to
 * the caller in `masked`, which is the only place it is kept: the caller owns
 * the lossless copy (the session log, a spill file) and can put a body back
 * with `unmaskToolResults`. Tool inputs, assistant text, user text and
 * thinking are never touched.
 *
 * Every edit to a message that was already sent rewrites the cached prompt
 * prefix from that message onward. Masking therefore must run in batches, not
 * on every turn; `maskOldToolResults` is deterministic and idempotent so a
 * batch applied twice produces the same bytes.
 */

/** Most recent tool results left untouched. Proposal; tuned by the replay harness. */
export const AGEING_KEEP_RECENT_TOOL_RESULTS = 5;

/** A result shorter than this is not worth a stub (the stub is about 25 tokens). */
export const AGEING_MIN_RESULT_CHARS = 600;

/** Characters per token for the size estimate. Rough on purpose. */
export const AGEING_CHARS_PER_TOKEN = 4;

/** Tools whose results are never masked: the task list is re-sent each turn anyway. */
export const AGEING_PROTECTED_TOOLS: readonly string[] = [
  "task_list",
  "Checklist",
];

/** Marks a masked message, in `metadata` and at the start of the stub text. */
export const AGEING_STUB_PREFIX = "[tool result masked";
export const AGEING_METADATA_KEY = "maskedResult";

export interface MaskOptions {
  /** Newest tool results to leave alone. Default AGEING_KEEP_RECENT_TOOL_RESULTS. */
  keepRecent?: number;
  /** Results shorter than this stay. Default AGEING_MIN_RESULT_CHARS. */
  minChars?: number;
  /** Tool names never masked. Default AGEING_PROTECTED_TOOLS. */
  protectedTools?: readonly string[];
  /**
   * Extra veto: return true to keep a result (for example a pinned one, or an
   * error from the last turns). Receives the tool name when it can be found.
   */
  keep?: (
    message: ToolResultChatMessage,
    toolName: string | undefined,
  ) => boolean;
}

export interface MaskedResult {
  /** Handle written in the stub; stable for the same call and body. */
  handle: string;
  toolCallId: string;
  toolName: string | undefined;
  /** Index of the message in the input list. */
  index: number;
  /** The full original body, for the caller to store. */
  original: string;
  originalChars: number;
}

export interface MaskOutcome {
  /** A new list; the input list and its messages are not modified. */
  messages: ChatMessage[];
  masked: MaskedResult[];
  freedChars: number;
  freedTokensEstimate: number;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / AGEING_CHARS_PER_TOKEN);
}

/** FNV-1a, 32 bit, as 8 hex digits. Not security relevant: a label for a handle. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function recallHandle(toolCallId: string, body: string): string {
  return `mask-${fnv1a(`${toolCallId}\n${body}`)}`;
}

export function isMaskedToolResult(message: ChatMessage): boolean {
  return (
    message.role === "tool" &&
    (message.metadata?.[AGEING_METADATA_KEY] !== undefined ||
      message.content.startsWith(AGEING_STUB_PREFIX))
  );
}

/** One line, fixed wording, so the same input always gives the same bytes. */
export function stubText(
  handle: string,
  toolName: string | undefined,
  chars: number,
): string {
  return `${AGEING_STUB_PREFIX}: ${toolName ?? "unknown tool"}, ${chars} chars, recall ${handle}]`;
}

/** Tool name for each tool call id, read from the assistant messages. */
function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      if (call.id && call.function?.name)
        names.set(call.id, call.function.name);
    }
  }
  return names;
}

export function maskOldToolResults(
  messages: ChatMessage[],
  options: MaskOptions = {},
): MaskOutcome {
  const keepRecent = Math.max(
    0,
    options.keepRecent ?? AGEING_KEEP_RECENT_TOOL_RESULTS,
  );
  const minChars = options.minChars ?? AGEING_MIN_RESULT_CHARS;
  const protectedTools = options.protectedTools ?? AGEING_PROTECTED_TOOLS;
  const names = toolNamesById(messages);

  const toolIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") toolIndexes.push(i);
  });
  const eligibleEnd = toolIndexes.length - keepRecent;
  const oldIndexes = new Set(toolIndexes.slice(0, Math.max(0, eligibleEnd)));

  const out: ChatMessage[] = [];
  const masked: MaskedResult[] = [];
  let freedChars = 0;
  messages.forEach((m, index) => {
    if (m.role !== "tool" || !oldIndexes.has(index) || isMaskedToolResult(m)) {
      out.push(m);
      return;
    }
    const toolName = names.get(m.toolCallId);
    const chars = m.content.length;
    if (
      chars < minChars ||
      (toolName !== undefined && protectedTools.includes(toolName)) ||
      options.keep?.(m, toolName)
    ) {
      out.push(m);
      return;
    }
    const handle = recallHandle(m.toolCallId, m.content);
    const content = stubText(handle, toolName, chars);
    out.push({
      ...m,
      content,
      metadata: { ...m.metadata, [AGEING_METADATA_KEY]: handle },
    });
    masked.push({
      handle,
      toolCallId: m.toolCallId,
      toolName,
      index,
      original: m.content,
      originalChars: chars,
    });
    freedChars += chars - content.length;
  });

  return {
    messages: out,
    masked,
    freedChars,
    freedTokensEstimate: estimateTokens(freedChars),
  };
}

/**
 * Put bodies back. `originals` maps a handle to its body (built from
 * `MaskOutcome.masked`, or read back from the caller's store). A handle with
 * no body leaves the stub in place.
 */
export function unmaskToolResults(
  messages: ChatMessage[],
  originals: ReadonlyMap<string, string>,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const handle = m.metadata?.[AGEING_METADATA_KEY];
    if (typeof handle !== "string") return m;
    const body = originals.get(handle);
    if (body === undefined) return m;
    const { [AGEING_METADATA_KEY]: _dropped, ...rest } = m.metadata ?? {};
    return {
      ...m,
      content: body,
      metadata: Object.keys(rest).length ? rest : undefined,
    };
  });
}
