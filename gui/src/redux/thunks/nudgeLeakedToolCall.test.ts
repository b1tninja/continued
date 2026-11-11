import type { ChatHistoryItem } from "core";
import { LEAKED_CALL_NUDGE } from "core/util/turnEnd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RootState } from "../store";
import { addUserInputToHistory } from "./addUserInputToHistory";
import {
  leakedCallNudgesThisTurn,
  nudgeLeakedToolCall,
} from "./nudgeLeakedToolCall";

vi.mock("./addUserInputToHistory", () => ({
  addUserInputToHistory: vi.fn(async () => ({})),
}));

const LEAK =
  "<function=Write>\n<parameter=path>\na.txt\n</parameter>\n</function>";

const item = (
  role: "user" | "assistant",
  content: string,
  extra: object = {},
): ChatHistoryItem =>
  ({ message: { role, content, ...extra }, contextItems: [] }) as never;

const run = (history: ChatHistoryItem[], loop?: unknown, tools = ["Write"]) =>
  nudgeLeakedToolCall({
    state: { session: { history, loop } } as unknown as RootState,
    toolNames: tools,
    dispatch: vi.fn() as never,
    getState: (() => ({ session: { history } })) as never,
    ideMessenger: {} as never,
  });

beforeEach(() => vi.mocked(addUserInputToHistory).mockClear());

describe("nudgeLeakedToolCall (H13)", () => {
  it("adds one nudge when the reply is a tool call written as text", async () => {
    const sent = await run([
      item("user", "write a.txt"),
      item("assistant", LEAK),
    ]);
    expect(sent).toBe(true);
    const call = vi.mocked(addUserInputToHistory).mock.calls[0][0];
    expect(JSON.stringify(call.editorState)).toContain(LEAKED_CALL_NUDGE);
    expect(call.index).toBe(2);
  });

  it("stops after one nudge per turn", async () => {
    const history = [
      item("user", "write a.txt"),
      item("assistant", LEAK),
      item("user", LEAKED_CALL_NUDGE),
      item("assistant", LEAK),
    ];
    expect(leakedCallNudgesThisTurn(history)).toBe(1);
    expect(await run(history)).toBe(false);
    expect(addUserInputToHistory).not.toHaveBeenCalled();
  });

  it("counts again from the person's next message", async () => {
    const history = [
      item("user", "write a.txt"),
      item("assistant", LEAK),
      item("user", LEAKED_CALL_NUDGE),
      item("assistant", "I could not write it."),
      item("user", "try again"),
      item("assistant", LEAK),
    ];
    expect(leakedCallNudgesThisTurn(history)).toBe(0);
    expect(await run(history)).toBe(true);
  });

  it("leaves alone a fenced example, an undeclared tool, plain prose and a Loop run", async () => {
    const user = item("user", "hi");
    const fenced = item("assistant", "Format:\n\n```xml\n" + LEAK + "\n```\n");
    expect(await run([user, fenced])).toBe(false);
    expect(
      await run([user, item("assistant", LEAK)], undefined, ["Read"]),
    ).toBe(false);
    expect(await run([user, item("assistant", "Done.")])).toBe(false);
    expect(
      await run([user, item("assistant", LEAK)], { current: { kind: "item" } }),
    ).toBe(false);
  });

  it("leaves alone a reply that made a structured call", async () => {
    const reply = item("assistant", LEAK, {
      toolCalls: [{ id: "1", type: "function", function: { name: "Write" } }],
    });
    expect(await run([item("user", "hi"), reply])).toBe(false);
  });
});
