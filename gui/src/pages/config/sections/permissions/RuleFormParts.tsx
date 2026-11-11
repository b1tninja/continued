import type { ToolRuleEditResponse } from "core/tools/permissions/ruleEditor";
import type { RuleDecision } from "core/tools/permissions/rules";
import { CONFIRM_PHRASE } from "core/tools/permissions/ruleWords";
import { writtenRuleCommand } from "core/tools/permissions/writtenRule";
import { useId } from "react";
import { Button } from "../../../../components/ui";
import useCopy from "../../../../hooks/useCopy";

export function DiffView({
  diff,
}: {
  diff: NonNullable<ToolRuleEditResponse["diff"]>;
}) {
  if (diff.length === 0) return null;
  return (
    <pre
      className="m-0 max-h-40 overflow-auto rounded-sm border border-solid border-border bg-input p-1 font-mono text-2xs"
      aria-label="What will change in config.yaml"
      data-testid="rule-diff"
    >
      {diff.map((l, i) => (
        <div
          key={i}
          className={
            l.kind === "add"
              ? "text-success"
              : l.kind === "remove"
                ? "text-error"
                : "text-description-muted"
          }
        >
          {l.kind === "add" ? "+ " : l.kind === "remove" ? "- " : "  "}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

export function Verdict({
  verdict,
}: {
  verdict: NonNullable<ToolRuleEditResponse["verdict"]>;
}) {
  const word = (d: string) =>
    d === "allow" ? "runs" : d === "deny" ? "is refused" : "asks";
  return (
    <p className="m-0 text-xs" data-testid="rule-verdict">
      Try <code className="font-mono">{verdict.probe}</code>: now it{" "}
      <strong>{word(verdict.before.decision)}</strong>
      {verdict.before.decision === verdict.after.decision
        ? ", and it still will."
        : `, with this rule it ${word(verdict.after.decision)}.`}
    </p>
  );
}

/**
 * A very wide Always rule: the phrase is typed here, then the editor's own
 * dialog asks as well (the page alone cannot confirm a loosening).
 */
export function TypedConfirmation({
  broadReason,
  value,
  onChange,
}: {
  broadReason?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1" data-testid="typed-confirmation">
      <p className="m-0 text-xs text-warning" role="alert">
        This is a very wide Always rule. {broadReason} Anything it matches will
        run without asking.
      </p>
      <label htmlFor={id} className="text-2xs">
        Type <strong>{CONFIRM_PHRASE}</strong> to confirm
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="box-border min-h-6 w-full min-w-0 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
      />
    </div>
  );
}

/** Said whenever the change loosens: the answer is given in the editor, not here. */
export function NativeNotice({ waiting }: { waiting: boolean }) {
  return (
    <p
      className="m-0 text-2xs text-description-muted"
      data-testid="native-notice"
      role={waiting ? "status" : undefined}
    >
      {waiting
        ? "Waiting for your answer in the window your editor opened."
        : "This lets something run without asking that did not before. Your editor will ask you to confirm before it is saved."}
    </p>
  );
}

/**
 * The rule in the one written form, the command `continuous permissions add`
 * accepts, so it can be shared or run in a terminal. Copy does not run it.
 */
export function WrittenRuleLine({
  decision,
  rule,
}: {
  decision: RuleDecision;
  rule: string;
}) {
  const id = useId();
  const text = rule.trim() ? writtenRuleCommand(decision, rule) : "";
  const { copied, copyText } = useCopy(text);
  if (!text) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="written-rule">
      <span id={id} className="text-2xs">
        As a command
      </span>
      <div className="flex min-w-0 items-start gap-1">
        <code
          aria-labelledby={id}
          className="min-w-0 flex-1 font-mono text-2xs break-all"
        >
          {text}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-6 min-w-6"
          aria-label="Copy the command for this rule"
          onClick={copyText}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
