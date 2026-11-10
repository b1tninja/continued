import type { ChatHistoryItem, ToolStatus } from "core/index.js";
import { STUCK_NOTE_MARK } from "core/util/stuckNotes.js";
import { afterEach, describe, expect, it } from "vitest";

import { stuckNoteForHistory, stuckNotesEnabled } from "./stuckNotes.js";

function item(
  name: string,
  args: Record<string, unknown>,
  output: string,
  status: ToolStatus,
  id: string,
): ChatHistoryItem {
  return {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall: {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
        status,
        parsedArgs: args,
        output: [{ content: output, name: "Tool Result", description: "" }],
      },
    ],
  } as ChatHistoryItem;
}

const failing = (command: string, id: string) =>
  item("Bash", { command }, "Error: Cannot find module 'x'", "errored", id);

describe("stuckNoteForHistory", () => {
  afterEach(() => {
    delete process.env.CONTINUE_CLI_DISABLE_STUCK_NOTES;
  });

  const stuck = [
    failing("npm test --silent", "1"),
    failing("npm test --verbose", "2"),
  ];

  it("gives a note once a signal reaches note", () => {
    expect(stuckNoteForHistory(stuck.slice(0, 1))).toBeUndefined();
    expect(stuckNoteForHistory(stuck)).toContain("same error");
  });

  it("ignores a note already appended to a result", () => {
    const noted = stuck.map((h, i) => {
      const copy = structuredClone(h);
      copy.toolCallStates![0].output![0].content += `${STUCK_NOTE_MARK}old ${i}`;
      return copy;
    });
    expect(stuckNoteForHistory(noted)).toBe(stuckNoteForHistory(stuck));
  });

  it("is quiet for a healthy history", () => {
    const h = [
      item("Read", { path: "a.ts" }, "a", "done", "1"),
      item("Read", { path: "b.ts" }, "b", "done", "2"),
    ];
    expect(stuckNoteForHistory(h)).toBeUndefined();
  });

  it("can be turned off", () => {
    process.env.CONTINUE_CLI_DISABLE_STUCK_NOTES = "1";
    expect(stuckNotesEnabled()).toBe(false);
    expect(stuckNoteForHistory(stuck)).toBeUndefined();
  });
});
