/**
 * The S3 date notice (plans/research/env-disclosure-master-plan.md 3.7, row
 * ENV32), apart from ./environmentPrompt so the editor's webview can build
 * it without bundling node:crypto. ./environmentPrompt re-exports it.
 */
import { assertMayRender } from "./environmentContract";
import type { EnvironmentSnapshot } from "./environmentPrompt";

export const ENVIRONMENT_UPDATE_OPEN = '<context name="environment-update">';
export const CONTEXT_CLOSE = "</context>";

/**
 * The S3 notice for the next user message when the person's local day is no
 * longer the snapshot's, or nothing. It never changes earlier bytes: the
 * caller appends it to the newest user message.
 */
export function renderEnvironmentUpdate(
  saved: EnvironmentSnapshot,
  now: { localDay?: string },
): string | undefined {
  const day = now.localDay;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day === saved.localDay) {
    return undefined;
  }
  assertMayRender("dateUpdate", "update");
  return [
    ENVIRONMENT_UPDATE_OPEN,
    `Today's date is now ${day} (the session started on ${saved.localDay}).`,
    CONTEXT_CLOSE,
  ].join("\n");
}
