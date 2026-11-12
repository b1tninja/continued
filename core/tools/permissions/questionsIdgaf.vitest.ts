import { evaluateTerminalCommandSecurity } from "@continuedev/terminal-security";
import { describe, expect, it } from "vitest";

import { evaluateToolPolicyWithRules, IDGAF_NO_ASK_REASON } from "./evaluate";
import {
  DEFAULT_POLICY_LEVELS,
  questionDecider,
  questionsAutoAnswer,
  questionsNeverAsk,
  type PolicyLevel,
  type PolicySettings,
} from "./policy";
import { QUESTION_TYPES } from "./policy";

const settings = (
  questions: PolicyLevel,
  youDecide?: (typeof QUESTION_TYPES)[number][],
): PolicySettings => ({
  levels: { ...DEFAULT_POLICY_LEVELS, questions },
  ...(youDecide ? { questions: { youDecide } } : {}),
});

describe("Questions: who decides", () => {
  it("only IDGAF never asks", () => {
    expect(questionsNeverAsk("yolo")).toBe(true);
    for (const level of [
      "manual",
      "cautious",
      "automatic",
      "permissive",
    ] as const) {
      expect(questionsNeverAsk(level)).toBe(false);
    }
    expect(questionsNeverAsk(undefined)).toBe(false);
    expect(questionsAutoAnswer("yolo")).toBe(true);
  });

  it("IDGAF: the agent decides every type, your own list does not apply", () => {
    const own = settings("yolo", [...QUESTION_TYPES]);
    for (const type of [...QUESTION_TYPES, undefined, "made up"]) {
      expect(questionDecider(own, type), String(type)).toBe("agent");
    }
  });

  it("Permissive and Automatic still send your own list to you", () => {
    for (const level of ["permissive", "automatic"] as const) {
      const own = settings(level, ["irreversible"]);
      expect(questionDecider(own, "irreversible")).toBe("person");
      expect(questionDecider(own, "detail")).toBe("agent");
    }
  });

  it("Manual and Cautious are unchanged", () => {
    expect(questionDecider(settings("manual"), "detail")).toBe("person");
    expect(questionDecider(settings("cautious"), "detail")).toBe("agent");
    expect(questionDecider(settings("cautious"), "irreversible")).toBe(
      "person",
    );
  });
});

describe("a call that still asks at a IDGAF area is refused when Questions is IDGAF", () => {
  const ASK = "allowedWithPermission" as const;
  const OFF = "disabled" as const;
  const terminalTool = {
    group: "Built-In",
    evaluateToolCallPolicy: (base: any, args: Record<string, unknown>) =>
      evaluateTerminalCommandSecurity(base, args.command as string),
  };
  const run = (tools: PolicyLevel, questions: PolicyLevel) =>
    evaluateToolPolicyWithRules({
      tool: terminalTool as any,
      toolName: "run_terminal_command",
      basePolicy: ASK,
      parsedArgs: { command: "rm -rf $DIR" },
      permissions: undefined,
      shell: "bash",
      approval: { levels: { ...DEFAULT_POLICY_LEVELS, tools, questions } },
    });

  it("IDGAF tools with Questions below IDGAF still asks (the floor)", () => {
    expect(run("yolo", "cautious").policy).toBe(ASK);
  });

  it.each(["yolo"] as const)(
    "IDGAF tools with Questions %s is refused with the reason, never asked",
    (questions) => {
      const r = run("yolo", questions);
      expect(r.policy).toBe(OFF);
      expect(r.reason).toContain(IDGAF_NO_ASK_REASON);
    },
  );

  it("a tool area below IDGAF keeps its own asking: that is not a question", () => {
    expect(run("cautious", "yolo").policy).toBe(ASK);
  });
});
