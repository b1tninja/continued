import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWLIST,
  DEFAULT_SECRET_PATTERNS,
  scrubEnvironment,
  urlHasCredentials,
} from "./scrubEnvironment";

const host = {
  PATH: "/usr/bin",
  HOME: "/home/me",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  EDITOR: "vim",
  ANTHROPIC_API_KEY: "sk-ant-x",
  OPENAI_API_KEY: "sk-x",
  GITHUB_TOKEN: "ghp_x",
  GH_TOKEN: "ghp_y",
  NPM_TOKEN: "npm_x",
  MY_SERVICE_SECRET: "s",
  DB_PASSWORD: "p",
  AWS_ACCESS_KEY_ID: "AKIA",
  AWS_REGION: "us-east-1",
  AWS_PROFILE: "work",
  AWS_BEARER_TOKEN_BEDROCK: "b",
  AZURE_CLIENT_ID: "a",
  CONTINUOUS_TERMINAL_SHELL: "wsl",
  CONTINUE_GLOBAL_DIR: "/x",
  SSH_AUTH_SOCK: "/tmp/agent",
  DOCKER_HOST: "tcp://x",
  DATABASE_URL: "postgres://u:p@h/db",
  HTTPS_PROXY: "http://user:pw@proxy.example.com:8080",
  HTTP_PROXY: "http://proxy.example.com:8080",
  TOKEN: "t",
  NODE_ENV: "development",
  TOKENIZERS_PARALLELISM: "false",
  UNDEFINED_ONE: undefined,
};

describe("scrubEnvironment: denylist (the default)", () => {
  const { env, removed } = scrubEnvironment(host, { platform: "linux" });

  it("keeps what is not secret", () => {
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      EDITOR: "vim",
      NODE_ENV: "development",
      TOKENIZERS_PARALLELISM: "false",
      HTTP_PROXY: "http://proxy.example.com:8080",
    });
  });

  it("removes keys, tokens, secrets, passwords and cloud and product prefixes", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "MY_SERVICE_SECRET",
      "DB_PASSWORD",
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "AWS_PROFILE",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AZURE_CLIENT_ID",
      "CONTINUOUS_TERMINAL_SHELL",
      "CONTINUE_GLOBAL_DIR",
      "SSH_AUTH_SOCK",
      "DOCKER_HOST",
      "DATABASE_URL",
      "TOKEN",
    ]) {
      expect(env, name).not.toHaveProperty(name);
      expect(removed, name).toContain(name);
    }
  });

  it("removes a variable whose value is a URL with credentials, and reports only the name", () => {
    expect(env).not.toHaveProperty("HTTPS_PROXY");
    expect(removed).toContain("HTTPS_PROXY");
    expect(JSON.stringify(removed)).not.toContain("pw");
  });

  it("drops undefined values without reporting them", () => {
    expect(env).not.toHaveProperty("UNDEFINED_ONE");
    expect(removed).not.toContain("UNDEFINED_ONE");
  });

  it("does not change its input", () => {
    const input = { A_TOKEN: "x", B: "y" };
    scrubEnvironment(input);
    expect(input).toEqual({ A_TOKEN: "x", B: "y" });
  });
});

describe("scrubEnvironment: options", () => {
  it("strips extra names and patterns", () => {
    const { env } = scrubEnvironment(
      { A: "1", INTERNAL_THING: "2", B: "3" },
      { strip: ["internal_*", "B"], platform: "linux" },
    );
    expect(env).toEqual({ A: "1" });
  });

  it("passes named variables through, and only exact names", () => {
    const { env, removed } = scrubEnvironment(
      {
        AWS_REGION: "eu-west-1",
        AWS_ACCESS_KEY_ID: "AKIA",
        HTTPS_PROXY: "http://u:p@h:1",
      },
      {
        passThrough: ["AWS_REGION", "HTTPS_PROXY", "AWS_*"],
        platform: "linux",
      },
    );
    expect(env).toEqual({
      AWS_REGION: "eu-west-1",
      HTTPS_PROXY: "http://u:p@h:1",
    });
    expect(removed).toEqual(["AWS_ACCESS_KEY_ID"]);
  });

  it("can turn the default patterns off", () => {
    const { env } = scrubEnvironment(
      { GITHUB_TOKEN: "t", MINE: "m" },
      { noDefaultSecrets: true, strip: ["MINE"], platform: "linux" },
    );
    expect(env).toEqual({ GITHUB_TOKEN: "t" });
  });

  it("matches Windows names without regard to case", () => {
    const win = scrubEnvironment(
      { Path: "C:\\bin", github_token: "t", AwS_Region: "r" },
      { platform: "win32", passThrough: ["aws_region"] },
    );
    expect(win.env).toEqual({ Path: "C:\\bin", AwS_Region: "r" });
    // on Linux a pass-through name is exact, so a different case is still removed
    const linux = scrubEnvironment(
      { AWS_REGION: "r" },
      { platform: "linux", passThrough: ["aws_region"] },
    );
    expect(linux.env).toEqual({});
  });
});

describe("scrubEnvironment: allowlist", () => {
  it("keeps only the default names and what is added", () => {
    const { env, removed } = scrubEnvironment(host, {
      mode: "allowlist",
      allow: ["EDITOR", "NODE_ENV"],
      platform: "linux",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      EDITOR: "vim",
      NODE_ENV: "development",
    });
    expect(removed).toContain("ANTHROPIC_API_KEY");
    expect(removed).toContain("HTTP_PROXY");
  });

  it("an allowed name that is a secret is still removed, unless passed through", () => {
    const a = scrubEnvironment(
      { PATH: "/bin", GITHUB_TOKEN: "t", OK: "1" },
      { mode: "allowlist", allow: ["*"], platform: "linux" },
    );
    expect(a.env).toEqual({ PATH: "/bin", OK: "1" });
    const b = scrubEnvironment(
      { PATH: "/bin", GITHUB_TOKEN: "t" },
      { mode: "allowlist", passThrough: ["GITHUB_TOKEN"], platform: "linux" },
    );
    expect(b.env).toEqual({ PATH: "/bin", GITHUB_TOKEN: "t" });
  });

  it("removes an allowed variable whose value carries credentials", () => {
    const { env } = scrubEnvironment(
      { PATH: "/bin", MY_URL: "https://u:p@h/" },
      { mode: "allowlist", allow: ["MY_URL"], platform: "linux" },
    );
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("an empty environment gives an empty result", () => {
    expect(scrubEnvironment({}, { mode: "allowlist" })).toEqual({
      env: {},
      removed: [],
    });
  });
});

describe("the lists", () => {
  it("no allowlist name is also a secret pattern", () => {
    const secret = DEFAULT_SECRET_PATTERNS.map(
      (p) =>
        new RegExp(
          `^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
          "i",
        ),
    );
    for (const name of DEFAULT_ALLOWLIST.filter((n) => !n.includes("*"))) {
      expect(
        secret.some((r) => r.test(name)),
        name,
      ).toBe(false);
    }
  });

  it("recognises URLs with a user name", () => {
    expect(urlHasCredentials("https://u:p@host/x")).toBe(true);
    expect(urlHasCredentials("https://token@host")).toBe(true);
    expect(urlHasCredentials("https://host/a@b")).toBe(false);
    expect(urlHasCredentials("host:1234")).toBe(false);
    expect(urlHasCredentials("/usr/bin")).toBe(false);
  });
});
