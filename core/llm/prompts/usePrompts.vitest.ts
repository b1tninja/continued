import { describe, expect, it } from "vitest";
import {
  ACT_TURN_TAIL,
  actTurn,
  actTurnShort,
  actTurnTailored,
  CLI_TURN_TOOL_NAMES,
  PLAN_TURN_TAIL,
  planTurn,
  planTurnShort,
  planTurnTailored,
} from "./turns";
import {
  actTurnTextFor,
  planTurnTextFor,
  promptChoiceFor,
  promptChoiceFromRaw,
  tailFor,
  tailFromRaw,
  turnKindForUse,
  withTurnTail,
} from "./usePrompts";

const modeModels = {
  plan: { title: "Opus", prompt: "full" },
  agent: { title: "Sonnet", prompt: "short" },
  loop: { title: "Haiku" },
  chat: { title: "Haiku", prompt: "house", promptText: "Be brief." },
};

describe("promptChoiceFor", () => {
  it("returns a use's own profile or block text", () => {
    expect(promptChoiceFor(modeModels, "agent")).toEqual({ profile: "short" });
    expect(promptChoiceFor(modeModels, "chat")).toEqual({ text: "Be brief." });
  });

  it("falls back on the prompt alone: a loop entry with only a model takes the agent prompt", () => {
    expect(promptChoiceFor(modeModels, "loop")).toEqual({ profile: "short" });
    expect(promptChoiceFor(modeModels, "replan")).toEqual({ profile: "full" });
  });

  it("is undefined with no prompt anywhere, so the model's profile decides", () => {
    expect(
      promptChoiceFor({ agent: { title: "Sonnet" } }, "loop"),
    ).toBeUndefined();
    expect(promptChoiceFor(undefined, "plan")).toBeUndefined();
    expect(promptChoiceFor(modeModels, "reviewer")).toBeUndefined();
  });
});

describe("promptChoiceFromRaw (the CLI reads config as written)", () => {
  const prompts = [{ name: "house", prompt: "Be brief." }];

  it("reads a profile, and looks a block name up", () => {
    const raw = { loop: { prompt: "short" }, plan: { prompt: "house" } };
    expect(promptChoiceFromRaw(raw, prompts, "loop")).toEqual({
      profile: "short",
    });
    expect(promptChoiceFromRaw(raw, prompts, "plan")).toEqual({
      text: "Be brief.",
    });
  });

  it("falls back and ignores an unknown name", () => {
    const raw = { agent: { prompt: "short" }, replan: { prompt: "nope" } };
    expect(promptChoiceFromRaw(raw, prompts, "loop")).toEqual({
      profile: "short",
    });
    expect(promptChoiceFromRaw(raw, prompts, "replan")).toBeUndefined();
    expect(promptChoiceFromRaw(undefined, prompts, "loop")).toBeUndefined();
  });
});

it("turnKindForUse: chat is chat, plans plan, everything else acts", () => {
  expect(turnKindForUse("chat")).toBe("chat");
  expect(turnKindForUse("plan")).toBe("plan");
  expect(turnKindForUse("replan")).toBe("plan");
  expect(turnKindForUse("agent")).toBe("act");
  expect(turnKindForUse("loop")).toBe("act");
});

describe("tailFor: the reminder on the user messages", () => {
  it("is on for a Loop item by default, and off for Agent on a full-profile model", () => {
    expect(tailFor({ agent: { title: "Sonnet" } }, "loop", "claude")).toBe(
      ACT_TURN_TAIL,
    );
    expect(tailFor(undefined, "loop", "claude")).toBe(ACT_TURN_TAIL);
    expect(tailFor(undefined, "agent", "claude")).toBeUndefined();
    expect(tailFor(undefined, "plan", "claude")).toBeUndefined();
  });

  it("is on wherever a small model's profile is: by the prompt choice or the model id", () => {
    expect(tailFor({ agent: { prompt: "short" } }, "agent", "claude")).toBe(
      ACT_TURN_TAIL,
    );
    // qwen3-coder is the tailored profile, qwen3-32b the short one
    expect(tailFor(undefined, "plan", "qwen3-coder")).toBe(PLAN_TURN_TAIL());
    expect(tailFor(undefined, "plan", "qwen3-32b")).toBe(PLAN_TURN_TAIL());
    expect(tailFor({ agent: { prompt: "tailored" } }, "agent", "claude")).toBe(
      ACT_TURN_TAIL,
    );
    expect(tailFor({ plan: { prompt: "full" } }, "plan", "qwen3-coder")).toBe(
      undefined,
    );
    // A block's text is not the short profile
    expect(
      tailFor(
        { agent: { prompt: "house", promptText: "Do it." } },
        "agent",
        "qwen",
      ),
    ).toBeUndefined();
  });

  it("the setting wins: off, on, or a text as given", () => {
    expect(tailFor({ loop: { tail: "off" } }, "loop", "nova")).toBeUndefined();
    expect(tailFor({ agent: { tail: "on" } }, "agent", "claude")).toBe(
      ACT_TURN_TAIL,
    );
    expect(tailFor({ replan: { tail: "on" } }, "replan", "claude")).toBe(
      PLAN_TURN_TAIL(),
    );
    expect(
      tailFor({ agent: { tail: "Report when done." } }, "agent", "x"),
    ).toBe("Report when done.");
  });

  it("falls back loop → agent and replan → plan, on the tail alone", () => {
    expect(tailFor({ agent: { tail: "off" } }, "loop", "nova")).toBeUndefined();
    expect(tailFor({ plan: { tail: "on" } }, "replan", "claude")).toBe(
      PLAN_TURN_TAIL(),
    );
    // The loop's own setting wins over agent's
    expect(
      tailFor({ agent: { tail: "off" }, loop: { tail: "on" } }, "loop", "nova"),
    ).toBe(ACT_TURN_TAIL);
  });

  it("names the surface's tools, and chat has no built-in line", () => {
    expect(tailFor(undefined, "replan", "qwen", CLI_TURN_TOOL_NAMES)).toBe(
      PLAN_TURN_TAIL(CLI_TURN_TOOL_NAMES),
    );
    expect(tailFor({ chat: { tail: "on" } }, "chat", "qwen")).toBeUndefined();
    expect(tailFor({ chat: { tail: "Be brief." } }, "chat", "x")).toBe(
      "Be brief.",
    );
    expect(
      tailFor({ reviewer: { title: "x", tail: "on" } }, "reviewer", "qwen"),
    ).toBe(undefined);
  });
});

describe("tailFromRaw (the CLI reads config as written)", () => {
  const prompts = [{ name: "house", prompt: "Be brief." }];

  it("reads on, off, a text or a boolean, with the same fallback", () => {
    expect(
      tailFromRaw({ loop: { tail: false } }, prompts, "loop", "nova"),
    ).toBe(undefined);
    expect(
      tailFromRaw({ agent: { tail: true } }, prompts, "loop", "claude"),
    ).toBe(ACT_TURN_TAIL);
    expect(
      tailFromRaw({ plan: { tail: "Plan it." } }, prompts, "replan", "claude"),
    ).toBe("Plan it.");
  });

  it("defaults by the prompt choice, a block name looked up in prompts", () => {
    expect(
      tailFromRaw({ agent: { prompt: "short" } }, prompts, "agent", "claude"),
    ).toBe(ACT_TURN_TAIL);
    expect(
      tailFromRaw({ agent: { prompt: "house" } }, prompts, "agent", "qwen"),
    ).toBeUndefined();
    expect(tailFromRaw(undefined, prompts, "agent", "qwen")).toBe(
      ACT_TURN_TAIL,
    );
    expect(tailFromRaw(undefined, prompts, "agent", "claude")).toBeUndefined();
  });
});

describe("withTurnTail", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
    { role: "tool", content: "result" },
  ];

  it("appends to every user message; the other messages are the same objects", () => {
    const out = withTurnTail(messages, "Act.");
    expect(out[1]).toEqual({ role: "user", content: "first\n\nAct." });
    expect(out[3]).toEqual({ role: "user", content: "second\n\nAct." });
    expect(out[0]).toBe(messages[0]);
    expect(out[2]).toBe(messages[2]);
    expect(out[4]).toBe(messages[4]);
    expect(messages[1].content).toBe("first");
    expect(messages[3].content).toBe("second");
  });

  it("makes a later request an extension of the earlier one", () => {
    const earlier = withTurnTail(messages.slice(0, 3), "Act.");
    const later = withTurnTail(messages, "Act.");
    expect(JSON.stringify(later.slice(0, 3))).toBe(JSON.stringify(earlier));
  });

  it("adds a text part to a list of parts", () => {
    const parts = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    expect(withTurnTail(parts, "Act.")[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "Act." },
    ]);
  });

  it("returns the same array without a tail", () => {
    expect(withTurnTail(messages, undefined)).toBe(messages);
  });
});

describe("the turn text for a choice", () => {
  it("a block's text replaces the turn text", () => {
    expect(actTurnTextFor("claude", { text: "Do it." })).toBe("Do it.");
    expect(planTurnTextFor("claude", { text: "Plan it." })).toBe("Plan it.");
  });

  it("a named profile wins over the model's own", () => {
    expect(actTurnTextFor("claude-sonnet", { profile: "short" })).toBe(
      actTurnShort(),
    );
    expect(planTurnTextFor("qwen3-coder", { profile: "full" })).toBe(
      planTurn(),
    );
  });

  it("with no choice the model id decides", () => {
    expect(actTurnTextFor("claude-sonnet", undefined)).toBe(actTurn());
    expect(planTurnTextFor("qwen3-coder", undefined)).toBe(
      planTurnTailored("qwen3-coder"),
    );
    expect(planTurnTextFor("qwen3-32b", undefined)).toBe(planTurnShort());
  });

  it("a named tailored profile applies to any model", () => {
    expect(actTurnTextFor("claude-sonnet", { profile: "tailored" })).toBe(
      actTurnTailored("claude-sonnet"),
    );
  });
});
