import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  continueHome: "",
  apiBase: "https://api.continue.dev/",
}));
const auth = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("./env.js", () => ({ env: mockEnv }));
vi.mock("./auth/workos.js", () => ({
  getAccessToken: () => auth.token,
  getOrganizationId: () => null,
  updateConfigUri: vi.fn(),
}));

import { loadConfiguration } from "./configLoader.js";

function makeClient() {
  return {
    getAssistant: vi.fn().mockResolvedValue({
      configResult: { config: { name: "Remote", version: "1", schema: "v1" } },
    }),
    syncSecrets: vi.fn().mockResolvedValue([]),
    configuration: {},
  };
}

describe("first run with no config.yaml", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cn-firstrun-"));
    mockEnv.continueHome = home;
    auth.token = null;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("makes no API call and uses an empty local assistant", async () => {
    const client = makeClient();
    const result = await loadConfiguration(
      {} as any,
      undefined,
      client as any,
      [],
      true,
    );
    expect(result.source.type).toBe("no-config");
    expect(client.getAssistant).not.toHaveBeenCalled();
    expect(client.syncSecrets).not.toHaveBeenCalled();
  });

  it.each([
    ["signed in", () => (auth.token = "token")],
    ["CONTINUE_API_BASE set", () => (mockEnv.apiBase = "http://localhost:1/")],
  ])("still makes no default-config call when %s", async (_n, setup) => {
    setup();
    const client = makeClient();
    const result = await loadConfiguration(
      {} as any,
      undefined,
      client as any,
      [],
      true,
    );
    expect(result.source.type).toBe("no-config");
    expect(client.getAssistant).not.toHaveBeenCalled();
  });

  it("uses a local config.yaml without any API call", async () => {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      "name: Local\nversion: 1.0.0\nschema: v1\n",
    );
    const client = makeClient();
    const result = await loadConfiguration(
      {} as any,
      undefined,
      client as any,
      [],
      true,
    );
    expect(result.source.type).toBe("local-config-yaml");
    expect(client.getAssistant).not.toHaveBeenCalled();
  });
});
