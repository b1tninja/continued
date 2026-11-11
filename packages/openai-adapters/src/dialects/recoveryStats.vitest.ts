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

describe("recovery containment", () => {
  it("fails open to text and counts a recovery error when a stage throws", () => {
    const stage = createTextToolRecovery("qwen3", tools, {}, env)!;
    const inner = (stage as unknown as { inner: { end(): never } }).inner;
    inner.end = () => {
      throw new Error("boom");
    };
    const events = [...stage.push("<function=Read>\n<param"), ...stage.end()];
    expect(events.map((e) => (e.type === "text" ? e.text : "")).join("")).toBe(
      "<function=Read>\n<param",
    );
    expect(recoveryStatsSnapshot()[0]).toMatchObject({ recoveryErrors: 1 });
    expect(stage.push("more")).toEqual([{ type: "text", text: "more" }]);
  });

  it("releases a held block past the cap as text and stops holding", () => {
    for (const dialect of ["qwen-xml", "hermes-json"]) {
      resetRecoveryStats();
      const e = { CONTINUE_RECOVER_TEXT_TOOL_CALLS: dialect };
      const start =
        dialect === "qwen-xml" ? "<function=Read>\n" : "<tool_call>";
      const stage = createTextToolRecovery("qwen3", tools, {}, e)!;
      const chunk = "x".repeat(1 << 18);
      let text = "";
      for (let i = 0; i < 6; i++) {
        for (const ev of stage.push((i === 0 ? start : "") + chunk)) {
          if (ev.type === "text") text += ev.text;
        }
      }
      expect(stage.isHolding?.()).toBe(false);
      for (const ev of stage.end()) if (ev.type === "text") text += ev.text;
      expect(text).toBe(start + chunk.repeat(6));
      expect(recoveryStatsSnapshot()[0]).toMatchObject({
        held: 1,
        recovered: 0,
        releasedAsText: 1,
        releasedAtCap: 1,
      });
    }
  });
});
