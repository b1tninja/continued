import type { EffectiveRule } from "core/tools/permissions/effectiveRules";
import type { PolicyArea } from "core/tools/permissions/policy";
import { useRef, useState } from "react";
import { Button } from "../../../../components/ui";
import { RuleChangeForm, type FormMode } from "./RuleChangeForm";
import { RuleList, type RowExtra } from "./RuleList";
import { KINDS_BY_AREA } from "./RuleTester";
import { SAVED_TEXT } from "./useRuleChange";

export interface EditorEnv {
  /** config.yaml can be read and written */
  editable: boolean;
  /** The hash of config.yaml the page last read; a different file is a conflict */
  baseHash?: string;
  /** A change was saved: reload the rules and say so */
  onChanged: (message: string) => void;
}

interface OpenForm {
  /** The rule id the form belongs to, or "new" */
  id: string;
  mode: FormMode;
}

const EXAMPLES: Record<string, string> = {
  runTerminalCommand: "runTerminalCommand(git push*)",
  readFile: "readFile(src/**)",
  writeFile: "writeFile(.github/**)",
};

const adoptable = (r: EffectiveRule) =>
  r.state === "ignored" &&
  r.ignoredCause === "trust" &&
  r.decision === "allow" &&
  (r.source === "folder" || r.source === "assistant");

/**
 * The rules of one area with the controls to change them: add, change and
 * remove your own, adopt one that came from elsewhere. Rules from other
 * sources are never edited here, and the ones that cannot be changed say why.
 */
export function EditableRules({
  area,
  rules,
  highlight,
  env,
}: {
  area: PolicyArea;
  rules: EffectiveRule[];
  highlight?: string[];
  env: EditorEnv;
}) {
  const [open, setOpen] = useState<OpenForm | undefined>();
  const addButton = useRef<HTMLButtonElement>(null);
  const tool = KINDS_BY_AREA[area]?.[0]?.tool ?? "";
  const ownCount = rules.filter((r) => r.source === "user-config").length;

  const close = () => {
    setOpen(undefined);
    // Keyboard flow: back to where the person started
    queueMicrotask(() => addButton.current?.focus());
  };
  const saved = (message: string) => {
    close();
    env.onChanged(message);
  };

  const form = (id: string, mode: FormMode) => (
    <RuleChangeForm
      mode={mode}
      baseHash={env.baseHash}
      onSaved={(res) => saved(SAVED_TEXT[res.result] ?? "Saved.")}
      onCancel={close}
    />
  );

  const extraFor = (r: EffectiveRule): RowExtra | undefined => {
    const below = open?.id === r.id ? form(r.id, open.mode) : undefined;
    if (r.source === "permissions-yaml") {
      return {
        below: (
          <>
            <p className="m-0 text-2xs text-description-muted">
              This is in your CLI file. This page writes only config.yaml, so
              change it in permissions.yaml.
            </p>
            {below}
          </>
        ),
      };
    }
    if (!env.editable) return undefined;
    if (r.source === "user-config" && !r.locked) {
      return {
        actions: (
          <>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Change rule ${r.raw}`}
              onClick={() =>
                setOpen({
                  id: r.id,
                  mode: { kind: "edit", decision: r.decision, rule: r.raw },
                })
              }
            >
              Change
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Remove rule ${r.raw}`}
              onClick={() =>
                setOpen({
                  id: r.id,
                  mode: { kind: "remove", decision: r.decision, rule: r.raw },
                })
              }
            >
              Remove
            </Button>
          </>
        ),
        below,
      };
    }
    if (adoptable(r)) {
      return {
        actions: (
          <Button
            variant="outline"
            size="sm"
            aria-label={`Adopt rule ${r.raw}`}
            onClick={() =>
              setOpen({
                id: r.id,
                mode: {
                  kind: "adopt",
                  decision: r.decision,
                  rule: r.raw,
                  from: r.source,
                },
              })
            }
          >
            Adopt
          </Button>
        ),
        below,
      };
    }
    return below ? { below } : undefined;
  };

  return (
    <section aria-label="Rules" data-testid="rules">
      <div className="flex items-center justify-between gap-2">
        <h5 className="my-1 text-xs font-semibold">Rules</h5>
        {env.editable && (
          <Button
            ref={addButton}
            variant="outline"
            size="sm"
            aria-label="Add a rule"
            onClick={() =>
              setOpen({
                id: "new",
                mode: {
                  kind: "add",
                  prefix: tool ? `${tool}(` : "",
                  example: EXAMPLES[tool] ?? "toolName(pattern)",
                },
              })
            }
          >
            Add a rule
          </Button>
        )}
      </div>
      {open?.id === "new" && form("new", open.mode)}
      {ownCount === 0 && env.editable && (
        <p className="my-1 text-xs text-description" data-testid="no-own-rules">
          You have no rules of your own yet: these built-in protections apply.
        </p>
      )}
      <RuleList
        rules={rules}
        highlight={highlight}
        extraFor={extraFor}
        emptyText={
          env.editable
            ? "No rules from anyone. The locks and built-in protections above apply, then the level."
            : undefined
        }
      />
    </section>
  );
}
