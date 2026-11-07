import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchModels } from "./fetchModels";
import {
  contextLengthOf,
  detectLocalServers,
  listOpenAICompatibleModels,
} from "./localServers";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** What Strata's /v1/models returned on a running server. */
const STRATA_MODELS = {
  object: "list",
  data: [
    {
      id: "qwen3.8-flash-next-nvfp4-nvfp4",
      object: "model",
      status: { value: "loaded" },
      meta: { n_ctx: 524288 },
      architecture: {
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
    },
  ],
};

describe("contextLengthOf", () => {
  it("reads each server's name for the context window", () => {
    expect(contextLengthOf({ meta: { n_ctx: 524288 } })).toBe(524288); // llama.cpp, Strata
    expect(contextLengthOf({ max_model_len: 32768 })).toBe(32768); // vLLM
    expect(contextLengthOf({ max_context_length: 131072 })).toBe(131072); // LM Studio
    expect(contextLengthOf({ context_length: 200000 })).toBe(200000);
  });

  it("prefers the loaded window to the model's maximum", () => {
    expect(
      contextLengthOf({
        loaded_context_length: 8192,
        max_context_length: 131072,
      }),
    ).toBe(8192);
    expect(
      contextLengthOf({ meta: { n_ctx: 4096, n_ctx_train: 131072 } }),
    ).toBe(4096);
  });

  it("is undefined when nothing usable is reported", () => {
    expect(contextLengthOf({ id: "m" })).toBeUndefined();
    expect(contextLengthOf({ meta: { n_ctx: 0 } })).toBeUndefined();
    expect(contextLengthOf({ max_model_len: "8192" })).toBe(8192);
  });
});

describe("listOpenAICompatibleModels", () => {
  it("returns ids with the reported context, and sends the key", async () => {
    const fetchFn = vi.fn(async () => json(STRATA_MODELS));
    const models = await listOpenAICompatibleModels(
      "http://127.0.0.1:8080/v1",
      "secret",
      fetchFn as unknown as typeof fetch,
    );
    expect(models).toEqual([
      {
        name: "qwen3.8-flash-next-nvfp4-nvfp4",
        modelId: "qwen3.8-flash-next-nvfp4-nvfp4",
        contextLength: 524288,
      },
    ]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:8080/v1/models");
    expect(init.headers).toEqual({ Authorization: "Bearer secret" });
  });

  it("leaves out models that do not produce text", async () => {
    const fetchFn = vi.fn(async () =>
      json({
        data: [
          ...STRATA_MODELS.data,
          { id: "flux", architecture: { output_modalities: ["image"] } },
        ],
      }),
    );
    const models = await listOpenAICompatibleModels(
      "http://127.0.0.1:8080/v1/",
      undefined,
      fetchFn as unknown as typeof fetch,
    );
    expect(models.map((m) => m.name)).toEqual([
      "qwen3.8-flash-next-nvfp4-nvfp4",
    ]);
  });

  it("reports an error status", async () => {
    const fetchFn = vi.fn(async () => json({ error: "no" }, 401));
    await expect(
      listOpenAICompatibleModels(
        "http://127.0.0.1:8080/v1/",
        undefined,
        fetchFn as unknown as typeof fetch,
      ),
    ).rejects.toThrow("401");
  });
});

describe("fetchModels for OpenAI-compatible servers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the context window from a local OpenAI-compatible server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(STRATA_MODELS)),
    );
    const [m] = await fetchModels("openai", "", "http://127.0.0.1:8083/v1/");
    expect(m.contextLength).toBe(524288);
  });

  it("uses vLLM's max_model_len", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: [{ id: "m", max_model_len: 32768 }] })),
    );
    const [m] = await fetchModels("vllm", "", "http://127.0.0.1:8000/v1/");
    expect(m.contextLength).toBe(32768);
  });
});

describe("detectLocalServers", () => {
  /** Answers like a machine with Strata on 8083 and LM Studio on 1234. */
  function machine(url: URL | string): Response {
    const u = new URL(String(url));
    if (u.port === "8083" && u.pathname === "/v1/models")
      return json(STRATA_MODELS);
    if (u.port === "8083" && u.pathname === "/v1/status") {
      return json({
        service: "strata",
        model: "qwen3.8-flash-next-nvfp4-nvfp4",
      });
    }
    if (u.port === "1234" && u.pathname === "/v1/models") {
      return json({ data: [{ id: "qwen2.5-coder-7b" }] });
    }
    if (u.port === "1234") return json({ error: "not found" }, 404);
    if (u.port === "8000") return json({ error: "unauthorized" }, 401);
    throw new TypeError("fetch failed"); // nothing listening
  }

  it("finds servers on the presets and on ports after 8080, and names Strata", async () => {
    const fetchFn = vi.fn(async (url: URL | string) => machine(url));
    const found = await detectLocalServers({
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(found).toEqual([
      // vLLM's port answered, but only with a key
      {
        title: "vLLM",
        apiBase: "http://127.0.0.1:8000/v1/",
        models: [],
        needsKey: true,
      },
      {
        title: "LM Studio",
        apiBase: "http://127.0.0.1:1234/v1/",
        models: [{ name: "qwen2.5-coder-7b", modelId: "qwen2.5-coder-7b" }],
      },
      {
        title: "Strata",
        apiBase: "http://127.0.0.1:8083/v1/",
        models: [
          {
            name: "qwen3.8-flash-next-nvfp4-nvfp4",
            modelId: "qwen3.8-flash-next-nvfp4-nvfp4",
            contextLength: 524288,
          },
        ],
      },
    ]);
  });

  it("finds nothing when no server answers", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      await detectLocalServers({ fetchFn: fetchFn as unknown as typeof fetch }),
    ).toEqual([]);
  });
});
