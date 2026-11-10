import type { ChatHistoryItem } from "core/index.js";
import { stepsFromHistory } from "core/util/stuckHistory.js";
import { detectStuck } from "core/util/stuckSignals.js";
import {
  stripStuckNote,
  STUCK_NOTE_MARK,
  stuckNote,
} from "core/util/stuckNotes.js";

/**
 * L1 of the stuck ladder (plans/stuck-detection.md, S2) for the CLI: after a
 * round of tool calls, read the history with the shared signals and, if one
 * has reached `note`, give the text to append to the newest result.
 *
 * Off with CONTINUE_CLI_DISABLE_STUCK_NOTES=1 (the `stuckDetection` setting of
 * S6 does not exist yet). Notes are on by default (decision D3).
 */
export function stuckNotesEnabled(): boolean {
  const v = process.env.CONTINUE_CLI_DISABLE_STUCK_NOTES;
  return !v || v === "0" || v.toLowerCase() === "false";
}

/** The history as the signals should read it: without the notes themselves. */
function withoutNotes(history: ChatHistoryItem[]): ChatHistoryItem[] {
  return history.map((item) => {
    if (!item.toolCallStates?.some((s) => hasNote(s.output))) return item;
    return {
      ...item,
      toolCallStates: item.toolCallStates.map((s) => ({
        ...s,
        output: s.output?.map((o) => ({
          ...o,
          content: stripStuckNote(o.content ?? ""),
        })),
      })),
    };
  });
}

function hasNote(output: { content?: string }[] | undefined): boolean {
  return !!output?.some((o) => o.content?.includes(STUCK_NOTE_MARK));
}

/** The note to append to the newest result, or undefined. */
export function stuckNoteForHistory(
  history: ChatHistoryItem[],
): string | undefined {
  if (!stuckNotesEnabled()) return undefined;
  return stuckNote(detectStuck(stepsFromHistory(withoutNotes(history))));
}
