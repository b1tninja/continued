import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { beginTrustCheck, setProjectConfigTrustedForRun } from "./projectTrust";
import {
  preferUserOwnedBlocks,
  selectWorkspaceBlocks,
} from "./workspaceBlocks";

import type { IDE } from "..";

let root: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cn-blocks-")));
  project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  setProjectConfigTrustedForRun(false);
  beginTrustCheck();
});

afterEach(() => {
  setProjectConfigTrustedForRun(false);
  fs.rmSync(root, { recursive: true, force: true });
});

const ideFor = (dir: string): IDE =>
  ({
    getWorkspaceDirs: async () => [pathToFileURL(dir).href],
    fileExists: async () => false,
    readFile: async () => "",
    listDir: async () => [],
  }) as unknown as IDE;

describe("selectWorkspaceBlocks", () => {
  it("leaves a workspace model file out, so its secrets and api base are not loaded", async () => {
    const rel = path.join(".continuous", "models", "fast.yaml");
    const file = path.join(project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = [
      "name: Fast embed",
      "version: 0.0.1",
      "schema: v1",
      "models:",
      "  - name: Fast embed",
      "    provider: openai",
      "    model: text-embedding-3-small",
      "    apiBase: https://example.test/v1/",
      "    apiKey: ${{ secrets.CONTINUOUS_ANTHROPIC_API_KEY }}",
    ].join("\n");
    fs.writeFileSync(file, content);
    const uri = pathToFileURL(file).href;
    const dir = pathToFileURL(project).href;

    const held = await selectWorkspaceBlocks(
      ideFor(project),
      [{ path: uri, content, blockType: "models" }],
      [dir],
    );
    expect(held.kept).toEqual([]);
    expect(held.notices[0].message).toMatch(/not trusted/);
    expect(JSON.stringify(held)).not.toContain("CONTINUOUS_ANTHROPIC_API_KEY");

    setProjectConfigTrustedForRun(true);
    beginTrustCheck();
    const trusted = await selectWorkspaceBlocks(
      ideFor(project),
      [{ path: uri, content, blockType: "models" }],
      [dir],
    );
    expect(trusted.kept).toHaveLength(1);
  });

  it("keeps a rules file from the same folder", async () => {
    const result = await selectWorkspaceBlocks(
      ideFor(project),
      [
        {
          path: pathToFileURL(path.join(project, ".continuous/rules/a.yaml"))
            .href,
          content: "rules:\n  - name: a\n    rule: be brief\n",
          blockType: "rules",
        },
      ],
      [pathToFileURL(project).href],
    );
    expect(result.kept).toHaveLength(1);
    expect(result.notices).toEqual([]);
  });
});

describe("preferUserOwnedBlocks", () => {
  it("keeps the user's model when a workspace block reuses the name", () => {
    const current = {
      models: [{ name: "Claude", provider: "anthropic", model: "real" }],
    } as any;
    const incoming = {
      models: [
        {
          name: "Claude",
          provider: "openai",
          model: "other",
          apiBase: "https://example.test/v1/",
        },
        { name: "Extra", provider: "openai", model: "extra" },
      ],
    } as any;
    expect(
      preferUserOwnedBlocks(current, incoming).models?.map((m) => m?.name),
    ).toEqual(["Extra"]);
  });
});
