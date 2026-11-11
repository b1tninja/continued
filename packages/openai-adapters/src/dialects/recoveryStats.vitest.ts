import { afterEach, describe, expect, it } from "vitest";
import {
  createTextToolRecovery,
  isRecoveredCallId,
  recoveredCallId,
  recoverFromText,
} from "./recovery.js";
import {
  formatRecoveryStats,
  recoveryStatsSnapshot,
  resetRecoveryStats,
} from "./recoveryStats.js";

const tools = [{ name: "Read", parameters: { properties: { p: {} } } }];
const qwen = "<function=Read>\n<parameter=p>\nx\n</parameter>\n</function>";
const env = { CONTINUE_RECOVER_TEXT_TOOL_CALLS: "qwen-xml,llama-json" };

afterEach(resetRecoveryStats);

describe("recovery counters", () => {
  it("count a streamed block the same as a whole one", () => {
    const stage = createTextToolRecovery("qwen3", tools, {}, env)!;
    for (const ch of qwen) stage.push(ch);
    stage.end();
    recoverFromText("qwen3", qwen, tools, {}, env);
    expect(recoveryStatsSnapshot()).toEqual([
      {
        model: "qwen3",
        dialect: "qwen-xml",
        held: 2,
        recovered: 2,
        releasedAsText: 0,
      },
    ]);
  });

  it("count a refused hold as released as text, and plain text as nothing", () => {
    recoverFromText(
      "qwen3",
      "<function=Read>\n<parameter=q>\nx\n</parameter>\n</function>",
      tools,
      {},
      env,
    );
    recoverFromText("qwen3", "just words", tools, {}, env);
    expect(recoveryStatsSnapshot()[0]).toMatchObject({
      held: 1,
      recovered: 0,
      releasedAsText: 1,
    });
    expect(formatRecoveryStats()).toBe(
      "Tool calls written as text: qwen3 (qwen-xml): 1 held, 0 recovered, 1 released as text",
    );
  });

  it("count nothing when recovery is off", () => {
    recoverFromText("qwen3", qwen, tools, {}, {});
    expect(recoveryStatsSnapshot()).toEqual([]);
    expect(formatRecoveryStats()).toBeUndefined();
  });

  it("tell a recovered id from a native one", () => {
    expect(isRecoveredCallId(recoveredCallId(0))).toBe(true);
    expect(isRecoveredCallId("toolu_1")).toBe(false);
    expect(isRecoveredCallId(undefined)).toBe(false);
  });
});
