import type { ChatCompletionCreateParams } from "openai/resources/index.js";
import {
  ADAPTIVE_THINKING_MODEL,
  effortToBudgetTokens,
} from "./bedrockHelpers.js";

/** A thinking block as Anthropic returned it; it must be sent back unchanged. */
export type StoredThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AnthropicThinkingRequest {
  thinking: { type: "enabled"; budget_tokens: number } | { type: "adaptive" };
  output_config?: { effort: "low" | "medium" | "high" };
  /** Floor for max_tokens, which must exceed the budget. */
  minMaxTokens: number;
}

/**
 * The thinking request for a model: the body's `reasoning_effort`, else the
 * config's `requestOptions.extraBodyProperties.reasoning_effort` (a CLI use's
 * `modeModels` effort). `none`, `off` and unset send no thinking.
 */
export function thinkingRequestFor(
  model: string,
  oaiEffort: ChatCompletionCreateParams["reasoning_effort"],
  configEffort: unknown,
): AnthropicThinkingRequest | undefined {
  const effort: string | undefined =
    oaiEffort ?? (typeof configEffort === "string" ? configEffort : undefined);
  if (!effort || effort === "none" || effort === "off") return undefined;
  const level =
    effort === "minimal" || effort === "low"
      ? "low"
      : effort === "medium"
        ? "medium"
        : "high";
  if (ADAPTIVE_THINKING_MODEL.test(model)) {
    // These models refuse type "enabled"; there is no budget to exceed
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: level },
      minMaxTokens: 0,
    };
  }
  const budget = effortToBudgetTokens(level);
  // max_tokens must exceed budget_tokens; leave room for the visible answer
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    minMaxTokens: budget + 4096,
  };
}

/**
 * The thinking blocks of recent assistant turns, keyed by the id of each
 * tool_use in the turn. The OpenAI message shape the adapter is called with
 * (and the CLI, which rebuilds history from content and tool_calls) has no
 * place for them, but Anthropic refuses a tool_use turn that lacks its
 * thinking block while thinking is on, so the adapter keeps them itself and
 * puts them back. Bounded; the oldest entries go first.
 */
export class ThinkingStash {
  private byToolId = new Map<string, StoredThinkingBlock[]>();
  constructor(private readonly max = 256) {}

  remember(toolUseIds: string[], blocks: StoredThinkingBlock[]): void {
    if (!blocks.length) return;
    for (const id of toolUseIds) {
      this.byToolId.delete(id);
      this.byToolId.set(id, blocks);
    }
    while (this.byToolId.size > this.max) {
      const oldest = this.byToolId.keys().next().value;
      if (oldest === undefined) break;
      this.byToolId.delete(oldest);
    }
  }

  /** The blocks for an assistant turn with these tool calls, if known. */
  recall(toolUseIds: string[]): StoredThinkingBlock[] | undefined {
    for (const id of toolUseIds) {
      const blocks = this.byToolId.get(id);
      if (blocks) return blocks;
    }
    return undefined;
  }
}

/**
 * Whether thinking can be turned on for these messages. Anthropic needs the
 * thinking block on every assistant tool_use turn of the loop in progress (the
 * turns after the last user message); a history the adapter did not produce
 * (a resumed session, another provider's turns) lacks them, and sending
 * thinking then is a 400. In that case thinking is left off for the request.
 */
export function canThink(
  messages: { role: string; tool_calls?: { id: string }[] }[],
  stash: ThinkingStash,
): boolean {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  for (const m of messages.slice(lastUser + 1)) {
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    if (!stash.recall(m.tool_calls.map((t) => t.id))) return false;
  }
  return true;
}
