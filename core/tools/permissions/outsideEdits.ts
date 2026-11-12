import type { ApprovalSettings } from "./approval";
import { uriToPath } from "./names";

/**
 * File edits at IDGAF, the top level, says nothing asks, so an edit, a write or a new file outside the
 * workspace is carried out. Every host asks this one question, so the answer
 * is the same in the IDE, the CLI, headless and `serve`.
 *
 * Only the level decides. The locked floor (permission and policy files), a
 * tool switched off, an organisation ceiling and the person's own `floor:`
 * rules are settled by the evaluator before a call gets here, and still hold.
 */
export function editsAllowOutsideWorkspace(
  approval: Pick<ApprovalSettings, "levels"> | undefined,
): boolean {
  // `yolo` is the stored name of IDGAF, the top level
  const level = String(approval?.levels?.edits ?? "").toLowerCase();
  return level === "idgaf" || level === "yolo";
}

/** The note that goes in the transcript when a write lands outside the workspace. */
export function wroteOutsideNote(target: string): string {
  const shown = target.startsWith("file:")
    ? (uriToPath(target) ?? target)
    : target;
  return `Wrote outside the workspace: ${shown}`;
}

/** Added to the audit reason of an allowed call whose target is outside the workspace. */
export function outsideTargetReason(target: string): string {
  return `The target is outside the workspace: ${target}.`;
}
