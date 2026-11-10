import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigDependentToolDefinitions } from ".";
import { BuiltInToolNames } from "./builtIn";
import { recallMaskedResultImpl } from "./implementations/recallMaskedResult";
import { clearRecallStore, rememberMasked } from "../util/contextAgeing";

const params = {
  rules: [],
  modelName: "gpt-4",
  enableExperimentalTools: false,
  isRemote: true,
  ide: {} as any,
};

afterEach(() => {
  vi.unstubAllEnvs();
  clearRecallStore();
});

describe("recall_masked_result tool", () => {
  it("is not offered unless history ageing is on", async () => {
    const names = async () =>
      (await getConfigDependentToolDefinitions(params)).map(
        (t) => t.function.name,
      );
    expect(await names()).not.toContain(BuiltInToolNames.RecallMaskedResult);
    vi.stubEnv("CONTINUE_HISTORY_AGEING", "1");
    expect(await names()).toContain(BuiltInToolNames.RecallMaskedResult);
  });

  it("returns the stored body for a handle", async () => {
    rememberMasked([
      {
        handle: "mask-abc",
        toolCallId: "c",
        toolName: "t",
        index: 0,
        original: "FULL BODY",
        originalChars: 9,
      },
    ]);
    const out = await recallMaskedResultImpl(
      { handle: " mask-abc " },
      {} as any,
    );
    expect(out[0].content).toBe("FULL BODY");
    const miss = await recallMaskedResultImpl(
      { handle: "mask-zzz" },
      {} as any,
    );
    expect(miss[0].content).toContain("No stored result");
  });
});
