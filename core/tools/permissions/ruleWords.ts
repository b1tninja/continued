/**
 * The words the Permissions page, the CLI and the audit trail share. No
 * imports, so the webview can use them. The files keep `deny`, `ask` and
 * `allow`; a person reads Never, Ask and Always (design-iteration.md,
 * vocabulary).
 */
export type DecisionKey = "deny" | "ask" | "allow";

export const DECISION_WORDS: Record<DecisionKey, string> = {
  deny: "Never",
  ask: "Ask",
  allow: "Always",
};

/** What a person types to confirm a rule that allows everything, in either place. */
export const CONFIRM_PHRASE = "allow everything";
