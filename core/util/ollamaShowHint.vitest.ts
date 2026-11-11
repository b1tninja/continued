import { beforeEach, describe, expect, test, vi } from "vitest";
import qwenEmbedding from "./fixtures/ollama-show/qwen3-embedding-8b.json";
import qwen36 from "./fixtures/ollama-show/qwen3.6-27b.json";
import {
  getOllamaShowHint,
  ollamaBaseFor,
  resetOllamaShowCache,
} from "./ollamaShowHint.js";

const ok = (body: unknown) =>
  vi.fn(async () => ({ ok: true, json: async () => body }));
const ollama = { provider: "ollama", apiBase: undefined, model: "m" };

describe("ollamaBaseFor", () => {
  test("provider ollama, default and custom base", () => {
    expect(ollamaBaseFor("ollama", undefined)).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseFor("ollama", "http://box:9999/")).toBe("http://box:9999");
  });
  test("OpenAI-compatible provider on Ollama's port; /v1 is dropped", () => {
    expect(ollamaBaseFor("openai", "http://localhost:11434/v1")).toBe(
      "http://localhost:11434",
    );
  });
  test("other servers are not Ollama", () => {
    expect(ollamaBaseFor("openai", "http://localhost:8080/v1")).toBeUndefined();
    expect(ollamaBaseFor("openai", undefined)).toBeUndefined();
    expect(ollamaBaseFor("openai", "not a url")).toBeUndefined();
  });
});

describe("getOllamaShowHint", () => {
  beforeEach(() => resetOllamaShowCache());

  test("qwen3.6:27b: server parses, tools advertised", async () => {
    expect(await getOllamaShowHint({ ...ollama, fetchFn: ok(qwen36) })).toEqual(
      { serverParses: true, toolsAdvertised: true },
    );
  });

  test("template-only model: serverParses stays unset", async () => {
    const h = await getOllamaShowHint({
      ...ollama,
      fetchFn: ok(qwenEmbedding),
    });
    expect(h?.serverParses).toBeUndefined();
    expect(h?.toolsAdvertised).toBe(true);
  });

  test("capabilities without tools", async () => {
    const h = await getOllamaShowHint({
      ...ollama,
      fetchFn: ok({ capabilities: ["completion"], template: "{{ .Prompt }}" }),
    });
    expect(h).toEqual({ toolsAdvertised: false });
  });

  test("fetched once per model, posting to /api/show", async () => {
    const fetchFn = ok(qwen36);
    await getOllamaShowHint({ ...ollama, fetchFn });
    await getOllamaShowHint({ ...ollama, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe(
      "http://127.0.0.1:11434/api/show",
    );
    await getOllamaShowHint({ ...ollama, model: "other", fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("errors, bad status and timeouts mean no hint", async () => {
    expect(
      await getOllamaShowHint({
        ...ollama,
        fetchFn: vi.fn(async () => {
          throw new Error("refused");
        }),
      }),
    ).toBeUndefined();
    resetOllamaShowCache();
    expect(
      await getOllamaShowHint({
        ...ollama,
        fetchFn: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
      }),
    ).toBeUndefined();
    resetOllamaShowCache();
    const hang = (_u: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, rej) =>
        init.signal.addEventListener("abort", () => rej(new Error("abort"))),
      );
    expect(
      await getOllamaShowHint({ ...ollama, fetchFn: hang, timeoutMs: 20 }),
    ).toBeUndefined();
  });

  test("not Ollama: no request", async () => {
    const fetchFn = ok({});
    expect(
      await getOllamaShowHint({
        provider: "openai",
        apiBase: "http://x:8000/v1",
        model: "m",
        fetchFn,
      }),
    ).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("a failure is asked again after 60 s; a success is kept", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue({ ok: true, json: async () => qwen36 });
      expect(await getOllamaShowHint({ ...ollama, fetchFn })).toBeUndefined();
      vi.advanceTimersByTime(59_000);
      expect(await getOllamaShowHint({ ...ollama, fetchFn })).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      expect(
        (await getOllamaShowHint({ ...ollama, fetchFn }))?.serverParses,
      ).toBe(true);
      vi.advanceTimersByTime(10 * 60_000);
      await getOllamaShowHint({ ...ollama, fetchFn });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
