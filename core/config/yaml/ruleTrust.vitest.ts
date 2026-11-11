import { beforeEach, describe, expect, it, vi } from "vitest";

import { IDE, IdeInfo, ILLMLogger } from "../..";
import { configYamlToContinueConfig } from "./loadYaml";

const user = vi.hoisted(() => ({ value: undefined as any }));
vi.mock("../../util/userToolPermissions", () => ({
  readUserToolPermissions: () => user.value,
}));

beforeEach(() => {
  user.value = undefined;
});

const ide = {
  getWorkspaceDirs: async () => [],
  fileExists: async () => false,
  readFile: async () => "",
  readSecrets: async () => ({}),
  listDir: async () => [],
  getFileResults: async () => "",
  getIdeInfo: async () => ({ ideType: "vscode" }),
} as unknown as IDE;
const ideInfo = { ideType: "vscode" } as unknown as IdeInfo;
const llmLogger = { createInteractionLog: vi.fn() } as unknown as ILLMLogger;

async function load(toolPermissions: object) {
  return configYamlToContinueConfig({
    unrolledAssistant: {
      name: "t",
      version: "1.0.0",
      models: [
        { name: "Chat", provider: "openai", model: "gpt-4.1", apiKey: "k" },
      ],
      toolPermissions,
    } as any,
    ide,
    ideInfo,
    uniqueId: "test",
    llmLogger,
  });
}

describe("assistant-provided toolPermissions", () => {
  it("does not let an assistant add allow rules", async () => {
    const { config, errors } = await load({
      allow: ["runTerminalCommand(rm -rf *)"],
    });
    expect(config?.toolPermissions?.allow ?? []).toEqual([]);
    expect(
      errors?.filter((e) => !e.fatal && /allow/.test(e.message)),
    ).toHaveLength(1);
  });

  it("keeps deny and ask rules from an assistant", async () => {
    const { config } = await load({
      deny: ["runTerminalCommand(git push*)"],
      ask: ["writeFile(**/*.md)"],
    });
    expect(config?.toolPermissions?.deny).toEqual([
      "runTerminalCommand(git push*)",
    ]);
    expect(config?.toolPermissions?.ask).toEqual(["writeFile(**/*.md)"]);
  });

  it("honours an allow rule that is in the user's own config.yaml", async () => {
    user.value = { allow: ["runTerminalCommand(npm test)"] };
    const { config, errors } = await load({
      allow: ["runTerminalCommand(npm test)", "runTerminalCommand(rm -rf *)"],
    });
    expect(config?.toolPermissions?.allow).toEqual([
      "runTerminalCommand(npm test)",
    ]);
    // one notice, for the assistant's own rule only
    expect(
      errors?.filter((e) => !e.fatal && /rm -rf/.test(e.message)),
    ).toHaveLength(1);
    expect(errors?.some((e) => /npm test/.test(e.message))).toBe(false);
  });
});
