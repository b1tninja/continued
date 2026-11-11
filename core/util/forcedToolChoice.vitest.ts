import { describe, expect, it } from "vitest";
import Anthropic from "../llm/llms/Anthropic";
import {
  anthropicSurface,
  namedToolChoiceAllowed,
  SURFACE_FACTS_ENV,
  surfaceFactsEnabled,
} from "./forcedToolChoice";
import { resolveFact } from "./surfaceFacts";

const ON = { [SURFACE_FACTS_ENV]: "1" };
const FORCE = {
  type: "function" as const,
  function: { name: "report_done" },
};
const TOOL = {
  type: "function" as const,
  displayTitle: "Done",
  wouldLikeTo: "finish",
  isCurrently: "finishing",
  hasAlready: "finished",
  readonly: true,
  group: "t",
  function: {
    name: "report_done",
    description: "finish",
    parameters: { type: "object", properties: {} },
  },
};

function args(model: string, env?: string) {
  const prev = process.env[SURFACE_FACTS_ENV];
  if (env === undefined) delete process.env[SURFACE_FACTS_ENV];
  else process.env[SURFACE_FACTS_ENV] = env;
  try {
    const llm = new Anthropic({ apiKey: "k", model, apiBase: "https://x/v1/" });
    return llm.convertArgs({ model, tools: [TOOL], toolChoice: FORCE });
  } finally {
    if (prev === undefined) delete process.env[SURFACE_FACTS_ENV];
    else process.env[SURFACE_FACTS_ENV] = prev;
  }
}

describe("namedToolChoiceAllowed", () => {
  it("is off unless the env var is 1 or true", () => {
    expect(surfaceFactsEnabled({})).toBe(false);
    expect(surfaceFactsEnabled({ [SURFACE_FACTS_ENV]: "0" })).toBe(false);
    expect(surfaceFactsEnabled(ON)).toBe(true);
    expect(
      namedToolChoiceAllowed(anthropicSurface("claude-sonnet-5-5"), {}),
    ).toBe(true);
  });

  it("refuses a named choice for the Claude 5.5 generation when on", () => {
    for (const id of [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5",
    ]) {
      expect(namedToolChoiceAllowed(anthropicSurface(id), ON)).toBe(false);
    }
  });

  it("allows it where the facts say named is supported or say nothing", () => {
    expect(
      namedToolChoiceAllowed(anthropicSurface("claude-sonnet-4-5"), ON),
    ).toBe(true);
    expect(namedToolChoiceAllowed({ provider: "unlisted", api: "x" }, ON)).toBe(
      true,
    );
  });

  it("does not act on a derived fact", () => {
    const rows = [
      {
        id: "t",
        provider: "p",
        engine: "*",
        api: "a",
        facts: {
          toolChoice: {
            value: { named: false },
            level: "derived" as const,
            source: "x",
            readOn: "2026-11-11",
          },
        },
      },
    ];
    const f = resolveFact("toolChoice", { provider: "p", api: "a", rows });
    expect(f.value?.named).toBe(false);
    expect(f.level).toBe("derived");
  });
});

describe("Anthropic.convertArgs forced tool choice", () => {
  const forced = { type: "tool", name: "report_done" };

  it("golden: opt-in off sends the forced choice for every model", () => {
    for (const m of [
      "claude-sonnet-4-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]) {
      expect(args(m).tool_choice).toEqual(forced);
      expect(args(m, "0").tool_choice).toEqual(forced);
    }
  });

  it("golden: opt-in on leaves other models unchanged", () => {
    expect(args("claude-sonnet-4-5", "1").tool_choice).toEqual(forced);
    expect(args("claude-haiku-4-5-20251001", "1").tool_choice).toEqual(forced);
  });

  it("opt-in on drops the choice that the 5.5 generation answers with a 400", () => {
    expect(args("claude-sonnet-5-5", "1").tool_choice).toBeUndefined();
  });

  it("no toolChoice stays undefined", () => {
    const llm = new Anthropic({
      apiKey: "k",
      model: "claude-sonnet-5-5",
      apiBase: "https://x/v1/",
    });
    expect(llm.convertArgs({ model: "claude-sonnet-5-5" }).tool_choice).toBe(
      undefined,
    );
  });
});
