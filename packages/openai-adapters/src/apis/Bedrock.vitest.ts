import { beforeEach, describe, expect, it } from "vitest";
import { BedrockApi } from "./Bedrock.js";

const calls: Array<string | undefined> = [];
let chainImpl: (p: string | undefined) => Promise<any>;

class TestApi extends BedrockApi {
  protected async credentialChain(profile: string | undefined) {
    calls.push(profile);
    return chainImpl(profile);
  }
}
const make = (env: any = {}, extra: any = {}) =>
  new TestApi({ provider: "bedrock", env, ...extra } as any) as any;

describe("BedrockApi credentials", () => {
  beforeEach(() => {
    calls.length = 0;
    chainImpl = async () => ({ accessKeyId: "k", secretAccessKey: "s" });
  });

  it("passes sessionToken with explicit keys", async () => {
    const api = make({
      accessKeyId: "a",
      secretAccessKey: "b",
      sessionToken: "t",
    });
    expect(await api.getCreds()).toEqual({
      accessKeyId: "a",
      secretAccessKey: "b",
      sessionToken: "t",
    });
    expect(calls).toEqual([]);
  });

  it("uses an explicit profile strictly and adds an SSO hint", async () => {
    chainImpl = async () => {
      throw new Error(
        "The SSO session associated with this profile has expired",
      );
    };
    await expect(make({ profile: "work" }).getCreds()).rejects.toThrow(
      /aws sso login --profile work/,
    );
    expect(calls).toEqual(["work"]);
  });

  it("falls back from legacy 'bedrock' profile to the default chain", async () => {
    chainImpl = async (p) => {
      if (p === "bedrock") throw new Error("nope");
      return { accessKeyId: "d", secretAccessKey: "s" };
    };
    expect((await make().getCreds()).accessKeyId).toBe("d");
    expect(calls).toEqual(["bedrock", undefined]);
  });

  it("reads AWS_BEARER_TOKEN_BEDROCK only when nothing else is configured", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "env";
    try {
      expect(make().resolveApiKey()).toBe("env");
      expect(make({ profile: "p" }).resolveApiKey()).toBeUndefined();
      expect(make({}, { apiKey: "cfg" }).resolveApiKey()).toBe("cfg");
    } finally {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    }
  });

  it("builds service tier / latency / guardrail fields from env", () => {
    const api = make({
      serviceTier: "flex",
      latency: "optimized",
      guardrailIdentifier: "gr-1",
      guardrailVersion: "2",
    });
    expect(api.extraConverseFields()).toEqual({
      serviceTier: { type: "flex" },
      performanceConfig: { latency: "optimized" },
      guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "2" },
    });
    expect(make().extraConverseFields()).toEqual({});
  });
});

describe("BedrockApi networking (requestOptions)", () => {
  const SAVED = { ...process.env };
  const clear = () => {
    for (const k of [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      delete process.env[k];
    }
  };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  const handlerOf = async (config: any) => {
    const api = new TestApi({
      provider: "bedrock",
      apiKey: "k",
      ...config,
    } as any) as any;
    const client = await api.getClient();
    return client.config.requestHandler;
  };

  it("keeps the SDK's default handler when nothing is configured (Linux)", async () => {
    clear();
    const handler = await handlerOf({});
    if (process.platform === "linux") {
      expect(handler.constructor.name).not.toBe("NodeHttpHandler");
    }
  });

  it.each([
    ["caBundlePath", { caBundlePath: "/does/not/matter.pem" }],
    ["useSystemCa", { useSystemCa: true }],
    ["verifySsl=false", { verifySsl: false }],
    ["proxy", { proxy: "http://proxy.corp:3128" }],
  ])("uses a custom handler for %s", async (_name, requestOptions) => {
    clear();
    const handler = await handlerOf({ requestOptions });
    expect(handler.constructor.name).toBe("NodeHttpHandler");
  });

  it("picks up HTTPS_PROXY from the environment", async () => {
    clear();
    process.env.HTTPS_PROXY = "http://envproxy:8080";
    const handler = await handlerOf({});
    expect(handler.constructor.name).toBe("NodeHttpHandler");
  });

  it("does not proxy hosts listed in noProxy", async () => {
    clear();
    const handler = await handlerOf({
      requestOptions: { proxy: "http://proxy:1", noProxy: ["*.amazonaws.com"] },
    });
    expect(handler.constructor.name).not.toBe("NodeHttpHandler");
  });
});

describe("BedrockApi usage", () => {
  const events = [
    { contentBlockDelta: { delta: { text: "Hello" } } },
    { contentBlockDelta: { delta: { text: " there" } } },
    {
      metadata: {
        usage: {
          inputTokens: 12,
          outputTokens: 34,
          cacheReadInputTokens: 5000,
          cacheWriteInputTokens: 700,
        },
      },
    },
  ];

  const makeStreaming = (stream: any[]) => {
    class StreamApi extends TestApi {
      async getClient() {
        return {
          send: async () => ({
            stream: (async function* () {
              for (const e of stream) yield e;
            })(),
          }),
        } as any;
      }
    }
    return new StreamApi({ provider: "bedrock", env: {} } as any);
  };

  const body = {
    model: "anthropic.claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  } as any;

  it("streams a final usage chunk with the cache counts", async () => {
    const api = makeStreaming(events);
    const chunks: any[] = [];
    for await (const c of api.chatCompletionStream(
      body,
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    const usageChunks = chunks.filter((c) => c.usage);
    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0].choices).toEqual([]);
    expect(usageChunks[0].usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      prompt_tokens_details: {
        cached_tokens: 5000,
        cache_read_tokens: 5000,
        cache_write_tokens: 700,
      },
    });
    // The usage chunk comes after the text
    expect(chunks[chunks.length - 1]).toBe(usageChunks[0]);
  });

  it("returns the usage from a non-streaming call", async () => {
    const api = makeStreaming(events);
    const res = await api.chatCompletionNonStream(
      { ...body, stream: false },
      new AbortController().signal,
    );
    expect(res.choices[0].message.content).toBe("Hello there");
    expect(res.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 34,
      prompt_tokens_details: { cache_read_tokens: 5000 },
    });
  });

  it("emits no usage chunk when the stream has no metadata", async () => {
    const api = makeStreaming(events.slice(0, 2));
    const chunks: any[] = [];
    for await (const c of api.chatCompletionStream(
      body,
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.usage)).toHaveLength(0);
    const res = await api.chatCompletionNonStream(
      { ...body, stream: false },
      new AbortController().signal,
    );
    expect(res.usage).toBeUndefined();
  });

  it("counts missing cache fields as zero", async () => {
    const api = makeStreaming([
      { metadata: { usage: { inputTokens: 3, outputTokens: 4 } } },
    ]);
    const res = await api.chatCompletionNonStream(
      { ...body, stream: false },
      new AbortController().signal,
    );
    expect(res.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    });
  });
});
