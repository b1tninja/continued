import type { EffectiveRulesReport } from "core/tools/permissions/effectiveRules";
import type { PolicyLevels } from "core/tools/permissions/policy";
import { useEffect, useState } from "react";
import type { IIdeMessenger } from "../../../../context/IdeMessenger";
import { SLOW_AFTER_MS } from "./PermissionsStates";

/**
 * Reads the rules from core. `loading` is true until the first answer; a
 * later reload keeps the old report on screen. `slow` turns on after
 * SLOW_AFTER_MS without an answer, so the page can say so instead of
 * spinning for ever. `reload` asks again and clears an error.
 */
export function usePermissionsReport(
  ideMessenger: IIdeMessenger,
  levels: PolicyLevels,
) {
  const [report, setReport] = useState<EffectiveRulesReport | undefined>();
  const [error, setError] = useState(false);
  const [slow, setSlow] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    const finish = (content?: EffectiveRulesReport) => {
      if (cancelled) return;
      clearTimeout(timer);
      setSlow(false);
      if (content) setReport(content);
      setError(!content);
    };
    ideMessenger
      .request("policy/rules", { levels })
      .then((res) => finish(res.status === "success" ? res.content : undefined))
      .catch(() => finish(undefined));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ideMessenger, levels, reloads]);

  return {
    report,
    error,
    slow,
    loading: !report && !error,
    reload: () => setReloads((n) => n + 1),
  };
}
