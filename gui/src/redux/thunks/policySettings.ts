import { createAsyncThunk } from "@reduxjs/toolkit";
import type {
  PolicyArea,
  PolicyLevel,
  PolicyLevels,
} from "core/tools/permissions/policy";
import type { PolicyFileUpdate } from "core/tools/permissions/settingsFile";
import {
  setPolicyExtras,
  setPolicyLevel,
  setPolicyLevels,
  type PolicyExtras,
} from "../slices/uiSlice";
import { ThunkApiType } from "../store";

/**
 * The levels and settings live in the file the CLI shares
 * (~/.continuous/permissions.yaml); core reads and writes it. At startup the
 * file replaces whatever the webview remembered, which is how a IDGAF from an
 * earlier session is dropped: IDGAF is for one session only.
 */
export const loadPolicySettings = createAsyncThunk<void, void, ThunkApiType>(
  "policy/load",
  async (_, { dispatch, extra }) => {
    try {
      const res = await extra.ideMessenger.request("policy/load", undefined);
      if (res.status !== "success") return;
      const { settings, notices } = res.content;
      dispatch(setPolicyLevels(settings.levels));
      dispatch(
        setPolicyExtras({
          maxNewPlanItems: settings.maxNewPlanItems,
          questions: {
            youDecide: settings.questions?.youDecide,
            agentDecides: settings.questions?.agentDecides,
          },
          builtin: settings.builtin ?? {},
          floor: settings.floor ?? [],
          planMcpTools: settings.planMcpTools ?? [],
          trustedMcpServers: Object.keys(settings.mcpServers ?? {}),
          questionDelivery: settings.questions?.delivery,
          planAllowTerminal: settings.planAllowTerminal,
          guards: settings.guards ?? {},
        }),
      );
      for (const notice of notices) console.warn(notice);
    } catch (e) {
      console.warn("Could not read the policy settings", e);
    }
  },
);

/** Writes the levels (never IDGAF) and the settings a person can change. */
export const savePolicySettings = createAsyncThunk<void, void, ThunkApiType>(
  "policy/save",
  async (_, { getState, extra }) => {
    const { policyLevels, policyExtras } = getState().ui;
    const update: PolicyFileUpdate = {
      levels: policyLevels,
      ...(policyExtras.maxNewPlanItems !== undefined
        ? { maxNewPlanItems: policyExtras.maxNewPlanItems }
        : {}),
      questions: {
        ...(policyExtras.questions?.youDecide
          ? { youDecide: policyExtras.questions.youDecide }
          : {}),
        ...(policyExtras.questions?.agentDecides
          ? { agentDecides: policyExtras.questions.agentDecides }
          : {}),
      },
      builtin: policyExtras.builtin,
      ...(policyExtras.guards ? { guards: policyExtras.guards } : {}),
    };
    const res = await extra.ideMessenger.request("policy/save", update);
    if (res.status !== "success") {
      throw new Error(
        res.status === "error"
          ? res.error
          : "Could not save the policy settings",
      );
    }
  },
);

/** What the Custom policy page saves to permissions.yaml in one write. */
export interface CustomPolicySave {
  levels: PolicyLevels;
  extras: Pick<
    PolicyExtras,
    | "builtin"
    | "maxNewPlanItems"
    | "questions"
    | "questionDelivery"
    | "floor"
    | "trustedMcpServers"
    | "planMcpTools"
    | "planAllowTerminal"
  >;
}

/**
 * The Custom policy page's save: the levels and every setting it shows, in
 * one write of permissions.yaml (core's writer: temp file and rename, other
 * keys and comments kept). On failure nothing in the page's state changes and
 * the error is the writer's sentence.
 */
export const saveCustomPolicy = createAsyncThunk<
  void,
  CustomPolicySave,
  ThunkApiType
>("policy/saveCustom", async ({ levels, extras }, { dispatch, extra }) => {
  const update: PolicyFileUpdate = {
    levels,
    ...(extras.maxNewPlanItems !== undefined
      ? { maxNewPlanItems: extras.maxNewPlanItems }
      : {}),
    questions: {
      ...(extras.questionDelivery ? { delivery: extras.questionDelivery } : {}),
      ...(extras.questions?.youDecide
        ? { youDecide: extras.questions.youDecide }
        : {}),
      ...(extras.questions?.agentDecides
        ? { agentDecides: extras.questions.agentDecides }
        : {}),
    },
    builtin: extras.builtin ?? {},
    floor: extras.floor ?? [],
    trustedMcpServers: extras.trustedMcpServers ?? [],
    planMcpTools: extras.planMcpTools ?? [],
    planAllowTerminal: extras.planAllowTerminal ?? false,
  };
  const res = await extra.ideMessenger.request("policy/save", update);
  if (res.status !== "success") {
    throw new Error(
      res.status === "error" ? res.error : "Could not save the policy settings",
    );
  }
  dispatch(setPolicyLevels(levels));
  dispatch(setPolicyExtras(extras));
});

export const changePolicyLevel = createAsyncThunk<
  void,
  { area: PolicyArea; level: PolicyLevel },
  ThunkApiType
>("policy/changeLevel", async (change, { dispatch, getState }) => {
  const previous = getState().ui.policyLevels;
  dispatch(setPolicyLevel(change));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
  }
});

export const applyPolicyPreset = createAsyncThunk<
  void,
  PolicyLevels,
  ThunkApiType
>("policy/applyPreset", async (levels, { dispatch, getState }) => {
  const previous = getState().ui.policyLevels;
  dispatch(setPolicyLevels(levels));
  const saved = await dispatch(savePolicySettings());
  if (savePolicySettings.rejected.match(saved)) {
    dispatch(setPolicyLevels(previous));
  }
});

export const changePolicyExtras = createAsyncThunk<
  void,
  Partial<PolicyExtras>,
  ThunkApiType
>("policy/changeExtras", async (change, { dispatch }) => {
  dispatch(setPolicyExtras(change));
  try {
    await dispatch(savePolicySettings()).unwrap();
  } catch (e) {
    console.warn("Could not save the policy settings", e);
  }
});
