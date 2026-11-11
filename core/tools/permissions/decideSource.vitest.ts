import { describe, expect, it } from "vitest";
import { decideToolCall } from "./decide";
import { parsePermissions } from "./names";

const decide = (origin?: Parameters<typeof parsePermissions>[1]) =>
  decideToolCall({
    toolName: "run_terminal_command",
    parsedArgs: { command: "rm -rf build" },
    base: "allowedWithPermission",
    evaluated: "allowedWithPermission",
    rules: parsePermissions({ deny: ["runTerminalCommand(rm -rf*)"] }, origin),
    shell: "bash",
  });

describe("the reason names the source of the matching rule", () => {
  it.each([
    ["user-config", "Blocked by your rule", "in your config.yaml"],
    ["permissions-yaml", "Blocked by your rule", "in your permissions.yaml"],
    ["assistant", "Blocked by the rule", "in the assistant configuration"],
    ["folder", "Blocked by the rule", "came with this workspace"],
  ] as const)("%s", (origin, start, where) => {
    const { reason, rule } = decide(origin);
    expect(reason).toContain(start);
    expect(reason).toContain(where);
    expect(rule).toBe("runTerminalCommand(rm -rf*)");
  });

  it("does not claim config.yaml when the source is not known", () => {
    expect(decide().reason).toBe(
      "Blocked by your rule runTerminalCommand(rm -rf*) (a toolPermissions.deny rule).",
    );
  });
});
