import { afterEach, describe, expect, it, vi } from "vitest";

import { testConnectionCommand } from "./testConnection.js";

const fetchFn = (async (url: string) => ({
  ok: url.endsWith("/models"),
  status: url.endsWith("/models") ? 200 : 500,
  json: async () => ({ data: [{ id: "m1" }] }),
  text: async () => "",
})) as never;

function capture() {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("testConnectionCommand", () => {
  it("needs a provider", async () => {
    const out = capture();
    expect(await testConnectionCommand({})).toBe(2);
    expect(out.join("")).toContain("--provider");
  });

  it("refuses a named key variable that is not set", async () => {
    capture();
    expect(
      await testConnectionCommand({
        provider: "openai",
        apiKeyEnv: "NOPE_KEY",
        env: {},
      }),
    ).toBe(2);
  });

  it("lists the models and exits 0", async () => {
    const out = capture();
    const code = await testConnectionCommand({
      provider: "lmstudio",
      fetchFn,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("Connected. 1 model listed: m1");
  });

  it("exits 1 on failure and never prints the key", async () => {
    const out = capture();
    const code = await testConnectionCommand({
      provider: "openai",
      apiKeyEnv: "K",
      env: { K: "sk-secret" },
      fetchFn: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "bad sk-secret",
      })) as never,
    });
    expect(code).toBe(1);
    expect(out.join("")).not.toContain("sk-secret");
  });
});
