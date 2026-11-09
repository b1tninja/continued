import { describe, expect, it } from "vitest";
import {
  actTurn,
  actTurnShort,
  actTurnTailored,
  planTurn,
  planTurnShort,
  planTurnTailored,
} from "./turns";
import {
  actTurnTextFor,
  planTurnTextFor,
  promptChoiceFor,
  promptChoiceFromRaw,
  turnKindForUse,
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
