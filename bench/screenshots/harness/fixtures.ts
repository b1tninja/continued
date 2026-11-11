// Fixture states for the screenshot harness. Each fixture dispatches the real
// redux actions the app uses (the same ones the gui tests use), against the
// real store, with MockIdeMessenger standing in for the IDE. Nothing here is
// sent anywhere: no model, no network.
import type {
  ChatHistoryItem,
  LoopState,
  ModelDescription,
  TaskPlan,
  ToolCallState,
} from "core";
import { parsePolicyFile } from "core/tools/permissions/settingsFile";
import { createLoop, enterWait } from "core/util/loopMode";
import type { MockIdeMessenger } from "@gui/context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  setMode,
  setTaskPlan,
} from "@gui/redux/slices/sessionSlice";
import type { setupStore } from "@gui/redux/store";

export type Store = ReturnType<typeof setupStore>;
export interface FixtureContext {
  store: Store;
  messenger: MockIdeMessenger;
  /** Sends a message as the IDE would (navigation, config updates ...) */
  navigate: (path: string) => void;
}
export type Fixture = (ctx: FixtureContext) => void | Promise<void>;

/** A fixed clock so budgets and ages draw the same on every run. */
const NOW = new Date("2026-11-10T10:00:00Z");

export const CHAT_MODEL: ModelDescription = {
  title: "Claude Sonnet",
  model: "claude-sonnet-4-5",
  provider: "bedrock",
  underlyingProviderName: "bedrock",
  contextLength: 200_000,
} as ModelDescription;

/** Seeds the answers the app asks the IDE for at start, before it mounts. */
export function seedMessenger(messenger: MockIdeMessenger): void {
  const info: any = structuredClone(
    messenger.responses["config/getSerializedProfileInfo"],
  );
  info.result.config.modelsByRole.chat = [CHAT_MODEL];
  info.result.config.selectedModelByRole.chat = CHAT_MODEL;
  messenger.responses["config/getSerializedProfileInfo"] = info;
  Object.assign(messenger.responses, {
    "models/fetch": [],
    "config/getTerminalEnvironment": {
      mode: "scrub",
      source: "default",
      passEnv: [],
      allow: [],
      notices: [],
      hostEnvNames: ["PATH", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "EDITOR"],
      credentialUrlNames: [],
    },
    getOpenFiles: [],
    "policy/load": parsePolicyFile(undefined),
    "config/getProviderSetup": {
      connections: [],
      secureStorageAvailable: true,
      preferredKeyStorage: "secure",
      editable: true,
    },
  });
}

/** What the IDE would send after loading the config: puts the model in the store. */
export function sendConfig(messenger: MockIdeMessenger): void {
  const info: any = messenger.responses["config/getSerializedProfileInfo"];
  messenger.mockMessageToWebview("configUpdate", info);
}

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}
function assistant(
  text: string,
  toolCallStates?: ToolCallState[],
): ChatHistoryItem {
  return {
    message: { role: "assistant", content: text },
    contextItems: [],
    toolCallStates,
  };
}
function session(history: ChatHistoryItem[], title = "Fix the failing test") {
  return {
    sessionId: "fixture-session",
    title,
    workspaceDirectory: "file:///c:/work/app",
    history,
  };
}

const MARKDOWN_REPLY = [
  "The failure is in `parseConfig`: it reads `opts.timeout` before the defaults are merged, so a missing value becomes `undefined`.",
  "",
  "```ts",
  "export function parseConfig(opts: Partial<Config> = {}) {",
  "  const merged = { ...DEFAULTS, ...opts };",
  "  return { ...merged, timeout: merged.timeout * 1000 };",
  "}",
  "```",
  "",
  "- merge the defaults first",
  "- convert the unit last",
].join("\n");

function runCommandCall(status: ToolCallState["status"]): ToolCallState {
  return {
    toolCallId: "call-1",
    toolCall: {
      id: "call-1",
      type: "function",
      function: {
        name: "run_terminal_command",
        arguments: JSON.stringify({ command: "npm test -- parseConfig" }),
      },
    },
    status,
    parsedArgs: { command: "npm test -- parseConfig" },
    output:
      status === "done"
        ? [
            {
              name: "Terminal",
              description: "Terminal command output",
              content:
                "PASS  src/parseConfig.test.ts\n  parseConfig\n    ok defaults are merged first (3 ms)\n\nTests: 1 passed, 1 total",
            },
          ]
        : undefined,
  } as ToolCallState;
}

const PLAN: TaskPlan = {
  items: [
    {
      id: "1",
      text: "Reproduce the failure with a test",
      status: "done",
    },
    {
      id: "2",
      text: "Merge the defaults before converting the unit",
      status: "in_progress",
      budget: { tokens: 20_000, minutes: 10, turns: 20 },
    },
    {
      id: "3",
      text: "Run the whole suite",
      status: "pending",
      budget: { tokens: 10_000, minutes: 5 },
    },
  ],
  updatedAt: NOW.toISOString(),
} as TaskPlan;

function loopState(): LoopState {
  // the real clock: a loop whose start is far in the past is stopped by its own time budget
  const loop = createLoop(PLAN, {
    now: new Date(),
    sessionTokens: 0,
    autonomy: "auto",
  });
  loop.items = loop.items.map((item) =>
    item.id === "2"
      ? { ...item, attempts: 1, usage: { tokens: 9_000, ms: 150_000 } }
      : item,
  );
  // waiting on the person: the loop controller does not start a turn of its own
  return enterWait(loop, new Date());
}

export const FIXTURES: Record<string, Fixture> = {
  /** A new, empty chat */
  idle: ({ store }) => {
    store.dispatch(newSession());
  },
  /** A finished exchange, markdown and a code block */
  conversation: ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          assistant(MARKDOWN_REPLY),
        ]),
      ),
    );
  },
  /** A reply that is still arriving */
  streaming: async ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Why does the parseConfig test fail?"),
          assistant(MARKDOWN_REPLY.slice(0, 120)),
        ]),
      ),
    );
    store.dispatch({ type: "session/setActive" });
  },
  /** A tool call card waiting for approval, then one that finished */
  "tool-call": ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Run the parseConfig tests"),
          assistant("I will run the tests for that file.", [
            runCommandCall("generated"),
          ]),
        ]),
      ),
    );
  },
  "tool-call-done": ({ store }) => {
    store.dispatch(
      newSession(
        session([
          user("Run the parseConfig tests"),
          assistant("I ran the tests for that file.", [runCommandCall("done")]),
          assistant("All of them pass."),
        ]),
      ),
    );
  },
  /** Loop mode: the plan card, the per-item budgets and the loop controls */
  loop: ({ store }) => {
    store.dispatch(newSession(session([], "Fix parseConfig")));
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loopState()));
  },
  /** The Settings page, Tools tab, with "Commands and secrets" */
  "settings-tools": async ({ navigate }) => {
    navigate("/config?tab=tools");
    await new Promise((r) => setTimeout(r, 500));
    // the section lower on the page
    document
      .querySelector("[data-testid=terminal-env]")
      ?.scrollIntoView({ block: "start" });
  },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);
