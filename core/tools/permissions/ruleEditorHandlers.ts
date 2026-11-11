import * as os from "node:os";
import { getAuditTrail } from "./audit/global";
import type { ChangeSource } from "./ruleAnalysis";
import {
  editToolRule,
  hasUndo,
  undoToolRuleChange,
  type ToolRuleEdit,
  type ToolRuleEditResponse,
  type UndoResponse,
} from "./ruleEditor";
import { readRuleSources } from "./readRuleSources";
import type { RuleDecision, ToolPermissions } from "./rules";
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
}

type On = (
  name: any,
  handler: (msg: { data: any }) => Promise<unknown>,
) => void;

/** Register the rule editor's messages on core's messenger. */
export function registerRuleEditorHandlers(on: On, host: RuleEditorHost): void {
  const run = async (
    op: ToolRuleEdit["op"],
    data: RuleEditRequest,
    fallbackSource: ChangeSource,
  ): Promise<ToolRuleEditResponse> => {
    const merged = await host.mergedRules();
    const cwd = await host.cwd();
    const file = getConfigYamlPath();
    const res = editToolRule(
      { ...data, op, source: data.source ?? fallbackSource },
      {
        file,
        sources: () => readRuleSources({ merged, withFolder: true }),
        audit: getAuditTrail(),
        home: os.homedir(),
        ...(cwd ? { cwd } : {}),
      },
    );
    if (
      res.result === "added" ||
      res.result === "updated" ||
      res.result === "removed" ||
      res.result === "adopted"
    ) {
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
  on("config/undoToolRule", async ({ data }): Promise<UndoResponse> => {
    const file = getConfigYamlPath();
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
