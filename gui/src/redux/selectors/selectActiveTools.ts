import { createSelector } from "@reduxjs/toolkit";
import { Tool } from "core";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "core/tools/builtIn";
import { ideToolRef } from "core/tools/roleToolRefs";
import { filterToolsForRole, roleForMode } from "core/tools/roleTools";
import { stableToolOrder as orderTools } from "core/tools/stableToolOrder";
import { DEFAULT_TOOL_SETTING } from "../slices/uiSlice";
import { RootState } from "../store";

/**
 * Built-in tools in their own fixed order, then the rest by name. MCP
 * servers connect in no fixed order and a reconnected server's tools move to
 * the end; the tool list comes before the conversation in every request, so
 * a reordered list makes a local server's prompt cache read the whole
 * conversation again.
 */
function stableToolOrder(tools: Tool[]): Tool[] {
  return orderTools(
    tools,
    (t) => t.function.name,
    (t) => t.group === BUILT_IN_GROUP_NAME,
  );
}

export const selectActiveTools = createSelector(
  [
    (store: RootState) => store.session.mode,
    (store: RootState) => store.config.config.tools,
    (store: RootState) => store.ui.toolSettings,
    (store: RootState) => store.ui.toolGroupSettings,
    // Loop mode: an item is running (its two tools, and the loop owns the list)
    (store: RootState) => store.session.loop?.current?.kind === "item",
    (store: RootState) => !!store.session.taskPlan?.items.length,
    // What the person said about MCP tools for Plan mode (permissions.yaml)
    (store: RootState) => store.ui.policyExtras.planMcpTools,
    (store: RootState) => store.ui.policyExtras.trustedMcpServers,
  ],
  (
    mode,
    tools,
    policies,
    groupPolicies,
    loopItemRunning,
    hasTaskList,
    planMcpTools,
    trustedMcpServers,
  ): Tool[] => {
    if (mode === "chat") {
      return [];
    } else {
      const enabledTools = tools.filter((tool) => {
        // Plan mode does not offer the task list: present_plan's to-dos
        // become the list, and a model offered both sent the list instead of
        // the plan (Nova 2 Lite and Qwen3-Coder-30B in the turn-prompt eval,
        // plans/turn-prompt-eval.md; the CLI has withheld it since
        // research-bedrock-families.md item 3). Agent mode acts: it gets the
        // tool only to keep a list a plan left. While the loop runs an item,
        // the loop keeps the list.
        if (
          tool.function.name === BuiltInToolNames.TaskList &&
          !(mode === "agent" && hasTaskList && !loopItemRunning)
        ) {
          return false;
        }
        // Loop mode's tools exist only for the item it is running.
        if (
          (tool.function.name === BuiltInToolNames.HoldQuestion ||
            tool.function.name === BuiltInToolNames.FinishItem ||
            tool.function.name === BuiltInToolNames.RemindMe) &&
          !(loopItemRunning && mode === "agent")
        ) {
          return false;
        }
        // Presenting a plan is how Plan mode ends: Plan mode only.
        if (
          tool.function.name === BuiltInToolNames.PresentPlan &&
          mode !== "plan"
        ) {
          return false;
        }
        const toolPolicy =
          policies[tool.function.name] ??
          tool.defaultToolPolicy ??
          DEFAULT_TOOL_SETTING;
        return (
          toolPolicy !== "disabled" && groupPolicies[tool.group] !== "exclude"
        );
      });
      // The role table decides what the mode's role may use (roleTools.ts):
      // Plan mode offers the read-only built-ins and the MCP tools the person
      // marked read-only, not every tool of every server.
      return stableToolOrder(
        filterToolsForRole(roleForMode(mode), enabledTools, ideToolRef, {
          trust: { tools: planMcpTools, trustedServers: trustedMcpServers },
        }),
      );
    }
  },
);
