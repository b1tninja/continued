import { createAsyncThunk } from "@reduxjs/toolkit";
import type {
  PolicyArea,
  PolicyLevel,
  PolicyLevels,
} from "core/tools/permissions/policy";
import type {
  PolicyFileUpdate,
  StoredCustomSet,
} from "core/tools/permissions/settingsFile";
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
          customSet: settings.custom,
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
  /**
   * The set to keep at `levels.custom` for the chip and for recall; absent
   * leaves what the file has (a preset's levels are not a custom set).
   */
  custom?: StoredCustomSet;
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
>("policy/saveCustom", async (save, { dispatch, extra }) => {
  const update = customPolicyUpdate(save);
  const res = await extra.ideMessenger.request("policy/save", update);
  if (res.status !== "success") {
    throw new Error(
      res.status === "error" ? res.error : "Could not save the policy settings",
    );
  }
  dispatch(setPolicyLevels(save.levels));
  dispatch(
    setPolicyExtras({
      ...save.extras,
      ...(save.custom ? { customSet: save.custom } : {}),
    }),
  );
});

/**
 * The one permissions.yaml update the Custom policy page saves, and previews
 * with `policy/preview` before it does.
 */
export function customPolicyUpdate({
  levels,
  extras,
  custom,
}: CustomPolicySave): PolicyFileUpdate {
  return {
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
    ...(custom ? { custom } : {}),
  };
}

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
>("policy/changeExtras", async (change, { dispatch, getState }) => {
  const previous = getState().ui.policyExtras;
  dispatch(setPolicyExtras(change));
  try {
    await dispatch(savePolicySettings()).unwrap();
  } catch (e) {
    // Not saved (the editor's own dialog said no, or the write failed): the
    // switch shows what the file still says
    const restore: Partial<PolicyExtras> = {};
    for (const key of Object.keys(change) as (keyof PolicyExtras)[]) {
      (restore as Record<string, unknown>)[key] = previous[key];
    }
    dispatch(setPolicyExtras(restore));
    console.warn("Could not save the policy settings", e);
  }
});
