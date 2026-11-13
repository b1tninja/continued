import type { JSX } from "react";
import { cacheTipKey } from "../../util/cacheTips";
import { ToolPolicy } from "@continuedev/terminal-security";
import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { MessageModes, RuleWithSource, Tool } from "core";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import {
  DEFAULT_POLICY_LEVELS,
  parsePolicyLevel,
  type BuiltinRuleId,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
  type QuestionType,
} from "core/tools/permissions/policy";
import {
  defaultOnboardingCardState,
  OnboardingCardState,
} from "../../components/OnboardingCard";
import { getLocalStorage, LocalStorageKey } from "../../util/localStorage";
import type { PromptCacheSetting } from "../../util/promptCache";

export type RulePolicy = "on" | "off";

export type ToolGroupPolicy = "include" | "exclude";

export type ToolPolicies = { [toolName: string]: ToolPolicy };
export type RulePolicies = { [ruleName: string]: RulePolicy };
export type ToolGroupPolicies = { [toolGroupName: string]: ToolGroupPolicy };
export type ReasoningSettings = { [modelTitle: string]: boolean };
export type PromptCacheSettings = { [modelTitle: string]: PromptCacheSetting };

type UIState = {
  showDialog: boolean;
  dialogMessage: JSX.Element | undefined;
  onboardingCard: OnboardingCardState;
  isExploreDialogOpen: boolean;
  hasDismissedExploreDialog: boolean;
  shouldAddFileForEditing: boolean;
  toolSettings: ToolPolicies;
  toolGroupSettings: ToolGroupPolicies;
  ruleSettings: RulePolicies;
  reasoningSettings: ReasoningSettings;
  /** Prompt cache choice per model title; absent means follow config.yaml. */
  promptCacheSettings: PromptCacheSettings;
  /** Cache tips the user dismissed, keyed by `cacheTipKey(modelTitle, tipId)`. */
  dismissedCacheTips: Record<string, true>;
  /** Model the user picked by hand per mode; wins over `modeModels` until reload. */
  modeModelOverrides: Partial<Record<MessageModes, string>>;
  ttsActive: boolean;
  /**
   * The level chosen for each policy area (plans/policy-areas.md). "automatic"
   * needs the experimental flag and a reviewer model; see selectPolicySettings.
   */
  policyLevels: PolicyLevels;
  /** The rest of the shared settings file; see PolicyExtras */
  policyExtras: PolicyExtras;
};

/** The settings beside the levels (plans/policy-areas.md, "Settings"). */
export interface PolicyExtras {
  /** Permissive on Plan edits: new to-dos a re-plan may add by itself */
  maxNewPlanItems?: number;
  questions?: { youDecide?: QuestionType[]; agentDecides?: QuestionType[] };
  /** Built-in rules by id; absent means on */
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
  /** Deny rules that bind at every level; read from the file, never written here */
  floor?: string[];
  /** MCP tools Plan mode may use ("server/tool", "server/*"); read from the file, never written here */
  planMcpTools?: string[];
  /** MCP servers whose read-only hints the person trusts; read from the file, never written here */
  trustedMcpServers?: string[];
}

export const DEFAULT_TOOL_SETTING: ToolPolicy = "allowedWithPermission";
export const DEFAULT_RULE_SETTING: RulePolicy = "on";
export const DEFAULT_UI_SLICE: UIState = {
  showDialog: false,
  dialogMessage: undefined,
  onboardingCard: defaultOnboardingCardState,
  isExploreDialogOpen:
    getLocalStorage(LocalStorageKey.IsExploreDialogOpen) ?? false,
  hasDismissedExploreDialog:
    getLocalStorage(LocalStorageKey.HasDismissedExploreDialog) ?? false,
  shouldAddFileForEditing: false,
  ttsActive: false,
  policyLevels: DEFAULT_POLICY_LEVELS,
  policyExtras: {},
  toolSettings: {},
  toolGroupSettings: {
    [BUILT_IN_GROUP_NAME]: "include",
  },
  ruleSettings: {},
  reasoningSettings: {},
  promptCacheSettings: {},
  dismissedCacheTips: {},
  modeModelOverrides: {},
};

export const uiSlice = createSlice({
  name: "ui",
  initialState: DEFAULT_UI_SLICE,
  reducers: {
    setOnboardingCard: (
      state,
      action: PayloadAction<Partial<OnboardingCardState>>,
    ) => {
      state.onboardingCard = { ...state.onboardingCard, ...action.payload };
    },
    setDialogMessage: (
      state,
      action: PayloadAction<UIState["dialogMessage"]>,
    ) => {
      state.dialogMessage = action.payload;
    },
    setShowDialog: (state, action: PayloadAction<UIState["showDialog"]>) => {
      state.showDialog = action.payload;
    },
    setIsExploreDialogOpen: (
      state,
      action: PayloadAction<UIState[LocalStorageKey.IsExploreDialogOpen]>,
    ) => {
      state.isExploreDialogOpen = action.payload;
    },
    // Tools
    addTool: (state, action: PayloadAction<Tool>) => {
      state.toolSettings[action.payload.function.name] =
        action.payload.defaultToolPolicy ?? DEFAULT_TOOL_SETTING;
    },
    setToolPolicy: (
      state,
      action: PayloadAction<{
        toolName: string;
        policy: ToolPolicy;
      }>,
    ) => {
      state.toolSettings[action.payload.toolName] = action.payload.policy;
    },
    clearToolPolicy: (state, action: PayloadAction<string>) => {
      delete state.toolSettings[action.payload];
    },
    toggleToolSetting: (state, action: PayloadAction<string>) => {
      const setting = state.toolSettings[action.payload];

      switch (setting) {
        case "allowedWithPermission":
          state.toolSettings[action.payload] = "allowedWithoutPermission";
          break;
        case "allowedWithoutPermission":
          state.toolSettings[action.payload] = "disabled";
          break;
        case "disabled":
          state.toolSettings[action.payload] = "allowedWithPermission";
          break;
        default:
          state.toolSettings[action.payload] = DEFAULT_TOOL_SETTING;
          break;
      }
    },
    toggleToolGroupSetting: (state, action: PayloadAction<string>) => {
      const setting = state.toolGroupSettings[action.payload] ?? "include";

      if (setting === "include") {
        state.toolGroupSettings[action.payload] = "exclude";
      } else {
        state.toolGroupSettings[action.payload] = "include";
      }
    },
    // Rules
    addRule: (state, action: PayloadAction<RuleWithSource>) => {
      state.ruleSettings[action.payload.name!] = DEFAULT_RULE_SETTING;
    },
    toggleRuleSetting: (state, action: PayloadAction<string>) => {
      const setting = state.ruleSettings[action.payload];

      switch (setting) {
        case "on":
          state.ruleSettings[action.payload] = "off";
          break;
        case "off":
          state.ruleSettings[action.payload] = "on";
          break;
        default:
          state.ruleSettings[action.payload] = DEFAULT_RULE_SETTING;
          break;
      }
    },
    setPolicyLevel: (
      state,
      { payload }: PayloadAction<{ area: PolicyArea; level: PolicyLevel }>,
    ) => {
      state.policyLevels = {
        ...state.policyLevels,
        // a message from an older host may still say "yolo"
        [payload.area]: parsePolicyLevel(payload.level) ?? payload.level,
      };
    },
    setPolicyLevels: (state, { payload }: PayloadAction<PolicyLevels>) => {
      state.policyLevels = Object.fromEntries(
        Object.entries(payload).map(([a, l]) => [a, parsePolicyLevel(l) ?? l]),
      ) as PolicyLevels;
    },
    setPolicyExtras: (
      state,
      { payload }: PayloadAction<Partial<PolicyExtras>>,
    ) => {
      state.policyExtras = { ...state.policyExtras, ...payload };
    },
    setTTSActive: (state, { payload }: PayloadAction<boolean>) => {
      state.ttsActive = payload;
    },
    setReasoningSetting: (
      state,
      action: PayloadAction<{ modelTitle: string; enabled: boolean }>,
    ) => {
      state.reasoningSettings[action.payload.modelTitle] =
        action.payload.enabled;
    },
    setPromptCacheSetting: (
      state,
      action: PayloadAction<{
        modelTitle: string;
        setting: PromptCacheSetting | undefined;
      }>,
    ) => {
      if (action.payload.setting === undefined) {
        delete state.promptCacheSettings[action.payload.modelTitle];
      } else {
        state.promptCacheSettings[action.payload.modelTitle] =
          action.payload.setting;
      }
    },
    dismissCacheTip: (state, action: PayloadAction<{ key: string }>) => {
      state.dismissedCacheTips[action.payload.key] = true;
    },
    restoreCacheTips: (state) => {
      state.dismissedCacheTips = {};
    },
    /** Bring back the dismissed tips of one model, leaving other models' alone. */
    restoreCacheTipsForModel: (
      state,
      action: PayloadAction<{ modelTitle: string }>,
    ) => {
      const prefix = cacheTipKey(action.payload.modelTitle, "");
      for (const key of Object.keys(state.dismissedCacheTips)) {
        if (key.startsWith(prefix)) delete state.dismissedCacheTips[key];
      }
    },
    setModeModelOverride: (
      state,
      action: PayloadAction<{ mode: MessageModes; title: string }>,
    ) => {
      state.modeModelOverrides[action.payload.mode] = action.payload.title;
    },
  },
});

export const {
  setOnboardingCard,
  setDialogMessage,
  setShowDialog,
  setIsExploreDialogOpen,
  toggleToolSetting,
  setToolPolicy,
  clearToolPolicy,
  toggleToolGroupSetting,
  addTool,
  addRule,
  toggleRuleSetting,
  setPolicyLevel,
  setPolicyLevels,
  setPolicyExtras,
  setTTSActive,
  setReasoningSetting,
  setPromptCacheSetting,
  dismissCacheTip,
  restoreCacheTips,
  restoreCacheTipsForModel,
  setModeModelOverride,
} = uiSlice.actions;

export default uiSlice.reducer;
