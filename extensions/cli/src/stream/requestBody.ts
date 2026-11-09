import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { convertFromUnifiedHistoryWithSystemMessage } from "core/util/messageConversion.js";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources.mjs";

import { getRequestBodyHints } from "../contextManagement.js";

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
 * put its cache point before it.
 */
export function buildChatRequestBody(args: {
  model: ModelConfig;
  chatHistory: ChatHistoryItem[];
  systemMessage: string;
  tools?: ChatCompletionTool[];
  /** The session's task list block, or empty when none is sent. */
  taskListBlock?: string;
  /** A compaction summary is never continued, so it is a one-shot request. */
  isCompacting?: boolean;
}): ChatCompletionCreateParamsStreaming {
  const { model, chatHistory, systemMessage, tools, taskListBlock } = args;
  const messages = convertFromUnifiedHistoryWithSystemMessage(
    chatHistory,
    systemMessage,
  ) as ChatCompletionMessageParam[];
  if (taskListBlock) {
    messages.push({ role: "user", content: taskListBlock });
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
  } as ChatCompletionCreateParamsStreaming;
}
