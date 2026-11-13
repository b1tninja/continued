/**
 * Guards: checks the person turns on one by one, each off until chosen
 * (plans/research/custom-policy.md). A guard that is on refuses the call at
 * every level, IDGAF included, like a rule in `floor:`: it never asks, so a
 * run at IDGAF is not stopped to wait for anyone, the call is refused and the
 * agent is told why.
 *
 * A guard never turns on a check the person did not choose. IDGAF on its own
 * still runs everything; a policy based on IDGAF with one guard runs
 * everything except what that one guard names.
 *
 * Stored in permissions.yaml as `guards: { <id>: on }`, in the person's own
 * global file only. Nothing in a workspace can turn a guard off or on.
 */

export type GuardId = "edits-outside-workspace";

export interface GuardInfo {
  id: GuardId;
  /** The switch's label, a sentence that says what is refused */
  label: string;
  description: string;
}

export const GUARDS: readonly GuardInfo[] = [
  {
    id: "edits-outside-workspace",
    label: "Do not edit files outside the workspace",
    description:
      "A File edits call (create, edit or write a file) whose target is outside the workspace folders is refused, at every level including IDGAF. Uses the same outside-the-workspace check as the built-in rule that asks. A terminal command that writes a file is not covered.",
  },
];

export const GUARD_IDS: ReadonlySet<string> = new Set(GUARDS.map((g) => g.id));

export type GuardSettings = Partial<Record<GuardId, boolean>>;

/** True only when the person turned this guard on. */
export function guardOn(
  settings: { guards?: GuardSettings } | undefined,
  id: GuardId,
): boolean {
  return settings?.guards?.[id] === true;
}

/** The guards that are on, in the order of GUARDS. */
export function guardsOn(guards: GuardSettings | undefined): GuardId[] {
  return GUARDS.filter((g) => guards?.[g.id] === true).map((g) => g.id);
}

/** The label of a guard, for a reason or a chip. */
export function guardLabel(id: GuardId): string {
  return GUARDS.find((g) => g.id === id)?.label ?? id;
}

/** The rule text a refusal names, so the audit trail can tell guards apart. */
export function guardRuleText(id: GuardId): string {
  return `guards.${id}`;
}
