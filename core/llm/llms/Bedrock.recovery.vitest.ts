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

const MODEL = "qwen.qwen3-coder-30b-a3b-v1:0";
const leaked =
  "<function=Read>\n<parameter=filepath>\na.txt\n</parameter>\n</function>";
const readTool = {
  type: "function" as const,
  displayTitle: "Read",
  wouldLikeTo: "read",
  isCurrently: "reading",
  hasAlready: "read",
  readonly: true,
  group: "t",
  function: {
    name: "Read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" } },
      required: ["filepath"],
    },
  },
};

function replyOf(events: any[]) {
  return {
    $metadata: { requestId: "r" },
    stream: (async function* () {
      for (const e of events) yield e;
    })(),
  };
}
const text = (t: string) => ({ contentBlockDelta: { delta: { text: t } } });

async function run(events: any[], extraBodyProperties?: object) {
  send.mockResolvedValueOnce(replyOf(events));
  const llm = new Bedrock({
    apiKey: "k",
    model: MODEL,
    region: "us-east-1",
    requestOptions: extraBodyProperties ? { extraBodyProperties } : undefined,
  } as any);
  const out: any[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "read a.txt" }],
    new AbortController().signal,
    { tools: [readTool] } as any,
  )) {
    out.push(m);
  }
  return {
    content: out
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join(""),
    calls: out.flatMap((m) => m.toolCalls ?? []),
  };
}

describe("Bedrock: Qwen XML tool calls written as text (recovery, off by default)", () => {
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

  const reply = () => [
    text("I will read it.\n"),
    text(leaked.slice(0, 12)),
    text(leaked.slice(12)),
    { contentBlockStop: {} },
    { messageStop: { stopReason: "end_turn" } },
  ];

  it("leaves the text alone when the setting is off", async () => {
    const r = await run(reply());
    expect(r.content).toBe("I will read it.\n" + leaked);
    expect(r.calls).toEqual([]);
  });

  it("makes the call from the text with the environment variable", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "qwen-xml";
    const r = await run(reply().slice(1));
    expect(r.content).toBe("");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].function.name).toBe("Read");
    expect(JSON.parse(r.calls[0].function.arguments)).toEqual({
      filepath: "a.txt",
    });
  });

  it("leaves a call after prose as text: the whole reply must be calls", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "qwen-xml";
    const r = await run(reply());
    expect(r.content).toBe("I will read it.\n" + leaked);
    expect(r.calls).toEqual([]);
  });

  it("makes the call with extraBodyProperties", async () => {
    const r = await run(reply().slice(1), {
      x_continue_recover_text_tool_calls: "qwen-xml",
    });
    expect(r.calls).toHaveLength(1);
  });

  it("keeps prose that quotes the markup", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "qwen-xml";
    const prose = "A call looks like `<function=Read>` in a reply.";
    const r = await run([
      text(prose),
      { contentBlockStop: {} },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(r.content).toBe(prose);
    expect(r.calls).toEqual([]);
  });

  it("makes no second call beside a toolUse of the model's own", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "qwen-xml";
    const r = await run([
      text(leaked),
      { contentBlockStop: {} },
      {
        contentBlockStart: {
          start: { toolUse: { toolUseId: "t1", name: "Read" } },
        },
      },
      {
        contentBlockDelta: {
          delta: { toolUse: { input: '{"filepath":"a.txt"}' } },
        },
      },
      { contentBlockStop: {} },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    expect(r.calls.map((c: any) => c.id).filter(Boolean)).toEqual(["t1"]);
  });
});
