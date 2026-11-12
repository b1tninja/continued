/**
 * The retirement notice for the active model, at most once a day and never
 * after the user dismissed it (core/util/retirementNoticeState.ts). Offline:
 * the checked-in table, overridden by the lifecycle the user's own key last
 * returned. Returns the line to print, or undefined. Never blocks, never
 * throws.
 */
import { retirementNotice, type RetirementNotice } from "./modelRetirement.js";
import {
  dismissNotice,
  dueToday,
  liveFor,
  markShown,
} from "./retirementNoticeState.js";

export interface StartupInput {
  provider: string | undefined;
  model: string | undefined;
  /** Today, YYYY-MM-DD. */
  now?: string;
  /** For tests. */
  file?: string;
}

const today = (now?: string) => now ?? new Date().toISOString().slice(0, 10);

/** The current notice for a model, whether or not it was shown today. */
export function currentNotice(
  input: StartupInput,
): RetirementNotice | undefined {
  try {
    if (!input.model) return undefined;
    const live = liveFor(input.model, input.file);
    return retirementNotice({
      provider: input.provider,
      model: input.model,
      now: today(input.now),
      ...(live ? { live } : {}),
    });
  } catch {
    return undefined;
  }
}

/** The start-up line, marking it shown; undefined when none is due. */
export function startupRetirementLine(input: StartupInput): string | undefined {
  const n = currentNotice(input);
  if (!n || !dueToday(n.key, today(input.now), input.file)) return undefined;
  markShown(n.key, today(input.now), input.file);
  return `Warning: ${n.message} To hide this notice: continuous dismiss-notice ${n.model}`;
}

/** Dismiss the current notice for a model; true when there was one. */
export function dismissCurrentNotice(input: StartupInput): boolean {
  const n = currentNotice(input);
  if (!n) return false;
  dismissNotice(n.key, today(input.now), input.file);
  return true;
}
