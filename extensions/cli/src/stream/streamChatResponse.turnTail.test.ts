import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { ACT_TURN_TAIL } from "core/llm/prompts/turns.js";
import type { ChatCompletionTool } from "openai/resources.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";

import {
  processStreamingResponse,
  streamChatResponse,
} from "./streamChatResponse.js";

/*
 * The use's tail (`modeModels.<use>.tail`) goes on the newest user message of
 * the request and nowhere else: the system message and every message before
 * it are the same bytes with or without it, so their cached prefix holds.
 */

vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return {
    ...actual,
    getSessionTaskPlan: () => ({
      items: [{ id: "1", text: "Fix", status: "in_progress" }],
      updatedAt: "2026-11-08T12:00:00.000Z",
    }),
    getSessionLoop: () => undefined,
    trackSessionUsage: vi.fn(),
  };
});

// No tools and no tool calls, so streamChatResponse makes one request
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls: vi.fn(async () => false),
  };
});

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(async () => "sys"),
      turnTail: vi.fn(() => undefined),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => false),
    },
    chatHistory: { isReady: vi.fn(() => false) },
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const model = {
  model: "us.amazon.nova-2-lite-v1:0",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const taskListTool: ChatCompletionTool = {
  type: "function",
  function: { name: "TaskList", parameters: { type: "object" } },
};

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "first" }, contextItems: [] },
  { message: { role: "assistant", content: "ok" }, contextItems: [] },
  { message: { role: "user", content: "second" }, contextItems: [] },
];

type Sent = Array<{ role: string; content: unknown }>;

function llmApiRecording() {
  const llmApi = {
    chatCompletionStream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "ok" } }] };
      },
    }),
  } as unknown as BaseLlmApi;
  const sent = () =>
    vi.mocked(llmApi.chatCompletionStream).mock.calls[0][0].messages as Sent;
  return { llmApi, sent };
}

async function requestWith(
  turnTail: string | undefined,
  tools: ChatCompletionTool[] = [],
): Promise<Sent> {
  const { llmApi, sent } = llmApiRecording();
  await processStreamingResponse({
    chatHistory: history,
    model,
    llmApi,
    abortController: new AbortController(),
    systemMessage: "sys",
    tools,
    turnTail,
  });
  return sent();
}

describe("the tail in the CLI request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goes on the newest user message; the system message and the earlier messages are byte-identical without it", async () => {
    const without = await requestWith(undefined);
    const withTail = await requestWith(ACT_TURN_TAIL);
    expect(withTail.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(withTail.slice(0, -1))).toBe(
      JSON.stringify(without.slice(0, -1)),
    );
    expect(without.at(-1)?.content).toBe("second");
    expect(withTail.at(-1)?.content).toBe(`second\n\n${ACT_TURN_TAIL}`);
    // The environment block stays on the first user message, before it
    expect(String(withTail[1].content)).toContain(
      '<context name="environment">',
    );
    expect(String(withTail[1].content)).not.toContain(ACT_TURN_TAIL);
  });

  it("stays before the task list block, which is sent last", async () => {
    const messages = await requestWith("Act.", [taskListTool]);
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(messages[3].content).toBe("second\n\nAct.");
    expect(String(messages.at(-1)?.content).startsWith("<task_list>")).toBe(
      true,
    );
  });

  it("is read from the system message service for the turn's use, and left out of a compaction", async () => {
    vi.mocked(services.systemMessage.turnTail).mockReturnValue("Act.");
    const { llmApi, sent } = llmApiRecording();
    await streamChatResponse(history, model, llmApi, new AbortController());
    expect(services.systemMessage.turnTail).toHaveBeenCalledWith("agent");
    expect(sent().at(-1)?.content).toBe("second\n\nAct.");

    const compaction = llmApiRecording();
    await streamChatResponse(
      history,
      model,
      compaction.llmApi,
      new AbortController(),
      undefined,
      true,
    );
    expect(compaction.sent().at(-1)?.content).toBe("second");
  });
});
