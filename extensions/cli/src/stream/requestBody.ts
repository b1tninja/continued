import { type ModelConfig, withToolDialect } from "@continuedev/config-yaml";
import { CACHE_PIN_FIELD } from "@continuedev/openai-adapters";
import type { ChatHistoryItem, ChatMessage } from "core/index.js";
import {
  normalizeTurns,
  providerRequiresAlternation,
} from "core/llm/normalizeTurns.js";
import { withTurnTail } from "core/llm/prompts/usePrompts.js";
import {
  chatMessagesFromUnifiedHistory,
  convertChatMessagesToOpenAI,
} from "core/util/messageConversion.js";
import { providerRecoversText } from "core/util/toolDialectLeak.js";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources.mjs";

import { getRequestBodyHints } from "../contextManagement.js";
import { withEnvironmentBlock } from "../environmentContext.js";

import { getDefaultCompletionOptions } from "./streamChatResponse.types.js";

/**
 * The chat request the CLI sends for one model call, built from the pieces
 * `processStreamingResponse` has already validated and pruned. A pure
 * function, so a test can build the requests of consecutive turns and check
 * that everything before the provider's cache point stays byte-identical
 * (prefixStability.test.ts).
 *
 * Order matters for the prompt cache: the system message first, then the
 * history, and the task list block last, as its own user message, so a change
 * to the list changes only the tail of the request and the Bedrock adapter can
 * put its cache point before it. The date and git status go on the first user
 * message (`withEnvironmentBlock`), after the system checkpoint, so the system
 * text is the same across sessions. The use's tail goes last on every user
 * message (`withTurnTail`), the same line each time, so a message's bytes
 * never change between requests and the cache markers on the last two user
 * messages keep matching (core/llm/prompts/usePrompts.ts).
 */
/**
 * Providers whose adapters build their own request body and read
 * CACHE_PIN_FIELD. Every other adapter passes the messages on to the provider,
 * which would reject the unknown field, so the mark is set for these only.
 */
const PIN_PROVIDERS = new Set(["bedrock", "anthropic"]);

/**
 * How many messages are sent ahead of the first one history item `item`
 * produced. A message normalizeTurns added or rewrote counts as part of the
 * item before it; a reasoning turn is not sent.
 */
function sentBeforeItem(
  history: { messages: ChatMessage[]; itemIndex: number[] },
  conversation: ChatMessage[],
  item: number,
): number {
  const origin = new Map(
    history.messages.map((message, i) => [message, history.itemIndex[i]]),
  );
  let from = -1;
  let sent = 0;
  for (const message of conversation) {
    from = origin.get(message) ?? from;
    if (from >= item) break;
    if (message.role !== "thinking") sent++;
  }
  return sent;
}

export function buildChatRequestBody(args: {
  model: ModelConfig;
  chatHistory: ChatHistoryItem[];
  systemMessage: string;
  tools?: ChatCompletionTool[];
  /** The session's task list block, or empty when none is sent. */
  taskListBlock?: string;
  /** A compaction summary is never continued, so it is a one-shot request. */
  isCompacting?: boolean;
  /** The use's tail (`modeModels.<use>.tail`), appended to every user message. */
  turnTail?: string;
}): ChatCompletionCreateParamsStreaming {
  const { model, chatHistory, systemMessage, tools, taskListBlock } = args;
  // The history as a conversation every provider accepts: an aborted or
  // empty turn dropped, reasoning left out, every tool call answered
  // (core/llm/normalizeTurns.ts). A valid history comes back as it is, so the
  // request is byte-identical and the prompt cache keeps hitting.
  const history = chatMessagesFromUnifiedHistory(chatHistory);
  const conversation = normalizeTurns(history.messages, {
    requiresAlternation: providerRequiresAlternation(model.provider),
  }).messages;
  const messages = withTurnTail(
    withEnvironmentBlock([
      { role: "system", content: systemMessage },
      ...convertChatMessagesToOpenAI(conversation),
    ] as ChatCompletionMessageParam[]),
    args.turnTail,
  );
  if (taskListBlock) {
    messages.push({ role: "user", content: taskListBlock });
  }
  // A history item marked as a fork point (ChatHistoryItem.cachePin) becomes
  // the mark on the first message it produced: index 0 is the system message,
  // then the messages the items before it produce.
  const pinAt = chatHistory.findIndex((item) => item.cachePin);
  if (pinAt >= 0 && PIN_PROVIDERS.has(model.provider)) {
    const index = 1 + sentBeforeItem(history, conversation, pinAt);
    const pinned = messages[index] as unknown as
      Record<string, unknown> | undefined;
    if (pinned) pinned[CACHE_PIN_FIELD] = true;
  }
  return {
    model: model.model,
    messages,
    stream: true,
    tools,
    ...getDefaultCompletionOptions(model.defaultCompletionOptions),
    ...getRequestBodyHints(
      model,
      args.isCompacting ? "oneShot" : "conversation",
    ),
    // The model's `toolDialect`, as the recovery switch the Bedrock and
    // OpenAI-compatible adapters read from the body (and remove). Nothing is added without one, or with the
    // CONTINUE_RECOVER_TEXT_TOOL_CALLS variable set (it wins).
    ...(providerRecoversText(model.provider, "cli")
      ? withToolDialect({}, model.toolDialect)
      : {}),
  } as ChatCompletionCreateParamsStreaming;
}
