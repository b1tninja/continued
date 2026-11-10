import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BedrockRuntimeClient: vi.fn().mockImplementation(function () {
    return { send, middlewareStack: { add: vi.fn() } };
  }),
  ConverseStreamCommand: vi.fn().mockImplementation(function (input: any) {
    return { input };
  }),
  ConverseCommand: vi.fn().mockImplementation(function (input: any) {
    return { input };
  }),
}));

import Bedrock from "./Bedrock";

/**
 * Replies observed live on Bedrock Converse on 2026-11-10 (the corpus
 * fixtures llama33-bedrock-json-*, deepseek-v32-bedrock-dsml-fragment and
 * kimi-k2-thinking-bedrock-think-tags-in-text), pushed through the handler.
 */
const readTool = {
  type: "function" as const,
  displayTitle: "read_file",
  wouldLikeTo: "read",
  isCurrently: "reading",
  hasAlready: "read",
  readonly: true,
  group: "t",
  function: {
    name: "read_file",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

const LLAMA_TEXT =
  '{"type": "function", "name": "read_file", "parameters": {"path": "src/main.ts"}}';
const DSML_TEXT =
  "I'll read the src/main.ts file for you.\n\n<｜DSML｜function_calls";
const KIMI_TEXT =
  ' <think> The file `docs/a.md` contains the word "hello". </think> The file `docs/a.md` contains the word "hello".';

const converseReply = (content: any[]) => ({
  $metadata: { requestId: "r" },
  output: { message: { role: "assistant", content } },
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const streamReply = (events: any[]) => ({
  $metadata: { requestId: "r" },
  stream: (async function* () {
    for (const e of events) yield e;
  })(),
});

async function run(model: string, extraBodyProperties?: object) {
  const llm = new Bedrock({
    apiKey: "k",
    model,
    region: "us-east-1",
    // Tools are off by default for these models (llm/toolSupport.ts).
    capabilities: { tools: true },
    requestOptions: extraBodyProperties ? { extraBodyProperties } : undefined,
  } as any);
  const out: any[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "read src/main.ts" }],
    new AbortController().signal,
    { tools: [readTool] } as any,
  )) {
    out.push(m);
  }
  return {
    content: out
      .filter((m) => m.role === "assistant")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join(""),
    thinking: out
      .filter((m) => m.role === "thinking")
      .map((m) => m.content)
      .join(""),
    calls: out.flatMap((m) => m.toolCalls ?? []),
  };
}

const refusedStreaming = () =>
  Object.assign(
    new Error("This model doesn't support tool use in streaming mode."),
    { name: "ValidationException" },
  );

describe("Bedrock: replies observed live on 2026-11-10", () => {
  const saved = process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
  beforeEach(() => {
    send.mockReset();
    delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
  });
  afterEach(() => {
    if (saved === undefined)
      delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
    else process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = saved;
  });

  describe("llama-json recovery (off unless asked for)", () => {
    const MODEL = "us.meta.llama4-maverick-17b-instruct-v1:0";

    it("shows the JSON as text when the setting is off", async () => {
      send.mockResolvedValueOnce(converseReply([{ text: LLAMA_TEXT }]));
      const r = await run(MODEL);
      expect(r.content).toBe(LLAMA_TEXT);
      expect(r.calls).toEqual([]);
    });

    it("makes the call from the text of a Converse reply", async () => {
      process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "llama-json";
      send.mockResolvedValueOnce(converseReply([{ text: LLAMA_TEXT }]));
      const r = await run(MODEL);
      expect(r.content).toBe("");
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].function.name).toBe("read_file");
      expect(JSON.parse(r.calls[0].function.arguments)).toEqual({
        path: "src/main.ts",
      });
    });

    it("makes the call from a streamed reply, however it is chunked", async () => {
      process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "llama-json";
      send.mockResolvedValueOnce(
        streamReply([
          ...LLAMA_TEXT.match(/.{1,9}/g)!.map((t) => ({
            contentBlockDelta: { delta: { text: t } },
          })),
          { contentBlockStop: {} },
          { messageStop: { stopReason: "end_turn" } },
        ]),
      );
      const r = await run("meta.llama3-1-70b-instruct-v1:0");
      expect(r.content).toBe("");
      expect(r.calls.map((c) => c.function.name)).toEqual(["read_file"]);
    });
  });

  describe("the DSML fragment of deepseek.v3.2", () => {
    const toolUse = {
      toolUse: {
        toolUseId: "tooluse_x",
        name: "read_file",
        input: { path: "src/main.ts" },
      },
    };

    it("is not shown in a streamed reply", async () => {
      send.mockResolvedValueOnce(
        streamReply([
          { contentBlockDelta: { delta: { text: DSML_TEXT.slice(0, 44) } } },
          { contentBlockDelta: { delta: { text: DSML_TEXT.slice(44) } } },
          { contentBlockStop: {} },
          {
            contentBlockStart: {
              start: { toolUse: { toolUseId: "tooluse_x", name: "read_file" } },
            },
          },
          { messageStop: { stopReason: "tool_use" } },
        ]),
      );
      const r = await run("deepseek.v3.2");
      expect(r.content).toBe("I'll read the src/main.ts file for you.\n\n");
      expect(r.calls).toHaveLength(1);
    });

    it("is not shown in a whole Converse reply either", async () => {
      send
        .mockRejectedValueOnce(refusedStreaming())
        .mockResolvedValueOnce(converseReply([{ text: DSML_TEXT }, toolUse]));
      const r = await run("us.deepseek.v3.2");
      expect(r.content).toBe("I'll read the src/main.ts file for you.\n\n");
      expect(r.content).not.toMatch(/DSML/);
      expect(r.calls.map((c) => c.function.name)).toEqual(["read_file"]);
    });
  });

  describe("the <think> block of moonshot.kimi-k2-thinking", () => {
    it("becomes thinking in a whole Converse reply", async () => {
      send
        .mockRejectedValueOnce(refusedStreaming())
        .mockResolvedValueOnce(converseReply([{ text: KIMI_TEXT }]));
      const r = await run("moonshot.kimi-k2-thinking");
      expect(r.content.trim()).toBe(
        'The file `docs/a.md` contains the word "hello".',
      );
      expect(r.thinking.trim()).toBe(
        'The file `docs/a.md` contains the word "hello".',
      );
    });

    it("becomes thinking in a streamed reply", async () => {
      send.mockResolvedValueOnce(
        streamReply([
          ...KIMI_TEXT.match(/.{1,4}/g)!.map((t) => ({
            contentBlockDelta: { delta: { text: t } },
          })),
          { contentBlockStop: {} },
          { messageStop: { stopReason: "end_turn" } },
        ]),
      );
      const r = await run("us.moonshot.kimi-k2-thinking");
      expect(r.content).not.toMatch(/think>/);
      expect(r.content.trim()).toBe(
        'The file `docs/a.md` contains the word "hello".',
      );
      expect(r.thinking.trim()).not.toBe("");
    });
  });
});
