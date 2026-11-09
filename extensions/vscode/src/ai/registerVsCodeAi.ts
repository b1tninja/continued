import type { ContinueConfig } from "core";
import type { ConfigHandler } from "core/config/ConfigHandler";
import * as vscode from "vscode";

import { registerAgentSessions } from "./agentSessions";
import { setExternalAccount } from "core/config/providers/externalAccounts";

import {
  ContinuousLanguageModelChatProvider,
  groupToAccount,
  LM_VENDOR,
} from "./languageModelChatProvider";
import {
  ContinuousMcpServerDefinitionProvider,
  MCP_PROVIDER_ID,
} from "./mcpServerDefinitionProvider";

const SHARE_MODELS = "continuous.shareModelsWithVSCode";
const SHARE_MCP = "continuous.shareMcpServersWithVSCode";
const ACCOUNTS_FROM_VSCODE = "continuous.accountsFromVSCode";

/**
 * Offer the selected Continuous config's chat models (then the rest of the
 * model catalog) and MCP servers to VS Code's own chat and agents, through the stable language model and MCP
 * provider APIs. Each can be turned off in settings.
 */
export function registerVsCodeAi(
  context: vscode.ExtensionContext,
  configHandler: ConfigHandler,
) {
  const models = new ContinuousLanguageModelChatProvider();
  const mcp = new ContinuousMcpServerDefinitionProvider();
  context.subscriptions.push(models, mcp);

  const lm = vscode.lm as Partial<typeof vscode.lm> | undefined;
  try {
    if (lm?.registerLanguageModelChatProvider) {
      context.subscriptions.push(
        lm.registerLanguageModelChatProvider(LM_VENDOR, models),
      );
    }
    if (lm?.registerMcpServerDefinitionProvider) {
      context.subscriptions.push(
        lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, mcp),
      );
    }
  } catch (e) {
    // An editor without these APIs (some VS Code forks) keeps working.
    console.warn("Continuous: could not register with VS Code AI APIs", e);
  }

  // Groups added for Continuous in VS Code's Language Models editor become
  // accounts (in memory; see core/config/providers/externalAccounts.ts)
  const groupAccounts = new Set<string>();
  const onGroupConfiguration = async (
    configuration: Record<string, unknown>,
  ) => {
    const group = groupToAccount(configuration);
    if (!group) return undefined;
    groupAccounts.add(group.name);
    const changed = setExternalAccount(group.name, {
      account: group.account,
      models: group.models,
    });
    if (changed) await configHandler.reloadConfig("VS Code model account");
    return group.name;
  };

  const applySettings = () => {
    const settings = vscode.workspace.getConfiguration();
    models.setEnabled(settings.get<boolean>(SHARE_MODELS, true));
    mcp.setEnabled(settings.get<boolean>(SHARE_MCP, true));
    if (settings.get<boolean>(ACCOUNTS_FROM_VSCODE, false)) {
      models.onGroupConfiguration = onGroupConfiguration;
    } else {
      models.onGroupConfiguration = undefined;
      let removed = false;
      for (const name of groupAccounts) {
        removed = setExternalAccount(name, undefined) || removed;
      }
      groupAccounts.clear();
      if (removed)
        void configHandler.reloadConfig("VS Code model accounts off");
    }
  };
  applySettings();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(SHARE_MODELS) ||
        e.affectsConfiguration(SHARE_MCP) ||
        e.affectsConfiguration(ACCOUNTS_FROM_VSCODE)
      ) {
        applySettings();
      }
    }),
  );

  const apply = (config: ContinueConfig | undefined) => {
    models.update(config?.modelsByRole?.chat, config?.offeredModels);
    mcp.update(config?.mcpServerStatuses);
  };
  void configHandler.loadConfig().then(({ config }) => apply(config));
  configHandler.onConfigUpdate(({ config }) => apply(config));

  // Only in the "agents" build with the proposed API enabled; else a no-op.
  const agentSessions = registerAgentSessions(context, configHandler);

  return { models, mcp, agentSessions };
}
