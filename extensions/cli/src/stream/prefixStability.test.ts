import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { formatTaskPlanBlock } from "core/util/taskPlan.js";
import type { ChatCompletionTool } from "openai/resources.mjs";
import { describe, expect, it } from "vitest";

import { AnthropicApi } from "../../../../packages/openai-adapters/src/apis/Anthropic.js";
import { BedrockApi } from "../../../../packages/openai-adapters/src/apis/Bedrock.js";

import { buildChatRequestBody } from "./requestBody.js";

/**
 * A provider reads a cached prefix only when the bytes before the cache point
 * are identical to an earlier request's. Everything the Loop and cache plans
 * assume about a stable, cached system prompt rests on that, and until now it
 * was checked only by live runs. This builds the requests the CLI would send
 * for consecutive turns of an agent session, converts each through the Bedrock
 * and Anthropic adapters with caching on, and checks that the content before
 * the last cache point of one request is byte-identical to the same span of
 * the next. No network. The cases at the end show the check bites: a changing
 * system prompt or a reordered tool list fails it.
 */

const SYSTEM = [
  "You are an agent in the Continuous CLI.",
  "Working directory: /repo",
  "Rules: be brief; name files; run the tests after a change.",
].join("\n");

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { filepath: { type: "string" } },
        required: ["filepath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "TaskList",
      description: "Keep the task list.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});

const assistant = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});

const toolTurn = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  output: string,
): ChatHistoryItem => {
  const toolCall = {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
  return {
    message: { role: "assistant", content: "", toolCalls: [toolCall] },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall,
        status: "done",
        parsedArgs: args,
        output: [{ name: "output", description: "", content: output }],
      },
    ],
  } as ChatHistoryItem;
};

const plan = (statuses: ("pending" | "in_progress" | "completed")[]) =>
  formatTaskPlanBlock({
    items: statuses.map((status, i) => ({
      id: `t${i + 1}`,
      content: `step ${i + 1}`,
      status,
    })),
  } as any);

/**
 * Consecutive turns of one agent session: a user message, a tool call with
 * its result, an answer, a second user message, another tool call. The task
 * list changes between turns 2 and 3, as it does when the agent ticks a box.
 */
const turns: {
  chatHistory: ChatHistoryItem[];
  taskListBlock: string;
}[] = (() => {
  const h1 = [user("Read README.md and fix the typo in it.")];
  const h2 = [
    ...h1,
    toolTurn("call_1", "Read", { filepath: "README.md" }, "# Hello wrld"),
  ];
  const h3 = [
    ...h2,
    assistant("Fixed the typo in README.md."),
    user("Now run the tests."),
  ];
  const h4 = [
    ...h3,
    toolTurn("call_2", "Bash", { command: "npm test" }, "12 passed"),
  ];
  const planA = plan(["in_progress", "pending"]);
  const planB = plan(["completed", "in_progress"]);
  return [
    { chatHistory: h1, taskListBlock: planA },
    { chatHistory: h2, taskListBlock: planA },
    { chatHistory: h3, taskListBlock: planB },
    { chatHistory: h4, taskListBlock: planB },
  ];
})();

const model = (id: string, provider: string) =>
  ({
    name: "m",
    provider,
    model: id,
    defaultCompletionOptions: { maxTokens: 4096, temperature: 0 },
  }) as ModelConfig;

const build = (
  m: ModelConfig,
  turn: (typeof turns)[number],
  systemMessage = SYSTEM,
  toolList = tools,
) =>
  buildChatRequestBody({
    model: m,
    chatHistory: turn.chatHistory,
    systemMessage,
    tools: toolList,
    taskListBlock: turn.taskListBlock,
  });

// --- Bedrock (Converse): cache points are `cachePoint` blocks ---------------

const bedrock = (id: string) =>
  new BedrockApi({ provider: "bedrock", env: {}, promptCaching: true } as any);

const toConverse = (id: string, body: any) =>
  (bedrock(id) as any)._convertBody(body);

const isPoint = (block: any) => !!block?.cachePoint;

// --- Anthropic (Messages): cache points are `cache_control` fields ----------

const anthropic = () =>
  new AnthropicApi({
    provider: "anthropic",
    apiKey: "k",
    cachingStrategy: "systemAndTools",
  } as any);

const toMessages = (body: any) => {
  const out = (anthropic() as any)._convertBody(body);
  // Give it the shape of a Converse body so one comparison serves both:
  // tools, system and messages, each a list of blocks. Anthropic marks a
  // content block with `cache_control`, and the marked block is inside the
  // cached prefix, so it becomes the block followed by a separate cache point
  // block, as Bedrock has it.
  const blocks = (list: any[] | undefined) =>
    (list ?? []).flatMap((b: any) => {
      const { cache_control, ...rest } = b;
      return cache_control ? [rest, { cachePoint: true }] : [rest];
    });
  const system = Array.isArray(out.system)
    ? out.system
    : out.system
      ? [{ type: "text", text: out.system }]
      : [];
  return {
    toolConfig: { tools: blocks(out.tools) },
    system: blocks(system),
    messages: (out.messages ?? []).map((m: any) => ({
      role: m.role,
      content: blocks(
        Array.isArray(m.content)
          ? m.content
          : [{ type: "text", text: m.content }],
      ),
    })),
  };
};

// --- The check --------------------------------------------------------------

const strip = (blocks: any[]) =>
  blocks.filter((b) => !isPoint(b)).map(({ cachePoint, ...b }: any) => b);

/** Where the last cache point sits: message index and the count of content blocks before it. */
function lastCachePoint(body: any): { message: number; before: number } {
  let found: { message: number; before: number } | undefined;
  body.messages.forEach((m: any, i: number) => {
    let before = 0;
    for (const block of m.content ?? []) {
      if (isPoint(block)) found = { message: i, before };
      else before += 1;
    }
  });
  if (!found) throw new Error("no cache point in the messages");
  return found;
}

/** The content before `at` in `body`: tools, system, earlier messages, and the blocks of the marked message before the point. */
function prefixUpTo(body: any, at: { message: number; before: number }) {
  const earlier = body.messages
    .slice(0, at.message)
    .map((m: any) => ({ role: m.role, content: strip(m.content ?? []) }));
  const marked = body.messages[at.message];
  return JSON.stringify({
    tools: strip(body.toolConfig?.tools ?? []),
    system: strip(body.system ?? []),
    messages: [
      ...earlier,
      {
        role: marked?.role,
        content: strip(marked?.content ?? []).slice(0, at.before),
      },
    ],
  });
}

/** True when the next request starts with exactly what the previous one cached. */
function samePrefix(previous: any, next: any): boolean {
  const at = lastCachePoint(previous);
  return prefixUpTo(previous, at) === prefixUpTo(next, at);
}

const pairs = turns.slice(1).map((t, i) => [turns[i], t] as const);

describe("consecutive CLI agent requests keep a byte-identical cached prefix", () => {
  describe.each([
    ["Claude on Bedrock", "us.anthropic.claude-sonnet-4-6", "bedrock"],
    ["Nova 2 Lite on Bedrock", "us.amazon.nova-2-lite-v1:0", "bedrock"],
  ])("%s", (_name, id, provider) => {
    it.each(pairs.map((p, i) => [i + 1, p] as const))(
      "turn %i reads what the turn before it cached",
      (_n, [previous, next]) => {
        const a = toConverse(id, build(model(id, provider), previous));
        const b = toConverse(id, build(model(id, provider), next));
        expect(samePrefix(a, b)).toBe(true);
      },
    );

    it("puts the task list after the last cache point, so a change to it costs nothing", () => {
      const [t2, t3] = [turns[1], turns[2]];
      const a = toConverse(id, build(model(id, provider), t2));
      const b = toConverse(id, build(model(id, provider), t3));
      expect(t2.taskListBlock).not.toBe(t3.taskListBlock);
      expect(samePrefix(a, b)).toBe(true);
      const at = lastCachePoint(b);
      const tail = b.messages.slice(at.message).flatMap((m: any) => m.content);
      expect(JSON.stringify(tail)).toContain("<task_list>");
    });
  });

  describe("Claude on Anthropic", () => {
    const m = model("claude-sonnet-4-6", "anthropic");
    it.each(pairs.map((p, i) => [i + 1, p] as const))(
      "turn %i reads what the turn before it cached",
      (_n, [previous, next]) => {
        const a = toMessages(build(m, previous));
        const b = toMessages(build(m, next));
        expect(samePrefix(a, b)).toBe(true);
      },
    );
  });

  describe("the check bites", () => {
    const id = "us.anthropic.claude-sonnet-4-6";
    const m = model(id, "bedrock");

    it("fails when the system prompt carries the time", () => {
      const stamped = () => `${SYSTEM}\nNow: ${process.hrtime.bigint()}`;
      const a = toConverse(id, build(m, turns[0], stamped()));
      const b = toConverse(id, build(m, turns[1], stamped()));
      expect(samePrefix(a, b)).toBe(false);
    });

    it("fails when the tool list changes order", () => {
      const a = toConverse(id, build(m, turns[0]));
      const b = toConverse(
        id,
        build(m, turns[1], SYSTEM, [...tools].reverse()),
      );
      expect(samePrefix(a, b)).toBe(false);
    });

    it("fails when an earlier message is edited", () => {
      const a = toConverse(id, build(m, turns[2]));
      const edited = {
        ...turns[3],
        chatHistory: [
          user("Read README.md and fix the typo in it, please."),
          ...turns[3].chatHistory.slice(1),
        ],
      };
      const b = toConverse(id, build(m, edited));
      expect(samePrefix(a, b)).toBe(false);
    });
  });
});
