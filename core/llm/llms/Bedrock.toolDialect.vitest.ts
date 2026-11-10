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

import { RECOVER_ENV, RECOVER_FIELD } from "@continuedev/config-yaml";
import {
  RECOVER_TEXT_TOOL_CALLS_ENV,
  RECOVER_TEXT_TOOL_CALLS_FIELD,
} from "@continuedev/openai-adapters";
import Bedrock from "./Bedrock";

const MODEL = "amazon.nova-pro-v1:0";
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

async function run(
  events: any[],
  opts: { extraBodyProperties?: object; toolDialect?: string } = {},
) {
  send.mockResolvedValueOnce(replyOf(events));
  const llm = new Bedrock({
    apiKey: "k",
    model: MODEL,
    region: "us-east-1",
    toolDialect: opts.toolDialect,
    requestOptions: opts.extraBodyProperties
      ? { extraBodyProperties: opts.extraBodyProperties }
      : undefined,
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

describe("Bedrock: per-model toolDialect reaches the recovery switch", () => {
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
    text("I will read it.\n" + leaked),
    { contentBlockStop: {} },
    { messageStop: { stopReason: "end_turn" } },
  ];

  it("names the same field and variable as the adapters", () => {
    expect(RECOVER_FIELD).toBe(RECOVER_TEXT_TOOL_CALLS_FIELD);
    expect(RECOVER_ENV).toBe(RECOVER_TEXT_TOOL_CALLS_ENV);
  });

  it("changes nothing without toolDialect or the variable", async () => {
    const r = await run(reply());
    expect(r.content).toBe("I will read it.\n" + leaked);
    expect(r.calls).toEqual([]);
  });

  it("toolDialect: qwen-xml recovers on a model whose id does not say qwen, no variable", async () => {
    const r = await run(reply(), { toolDialect: "qwen-xml" });
    expect(r.content).toBe("I will read it.\n");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].function.name).toBe("Read");
  });

  it("auto leaves the model as before", async () => {
    const r = await run(reply(), { toolDialect: "auto" });
    expect(r.calls).toEqual([]);
  });

  it("off and native turn a request-level setting off", async () => {
    for (const toolDialect of ["off", "native"]) {
      send.mockReset();
      const r = await run(reply(), {
        toolDialect,
        extraBodyProperties: { [RECOVER_FIELD]: "force:qwen-xml" },
      });
      expect(r.calls).toEqual([]);
    }
  });

  it("the environment variable wins when set", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "force:qwen-xml";
    const r = await run(reply(), { toolDialect: "off" });
    expect(r.calls).toHaveLength(1);
  });
});
