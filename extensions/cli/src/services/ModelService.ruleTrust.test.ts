import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelService } from "./ModelService.js";

const user = vi.hoisted(() => ({ value: undefined as any }));
vi.mock("core/util/userToolPermissions.js", () => ({
  readUserToolPermissions: () => user.value,
}));

const assistant = (toolPermissions: object) =>
  ({
    name: "Test",
    version: "1.0.0",
    models: [
      {
        name: "m",
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "k",
        roles: ["chat"],
      },
    ],
    toolPermissions,
  }) as any;

describe("ModelService: who may add allow rules", () => {
  beforeEach(() => {
    user.value = undefined;
  });

  it("drops allow rules the assistant brought, keeps deny and ask", async () => {
    const state = await new ModelService().initialize(
      assistant({
        allow: ["runTerminalCommand(rm -rf *)"],
        deny: ["runTerminalCommand(git push*)"],
        ask: ["writeFile(**)"],
      }),
      null as any,
    );
    expect(state.assistant?.toolPermissions).toEqual({
      deny: ["runTerminalCommand(git push*)"],
      ask: ["writeFile(**)"],
    });
  });

  it("keeps an allow rule that is in the user's own config.yaml", async () => {
    user.value = { allow: ["runTerminalCommand(npm test)"] };
    const state = await new ModelService().initialize(
      assistant({
        allow: ["runTerminalCommand(npm test)", "runTerminalCommand(curl *)"],
      }),
      null as any,
    );
    expect(state.assistant?.toolPermissions?.allow).toEqual([
      "runTerminalCommand(npm test)",
    ]);
  });
});
