import type { ChatMessage, PromptProgress } from "core";
import { formatTokens } from "./cacheNotices";

/**
 * Splits a streamed batch into the signals that are not part of the reply and
 * the reply itself: the server's prompt-reading updates (`promptProgress`)
 * and the notice that the reply is held while recovery looks for a tool call
 * written as text (`recoveryHold`, "start" or "end"). Both are empty assistant
 * messages that only carry that field; they are not part of the conversation.
 */
export function splitPromptProgress(messages: ChatMessage[]): {
  progress: PromptProgress | undefined;
  hold: "start" | "end" | undefined;
  reply: ChatMessage[];
} {
  let progress: PromptProgress | undefined;
  let hold: "start" | "end" | undefined;
  const reply: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.promptProgress) {
      progress = message.promptProgress;
    } else if (message.role === "assistant" && message.recoveryHold) {
      hold = message.recoveryHold;
    } else {
      reply.push(message);
    }
  }
  return { progress, hold, reply };
}

/** The line shown while a reply is held for tool call recovery. */
export const RECOVERY_HOLD_TEXT = "Reading the model's reply";

function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

/**
 * "Reading the prompt: 140k of 300k tokens, 120k from the cache, about
 * 40 s left". The cached part is read in no time, so the share done and the
 * time left count only the rest: llama.cpp's own rule,
 * (processed - cache) / (total - cache).
 */
export function formatPromptProgress(p: PromptProgress): string {
  const toRead = Math.max(0, p.total - p.cache);
  const read = Math.max(0, Math.min(toRead, p.processed - p.cache));
  const parts = [
    `Reading the prompt: ${formatTokens(read)} of ${formatTokens(toRead)} tokens`,
  ];
  if (p.cache > 0) parts.push(`${formatTokens(p.cache)} from the cache`);
  if (read > 0 && p.timeMs > 0 && read < toRead) {
    const msLeft = ((toRead - read) * p.timeMs) / read;
    parts.push(`about ${formatSeconds(msLeft)} left`);
  }
  return parts.join(", ");
}
