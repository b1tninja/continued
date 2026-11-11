import type {
  AreaReport,
  EffectiveRulesReport,
} from "core/tools/permissions/effectiveRules";
import {
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  QUESTION_TYPE_DESCRIPTIONS,
  type PolicyArea,
} from "core/tools/permissions/policy";
import type { ToolCallTestResult } from "core/tools/permissions/testToolCall";
import { useContext, useEffect, useState } from "react";
import Alert from "../../../../components/gui/Alert";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppSelector } from "../../../../redux/hooks";
import { ConfigHeader } from "../../components/ConfigHeader";
import { BuiltinList, RuleList } from "./RuleList";
import { RuleTester } from "./RuleTester";

function PlanSettings({ area }: { area: AreaReport }) {
  const s = area.settings;
  if (s?.kind !== "plan") return null;
  return (
    <section aria-label="Plan settings" data-testid="plan-settings">
      <h5 className="my-1 text-xs font-semibold">What Plan edits has</h5>
      <p className="my-1 text-2xs text-description-muted">
        Plan edits is a level, not a list of rules. In Loop it decides whether a
        plan or re-plan goes on without you.
      </p>
      <ul className="m-0 pl-4 text-xs">
        <li>
          New to-dos a re-plan may add by itself (Permissive):{" "}
          <strong>{s.maxNewItems}</strong>
          {s.maxNewItems === DEFAULT_MAX_NEW_PLAN_ITEMS ? " (default)" : ""}
        </li>
        <li>
          Stop a re-plan that weakens a check:{" "}
          <strong>{s.keepsChecks ? "on" : "off"}</strong>
        </li>
      </ul>
    </section>
  );
}

function QuestionSettings({ area }: { area: AreaReport }) {
  const s = area.settings;
  if (s?.kind !== "questions") return null;
  const list = (items: string[]) => (items.length ? items.join(", ") : "none");
  return (
    <section aria-label="Question settings" data-testid="question-settings">
      <h5 className="my-1 text-xs font-semibold">What Questions has</h5>
      <p className="my-1 text-2xs text-description-muted">
        Questions is a level and two lists of question types, not a list of
        rules.
      </p>
      <ul className="m-0 pl-4 text-xs">
        <li>
          You always decide: <strong>{list(s.youDecide)}</strong>
        </li>
        <li>
          The agent may decide: <strong>{list(s.agentDecides)}</strong>
        </li>
        <li>
          While a question waits:{" "}
          <strong>
            {s.delivery === "wait" ? "work stops" : "work goes on (inbox)"}
          </strong>
        </li>
      </ul>
      <details className="mt-1 text-2xs">
        <summary className="cursor-pointer">The types</summary>
        <ul className="m-0 pl-4">
          {Object.entries(QUESTION_TYPE_DESCRIPTIONS).map(([k, v]) => (
            <li key={k}>
              <strong>{k}</strong>: {v}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function AreaPanel({
  area,
  report,
}: {
  area: PolicyArea;
  report: EffectiveRulesReport;
}) {
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const [result, setResult] = useState<ToolCallTestResult | undefined>();
  const a = report.areas[area];
  const hasRules = area !== "plan" && area !== "questions";
  return (
    <div
      role="tabpanel"
      id={`permissions-panel-${area}`}
      aria-labelledby={`permissions-tab-${area}`}
      className="flex min-w-0 flex-col gap-3"
      data-testid={`panel-${area}`}
    >
      <section aria-label="Level">
        <div className="text-xs">
          {a.label}: <strong data-testid="area-level">{a.levelLabel}</strong>
        </div>
        <div className="text-2xs text-description-muted">
          {a.levelDescription} Change it in Settings &gt; Tools or the toolbar.
        </div>
      </section>
      <PlanSettings area={a} />
      <QuestionSettings area={a} />
      {hasRules && (
        <p
          className="m-0 text-2xs text-description-muted"
          data-testid="decision-order"
        >
          {report.decisionOrder}
        </p>
      )}
      <BuiltinList builtins={a.builtins} />
      {hasRules && (
        <>
          <section aria-label="Rules" data-testid="rules">
            <h5 className="my-1 text-xs font-semibold">Rules</h5>
            <RuleList
              rules={a.rules}
              highlight={result?.matchedRules.map((m) => m.raw)}
            />
          </section>
          <RuleTester area={area} levels={levels} onResult={setResult} />
        </>
      )}
    </div>
  );
}

/**
 * Settings > Permissions (read-only, slice 1): every rule in effect by area,
 * with its source and whether it is obeyed, and a tester that runs the real
 * check. Rules are edited in config.yaml for now; nothing here writes.
 * The Reviewer tab joins the area tabs here later.
 */
export function PermissionsSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const levels = useAppSelector((s) => s.ui.policyLevels);
  const [report, setReport] = useState<EffectiveRulesReport | undefined>();
  const [error, setError] = useState(false);
  const [active, setActive] = useState<PolicyArea>("tools");

  useEffect(() => {
    let cancelled = false;
    void ideMessenger.request("policy/rules", { levels }).then((res) => {
      if (cancelled) return;
      if (res.status === "success") {
        setReport(res.content);
        setError(false);
      } else {
        setError(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, levels]);

  return (
    <section className="mb-4 min-w-0" data-testid="permissions-page">
      <ConfigHeader
        title="Permissions"
        subtext="Every rule that decides what the agent may read, run and change, where it came from, and whether it applies. Read-only: edit rules in config.yaml."
        showAddButton={false}
        className="mb-2"
      />
      {error && (
        <Alert type="error" size="sm">
          <span className="text-2xs">The rules could not be read.</span>
        </Alert>
      )}
      {report?.notices.map((n) => (
        <div className="mb-2" key={n}>
          <Alert type="warning" size="sm">
            <span className="text-2xs">{n}</span>
          </Alert>
        </div>
      ))}
      <div
        role="tablist"
        aria-label="Permission areas"
        className="mb-3 flex flex-wrap gap-1"
      >
        {POLICY_AREAS.map((area) => (
          <button
            key={area}
            role="tab"
            id={`permissions-tab-${area}`}
            aria-selected={active === area}
            aria-controls={`permissions-panel-${area}`}
            data-testid={`tab-${area}`}
            onClick={() => setActive(area)}
            className={`cursor-pointer rounded-sm border border-solid px-2 py-0.5 text-xs text-foreground ${
              active === area
                ? "border-border-focus bg-input"
                : "border-border bg-transparent"
            }`}
          >
            {POLICY_AREA_LABELS[area]}
            {report && report.areas[area].rules.length > 0 && (
              <span className="ml-1 text-description-muted">
                {report.areas[area].rules.length}
              </span>
            )}
          </button>
        ))}
      </div>
      {report && <AreaPanel key={active} area={active} report={report} />}
      {report && report.unscoped.length > 0 && (
        <section aria-label="Rules with no area" className="mt-3">
          <h5 className="my-1 text-xs font-semibold">Rules with no area</h5>
          <p className="my-1 text-2xs text-description-muted">
            These name a tool that only touches the session, or cannot be read,
            so no area applies.
          </p>
          <RuleList rules={report.unscoped} />
        </section>
      )}
    </section>
  );
}
