import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  parsePolicyLevel,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
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
 * (~/.continuous/permissions.yaml); core reads and writes it, and never writes
 * IDGAF there. At startup the file replaces what the webview remembered,
 * except an area the person had at IDGAF: a reload or a restart must not drop
 * IDGAF in the middle of an unattended run. It stays until the person changes it.
 */
export const loadPolicySettings = createAsyncThunk<void, void, ThunkApiType>(
  "policy/load",
  async (_, { dispatch, extra, getState }) => {
    try {
      const res = await extra.ideMessenger.request("policy/load", undefined);
      if (res.status !== "success") return;
      const { settings, notices } = res.content;
      dispatch(
        setPolicyLevels(keepIdgaf(getState().ui.policyLevels, settings.levels)),
      );
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
        }),
      );
      for (const notice of notices) console.warn(notice);
    } catch (e) {
      console.warn("Could not read the policy settings", e);
    }
  },
);

/** The file's levels, with every area the webview remembered at IDGAF kept there. */
export function keepIdgaf(
  remembered: Partial<PolicyLevels> | undefined,
  fromFile: PolicyLevels,
): PolicyLevels {
  const out = { ...fromFile };
  for (const area of Object.keys(out) as PolicyArea[]) {
    if (parsePolicyLevel(remembered?.[area]) === "idgaf") out[area] = "idgaf";
  }
  return out;
}

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
