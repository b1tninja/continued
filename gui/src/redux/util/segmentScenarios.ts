import type {
  ChatHistoryItem,
  ModelDescription,
  RuleWithSource,
  TaskPlan,
} from "core";
import { editFileTool } from "core/tools/definitions/editFile";
import { multiEditTool } from "core/tools/definitions/multiEdit";
import { presentPlanTool } from "core/tools/definitions/presentPlan";
import { readFileTool } from "core/tools/definitions/readFile";
import { runTerminalCommandTool } from "core/tools/definitions/runTerminalCommand";
import { taskListTool } from "core/tools/definitions/taskList";
import { createLoop, startItemRun } from "core/util/loopMode";
import { getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";

/**
 * Test-only: the IDE request scenarios the prompt-segment tests build with the
 * real builders (buildChatRequest) over a mock store. Shared by the golden
 * request test (nothing sent may change) and the segment manifest tests.
 */

export const CLAUDE: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};
export const QWEN: ModelDescription = {
  title: "Qwen",
  model: "qwen3-coder:30b",
  provider: "ollama",
  underlyingProviderName: "ollama",
};
export const NOVA: ModelDescription = {
  title: "Nova",
  model: "amazon.nova-pro-v1:0",
  provider: "bedrock",
  underlyingProviderName: "bedrock",
};

const T0 = new Date("2026-11-07T10:00:00Z");
export const PLAN: TaskPlan = {
  items: [
    { id: "1", text: "Write the lexer", status: "completed" },
    { id: "2", text: "Add tests", status: "pending" },
  ],
  updatedAt: T0.toISOString(),
};

export const RULES: RuleWithSource[] = [
  {
    name: "always",
    rule: "Always answer in British English.",
    source: "rules-block" as any,
    alwaysApply: true,
  },
  {
    name: "ts-only",
    rule: "In TypeScript files prefer named exports.",
    source: "rules-block" as any,
    globs: "**/*.ts",
  },
];

const TOOLS = [
  readFileTool,
  editFileTool,
  multiEditTool,
  runTerminalCommandTool,
  presentPlanTool,
  taskListTool,
];

let n = 0;
export const msg = (
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatHistoryItem> = {},
): ChatHistoryItem =>
  ({
    message: { id: `m${++n}`, role, content },
    contextItems: [],
    ...extra,
  }) as ChatHistoryItem;

export function ideState(opts: {
  model: ModelDescription;
  mode?: RootState["session"]["mode"];
  history?: ChatHistoryItem[];
  taskPlan?: TaskPlan;
  rules?: RuleWithSource[];
  loop?: boolean;
  onlySystemTools?: boolean;
}): RootState {
  const state = getEmptyRootState();
  const history = opts.history ?? [
    msg("user", "Fix the bug in lexer.ts"),
    msg("assistant", "Looking at it."),
    msg("user", "Now add a test."),
  ];
  const loop = opts.loop
    ? startItemRun(
        createLoop(PLAN, { now: T0, sessionTokens: 0 }),
        "2",
        history.length - 1,
        T0,
      )
    : undefined;
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        tools: TOOLS,
        rules: opts.rules ?? RULES,
        experimental: opts.onlySystemTools
          ? { onlyUseSystemMessageTools: true }
          : state.config.config.experimental,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: opts.model,
        },
      },
    },
    session: {
      ...state.session,
      mode: opts.mode ?? "agent",
      history: history as RootState["session"]["history"],
      taskPlan: opts.taskPlan,
      loop,
    },
  };
}

/** The IDE scenarios by name (C62 scenarios 1 to 5, and 9 and 10 in the IDE). */
export const IDE_SCENARIOS: Record<string, () => RootState> = {
  "ide-agent-claude": () => ideState({ model: CLAUDE }),
  "ide-agent-claude-tasklist": () =>
    ideState({ model: CLAUDE, taskPlan: PLAN }),
  "ide-plan-claude": () => ideState({ model: CLAUDE, mode: "plan" }),
  "ide-agent-qwen-prompted": () =>
    ideState({ model: QWEN, onlySystemTools: true }),
  "ide-agent-nova": () => ideState({ model: NOVA }),
  "ide-loop-item": () =>
    ideState({ model: CLAUDE, loop: true, taskPlan: PLAN }),
  "ide-agent-scoped-rule": () =>
    ideState({
      model: CLAUDE,
      history: [
        msg("user", "Fix the bug in lexer.ts", {
          contextItems: [
            {
              name: "lexer.ts",
              description: "",
              content: "export const a = 1;",
              uri: { type: "file", value: "file:///repo/src/lexer.ts" },
              id: { providerTitle: "file", itemId: "lexer" },
            },
          ],
        }),
      ],
    }),
  "ide-compacted": () =>
    ideState({
      model: CLAUDE,
      history: [
        msg("user", "Fix the bug in lexer.ts"),
        msg("assistant", "Done.", {
          conversationSummary: "The lexer bug was fixed.",
        }),
        msg("user", "Now add a test."),
      ],
    }),
};
