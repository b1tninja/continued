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
 * A reply held for text tool call recovery says so on the stream: one message
 * with recoveryHold "start" and one with "end", once per held reply, whatever
 * the outcome, and none when the reply is not held or recovery is off.
 */
const MODEL = "us.amazon.nova-pro-v1:0";
let runs = 0;
const CALL =
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

async function holds() {
  const llm = new Bedrock({
    apiKey: "k",
    model: `${MODEL}-hold${++runs}`,
    region: "us-east-1",
    capabilities: { tools: true },
  } as any);
  const out: any[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "read a.txt" }],
    new AbortController().signal,
    { tools: [readTool] } as any,
  )) {
    out.push(m);
  }
  return out.flatMap((m) => m.recoveryHold ?? []);
}

const streamed = (reply: string, size: number) => () =>
  send.mockResolvedValueOnce({
    $metadata: { requestId: "r" },
    stream: (async function* () {
      for (const t of reply.match(new RegExp(`[^]{1,${size}}`, "g")) ?? []) {
        yield { contentBlockDelta: { delta: { text: t } } };
      }
      yield { contentBlockStop: {} };
      yield { messageStop: { stopReason: "end_turn" } };
    })(),
  });

describe("Bedrock: the hold signal", () => {
  const saved = process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
  beforeEach(() => {
    send.mockReset();
  });
  afterEach(() => {
    if (saved === undefined)
      delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
    else process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = saved;
  });

  it.each([
    ["recovered as a call", CALL],
    ["released as text", CALL + " and then prose"],
    ["refused", CALL.replace("Read", "Delete")],
  ])("is one start and one end for a reply %s", async (_n, reply) => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "force:qwen-xml";
    for (const size of [1, 7, 1000]) {
      streamed(reply, size)();
      expect(await holds()).toEqual(["start", "end"]);
    }
  });

  it("is absent for a reply that is not held", async () => {
    process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS = "force:qwen-xml";
    streamed("Nothing to call.", 4)();
    expect(await holds()).toEqual([]);
  });

  it("is absent when recovery is off, even for a reply that looks like a call", async () => {
    delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
    streamed(CALL, 4)();
    expect(await holds()).toEqual([]);
  });
});
