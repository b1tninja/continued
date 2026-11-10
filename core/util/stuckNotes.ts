import type { StuckReport, StuckSignal, StuckSignalKind } from "./stuckSignals";

/**
 * L1 of the stuck ladder (plans/stuck-detection.md): a one-line note appended
 * to the tool result of the call that tripped a signal. It is appended to the
 * newest result only, so the system prompt and every earlier message stay as
 * they were and the prompt cache holds.
 */

/** Marks the note, so a host can take it back out before reading a history. */
export const STUCK_NOTE_MARK = "\n\n[Stuck check] ";

/**
 * Signals that never get a note here. `repeat-call` is the CLI's repeat guard,
 * which refuses the call itself; `monologue` has no tool result to write on.
 */
const NO_NOTE = new Set<StuckSignalKind>(["repeat-call", "monologue"]);

const WORDING: Record<
  Exclude<StuckSignalKind, "repeat-call" | "monologue">,
  (s: StuckSignal) => string
> = {
  "near-repeat": (s) =>
    `this is the ${ordinal(s.count)} call that differs from the others only in spacing, case, numbers or flag order. A variation of the same call will give the same result; change what you do, not how you write it.`,
  "repeat-error": (s) =>
    `${s.count} different calls have failed with the same error. State what you expected and what you see, then try the smallest experiment that tells them apart.`,
  "ping-pong": (s) =>
    `you have alternated between the same two calls for ${s.count} cycles. List the two approaches and what each breaks, then pick one.`,
  "edit-revert": (s) =>
    `a file has gone back to content it already had (${s.count} ${s.count === 1 ? "time" : "times"}). Decide on the approach before editing it again.`,
  "no-progress": (s) =>
    `${s.count} steps in a row have changed no file, read no new file and hit no new error. Restate the goal and take the next concrete step.`,
  "retry-after-fail": (s) =>
    `this is the ${ordinal(s.count)} failed attempt of the same command since the last file change. Reproduce the failure smaller, or find what differs from the passing case.`,
};

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ??
        "th");
  return `${n}${suffix}`;
}

/**
 * The note for a report, or undefined when no signal that has a note is
 * active. One note per call: the most severe signal wins, then the first.
 */
export function stuckNote(report: StuckReport): string | undefined {
  const candidates = report.signals.filter((s) => !NO_NOTE.has(s.kind));
  const pick =
    candidates.find((s) => s.level === "stuck") ??
    candidates.find((s) => s.level === "note");
  if (!pick) return undefined;
  const say = WORDING[pick.kind as keyof typeof WORDING];
  return `${STUCK_NOTE_MARK}${say(pick)}`;
}

/** A tool result without the note a host appended to it. */
export function stripStuckNote(text: string): string {
  const at = text.indexOf(STUCK_NOTE_MARK);
  return at < 0 ? text : text.slice(0, at);
}
