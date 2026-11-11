import * as os from "node:os";
import type { IDE } from "../..";
import { getAuditTrail } from "./audit/global";
import type { ChangeSource } from "./ruleAnalysis";
import {
  editToolRule,
  hasUndo,
  undoToolRuleChange,
  undoWouldLoosen,
  type ToolRuleEdit,
  type ToolRuleEditResponse,
  type UndoResponse,
} from "./ruleEditor";
import { readRuleSources } from "./readRuleSources";
import type { RuleDecision, ToolPermissions } from "./rules";
import { CONFIRM_PHRASE, DECISION_WORDS } from "./ruleWords";
import { getConfigYamlPath } from "../../util/paths";

/**
 * The webview's way to change rules: one request per kind of change, all
 * answered with a named result (ruleEditor.ts). These are protocol messages, not
 * tools: nothing the model can call reaches them.
 */
export interface RuleEditRequest {
  decision: RuleDecision;
  rule: string;
  /** update: the list and text the rule becomes */
  newDecision?: RuleDecision;
  newRule?: string;
  /** move: one place up (-1) or down (1) in its list */
  moveBy?: -1 | 1;
  /** The typed phrase, or "yes" */
  confirm?: string;
  baseHash?: string;
  dryRun?: boolean;
  probe?: string;
  source?: ChangeSource;
}

export interface RuleEditorHost {
  /** The loaded configuration's merged rules, for naming where each rule came from */
  mergedRules: () => Promise<ToolPermissions | undefined>;
  cwd: () => Promise<string | undefined>;
  /** Called after a change that was written, so the new rules are loaded */
  reload: (reason: string) => Promise<void>;
  /**
   * Ask the person in the IDE's own dialog, which the page cannot click.
   * Resolves true only on an explicit yes. Missing: a loosening is refused.
   */
  confirmLoosening?: (text: string) => Promise<boolean>;
}

type On = (
  name: any,
  handler: (msg: { data: any }) => Promise<unknown>,
) => void;

const WRITTEN: string[] = ["added", "updated", "removed", "adopted", "moved"];

const ALLOW = "Allow";

const NOT_CONFIRMED =
  "Not confirmed in the editor's own dialog, so nothing was changed.";

/** The sentence the native dialog shows, in the page's words. */
export function looseningText(
  op: ToolRuleEdit["op"],
  data: Pick<RuleEditRequest, "decision" | "rule" | "newDecision" | "newRule">,
  broadReason?: string,
): string {
  const word = (d: RuleDecision) => DECISION_WORDS[d];
  const what =
    op === "remove"
      ? `Remove the ${word(data.decision)} rule ${data.rule}?`
      : op === "update"
        ? `Change ${word(data.decision)} ${data.rule} to ${word(data.newDecision ?? data.decision)} ${data.newRule ?? data.rule}?`
        : `${op === "adopt" ? "Adopt" : "Add"} ${word(data.decision)} ${data.rule}?`;
  return `${what}\n\nThis lets something run without asking that did not before.${broadReason ? ` ${broadReason}` : ""}\n\nRules are saved to your own config.yaml.`;
}

/**
 * Ask in the IDE's own dialog. VS Code gets a modal one; other IDEs get their
 * notification with an Allow action. The page cannot reach either, and a
 * missing answer (closed, timed out, an IDE that cannot ask) is a no.
 */
export async function confirmInIde(
  ide: Pick<IDE, "getIdeInfo" | "showToast">,
  text: string,
): Promise<boolean> {
  const info = await ide.getIdeInfo().catch(() => undefined);
  const modal = info?.ideType === "vscode" ? [{ modal: true }] : [];
  const choice = await ide.showToast("warning", text, ...modal, ALLOW);
  return choice === ALLOW;
}

/** Register the rule editor's messages on core's messenger. */
export function registerRuleEditorHandlers(on: On, host: RuleEditorHost): void {
  const ask = async (text: string): Promise<boolean> =>
    host.confirmLoosening
      ? host.confirmLoosening(text).catch(() => false)
      : false;

  const attempt = async (
    op: ToolRuleEdit["op"],
    data: RuleEditRequest,
    fallbackSource: ChangeSource,
    extra: { dryRun?: boolean; native?: boolean; confirm?: string },
  ): Promise<ToolRuleEditResponse> => {
    const merged = await host.mergedRules();
    const cwd = await host.cwd();
    const dryRun = extra.dryRun ?? data.dryRun;
    return editToolRule(
      // Named fields, not a spread: nothing the page sends can set
      // `confirmedNatively`; only the host's own dialog does.
      {
        op,
        decision: data.decision,
        rule: data.rule,
        ...(data.newDecision ? { newDecision: data.newDecision } : {}),
        ...(data.newRule !== undefined ? { newRule: data.newRule } : {}),
        ...(data.moveBy ? { moveBy: data.moveBy } : {}),
        ...(extra.confirm ? { confirm: extra.confirm } : {}),
        ...(data.baseHash ? { baseHash: data.baseHash } : {}),
        ...(dryRun ? { dryRun: true } : {}),
        ...(data.probe ? { probe: data.probe } : {}),
        ...(extra.native ? { confirmedNatively: true } : {}),
        source: data.source ?? fallbackSource,
      },
      {
        file: getConfigYamlPath(),
        sources: () => readRuleSources({ merged, withFolder: true }),
        audit: getAuditTrail(),
        home: os.homedir(),
        ...(cwd ? { cwd } : {}),
      },
    );
  };

  const run = async (
    op: ToolRuleEdit["op"],
    data: RuleEditRequest,
    fallbackSource: ChangeSource,
  ): Promise<ToolRuleEditResponse> => {
    if (data.dryRun) return attempt(op, data, fallbackSource, {});
    // A real change is checked first. One that loosens waits for the IDE's own
    // dialog: the page's checkbox and typed phrase are not enough, because
    // the page can be made to send them.
    const check = await attempt(op, data, fallbackSource, { dryRun: true });
    if (check.result !== "preview") return check;
    let confirm = data.confirm;
    let native = false;
    const analysis = check.analysis;
    if (analysis?.loosens) {
      const typedOk =
        analysis.friction !== "typed" ||
        (data.confirm ?? "").trim().toLowerCase() === CONFIRM_PHRASE;
      // The core says what is missing; the dialog is for a change that is ready
      if (!typedOk) return attempt(op, data, fallbackSource, {});
      if (!(await ask(looseningText(op, data, analysis.broadReason)))) {
        return {
          result: "refused",
          error: NOT_CONFIRMED,
          analysis,
          ...(check.diff ? { diff: check.diff } : {}),
          ...(check.beforeHash ? { beforeHash: check.beforeHash } : {}),
        };
      }
      native = true;
      // The dialog is the confirmation for a plain loosening
      if (analysis.friction === "confirm") confirm = "yes";
    }
    const res = await attempt(op, data, fallbackSource, { native, confirm });
    if (WRITTEN.includes(res.result)) {
      await host.reload(`Tool rule changed (config/${op}ToolRule message)`);
    }
    return res;
  };

  on("config/addToolRule", ({ data }) =>
    run("add", data, "always-allow-button"),
  );
  on("config/updateToolRule", ({ data }) =>
    run("update", data, "permissions-page"),
  );
  on("config/removeToolRule", ({ data }) =>
    run("remove", data, "permissions-page"),
  );
  on("config/adoptToolRule", ({ data }) =>
    run("adopt", data, "permissions-page"),
  );
  on("config/moveToolRule", ({ data }) =>
    run("move", data, "permissions-page"),
  );
  on("config/undoToolRule", async ({ data }): Promise<UndoResponse> => {
    const file = getConfigYamlPath();
    if (
      undoWouldLoosen(file) &&
      !(await ask(
        "Put back the earlier config.yaml?\n\nThis lets something run without asking that the last change had stopped.",
      ))
    ) {
      return { result: "failed", error: NOT_CONFIRMED, undoable: true };
    }
    const res = undoToolRuleChange({
      file,
      audit: getAuditTrail(),
      source: (data?.source as ChangeSource | undefined) ?? "permissions-page",
    });
    if (res.result === "undone") await host.reload("Tool rule change undone");
    return res;
  });
}

/** Whether the file has an edit of this session to put back, for the page's Undo button. */
export function undoAvailable(): boolean {
  return hasUndo(getConfigYamlPath());
}
