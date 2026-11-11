import { describe, expect, it } from "vitest";
import { resolveToolPermissions } from "./ruleTrust";

describe("resolveToolPermissions", () => {
  it("drops an allow rule the user's own config does not have, with a notice", () => {
    const r = resolveToolPermissions(undefined, {
      allow: ["runTerminalCommand(npm test)"],
    });
    expect(r.permissions?.allow).toBeUndefined();
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("npm test");
    expect(r.notices[0]).not.toContain("\n");
  });

  it("keeps the user's own allow rules, whitespace aside", () => {
    const r = resolveToolPermissions(
      { allow: ["readFile(**/*.md)"] },
      { allow: [" readFile(**/*.md) "] },
    );
    expect(r.permissions?.allow).toEqual([" readFile(**/*.md) "]);
    expect(r.notices).toEqual([]);
  });

  it("accepts deny and ask rules from any source", () => {
    const merged = {
      deny: ["runTerminalCommand(git push*)"],
      ask: ["writeFile(**)"],
    };
    const r = resolveToolPermissions(undefined, merged);
    expect(r.permissions).toEqual(merged);
    expect(r.notices).toEqual([]);
  });

  it("one notice per ignored rule, and the rest of the config stays", () => {
    const r = resolveToolPermissions(
      { allow: ["a"] },
      {
        allow: ["a", "b", "c"],
        deny: ["d"],
        auto: { limits: { totalDenials: 3 } },
      },
    );
    expect(r.permissions).toEqual({
      allow: ["a"],
      deny: ["d"],
      auto: { limits: { totalDenials: 3 } },
    });
    expect(r.notices).toHaveLength(2);
  });

  it("the CLI dialect (Bash(...)) is treated the same way", () => {
    const r = resolveToolPermissions(
      { allow: ["Bash(npm test)"] },
      { allow: ["Bash(npm test)", "Bash(curl *)"] },
    );
    expect(r.permissions?.allow).toEqual(["Bash(npm test)"]);
    expect(r.notices).toHaveLength(1);
  });

  it("leaves undefined alone", () => {
    expect(resolveToolPermissions(undefined, undefined)).toEqual({
      permissions: undefined,
      notices: [],
    });
  });
});
