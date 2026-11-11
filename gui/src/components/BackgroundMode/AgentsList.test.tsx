import type {
  ChatHistoryItem,
  LoopState,
  Session,
  SubagentRunState,
} from "core";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  updateSubagentRun,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { AgentsList } from "./AgentsList";

vi.mock("../../util/subagents/registry", () => ({
  stopSubagentRun: vi.fn(),
  answerSubagentApproval: vi.fn(),
}));

const SECRET = "AKIAIOSFODNN7CANARY0";

const call = (id: string) => ({
  toolCallId: id,
  toolCall: {
    id,
    type: "function" as const,
    function: { name: "subagent", arguments: "{}" },
  },
  status: "calling" as const,
  parsedArgs: {},
});

const run = (over: Partial<SubagentRunState>): SubagentRunState => ({
  agent: "explore",
  prompt: `look for ${SECRET}`,
  status: "running",
  toolCalls: [],
  text: `found ${SECRET}`,
  startedAt: Date.now() - 5000,
  ...over,
});

async function setup(runs: Record<string, Partial<SubagentRunState>>) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const item = {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: Object.keys(runs).map(call),
  } as unknown as ChatHistoryItem;
  await renderWithProviders(<AgentsList />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "t",
        workspaceDirectory: "",
        history: [item],
      } as Session),
    );
  });
  await act(async () => {
    for (const [toolCallId, patch] of Object.entries(runs)) {
      store.dispatch(updateSubagentRun({ toolCallId, run: run(patch) }));
    }
  });
  return store;
}

describe("AgentsList", () => {
  it("renders nothing until an agent has been started", async () => {
    await setup({});
    expect(screen.queryByTestId("agents-panel")).toBeNull();
  });

  it("shows the session with its subagents, their state chips and what they do", async () => {
    await setup({
      a: {
        agent: "explore",
        model: "Haiku",
        toolCalls: [
          { name: "Bash", summary: `curl ${SECRET}`, status: "calling" },
        ],
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
      b: {
        agent: "reviewer",
        pendingApproval: {
          id: "p",
          toolName: "run_terminal_command",
          summary: `rm -rf ${SECRET}`,
        },
      },
      c: { agent: "writer", status: "completed", endedAt: Date.now() },
      d: { agent: "broken", status: "failed", error: SECRET },
    });

    const list = screen.getByTestId("agents-list");
    expect(within(list).getByText("Session")).toBeDefined();
    expect(screen.getByTestId("agent-state-sub-a").textContent).toBe("Running");
    expect(screen.getByTestId("agent-state-sub-b").textContent).toBe(
      "Needs you",
    );
    expect(screen.getByTestId("agent-state-sub-c").textContent).toBe("Done");
    expect(screen.getByTestId("agent-state-sub-d").textContent).toBe("Failed");
    expect(screen.getByTestId("agent-doing-sub-a").textContent).toBe(
      "running a command",
    );
    expect(screen.getByTestId("agent-doing-sub-b").textContent).toBe(
      "waiting for you",
    );
    expect(screen.getByTestId("agents-summary").textContent).toContain(
      "1 waiting for you",
    );
    expect(within(list).getByText("1.5k tokens")).toBeDefined();
    // The session has no priced usage here: unknown, never $0
    expect(screen.getByTestId("agent-cost-sub-a").textContent).toBe(
      "cost unknown",
    );
    // Nothing of the prompt, the answer, a tool's summary or an approval's
    // text is on the page
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain("curl");
  });

  it("lists the workers of a Loop wave with their worktree folder", async () => {
    const store = await setup({ a: {} });
    await act(async () => {
      store.dispatch(
        setLoop({
          parallel: [
            {
              itemId: "3",
              worktree: "C:\\Users\\someone\\wt\\item-3",
              startedAt: new Date().toISOString(),
            },
          ],
          items: [{ id: "3", model: { title: "Local" } }],
        } as unknown as LoopState),
      );
    });
    const row = screen.getByTestId("agent-row-worker-3");
    expect(row.textContent).toContain("item 3");
    expect(row.textContent).toContain("Local");
    expect(screen.getByTestId("agent-doing-worker-3").textContent).toBe(
      "item-3",
    );
    expect(document.body.textContent).not.toContain("someone");
  });

  it("collapses a branch and the whole list, with names a screen reader can use", async () => {
    await setup({ a: {}, b: {} });
    const toggle = screen.getByRole("button", { name: "Collapse Session" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId(/^agent-row-sub-/)).toHaveLength(2);
    fireEvent.click(toggle);
    expect(screen.queryAllByTestId(/^agent-row-sub-/)).toHaveLength(0);
    expect(
      screen
        .getByRole("button", { name: "Expand Session" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("agents-toggle"));
    expect(screen.queryByTestId("agents-list")).toBeNull();
    expect(
      screen.getByTestId("agents-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("holds twelve agents in a list that wraps instead of scrolling sideways", async () => {
    const runs: Record<string, Partial<SubagentRunState>> = {};
    for (let i = 0; i < 12; i++) runs[`r${i}`] = { agent: `agent-number-${i}` };
    await setup(runs);
    expect(screen.getAllByTestId(/^agent-row-sub-/)).toHaveLength(12);
    const list = screen.getByTestId("agents-list");
    expect(list.className).toContain("min-w-0");
    for (const row of screen.getAllByTestId(/^agent-row-sub-/)) {
      expect(row.firstElementChild?.className).toContain("flex-wrap");
    }
  });
});
