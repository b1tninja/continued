import { describe, expect, it } from "vitest";
import { rulesEnabledForMode, rulesEnabledForUse } from "./rulesByMode";

describe("rulesEnabledForUse", () => {
  it("a mode follows its own switch; absent means on", () => {
    expect(rulesEnabledForUse({ plan: false }, "plan")).toBe(false);
    expect(rulesEnabledForUse({ plan: false }, "agent")).toBe(true);
    expect(rulesEnabledForUse(undefined, "chat")).toBe(true);
  });

  it("a Loop item follows Agent and a re-plan Plan until given a switch", () => {
    expect(rulesEnabledForUse({ agent: false }, "loop")).toBe(false);
    expect(rulesEnabledForUse({ plan: false }, "replan")).toBe(false);
    expect(rulesEnabledForUse({ agent: false, loop: true }, "loop")).toBe(true);
    expect(rulesEnabledForUse({ replan: false }, "replan")).toBe(false);
    expect(rulesEnabledForUse({ replan: false }, "plan")).toBe(true);
  });

  it("other uses and no use are on", () => {
    expect(rulesEnabledForUse({ agent: false }, "reviewer")).toBe(true);
    expect(rulesEnabledForUse({ agent: false }, undefined)).toBe(true);
  });

  it("matches rulesEnabledForMode for the modes", () => {
    const cfg = { chat: false, agent: true };
    for (const mode of ["chat", "agent", "plan"] as const) {
      expect(rulesEnabledForUse(cfg, mode)).toBe(
        rulesEnabledForMode(cfg, mode),
      );
    }
  });
});
