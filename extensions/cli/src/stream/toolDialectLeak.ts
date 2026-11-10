import type { ModelConfig } from "@continuedev/config-yaml";
import {
  detectToolDialectLeak,
  leakHintText,
  providerRecoversText,
} from "core/util/toolDialectLeak.js";

import type { StreamCallbacks } from "./streamChatResponse.types.js";

const hinted = new Set<string>();

/** Forget which models were hinted (tests, and a new session). */
export function resetToolDialectHints(): void {
  hinted.clear();
}

/**
 * Print a one-line hint, once per session per model, when a reply carried a
 * tool call written as text (outside a code fence) and `toolDialect` is not
 * set. Never turns recovery on by itself.
 */
export function hintToolDialectLeak(args: {
  model: ModelConfig;
  content: string;
  toolCalls: { id?: string; name: string; argumentsStr?: string }[];
  callbacks: StreamCallbacks | undefined;
  print?: (line: string) => void;
}): void {
  const { model } = args;
  if (!providerRecoversText(model.provider) || hinted.has(model.name)) return;
  const leak = detectToolDialectLeak({
    content: args.content,
    toolCalls: args.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.argumentsStr ?? "{}",
    })),
    current: model.toolDialect,
  });
  if (!leak) return;
  hinted.add(model.name);
  const line = leakHintText(model.name, leak.dialect);
  if (args.callbacks?.onStatusMessage) args.callbacks.onStatusMessage(line);
  else (args.print ?? ((l) => console.error(l)))(line);
}
