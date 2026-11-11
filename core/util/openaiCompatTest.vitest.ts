import { beforeEach, describe, expect, it } from "vitest";
import { resetOllamaShowCache } from "./ollamaShowHint.js";
import {
  openAICompatBase,
  testOpenAICompatConnection,
  type TestFetch,
} from "./openaiCompatTest.js";

type Route = { status?: number; body?: unknown };

function fakeFetch(routes: Record<string, Route>, seen: string[] = []) {
  const fn: TestFetch = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    const r = routes[`${init.method} ${url}`];
    if (!r) throw new Error("ECONNREFUSED");
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    };
  };
  return fn;
}

const models = { data: [{ id: "qwen3-coder" }, { id: "m2" }] };
const nativeReply = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "1",
            function: {
              name: "echo_text",
              arguments: JSON.stringify({ text: 'a"béé', count: 1 }),
            },
          },
        ],
      },
    },
  ],
};
const proseReply = {
  choices: [{ message: { content: "I cannot call tools." } }],
};

beforeEach(() => resetOllamaShowCache());

describe("openAICompatBase", () => {
  it("defaults per provider and adds /v1 to Ollama's native base", () => {
    expect(openAICompatBase("lmstudio")).toBe("http://127.0.0.1:1234/v1");
    expect(openAICompatBase("ollama", "http://h:11434/")).toBe(
      "http://h:11434/v1",
    );
    expect(openAICompatBase("custom")).toBeUndefined();
  });
});

describe("testOpenAICompatConnection", () => {
  it("asks for a base when the provider has no default", async () => {
    const r = await testOpenAICompatConnection({ provider: "custom" });
    expect(r).toEqual({ ok: false, error: "Enter the API base URL first." });
  });

  it("lists models without probing when no model is given", async () => {
    const seen: string[] = [];
    const r = await testOpenAICompatConnection({
      provider: "vllm",
      fetchFn: fakeFetch(
        { "GET http://127.0.0.1:8000/v1/models": { body: models } },
        seen,
      ),
    });
    expect(r).toEqual({ ok: true, models: ["qwen3-coder", "m2"] });
    expect(seen).toHaveLength(1);
  });

  it("names a rejected key without echoing it", async () => {
    const r = await testOpenAICompatConnection({
      provider: "openai",
      apiKey: "sk-secret",
      fetchFn: fakeFetch({
        "GET https://api.openai.com/v1/models": { status: 401 },
      }),
    });
    expect(r).toEqual({
      ok: false,
      error: "The server rejected the API key (HTTP 401).",
    });
  });

  it("reports an unreachable server", async () => {
    const r = await testOpenAICompatConnection({
      provider: "lmstudio",
      fetchFn: fakeFetch({}),
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("Could not reach");
  });

  it("probes a model that answers with a structured call, sending the key only as a header", async () => {
    let body = "";
    const base = fakeFetch({
      "GET http://127.0.0.1:1234/v1/models": { body: models },
      "POST http://127.0.0.1:1234/v1/chat/completions": { body: nativeReply },
    });
    const r = await testOpenAICompatConnection({
      provider: "lmstudio",
      model: "qwen3-coder",
      apiKey: "sk-secret",
      fetchFn: (u, i) => {
        if (i.body) body = i.body;
        return base(u, i);
      },
    });
    expect(r.ok && r.probe && "kind" in r.probe && r.probe.kind).toBe("native");
    expect(JSON.parse(body).stream).toBe(false);
    expect(body).not.toContain("sk-secret");
    expect(JSON.stringify(r)).not.toContain("sk-secret");
  });

  it("says a prose reply means no tool support", async () => {
    const r = await testOpenAICompatConnection({
      provider: "lmstudio",
      model: "m2",
      fetchFn: fakeFetch({
        "GET http://127.0.0.1:1234/v1/models": { body: models },
        "POST http://127.0.0.1:1234/v1/chat/completions": { body: proseReply },
      }),
    });
    expect(r.ok && r.probe && "kind" in r.probe && r.probe.kind).toBe("none");
  });

  it("turns a failed probe into unknown, not a failed connection", async () => {
    const r = await testOpenAICompatConnection({
      provider: "lmstudio",
      model: "m2",
      fetchFn: fakeFetch({
        "GET http://127.0.0.1:1234/v1/models": { body: models },
        "POST http://127.0.0.1:1234/v1/chat/completions": { status: 500 },
      }),
    });
    expect(r.ok && r.probe && "kind" in r.probe && r.probe.kind).toBe(
      "unknown",
    );
  });

  it("reads the llama.cpp template and says the parser left the call in text", async () => {
    const qwenTemplate =
      "{% for tool in tools %}<tool_call>\n<function={{ tool.name }}>\n<parameter=x>{% endfor %}";
    const textReply = {
      choices: [
        {
          message: {
            content:
              "<tool_call>\n<function=echo_text>\n<parameter=text>\nq\n</parameter>\n<parameter=count>\n1\n</parameter>\n</function>\n</tool_call>",
          },
        },
      ],
    };
    const r = await testOpenAICompatConnection({
      provider: "llama.cpp",
      model: "qwen3-coder",
      fetchFn: fakeFetch({
        "GET http://127.0.0.1:8080/v1/models": { body: models },
        "GET http://127.0.0.1:8080/props": {
          body: {
            chat_template: qwenTemplate,
            model_path: "Qwen3-Coder-30B.gguf",
          },
        },
        "POST http://127.0.0.1:8080/v1/chat/completions": { body: textReply },
      }),
    });
    expect(r.ok && r.template).toMatch(/qwen-xml/);
    expect(r.ok && r.template).toMatch(/left the call in text/);
  });

  it("an Ollama parser means the server parses, so no preset is suggested", async () => {
    const r = await testOpenAICompatConnection({
      provider: "ollama",
      model: "qwen3-coder",
      fetchFn: fakeFetch({
        "GET http://127.0.0.1:11434/v1/models": { body: models },
        "POST http://127.0.0.1:11434/api/show": {
          body: { parser: "qwen3-coder", capabilities: ["tools"] },
        },
        "POST http://127.0.0.1:11434/v1/chat/completions": {
          body: nativeReply,
        },
      }),
    });
    expect(r.ok && r.probe && "serverParses" in r.probe).toBe(true);
    expect(r.ok && r.probe && "preset" in r.probe).toBe(false);
  });
});
