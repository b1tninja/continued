import { afterEach, describe, expect, it } from "vitest";

import {
  actTurn,
  actTurnFor,
  actTurnShort,
  actTurnTailored,
  CLI_TURN_TOOL_NAMES,
  IDE_TURN_TOOL_NAMES,
  planTurn,
  planTurnFor,
  planTurnShort,
  planTurnTailored,
  PROMPT_PROFILE_ENV,
  promptProfile,
} from "./turns";

describe("prompt profile", () => {
  it("is short for Qwen and full for everything else or unknown", () => {
    expect(promptProfile("qwen.qwen3-32b-v1:0")).toBe("short");
    expect(promptProfile("qwen3.8-flash-next-nvfp4-nvfp4")).toBe("short");
    expect(promptProfile("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "full",
    );
    expect(promptProfile("us.amazon.nova-2-lite-v1:0")).toBe("full");
    expect(promptProfile(undefined)).toBe("full");
  });

  describe("environment override", () => {
    const saved = process.env[PROMPT_PROFILE_ENV];
    afterEach(() => {
      if (saved === undefined) delete process.env[PROMPT_PROFILE_ENV];
      else process.env[PROMPT_PROFILE_ENV] = saved;
    });

    it("picks the profile for every model when set to full or short", () => {
      process.env[PROMPT_PROFILE_ENV] = "short";
      expect(promptProfile("us.amazon.nova-2-lite-v1:0")).toBe("short");
      expect(promptProfile(undefined)).toBe("short");
      expect(
        actTurnFor("us.amazon.nova-2-lite-v1:0", CLI_TURN_TOOL_NAMES),
      ).toBe(actTurnShort(CLI_TURN_TOOL_NAMES));
      process.env[PROMPT_PROFILE_ENV] = "full";
      expect(promptProfile("qwen.qwen3-32b-v1:0")).toBe("full");
      expect(planTurnFor("qwen.qwen3-32b-v1:0")).toBe(planTurn());
    });

    it("ignores any other value", () => {
      process.env[PROMPT_PROFILE_ENV] = "terse";
      expect(promptProfile("qwen.qwen3-32b-v1:0")).toBe("short");
      expect(promptProfile("gpt-5")).toBe("full");
      process.env[PROMPT_PROFILE_ENV] = "";
      expect(promptProfile("qwen.qwen3-32b-v1:0")).toBe("short");
    });

    it("accepts tailored for any model", () => {
      process.env[PROMPT_PROFILE_ENV] = "tailored";
      expect(promptProfile("gpt-5")).toBe("tailored");
      expect(actTurnFor("gpt-5", CLI_TURN_TOOL_NAMES)).toBe(
        actTurnTailored("gpt-5", CLI_TURN_TOOL_NAMES),
      );
    });
  });

  it("is tailored for the Qwen coder and MoE models only", () => {
    expect(promptProfile("qwen.qwen3-coder-30b-a3b-v1:0")).toBe("tailored");
    expect(promptProfile("qwen.qwen3-coder-next")).toBe("tailored");
    expect(promptProfile("qwen.qwen3-next-80b-a3b")).toBe("tailored");
    expect(promptProfile("Qwen3-Coder-480B-A35B-Instruct")).toBe("tailored");
    expect(promptProfile("qwen.qwen3-32b-v1:0")).toBe("short");
    expect(promptProfile("qwen3.8-flash-next-nvfp4-nvfp4")).toBe("short");
  });

  it("selects the matching turn text", () => {
    expect(actTurnFor("qwen.qwen3-32b-v1:0", CLI_TURN_TOOL_NAMES)).toBe(
      actTurnShort(CLI_TURN_TOOL_NAMES),
    );
    expect(planTurnFor("qwen.qwen3-32b-v1:0")).toBe(
      planTurnShort(IDE_TURN_TOOL_NAMES),
    );
    expect(actTurnFor("gpt-5")).toBe(actTurn());
    expect(planTurnFor("gpt-5")).toBe(planTurn());
  });
});

describe("short turns", () => {
  it("are a third of the words and name the tools", () => {
    const words = (text: string) => text.split(/\s+/).length;
    expect(words(actTurnShort())).toBeLessThan(words(actTurn()) / 2);
    expect(words(planTurnShort())).toBeLessThan(words(planTurn()) / 2);
    expect(actTurnShort(CLI_TURN_TOOL_NAMES)).toContain("TaskList");
    expect(planTurnShort(CLI_TURN_TOOL_NAMES)).toContain("PresentPlan");
  });

  it("state the finish rule first and last", () => {
    const act = actTurnShort();
    expect(act.split("\n")[0]).toContain(
      "Your turn lasts until the request is done",
    );
    expect(act.trim().split("\n").at(-1)).toContain(
      "Keep going until the request is done",
    );
    const plan = planTurnShort(CLI_TURN_TOOL_NAMES);
    expect(plan).toContain("End by calling PresentPlan, then stop");
    expect(plan.trim().split("\n").at(-1)).toContain(
      "Your turn ends only by calling PresentPlan or by asking a question",
    );
  });

  it("close the command route and forbid a task list while planning", () => {
    expect(actTurnShort()).toContain(
      "do not reach the same result through a command",
    );
    expect(actTurnShort()).toContain("Call only the tools listed");
    expect(planTurnShort()).toContain("do not make a task list");
    expect(planTurnShort()).toMatch(/kept for themselves.*goes in `decisions`/);
  });
});

describe("tailored turns", () => {
  it("are the short text plus a tool-calls group naming the surface's tools", () => {
    const act = actTurnTailored(
      "qwen.qwen3-coder-30b-a3b-v1:0",
      CLI_TURN_TOOL_NAMES,
    );
    expect(act.startsWith(actTurnShort(CLI_TURN_TOOL_NAMES))).toBe(true);
    expect(act).toContain("\n\nTool calls\n");
    expect(act).toContain("one Read call with arguments");
    expect(act).toContain("Write files with Write, never echo >");
    const ide = planTurnTailored("qwen.qwen3-next-80b-a3b");
    expect(ide.startsWith(planTurnShort())).toBe(true);
    expect(ide).toContain("one read_file call with arguments");
    expect(ide).toContain("Write files with create_new_file");
    expect(ide.trim().split("\n").at(-1)).toContain(
      "until the plan is presented with present_plan",
    );
  });

  it("name the markup the model was trained on", () => {
    expect(actTurnTailored("qwen.qwen3-coder-30b-a3b-v1:0")).toContain(
      "<tool_call><function=Name><parameter=key>value</parameter></function></tool_call>",
    );
    expect(actTurnTailored("qwen.qwen3-next-80b-a3b")).toContain(
      '<tool_call>{"name": "Name", "arguments": {...}}</tool_call>',
    );
  });
});
