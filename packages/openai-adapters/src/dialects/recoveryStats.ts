/**
 * Counts of what text tool call recovery did, per model and dialect, in this
 * process (plans/tool-dialects.md, section 8). Counts only: no argument value,
 * tool name or text is ever stored here, so a snapshot is safe to show.
 *
 * - held: a block was held back because it began like a call
 * - recovered: calls made from held blocks
 * - releasedAsText: held blocks that did not validate (unknown tool, unknown
 *   or missing argument, a value the schema refuses, malformed text) and went
 *   to the person as text. A refusal by the schema is counted here; the
 *   parsers do not say which check refused.
 * - releasedAtCap: held blocks released as text because they grew past the
 *   hold cap (also counted in releasedAsText); absent until it happens
 * - recoveryErrors: stages that threw and were failed open to plain text;
 *   absent until it happens
 */
export interface RecoveryCounts {
  held: number;
  recovered: number;
  releasedAsText: number;
  releasedAtCap?: number;
  recoveryErrors?: number;
}

export interface RecoveryStatRow extends RecoveryCounts {
  model: string;
  dialect: string;
}

const rows = new Map<string, RecoveryStatRow>();
const MAX_ROWS = 200;

export function recordRecovery(
  model: string,
  dialect: string,
  delta: Partial<RecoveryCounts>,
): void {
  const key = `${model}\u0000${dialect}`;
  let row = rows.get(key);
  if (!row) {
    if (rows.size >= MAX_ROWS) return;
    row = { model, dialect, held: 0, recovered: 0, releasedAsText: 0 };
    rows.set(key, row);
  }
  row.held += delta.held ?? 0;
  row.recovered += delta.recovered ?? 0;
  row.releasedAsText += delta.releasedAsText ?? 0;
  if (delta.releasedAtCap) {
    row.releasedAtCap = (row.releasedAtCap ?? 0) + delta.releasedAtCap;
  }
  if (delta.recoveryErrors) {
    row.recoveryErrors = (row.recoveryErrors ?? 0) + delta.recoveryErrors;
  }
}

export function recoveryStatsSnapshot(): RecoveryStatRow[] {
  return [...rows.values()].map((r) => ({ ...r }));
}

export function resetRecoveryStats(): void {
  rows.clear();
}

/** One line for a usage display, or undefined when recovery did nothing. */
export function formatRecoveryStats(
  snapshot: RecoveryStatRow[] = recoveryStatsSnapshot(),
): string | undefined {
  const active = snapshot.filter((r) => r.held > 0 || r.recoveryErrors);
  if (active.length === 0) return undefined;
  const parts = active.map(
    (r) =>
      `${r.model} (${r.dialect}): ${r.held} held, ${r.recovered} recovered, ` +
      `${r.releasedAsText} released as text` +
      (r.releasedAtCap ? ` (${r.releasedAtCap} at the hold cap)` : "") +
      (r.recoveryErrors ? `, ${r.recoveryErrors} recovery errors` : ""),
  );
  return `Tool calls written as text: ${parts.join("; ")}`;
}
