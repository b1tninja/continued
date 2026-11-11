import { LEAKED_CALL_NUDGE_SESSION_LIMIT } from "core/util/turnEnd.js";

/**
 * The setting and the session budget for the nudge sent when a reply is a
 * tool call written as text (H13). On by default: it is at most one extra
 * request per turn, at most LEAKED_CALL_NUDGE_SESSION_LIMIT per session, and
 * it runs nothing. `CONTINUE_NUDGE_LEAKED_CALLS=0` (or off, false, no) turns
 * it off.
 */
export const NUDGE_LEAKED_CALLS_ENV = "CONTINUE_NUDGE_LEAKED_CALLS";

let sent = 0;

export function leakedCallNudgeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env[NUDGE_LEAKED_CALLS_ENV]?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** Whether another nudge may go out in this session. */
export function leakedCallNudgeAllowed(): boolean {
  return leakedCallNudgeEnabled() && sent < LEAKED_CALL_NUDGE_SESSION_LIMIT;
}

export function noteLeakedCallNudge(): void {
  sent++;
}

/** For tests. */
export function resetLeakedCallNudges(): void {
  sent = 0;
}
