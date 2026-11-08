import type { LoopAutonomy, LoopState } from "core/index.js";
import {
  formatLoopStatus,
  LOOP_AUTONOMY_LEVELS,
  type LoopAnswerInput,
} from "core/util/loopMode.js";

import {
  acceptLoopPlan,
  answerLoopQuestion,
  getSessionLoop,
  requestLoopStop,
  resumeStoppedLoop,
  setRunningLoopAutonomy,
  startLoopFromPlan,
} from "../loop/loopSession.js";

/**
 * Loop mode in `cn serve`: what `GET /state` adds, and the Loop mode fields
 * of `POST /message`:
 *
 * - `loopAnswer: {questionId?, itemId?, text, confirm?, approve?, replanNow?,
 *   standing?}` answers a question in the loop's inbox, or writes about an
 *   item or the plan. Core's answerLoop routes it by the item's state; an
 *   answer for the running item goes in at its next tool boundary, as
 *   `steer: true` does.
 * - `loopAction: "start" | "stop" | "resume" | "continue"` are the inbox's
 *   buttons: build the session's plan in a loop (headless PresentPlan saves
 *   it without asking), Stop loop, Resume, and Continue the loop with a
 *   re-plan that waits for the person.
 * - `loopAutonomy: "supervised" | "auto" | "unattended"` is the level picker.
 */

/** Loop mode's fields in `GET /state`. */
export interface LoopSnapshot {
  /** The session's loop (core's LoopState), or null without one */
  loop: LoopState | null;
  /** One line for the loop's state, as the TUI shows it */
  loopStatus: string | null;
}

export function getLoopSnapshot(): LoopSnapshot {
  const loop = getSessionLoop();
  return {
    loop: loop ?? null,
    loopStatus: loop ? formatLoopStatus(loop) : null,
  };
}

const LOOP_ACTIONS = ["start", "stop", "resume", "continue"] as const;
type LoopAction = (typeof LOOP_ACTIONS)[number];

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseLoopAnswer(value: unknown): Parsed<LoopAnswerInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "loopAnswer must be an object" };
  }
  const v = value as Record<string, unknown>;
  const input: LoopAnswerInput = { text: "" };
  for (const key of ["questionId", "itemId", "text"] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== "string") {
      return { ok: false, error: `loopAnswer.${key} must be a string` };
    }
    input[key] = v[key] as string;
  }
  for (const key of ["confirm", "approve", "replanNow", "standing"] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== "boolean") {
      return { ok: false, error: `loopAnswer.${key} must be a boolean` };
    }
    input[key] = v[key] as boolean;
  }
  return { ok: true, value: input };
}

function applyLoopAction(action: LoopAction): string | undefined {
  switch (action) {
    case "start":
      return startLoopFromPlan()
        ? undefined
        : "The session has no plan to build in a loop";
    case "stop":
      if (!getSessionLoop()) return "No loop to stop";
      requestLoopStop();
      return undefined;
    case "resume":
      return resumeStoppedLoop() ? undefined : "No stopped loop to resume";
    case "continue":
      return acceptLoopPlan()
        ? undefined
        : "No re-planned plan waits to be accepted";
  }
}

export interface LoopMessageResponse {
  status: number;
  json: Record<string, unknown>;
}

/**
 * POST /message with Loop mode fields. Returns undefined when the body has
 * none of them, so it is an ordinary message.
 */
export function handleLoopMessage(
  body: Record<string, unknown>,
): LoopMessageResponse | undefined {
  const { loopAnswer, loopAction, loopAutonomy } = body;
  if (
    loopAnswer === undefined &&
    loopAction === undefined &&
    loopAutonomy === undefined
  ) {
    return undefined;
  }
  const fail = (error: string) => ({ status: 400, json: { error } });

  if (
    loopAction !== undefined &&
    !LOOP_ACTIONS.includes(loopAction as LoopAction)
  ) {
    return fail(`loopAction must be one of ${LOOP_ACTIONS.join(", ")}`);
  }
  if (
    loopAutonomy !== undefined &&
    !LOOP_AUTONOMY_LEVELS.includes(loopAutonomy as LoopAutonomy)
  ) {
    return fail(
      `loopAutonomy must be one of ${LOOP_AUTONOMY_LEVELS.join(", ")}`,
    );
  }
  const parsed =
    loopAnswer === undefined ? undefined : parseLoopAnswer(loopAnswer);
  if (parsed && !parsed.ok) return fail(parsed.error);

  if (loopAction !== undefined) {
    const error = applyLoopAction(loopAction as LoopAction);
    if (error) return fail(error);
  }
  if (
    loopAutonomy !== undefined &&
    !setRunningLoopAutonomy(loopAutonomy as LoopAutonomy)
  ) {
    return fail("No loop in this session");
  }
  if (!parsed) {
    return { status: 200, json: { ...getLoopSnapshot() } };
  }
  const answered = answerLoopQuestion(parsed.value);
  if (!answered.ok) return fail(answered.error);
  return {
    status: 200,
    json: {
      answered: true,
      answerId: answered.answerId,
      route: answered.route,
      ...getLoopSnapshot(),
    },
  };
}
