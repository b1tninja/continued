import {
  POLICY_PRESETS,
  presetOf,
  type PolicyLevels,
} from "core/tools/permissions/policy.js";
import { GlobalContext } from "core/util/GlobalContext.js";

import { isServe, supportsInteractive } from "../util/cli.js";

/**
 * The first-run line in the interactive header. The dismissal lives in the
 * person's own global context (next to the other CLI-only flags), never in
 * the workspace. It is shown once: the flag is written when the line first
 * appears.
 */
export function shouldShowFirstRunBanner(): boolean {
  if (!supportsInteractive() || isServe()) {
    return false;
  }
  try {
    return new GlobalContext().get("cliFirstRunBannerShown") !== true;
  } catch {
    // an unreadable store must not put the line on every start
    return false;
  }
}

export function markFirstRunBannerShown(): void {
  try {
    new GlobalContext().update("cliFirstRunBannerShown", true);
  } catch {
    // best effort
  }
}

export function firstRunBannerText(levels: PolicyLevels): string {
  const name = presetOf(levels);
  const preset = name ? `${POLICY_PRESETS[name].label} preset` : "a custom mix";
  return `Permissions: ${preset}. Change it with /policy (presets, or area=level). Shown once.`;
}
