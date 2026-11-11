import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { evaluateToolPolicies } from "./evaluateToolPolicies";

const history = { userMessages: ["run the tests"], toolCalls: [] };

function call(name: string) {
  return {
    toolCallId: `id-${name}`,
    toolCall: {
      id: "x",
      type: "function",
      function: { name, arguments: "{}" },
    },
    parsedArgs: { command: "npm test" },
    status: "generated",
  } as any;
}

async function requestFor(name: string, withHistory: boolean) {
  const ide = new MockIdeMessenger();
  const evaluate = vi.fn(async () => ({
    policy: "allowedWithPermission" as const,
  }));
  ide.responseHandlers["tools/evaluatePolicy"] = evaluate as any;
  await evaluateToolPolicies(
    vi.fn() as any,
    ide,
    [],
    [call(name)],
    {},
    undefined,
    undefined,
    undefined,
    "s",
    undefined,
    withHistory ? history : undefined,
  );
  return (evaluate.mock.calls as any[][])[0][0] as Record<string, unknown>;
}

describe("shadow review input", () => {
  it("offers the conversation to core with the rules request", async () => {
    expect(await requestFor("run_terminal_command", true)).toMatchObject({
      history,
    });
  });

  it("sends none when the host has none", async () => {
    expect(await requestFor("run_terminal_command", false)).not.toHaveProperty(
      "history",
    );
  });

  it("sends none for an edit: its answer is a diff, not this call's approval", async () => {
    expect(await requestFor("edit_existing_file", true)).not.toHaveProperty(
      "history",
    );
  });
});
