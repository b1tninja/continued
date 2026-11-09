import { describe, expect, it } from "vitest";
import type { IDE } from "../index.js";
import { ideInWorkspace } from "./workspaceOverride.js";

class FakeIde {
  #secret = "kept";
  calls: string[] = [];
  async getWorkspaceDirs(): Promise<string[]> {
    return ["file:///main"];
  }
  async readFile(uri: string): Promise<string> {
    this.calls.push(uri);
    return `${this.#secret}:${uri}`;
  }
}

describe("ideInWorkspace", () => {
  it("answers the given folders and leaves every other method on the real IDE", async () => {
    const real = new FakeIde();
    const ide = ideInWorkspace(real as unknown as IDE, ["file:///worktree"]);
    expect(await ide.getWorkspaceDirs()).toEqual(["file:///worktree"]);
    expect(await ide.readFile("file:///worktree/a.ts")).toBe(
      "kept:file:///worktree/a.ts",
    );
    expect(real.calls).toEqual(["file:///worktree/a.ts"]);
    expect(await real.getWorkspaceDirs()).toEqual(["file:///main"]);
  });

  it("hands out a copy of the folders, so a caller cannot change them", async () => {
    const dirs = ["file:///worktree"];
    const ide = ideInWorkspace(new FakeIde() as unknown as IDE, dirs);
    dirs.push("file:///other");
    (await ide.getWorkspaceDirs()).push("file:///more");
    expect(await ide.getWorkspaceDirs()).toEqual(["file:///worktree"]);
  });
});
