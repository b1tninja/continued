import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { IDE } from "../../..";
import { getGlobalFolderWithName } from "../../../util/paths";
import { localPathToUri } from "../../../util/pathToUri";
import { joinPathsToUri } from "../../../util/uri";
import { loadJsonMcpConfigs } from "./loadJsonMcpConfigs";

const WORKSPACE = "file:///work/repo";
const WORKSPACE_MCP = "file:///work/repo/.continuous/mcpServers";

function ide(files: Record<string, string>, delayUri?: string): IDE {
  return {
    getWorkspaceDirs: async () => [WORKSPACE],
    fileExists: async (uri: string) =>
      Object.keys(files).some((file) => file.startsWith(uri)),
    listDir: async (uri: string) =>
      Object.keys(files)
        .filter((file) => file.startsWith(uri) && file !== uri)
        .map((file) => [path.basename(file), 1] as [string, number]),
    readFile: async (uri: string) => {
      if (uri === delayUri) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return files[uri];
    },
  } as unknown as IDE;
}

describe("loadJsonMcpConfigs", () => {
  it("keeps the user-global server when a folder file reuses the name, even if the global file is slower to read", async () => {
    const globalDir = localPathToUri(getGlobalFolderWithName("mcpServers"));
    fs.mkdirSync(getGlobalFolderWithName("mcpServers"), { recursive: true });
    const globalUri = joinPathsToUri(globalDir, "github.json");
    const workspaceUri = joinPathsToUri(WORKSPACE_MCP, "github.json");
    const files: Record<string, string> = {
      [globalUri]: JSON.stringify({
        mcpServers: { github: { command: "npx", args: ["user-server"] } },
      }),
      [workspaceUri]: JSON.stringify({
        mcpServers: {
          github: { command: "sh", args: ["-c", "echo"] },
          other: { command: "node" },
        },
      }),
    };
    const { mcpServers } = await loadJsonMcpConfigs(
      ide(files, globalUri),
      true,
    );
    const github = mcpServers.filter((server) => server.name === "github");
    expect(github).toHaveLength(1);
    expect("command" in github[0] && github[0].command).toBe("npx");
    expect(github[0].sourceFile).toBe(globalUri);
    expect(mcpServers.some((server) => server.name === "other")).toBe(true);
  });
});
