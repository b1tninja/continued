import {
  LOOP_FALLBACK_CHECK_LENGTH,
  setLoopFallbackCheck,
} from "core/util/loopMode.js";

import { commitLoop, getSessionLoop } from "./loopSession.js";

/**
 * The check every item without its own `check:` is held to (core's
 * LoopState.fallbackCheck). An empty command clears it. False when there is
 * no loop, or the command is over the length limit.
 */
export function setRunningLoopFallbackCheck(command: string): boolean {
  const loop = getSessionLoop();
  if (!loop) return false;
  if (command.trim().length > LOOP_FALLBACK_CHECK_LENGTH) return false;
  commitLoop(setLoopFallbackCheck(loop, command));
  return true;
}
