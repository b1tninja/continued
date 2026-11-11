import {
  createSegmentDump,
  promptSegmentsEnabled,
} from "core/llm/promptSegments";
import type { RootState } from "../store";
import { describeChatRequest } from "./describeChatRequest";

/**
 * CONTINUE_PROMPT_SEGMENTS for the IDE: the webview has no environment, so the
 * switch is the local storage key of the same name (set it to 1 in the
 * webview's dev tools). One console line per segment of every chat request:
 * id, region, stability, tokens, hash8, and which prefix segment changed since
 * the previous request. Never contents. With the key unset the function
 * returns after one storage read and builds nothing.
 */
const KEY = "CONTINUE_PROMPT_SEGMENTS";
const dump = createSegmentDump((line) => console.info(line));

function enabled(): boolean {
  try {
    return promptSegmentsEnabled(
      globalThis.localStorage?.getItem(KEY) ?? undefined,
    );
  } catch {
    return false;
  }
}

export function dumpPromptSegments(state: RootState): void {
  if (!enabled()) return;
  dump(
    `model=${state.config.config.selectedModelByRole.chat?.model} mode=${state.session.mode}`,
    () => describeChatRequest(state),
  );
}
