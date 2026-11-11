import type { ChatCompletionChunk } from "openai/resources/index";
import { describe, expect, it } from "vitest";
import { holdPhaseOf } from "../dialects/holdSignal.js";
import { BedrockApi } from "./Bedrock.js";

/**
 * A reply held for text tool call recovery says so on the stream: one start
 * and one end, once per held reply, whatever the outcome, and nothing when
 * the reply is not held or recovery is off.
 */
const CALL =
  "<function=Read>\n<parameter=filepath>\na.txt\n</parameter>\n</function>";

const tools = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: { filepath: { type: "string" } },
        required: ["filepath"],
      },
    },
  },
];

let runs = 0;

async function holds(reply: string, size: number, setting?: string) {
  class Api extends BedrockApi {
    protected async credentialChain() {
      return { accessKeyId: "k", secretAccessKey: "s" };
    }
    async getClient() {
      return {
        send: async () => ({
          $metadata: { requestId: "r" },
          stream: (async function* () {
            const re = new RegExp(`[^]{1,${size}}`, "g");
            for (const t of reply.match(re) ?? []) {
              yield { contentBlockDelta: { delta: { text: t } } };
            }
            yield { contentBlockStop: {} };
            yield { messageStop: { stopReason: "end_turn" } };
          })(),
        }),
      } as any;
    }
  }
  const api = new Api({ provider: "bedrock", env: {} } as any);
  const chunks: ChatCompletionChunk[] = [];
  for await (const c of api.chatCompletionStream(
    {
      model: `us.amazon.nova-pro-v1:0-hold${++runs}`,
      messages: [{ role: "user", content: "read a.txt" }],
      tools,
      stream: true,
      ...(setting ? { x_continue_recover_text_tool_calls: setting } : {}),
    } as any,
    new AbortController().signal,
  )) {
    chunks.push(c);
  }
  return chunks.flatMap((c) => holdPhaseOf(c) ?? []);
}

describe("BedrockApi: the hold signal", () => {
  it.each([
    ["recovered as a call", CALL],
    ["released as text", `${CALL} and then prose`],
    ["refused", CALL.replace("Read", "Delete")],
  ])("is one start and one end for a reply %s", async (_n, reply) => {
    for (const size of [1, 7, 1000]) {
      expect(await holds(reply, size, "force:qwen-xml")).toEqual([
        "start",
        "end",
      ]);
    }
  });

  it("is absent for a reply that is not held", async () => {
    expect(await holds("Nothing to call.", 5, "force:qwen-xml")).toEqual([]);
  });

  it("is absent when recovery is off, even for a reply that looks like a call", async () => {
    expect(await holds(CALL, 5)).toEqual([]);
  });
});
