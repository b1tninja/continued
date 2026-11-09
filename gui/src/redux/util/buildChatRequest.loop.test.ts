import type { ChatHistoryItem, ModelDescription } from "core";
import { ACT_TURN_TAIL } from "core/llm/prompts/turns";
import { readFileTool } from "core/tools/definitions/readFile";
import { createLoop, startItemRun } from "core/util/loopMode";
import { renderChatMessage } from "core/util/messageContent";
import { describe, expect, it } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { buildChatRequest } from "./buildChatRequest";

/* Loop mode's fresh context: a run's request starts at the run's own turns. */

const model: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};
const T0 = new Date("2026-11-07T10:00:00Z");
const plan = {
  items: [
    { id: "1", text: "Write the lexer", status: "completed" as const },
    { id: "2", text: "Add tests", status: "pending" as const },
  ],
  updatedAt: T0.toISOString(),
};

let n = 0;
const turn = (role: "user" | "assistant", content: string) =>
  ({
    message: { id: `m${++n}`, role, content },
    contextItems: [],
  }) as ChatHistoryItem & { message: { id: string } };

function stateWith(freshContext?: boolean): RootState {
  const state = getEmptyRootState();
  const history = [
    turn("user", "item one prompt"),
    turn("assistant", "item one done"),
    turn("user", "item two prompt"),
  ];
  const loop = startItemRun(
    createLoop(plan, { now: T0, sessionTokens: 0, freshContext }),
    "2",
    2,
    T0,
  );
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        tools: [readFileTool],
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: model,
        },
      },
    },
    session: { ...state.session, mode: "agent", history, loop },
  };
}

const texts = (state: RootState) =>
  buildChatRequest(state)
    .messages.filter((m) => m.role !== "system")
    .map(renderChatMessage);

// A Loop item's user messages carry the act reminder by default, after a
// blank line
const TAIL = `\n\n${ACT_TURN_TAIL}`;

describe("a loop item's request", () => {
  it("carries only the turns since the item started", () => {
    expect(texts(stateWith())).toEqual([`item two prompt${TAIL}`]);
  });

  it("carries the whole conversation when fresh context is off", () => {
    expect(texts(stateWith(false))).toEqual([
      `item one prompt${TAIL}`,
      "item one done",
      `item two prompt${TAIL}`,
    ]);
  });

  it("is unchanged outside a run", () => {
    const state = stateWith();
    const idle = {
      ...state,
      session: {
        ...state.session,
        loop: { ...state.session.loop!, current: undefined },
      },
    };
    expect(texts(idle)).toHaveLength(3);
  });
});

describe("a loop item's plan block", () => {
  const withPlan = (state: RootState): RootState => ({
    ...state,
    session: { ...state.session, taskPlan: plan },
  });

  it("goes after the item prompt, with every slot and the running item marked", () => {
    const request = buildChatRequest(withPlan(stateWith()));
    // Not last: a block after the newest message moves with every request
    // and breaks a prompt cache there
    expect(request.taskListMessage).toBeUndefined();
    const [prompt] = texts(withPlan(stateWith()));
    expect(prompt.startsWith("item two prompt\n\n<task_list>")).toBe(true);
    expect(prompt).toContain("[x] 1. Write the lexer");
    expect(prompt).toContain("[>] 2. Add tests  <- this item");
    expect(prompt).toContain("report it with finish_item");
    // The tail comes last, after the block
    expect(prompt.endsWith(`</task_list>${TAIL}`)).toBe(true);
  });

  it("stays as the run started while the run goes on", () => {
    const state = withPlan(stateWith());
    const [before] = texts(state);
    const loop = state.session.loop!;
    const changed = {
      ...state,
      session: {
        ...state.session,
        loop: {
          ...loop,
          items: loop.items.map((i) =>
            i.id === "1" ? { ...i, summary: "changed meanwhile" } : i,
          ),
        },
      },
    };
    expect(texts(changed)[0]).toBe(before);
    // The kept history is not changed
    expect(renderChatMessage(state.session.history.at(-1)!.message)).toBe(
      "item two prompt",
    );
  });

  it("is not sent outside an item's run", () => {
    const state = withPlan(stateWith());
    const idle = {
      ...state,
      session: {
        ...state.session,
        loop: { ...state.session.loop!, current: undefined },
      },
    };
    // The task list tool is not among this state's tools either
    expect(buildChatRequest(idle).taskListMessage).toBeUndefined();
  });
});

describe("a loop turn's reasoning effort", () => {
  const withEffort = (state: RootState, modeModels: any): RootState => ({
    ...state,
    config: {
      ...state.config,
      config: { ...state.config.config, modeModels },
    },
  });

  it("an item takes modeModels.loop's effort, not the mode's", () => {
    const state = withEffort(stateWith(), {
      agent: { title: "Claude", reasoningEffort: "high" },
      loop: { title: "Claude", reasoningEffort: "off" },
    });
    expect(buildChatRequest(state).completionOptions).toMatchObject({
      reasoning: false,
    });
  });

  it("falls back to the agent entry when loop sets none", () => {
    const state = withEffort(stateWith(), {
      agent: { title: "Claude", reasoningEffort: "low" },
    });
    expect(buildChatRequest(state).completionOptions).toMatchObject({
      reasoning: true,
      reasoningBudgetTokens: 1024,
    });
  });
});

describe("a turn's tail (modeModels.<use>.tail)", () => {
  const withConfig = (state: RootState, extra: object): RootState => ({
    ...state,
    config: {
      ...state.config,
      config: { ...state.config.config, ...extra },
    },
  });
  const request = (state: RootState) => buildChatRequest(state).messages;

  it("goes on the user messages only: the system message and the assistant messages are byte-identical with and without it", () => {
    const base = stateWith(false);
    const on = request(
      withConfig(base, { modeModels: { loop: { tail: "on" } } }),
    );
    const off = request(
      withConfig(base, { modeModels: { loop: { tail: "off" } } }),
    );
    expect(on).toHaveLength(off.length);
    expect(on[0].role).toBe("system");
    expect(JSON.stringify(on[0])).toBe(JSON.stringify(off[0]));
    expect(JSON.stringify(on[2])).toBe(JSON.stringify(off[2]));
    expect(renderChatMessage(off.at(-1)!)).toBe("item two prompt");
    expect(renderChatMessage(on.at(-1)!)).toBe(`item two prompt${TAIL}`);
    // Nothing is written back to the history
    expect(renderChatMessage(base.session.history.at(-1)!.message)).toBe(
      "item two prompt",
    );
  });

  it("keeps every request an extension of the one before: a message's bytes never change once sent", () => {
    const state = withConfig(stateWith(false), {
      modeModels: { loop: { tail: "on" } },
    });
    const { history } = state.session;
    const earlier = buildChatRequest(state, history.slice(0, 1)).messages;
    const later = buildChatRequest(state, history).messages;
    expect(earlier).toHaveLength(2);
    expect(JSON.stringify(later.slice(0, 2))).toBe(JSON.stringify(earlier));
  });

  it("is off by default for Agent mode on a full-profile model, and follows modeModels.agent for a loop item", () => {
    const state = stateWith();
    const agent = {
      ...state,
      session: { ...state.session, loop: undefined },
    };
    expect(texts(agent)).toEqual([
      "item one prompt",
      "item one done",
      "item two prompt",
    ]);
    // On: every user message carries it, the assistant message does not
    expect(
      texts(withConfig(agent, { modeModels: { agent: { tail: "on" } } })),
    ).toEqual([
      `item one prompt${TAIL}`,
      "item one done",
      `item two prompt${TAIL}`,
    ]);
    expect(
      texts(withConfig(state, { modeModels: { agent: { tail: "off" } } })),
    ).toEqual(["item two prompt"]);
  });

  it("stays off the tool-output messages a model without native tools gets as user messages", () => {
    const state = withConfig(stateWith(false), {
      modeModels: { loop: { tail: "on" } },
      experimental: { onlyUseSystemMessageTools: true },
    });
    const history = [
      ...state.session.history.slice(0, 1),
      {
        message: {
          id: "a1",
          role: "assistant" as const,
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function" as const,
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "call-1",
            toolCall: {
              id: "call-1",
              type: "function" as const,
              function: { name: "read_file", arguments: "{}" },
            },
            status: "done" as const,
            parsedArgs: {},
            output: [
              { name: "out", description: "out", content: "file text here" },
            ],
          },
        ],
      } as unknown as ChatHistoryItem,
      ...state.session.history.slice(2),
    ];
    const messages = buildChatRequest({
      ...state,
      session: {
        ...state.session,
        history: history as RootState["session"]["history"],
      },
    }).messages;
    const users = messages
      .filter((m) => m.role === "user")
      .map(renderChatMessage);
    // The person's two messages carry the line; the tool output, a user
    // message on this path, does not
    expect(users).toHaveLength(3);
    expect(users[0]).toBe(`item one prompt${TAIL}`);
    expect(users[1]).toContain("file text here");
    expect(users[1]).not.toContain(ACT_TURN_TAIL);
    expect(users[2]).toBe(`item two prompt${TAIL}`);
  });

  it("takes a text as given", () => {
    const state = withConfig(stateWith(), {
      modeModels: { loop: { tail: "Finish the item, then report it." } },
    });
    expect(texts(state)).toEqual([
      "item two prompt\n\nFinish the item, then report it.",
    ]);
  });
});

describe("a loop turn's system prompt and rules", () => {
  const withConfig = (state: RootState, extra: object): RootState => ({
    ...state,
    config: {
      ...state.config,
      config: { ...state.config.config, ...extra },
    },
  });
  const systemText = (state: RootState) =>
    renderChatMessage(
      buildChatRequest(state).messages.find((m) => m.role === "system")!,
    );

  it("an item takes modeModels.loop's prompt: the short text here", () => {
    const state = withConfig(stateWith(), {
      modeModels: { loop: { title: "Claude", prompt: "short" } },
    });
    expect(systemText(state)).toContain("Keep going until the request is done");
    expect(systemText(stateWith())).toContain("Stopping");
  });

  it("an item follows the Agent rules switch unless loop has its own", () => {
    const rule = {
      name: "house",
      rule: "Always write tests first.",
      source: "default-chat",
      alwaysApply: true,
    };
    const off = withConfig(stateWith(), {
      rules: [rule],
      rulesByMode: { agent: false },
    });
    expect(systemText(off)).not.toContain("Always write tests first.");
    const on = withConfig(stateWith(), {
      rules: [rule],
      rulesByMode: { agent: false, loop: true },
    });
    expect(systemText(on)).toContain("Always write tests first.");
  });
});
