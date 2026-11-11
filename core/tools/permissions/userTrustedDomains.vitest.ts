import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateToolPolicyWithRules } from "./evaluate";
import { readRuleSources } from "./readRuleSources";
import { testToolCall } from "./testToolCall";
import { stripUntrustedLoosening } from "./trust";
import {
  clearUserTrustedDomainsCache,
  readUserTrustedDomains,
} from "./userTrustedDomains";

let dir = "";
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("../../util/paths", async (orig) => ({
  ...(await orig<typeof import("../../util/paths")>()),
  getContinueGlobalPath: () => dir,
}));

const CONFIG = [
  "name: user",
  "version: 1.0.0",
  "toolPermissions:",
  "  auto:",
  "    environment:",
  "      trustedDomains:",
  "        - example.com",
  "",
].join("\n");

const fetchTool = { group: "Built-In" } as any;
const levels = {
  context: "permissive",
  tools: "permissive",
  edits: "permissive",
  plan: "permissive",
  questions: "permissive",
} as const;

/** What core.ts (tools/evaluatePolicy) and the CLI's coreRules.ts pass: the list read from the user's own file. */
function production(url: string, permissions?: any) {
  return evaluateToolPolicyWithRules({
    tool: fetchTool,
    toolName: "fetch_url_content",
    basePolicy: "allowedWithoutPermission",
    parsedArgs: { url },
    permissions,
    approval: { levels: levels as any },
    trustedDomains: readUserTrustedDomains(),
    shell: "bash",
  }).policy;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-"));
  clearUserTrustedDomainsCache();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the user's own trustedDomains", () => {
  it("reaches the engine: another host asks, a listed one does not", () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), CONFIG);
    expect(readUserTrustedDomains()).toEqual(["example.com"]);
    expect(production("https://other.example.net/x")).toBe(
      "allowedWithPermission",
    );
    expect(production("https://example.com/x")).toBe(
      "allowedWithoutPermission",
    );
    expect(production("https://api.example.com/x")).toBe(
      "allowedWithoutPermission",
    );
  });

  it("changes nothing when no domains are listed", () => {
    expect(production("https://other.example.net/x")).toBe(
      "allowedWithoutPermission",
    );
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      "toolPermissions:\n  allow: [Read(*)]\n",
    );
    expect(production("https://other.example.net/x")).toBe(
      "allowedWithoutPermission",
    );
  });

  it("is not taken from a merged configuration (workspace, assistant, hub)", () => {
    const merged = {
      auto: { environment: { trustedDomains: ["example.com"] } },
    };
    expect(production("https://other.example.net/x", merged)).toBe(
      "allowedWithoutPermission",
    );
  });

  it("is stripped from a workspace file, which is reported", () => {
    const { config, removed } = stripUntrustedLoosening({
      toolPermissions: {
        auto: { environment: { trustedDomains: ["example.com"] } },
      },
    });
    expect(removed).toEqual([
      "toolPermissions.auto.environment.trustedDomains",
    ]);
    expect(JSON.stringify(config)).not.toContain("example.com");
  });

  it("is read by `permissions test`, the editor and the suggestions (readRuleSources)", () => {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, CONFIG);
    const sources = readRuleSources({ configFile: file, withFolder: false });
    expect(sources.trustedDomains).toEqual(["example.com"]);
    const decide = (url: string) =>
      testToolCall({
        tool: "fetch_url_content",
        args: { url },
        levels: levels as any,
        sources,
        cwd: "/home/dev/shop",
        shell: "bash",
      }).decision;
    expect(decide("https://other.example.net/x")).toBe("ask");
    expect(decide("https://example.com/x")).toBe("allow");
  });

  it("re-reads when mtime or size changes, not on every call", () => {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, CONFIG);
    const reads = () =>
      vi.mocked(fs.readFileSync).mock.calls.filter((c) => c[0] === file).length;
    const start = reads();
    for (let i = 0; i < 3; i++) {
      expect(readUserTrustedDomains(file)).toEqual(["example.com"]);
    }
    expect(reads() - start).toBe(1);
    // A different size: read again
    fs.writeFileSync(file, CONFIG.replace("example.com", "changed.example"));
    expect(readUserTrustedDomains(file)).toEqual(["changed.example"]);
    expect(reads() - start).toBe(2);
    // The same size and a later mtime: read again
    fs.writeFileSync(file, CONFIG.replace("example.com", "changed.exampLe"));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    expect(readUserTrustedDomains(file)).toEqual(["changed.exampLe"]);
    expect(reads() - start).toBe(3);
  });

  it("is no list when the file is missing, broken or has other shapes", () => {
    const file = path.join(dir, "config.yaml");
    expect(readUserTrustedDomains(file)).toEqual([]);
    fs.writeFileSync(file, ": : not yaml [");
    expect(readUserTrustedDomains(file)).toEqual([]);
    fs.writeFileSync(
      file,
      "toolPermissions:\n  auto:\n    environment:\n      trustedDomains: example.com\n",
    );
    expect(readUserTrustedDomains(file)).toEqual([]);
  });
});
