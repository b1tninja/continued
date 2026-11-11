import {
  ADVISORY_THRESHOLD,
  classifyToolReply,
  type ToolCallLike,
} from "../../../util/toolDialectDetect";

/**
 * What one captured reply was, for the rates. `leak`: a tool call written as
 * text, meaning classifyToolReply names a markup dialect at or above the
 * advisory threshold and no structured call came back. The advisory bar (0.5)
 * and not the accept bar (0.8) that gates recovery is used because a bare
 * Llama JSON object scores 0.7 and is the leak most worth counting. `structured`: the server returned a
 * tool call. `refused`: no call in either form (prose or empty), which for a
 * prompt that asks for a tool is a refusal or a wrong answer. `error`: the
 * request failed; errors stay out of every denominator.
 */
export type Outcome = "structured" | "leak" | "refused" | "error";

export interface Classified {
  outcome: Outcome;
  /** The dialect classifyToolReply named, or "none". */
  dialect: string;
}

export function classifyReply(args: {
  text: string;
  toolCalls: ToolCallLike[];
  knownTools: string[];
  error?: string;
}): Classified {
  if (args.error) return { outcome: "error", dialect: "none" };
  const c = classifyToolReply({
    content: args.text,
    toolCalls: args.toolCalls,
    knownTools: args.knownTools,
  });
  if (args.toolCalls.length > 0) {
    // Structured calls win even when markup is also left in the text.
    return { outcome: "structured", dialect: "native-structured" };
  }
  if (
    c.dialect !== "prose" &&
    c.dialect !== "unknown" &&
    c.dialect !== "native-structured" &&
    c.confidence >= ADVISORY_THRESHOLD
  ) {
    return { outcome: "leak", dialect: c.dialect };
  }
  return { outcome: "refused", dialect: c.dialect };
}
