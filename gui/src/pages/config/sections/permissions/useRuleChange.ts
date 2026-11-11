import type {
  ToolRuleEditResponse,
  ToolRuleEditResult,
} from "core/tools/permissions/ruleEditor";
import type { RuleDecision } from "core/tools/permissions/rules";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";

export type RuleChange =
  | { op: "add"; decision: RuleDecision; rule: string }
  | {
      op: "update";
      decision: RuleDecision;
      rule: string;
      newDecision: RuleDecision;
      newRule: string;
    }
  | { op: "remove"; decision: RuleDecision; rule: string }
  | { op: "adopt"; decision: RuleDecision; rule: string };

const MESSAGE = {
  add: "config/addToolRule",
  update: "config/updateToolRule",
  remove: "config/removeToolRule",
  adopt: "config/adoptToolRule",
} as const;

export const SAVED_RESULTS: ToolRuleEditResult[] = [
  "added",
  "updated",
  "removed",
  "adopted",
];

export const SAVED_TEXT: Record<string, string> = {
  added: "Rule added.",
  updated: "Rule changed.",
  removed: "Rule removed.",
  adopted: "Rule adopted into your own config.yaml.",
};

export interface RuleChangeState {
  /** The dry-run answer for the change as it stands: warnings, diff, verdict, friction */
  preview?: ToolRuleEditResponse;
  /** Why the change cannot be saved, in words, or why the preview could not be made */
  error?: string;
  busy: boolean;
  /** Check the change (nothing is written) */
  check: (probe?: string) => void;
  /** Save it, with the confirmation the preview asked for */
  save: (confirm?: string) => Promise<ToolRuleEditResponse | undefined>;
}

/**
 * The two-step change the editor makes: a dry run that explains the change, then
 * the same request with the confirmation. The last answer wins, so a slow
 * preview of an earlier keystroke never replaces a newer one.
 */
export function useRuleChange(
  change: RuleChange | undefined,
  baseHash: string | undefined,
  delayMs = 250,
): RuleChangeState {
  const ideMessenger = useContext(IdeMessengerContext);
  const [preview, setPreview] = useState<ToolRuleEditResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const probeRef = useRef<string | undefined>(undefined);
  const seq = useRef(0);
  const key = change ? JSON.stringify(change) : "";

  const send = useCallback(
    async (extra: {
      dryRun?: boolean;
      confirm?: string;
      probe?: string;
    }): Promise<ToolRuleEditResponse | undefined> => {
      if (!change) return undefined;
      const res = await ideMessenger.request(MESSAGE[change.op], {
        decision: change.decision,
        rule: change.rule,
        ...(change.op === "update"
          ? { newDecision: change.newDecision, newRule: change.newRule }
          : {}),
        ...(baseHash ? { baseHash } : {}),
        source: "permissions-page",
        ...extra,
      });
      return res.status === "success" ? res.content : undefined;
    },
    [ideMessenger, key, baseHash],
  );

  const run = useCallback(() => {
    const mine = ++seq.current;
    if (!change) {
      setPreview(undefined);
      setError(undefined);
      return;
    }
    setBusy(true);
    void send({ dryRun: true, probe: probeRef.current }).then((res) => {
      if (mine !== seq.current) return;
      setBusy(false);
      if (!res) {
        setPreview(undefined);
        setError("Could not check this rule. Try again.");
      } else if (res.result === "preview") {
        setPreview(res);
        setError(undefined);
      } else {
        setPreview(res.analysis ? res : undefined);
        setError(res.error ?? "This rule cannot be saved.");
      }
    });
  }, [send]);

  useEffect(() => {
    const t = setTimeout(run, delayMs);
    return () => clearTimeout(t);
  }, [run, delayMs]);

  const check = useCallback(
    (probe?: string) => {
      probeRef.current = probe;
      run();
    },
    [run],
  );

  const save = useCallback(
    async (confirm?: string) => {
      seq.current++;
      setBusy(true);
      const res = await send({ ...(confirm ? { confirm } : {}) });
      setBusy(false);
      if (!res) {
        setError("The change could not be saved. Nothing was written.");
        return undefined;
      }
      if (!SAVED_RESULTS.includes(res.result)) {
        setError(res.error ?? "The change could not be saved.");
        return res;
      }
      setError(undefined);
      return res;
    },
    [send],
  );

  return { preview, error, busy, check, save };
}
