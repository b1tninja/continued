import type { ChatCompletionChunk } from "openai/resources/index";
import type { HoldPhase } from "./recovery.js";

/**
 * How a held reply is told to whoever reads the stream. While text is held for
 * recovery nothing is emitted, so a reader sees a stalled model. The stage
 * says when a hold begins and ends (`takeHoldSignal`), and the streams carry
 * that as one extra chunk with an empty delta and this field set to "start"
 * or "end". A reader that does not know the field sees an empty chunk, as for
 * the role-only first chunk of any stream. Nothing is sent when recovery is
 * off. core/llm/openaiTypeConverters.ts reads the same field name; a test
 * pins the two equal.
 */
export const RECOVERY_HOLD_FIELD = "x_continue_recovery_hold";

/** A chunk with no content that carries the hold signal. */
export function holdChunk(
  phase: HoldPhase,
  base: { id?: string | null; model: string; created?: number },
): ChatCompletionChunk {
  return {
    id: base.id ?? "",
    object: "chat.completion.chunk",
    created: base.created ?? Date.now(),
    model: base.model,
    choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
    [RECOVERY_HOLD_FIELD]: phase,
  } as ChatCompletionChunk;
}

/** The hold phase a chunk carries, if it is a hold chunk. */
export function holdPhaseOf(chunk: unknown): HoldPhase | undefined {
  const phase = (chunk as Record<string, unknown> | undefined)?.[
    RECOVERY_HOLD_FIELD
  ];
  return phase === "start" || phase === "end" ? phase : undefined;
}
