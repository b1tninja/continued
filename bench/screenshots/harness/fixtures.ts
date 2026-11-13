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
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { parsePolicyFile } from "core/tools/permissions/settingsFile";
import { createLoop, enterWait } from "core/util/loopMode";
import { addBlockedCall } from "@gui/redux/slices/blockedCallsSlice";
import { setPolicyLevel } from "@gui/redux/slices/uiSlice";
import { POLICY_AREAS } from "core/tools/permissions/policy";
import type { MockIdeMessenger } from "@gui/context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  noteToolDialectLeak,
  setActive,
  setMode,
  setRecoveryHold,
  setTaskPlan,
} from "@gui/redux/slices/sessionSlice";
import type { setupStore } from "@gui/redux/store";
import { AUDIT_FIXTURES } from "./auditFixtures";

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
    "audit/shadowSettings": {
      form: { enabled: false, timeoutMs: 5000 },
      trailEnabled: true,
      spentUsd: 0,
      reservedUsd: 0,
      reviews: 0,
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

/** Set a controlled input's value the way typing does, so React sees it. */
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Permissions page with the add-rule form open on a rule that allows every command. */
const permissionsEditor: Fixture = async ({ messenger, navigate }) => {
  const report = {
    ...listEffectiveRules({
      levels: DEFAULT_POLICY_LEVELS,
      floor: ["runTerminalCommand(rm -rf /*)"],
      user: {
        deny: ["runTerminalCommand(terraform apply*)"],
        ask: ["runTerminalCommand(git push*)"],
        allow: ["runTerminalCommand(npm test*)"],
      },
      folder: [
        {
          file: "C:/work/app/.continue/rules.yaml",
          permissions: { allow: ["runTerminalCommand(make build*)"] },
        },
      ],
    }),
    userFile: { path: "config.yaml", state: "ok" as const, hash: "h1" },
  };
  Object.assign(messenger.responses, {
    "policy/rules": report,
    "config/addToolRule": {
      result: "preview",
      analysis: {
        valid: true,
        rule: "runTerminalCommand(*)",
        broad: true,
        broadReason: "It matches every command.",
        friction: "typed",
        loosens: true,
        warnings: [],
      },
      diff: [
        { kind: "same", text: "toolPermissions:" },
        { kind: "add", text: "  allow:" },
        { kind: "add", text: "    - runTerminalCommand(*)" },
      ],
      verdict: {
        probe: "rm notes.txt",
        before: { decision: "ask", reason: "level" },
        after: { decision: "allow", reason: "rule" },
      },
    },
  });
  navigate("/config?tab=permissions");
  await wait(600);
  const add = document.querySelector<HTMLButtonElement>(
    "button[aria-label='Add a rule']",
  );
  add?.click();
  await wait(100);
  const input = document.querySelector<HTMLInputElement>(
    "form[data-testid=rule-form] input.font-mono",
  );
  if (input) typeInto(input, "runTerminalCommand(*)");
  await wait(700);
  document
    .querySelector("[data-testid=rule-form]")
    ?.scrollIntoView({ block: "start" });
};

// ---- Loop mode: the plan tile and its tree ---------------------------------

const TILE_TITLES = [
  "Port sdk-forge/loop.py pickup to the projecthub CLI",
  "Move the roadmap sync onto projecthub issues",
  "Point every project AGENTS.md at the projecthub plan",
  "Move verify.py's five gates into projecthub",
  "Retire the sdk-forge githooks path and re-point core.hooksPath",
  "Write the migration note in PORTFOLIO.md",
  "Run the whole suite from a clean checkout",
  "Tag the release",
];

const PLAN_URI =
  "file:///c:/work/app/.continuous/plans/finish-the-migration.md";

function planCall(): ToolCallState {
  return {
    toolCallId: "plan-1",
    toolCall: {
      id: "plan-1",
      type: "function",
      function: { name: "present_plan", arguments: "{}" },
    },
    parsedArgs: {
      title: "Finish the sdk-forge to projecthub migration",
      plan: "Move the planning tools onto projecthub, one project at a time.",
      todos: TILE_TITLES,
    },
    status: "done",
    output: [
      {
        name: "Finish the sdk-forge to projecthub migration",
        description: ".continuous/plans/finish-the-migration.md",
        content: "Plan saved",
        uri: { type: "file", value: PLAN_URI },
      },
    ],
  } as ToolCallState;
}

function tilePlan(texts = TILE_TITLES): TaskPlan {
  return {
    items: texts.map((text, i) => ({
      id: String(i + 1),
      text,
      status: "pending" as const,
      ...(i === 1 ? { budget: { turns: 12 } } : {}),
    })),
    updatedAt: NOW.toISOString(),
  } as TaskPlan;
}

function toolTurn(command: string): ChatHistoryItem {
  return assistant("", [
    {
      toolCallId: "t-" + command.length,
      toolCall: {
        id: "t-" + command.length,
        type: "function",
        function: {
          name: "run_terminal_command",
          arguments: JSON.stringify({ command }),
        },
      },
      status: "done",
      parsedArgs: { command },
    } as ToolCallState,
  ]);
}

type LoopPatch = (loop: LoopState, plan: TaskPlan) => LoopState;

/** The plan card at the head of a Loop session, with the loop in the state `patch` sets */
function tileFixture(opts: {
  patch: LoopPatch;
  plan?: TaskPlan;
  /** The plan the loop was created from, when it differs (a re-plan waits) */
  loopPlan?: TaskPlan;
  history?: ChatHistoryItem[];
  /** Open the tree with a click, as a person would */
  open?: boolean;
}): Fixture {
  return async ({ store }) => {
    const plan = opts.plan ?? tilePlan();
    const base = createLoop(opts.loopPlan ?? plan, {
      now: new Date(Date.now() - 400_000),
      sessionTokens: 0,
      autonomy: "auto",
      title: "Finish the sdk-forge to projecthub migration",
    });
    const patched = opts.patch({ ...base, round: 2 }, plan);
    store.dispatch(
      newSession(
        session(
          [
            user("Plan the migration, then build it"),
            assistant("", [planCall()]),
            ...(opts.history ?? []),
          ],
          "Finish the migration",
        ),
      ),
    );
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(plan));
    store.dispatch(setLoop(patched));
    // a turn is running: the loop driver leaves a running loop alone
    if (patched.status === "running") store.dispatch(setActive());
    if (opts.open) {
      await new Promise((r) => setTimeout(r, 600));
      (
        document.querySelector(
          "[data-testid=plan-tree-root] > div",
        ) as HTMLElement | null
      )?.click();
      // and the fold of the finished items, to show what was replaced
      await new Promise((r) => setTimeout(r, 100));
      (
        document.querySelector(
          "[data-testid=plan-tree-fold-done] > div",
        ) as HTMLElement | null
      )?.click();
    }
  };
}

const withItems =
  (statuses: Record<string, Partial<LoopState["items"][number]>>) =>
  (loop: LoopState): LoopState => ({
    ...loop,
    items: loop.items.map((i) => ({ ...i, ...statuses[i.id] })),
  });

export const FIXTURES: Record<string, Fixture> = {
  /** Loop mode, the plan tile: collapsed, one click to audit */
  "loop-plan-tile": tileFixture({
    patch: (loop) => ({
      ...withItems({
        "1": { status: "done" },
        "2": { status: "running", attempts: 1 },
      })(loop),
      current: {
        kind: "item",
        itemId: "2",
        historyIndex: 2,
        startedAt: new Date(Date.now() - 130_000).toISOString(),
      },
    }),
  }),
  /** Loop mode, the plan tree open: done fold, the current item with its live lines, upcoming rows */
  "loop-plan-running": tileFixture({
    open: true,
    history: [
      toolTurn("pytest -q tests/test_roadmap.py"),
      toolTurn('pip install -e ".[dev]"'),
    ],
    patch: (loop) =>
      ({
        ...withItems({
          "1": { status: "done" },
          "2": { status: "running", attempts: 1, addedInRound: 2 },
        })(loop),
        current: {
          kind: "item",
          itemId: "2",
          historyIndex: 2,
          startedAt: new Date(Date.now() - 130_000).toISOString(),
        },
        replacedItems: [
          {
            id: "0",
            text: "Re-run the gates on the PR head",
            round: 2,
            replacedBy: "2",
          },
        ],
        autoDecisions: [
          {
            kind: "plan",
            by: "system",
            source: "Plan edits: Permissive",
            text: "Plan updated: 7 kept, 1 added, 1 dropped; check of item 1 replaced",
            at: new Date().toISOString(),
          },
          {
            kind: "question",
            by: "system",
            source: "Questions: Permissive",
            text: "Auto-answered: Merge PR #7 as-is? -> Merge it after writing the gate record",
            at: new Date().toISOString(),
          },
        ],
      }) as LoopState,
  }),
  /** Loop mode, a re-plan waiting to be accepted: dropped struck through, new to-do, kept folded */
  "loop-plan-waiting": (() => {
    const previous = TILE_TITLES.slice();
    const next = tilePlan([
      TILE_TITLES[0],
      "Write PR #7's gate record to the log",
      ...TILE_TITLES.slice(2),
    ]);
    // the new to-do has an id the loop does not know
    next.items[1] = { ...next.items[1], id: "9" };
    return tileFixture({
      plan: next,
      loopPlan: tilePlan(),
      patch: (loop) => ({
        ...withItems({ "1": { status: "done" } })(loop),
        status: "awaiting_plan" as const,
        replanReason:
          "It changes or removes the check of item 2, which ended stuck without running it.",
        replanned: { planTexts: previous },
      }),
    });
  })(),
  /** Loop mode, an item failed and a repair re-plan runs */
  "loop-plan-failed": tileFixture({
    history: [toolTurn("pytest -q")],
    patch: (loop) => ({
      ...withItems({
        "1": { status: "done" },
        "2": {
          status: "failed",
          attempts: 2,
          check: {
            status: "failed",
            command: "pytest -q",
            exitCode: 1,
            output: "collected 12 items\n2 failed, 10 passed in 3.4s",
            at: new Date().toISOString(),
          },
        },
      })(loop),
      current: {
        kind: "replan",
        itemId: "2",
        itemText: TILE_TITLES[1],
        historyIndex: 2,
        startedAt: new Date(Date.now() - 20_000).toISOString(),
      },
    }),
  }),
  /** Loop mode, finished: one fold, the root says N/N done */
  "loop-plan-finished": tileFixture({
    patch: (loop) => ({
      ...withItems(
        Object.fromEntries(
          TILE_TITLES.map((_, i) => [
            String(i + 1),
            { status: "done" as const },
          ]),
        ),
      )(loop),
      status: "stopped" as const,
    }),
  }),
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
  /** Three calls waiting: a long command, a directory outside the workspace, an MCP tool */
  approval: ({ store }) => {
    const call = (
      id: string,
      name: string,
      args: Record<string, unknown>,
      extra: Partial<ToolCallState> = {},
    ): ToolCallState => ({
      toolCallId: id,
      toolCall: {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
      status: "generated",
      parsedArgs: args,
      ...extra,
    });
    store.dispatch(
      newSession(
        session([
          user("Clean up and look around"),
          assistant("I need to run a few things.", [
            call("call-1", "run_terminal_command", {
              command:
                "cd packages/app && API_TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 npm run build \\\n  && rsync -av --delete dist/ deploy@staging.example.com:/var/www/app/ \\\n  && ssh deploy@staging.example.com 'sudo systemctl restart app && sudo journalctl -u app -n 50'\n# afterwards\necho done",
              cwd: "D:/code/app",
            }),
            call(
              "call-2",
              "ls",
              { dirPath: "D:/" },
              {
                policyNote:
                  "This reaches D:/, outside the workspace, a place the agent has not been given. Approve only if you meant it.",
                policyRule: "ls(D:/**)",
                policySource: "ask-rule",
              },
            ),
            call(
              "call-3",
              "github_create_issue",
              {
                repo: "b1tninja/continuous",
                title: "Approval row",
                labels: ["ux"],
              },
              {
                tool: {
                  type: "function",
                  function: { name: "github_create_issue" },
                  displayTitle: "create_issue",
                  group: "github",
                  originalFunctionName: "create_issue",
                  readonly: false,
                } as ToolCallState["tool"],
              },
            ),
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
  /** A reply held back while the app checks it for a tool request */
  held: ({ store }) => {
    store.dispatch(
      newSession(
        session([user("Why does the parseConfig test fail?"), assistant("")]),
      ),
    );
    store.dispatch({ type: "session/setActive" });
    store.dispatch(setRecoveryHold(true));
  },
  /** A model wrote a tool request as plain text: the notice above the input */
  dialect: ({ store }) => {
    store.dispatch(newSession());
    store.dispatch(
      noteToolDialectLeak({
        model: "Claude Sonnet",
        dialect: "qwen-xml",
      } as never),
    );
  },
  /** The "+" menu at the left of the prompt, open */
  "attach-open": async ({ store }) => {
    store.dispatch(newSession());
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector("[data-testid=attach-menu-button]") as HTMLElement
    )?.click();
  },
  /** The "..." menu under the prompt, open */
  "overflow-open": async ({ store }) => {
    store.dispatch(newSession());
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector(
        "[data-testid=input-overflow-button]",
      ) as HTMLElement
    )?.click();
  },
  /** The preset picker in the toolbar, open: glyph, what each sets, the check */
  "preset-open": async ({ store }) => {
    store.dispatch(newSession());
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector("[data-testid=policy-preset]") as HTMLElement
    )?.click();
  },
  /** Loop mode: the plan card, the per-item budgets and the loop controls */
  loop: ({ store }) => {
    store.dispatch(newSession(session([], "Fix parseConfig")));
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loopState()));
  },
  /** Loop mode at IDGAF with seven refused calls: the one-line chip and the blocked badge */
  "loop-idgaf": ({ store }) => {
    store.dispatch(newSession(session([], "Fix parseConfig")));
    store.dispatch(setMode("loop" as never));
    store.dispatch(setTaskPlan(PLAN));
    store.dispatch(setLoop(loopState()));
    for (const area of POLICY_AREAS) {
      store.dispatch(setPolicyLevel({ area, level: "idgaf" }));
    }
    for (let i = 0; i < 7; i++) {
      store.dispatch(
        addBlockedCall({
          id: String(i),
          toolName: "run_terminal_command",
          summary: `rm -rf build-${i}`,
          source: i % 2 ? "auto" : "deny-rule",
          reason: "Deletes files outside the task",
          parsedArgs: { command: `rm -rf build-${i}` },
          at: NOW.getTime(),
        } as never),
      );
    }
  },
  /** The same, with the blocked list open above the mode bar */
  "loop-blocked-open": async (ctx) => {
    await (FIXTURES as Record<string, Fixture>)["loop-idgaf"](ctx);
    await new Promise((r) => setTimeout(r, 800));
    (
      document.querySelector(
        "[data-testid=recently-blocked-toggle]",
      ) as HTMLElement
    )?.click();
  },
  "permissions-editor": permissionsEditor,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function subCall(id: string): ToolCallState {
  return {
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "subagent", arguments: "{}" },
    },
    status: "calling",
    parsedArgs: {},
    subagent: {
      agent: "explore",
      model: "Claude Haiku",
      description: "Find where timeouts are parsed",
      prompt: "find it",
      status: "running",
      toolCalls: [],
      text: "",
      startedAt: Date.now() - 95_000,
      usage: { inputTokens: 12_400, outputTokens: 900 },
    },
  } as ToolCallState;
}

/** Subagent calls with the given statuses (and names) on one assistant turn. */
function agentsSession(
  runs: { agent?: string; status: string; model?: string }[],
): Fixture {
  return ({ store }) => {
    const calls = runs.map((r, i) => {
      const c: any = subCall(`s${i + 1}`);
      c.subagent = {
        ...c.subagent,
        agent: r.agent ?? c.subagent.agent,
        status: r.status,
        ...(r.model ? { model: r.model } : {}),
        ...(r.status === "running" ? {} : { endedAt: Date.now() - 1000 }),
      };
      return c as ToolCallState;
    });
    store.dispatch(
      newSession(
        session([
          user("Look into the timeouts in three places"),
          assistant("I started some helpers.", calls),
        ]),
      ),
    );
  };
}

function settingsTab(tab: string): Fixture {
  return async ({ navigate }) => {
    navigate(`/config?tab=${tab}`);
    await sleep(600);
  };
}

const BEDROCK_MODELS = [
  {
    id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5",
    provider: "Anthropic",
    kind: "on-demand",
    needsAnthropicUseCase: true,
  },
  {
    id: "us.amazon.nova-pro-v1:0",
    name: "Nova Pro",
    provider: "Amazon",
    kind: "inference-profile",
    access: "needs-access",
  },
];

/** The Bedrock "Test connection" result, mounted on its own (see main.tsx). */
function bedrock(ok: boolean): Fixture {
  return async ({ messenger }) => {
    const h = messenger.responseHandlers as any;
    h["bedrock/listModels"] = async (d: any) =>
      !ok
        ? {
            ok: false,
            error:
              "AccessDeniedException: User arn:aws:sts::123456789012:assumed-role/dev-role-for-the-production-account/session-1731234567 is not authorized to perform: bedrock:ListFoundationModels",
          }
        : d.endpoint === "mantle"
          ? { ok: true, models: [] }
          : { ok: true, models: BEDROCK_MODELS };
    h["bedrock/probeToolCalls"] = async () => ({
      ok: true,
      kind: "text",
      label: "Tool calls: written as text (qwen-xml)",
      preset: "qwen-xml (tools written as text)",
    });
    await sleep(300);
    [...document.querySelectorAll("button")]
      .find((b) => /Test connection/.test(b.textContent ?? ""))
      ?.click();
    await sleep(600);
  };
}

// The loop frame is mounted on its own (see main.tsx, LoopFrameDemo); the state is in the name.
const noop: Fixture = async () => {};

Object.assign(FIXTURES, {
  "loop-frame-running": noop,
  "loop-frame-waiting": noop,
  "loop-frame-failed": noop,
  "loop-frame-finished": noop,
  "loop-frame-stopped": noop,
  "settings-models": settingsTab("models"),
  "settings-rules": settingsTab("rules"),
  "settings-permissions": async (ctx) => {
    ctx.messenger.responseHandlers["policy/rules"] = (async () =>
      listEffectiveRules({
        levels: DEFAULT_POLICY_LEVELS,
        floor: ["runTerminalCommand(rm -rf /*)"],
        user: {
          deny: ["runTerminalCommand(terraform apply*)"],
          ask: ["runTerminalCommand(git push*)"],
          allow: ["runTerminalCommand(npm test*)", "readFile(src/**)"],
        },
        assistant: { allow: ["mcp__github__*"] },
        folder: [],
        cliFile: { exclude: ["Write(.git/**)"] },
        maxNewPlanItems: 3,
        notices: [],
      } as never)) as never;
    await settingsTab("permissions")(ctx);
  },
  "settings-configs": settingsTab("configs"),
  "settings-indexing": settingsTab("indexing"),
  "settings-general": settingsTab("settings"),
  "settings-help": settingsTab("help"),
  "agents-running": agentsSession([
    { status: "running" },
    {
      agent: "a-reviewer-with-an-extremely-long-agent-name",
      status: "running",
      model:
        "Claude Opus 4 with a very long model title (eu-west-1 inference profile)",
    },
    { status: "completed" },
  ]),
  "agents-ended": agentsSession([
    {
      agent: "a-reviewer-with-an-extremely-long-agent-name",
      status: "completed",
    },
    { status: "interrupted" },
    { status: "cancelled" },
  ]),
  "bedrock-ok": bedrock(true),
  "bedrock-fail": bedrock(false),
});

const permissionsReport = () =>
  listEffectiveRules({
    levels: DEFAULT_POLICY_LEVELS,
    floor: ["runTerminalCommand(rm -rf /*)"],
    user: { ask: ["runTerminalCommand(git push*)"] },
    maxNewPlanItems: 3,
  } as never);

Object.assign(FIXTURES, {
  /** The rules are still being read: the skeleton, then the slow line */
  "permissions-loading": async (ctx: FixtureContext) => {
    ctx.messenger.responseHandlers["policy/rules"] = (() =>
      new Promise(() => {})) as never;
    await settingsTab("permissions")(ctx);
    await sleep(4500);
  },
  /** The read failed: an error that names the files, with Retry */
  "permissions-error": async (ctx: FixtureContext) => {
    ctx.messenger.responseHandlers["policy/rules"] = (async () => {
      throw new Error("unreadable");
    }) as never;
    await settingsTab("permissions")(ctx);
  },
  /** The first-run overview card on the Permissions page */
  "permissions-intro": async (ctx: FixtureContext) => {
    ctx.messenger.responseHandlers["policy/rules"] = (async () =>
      permissionsReport()) as never;
    await settingsTab("permissions")(ctx);
  },
  /** An empty chat with the one-line first-run notice (flag not set) */
  "chat-first-run": ({ store }: FixtureContext) => {
    store.dispatch(newSession());
  },
});

Object.assign(FIXTURES, AUDIT_FIXTURES);

export const FIXTURE_NAMES = Object.keys(FIXTURES);
