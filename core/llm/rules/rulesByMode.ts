import type { MessageModes, ModelUse, RulesByModeConfig } from "../..";

/**
 * Whether rules are sent in a mode. A mode with no entry is enabled, and
 * background runs follow Agent.
 */
export function rulesEnabledForMode(
  rulesByMode: RulesByModeConfig | undefined,
  mode: MessageModes,
): boolean {
  const key = mode === "background" ? "agent" : mode;
  if (key !== "chat" && key !== "agent" && key !== "plan") return true;
  return rulesByMode?.[key] !== false;
}

/**
 * Whether rules are sent for a use: a Loop item follows `loop`, else `agent`;
 * a re-plan `replan`, else `plan`. Anything else is on.
 */
export function rulesEnabledForUse(
  rulesByMode: RulesByModeConfig | undefined,
  use: ModelUse | undefined,
): boolean {
  if (!use) return true;
  if (use === "loop" || use === "replan") {
    const own = rulesByMode?.[use];
    if (own !== undefined) return own;
    return rulesEnabledForMode(rulesByMode, use === "loop" ? "agent" : "plan");
  }
  if (use === "chat" || use === "agent" || use === "plan") {
    return rulesEnabledForMode(rulesByMode, use);
  }
  return true;
}
