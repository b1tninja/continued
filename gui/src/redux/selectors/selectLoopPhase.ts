import type { RootState } from "../store";

/**
 * Which half of the loop is turning: a planning turn (the first plan, a
 * re-plan, a repair, a plan waiting on the person) or a building turn (an
 * item or its check). The rest are rests: waiting on an answer, stopped, or
 * no loop at all.
 */
export type LoopPhase =
  "planning" | "building" | "waiting" | "stopped" | "idle";

export function selectLoopPhase(state: RootState): LoopPhase {
  const { loop, loopRequested } = state.session;
  // Chosen Loop and not yet planned: the first turn is a plan turn
  if (!loop) return loopRequested ? "planning" : "idle";
  if (loop.status === "stopped") return "stopped";
  if (
    loop.current?.kind === "replan" ||
    loop.status === "replanning" ||
    loop.status === "awaiting_plan"
  ) {
    return "planning";
  }
  if (loop.status === "waiting") return "waiting";
  return "building";
}

export const LOOP_PHASE_LABEL: Record<LoopPhase, string> = {
  planning: "Planning",
  building: "Building",
  waiting: "Waiting for you",
  stopped: "Stopped",
  idle: "Loop",
};
