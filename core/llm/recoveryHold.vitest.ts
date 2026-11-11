import { describe, expect, it } from "vitest";
import {
  messagesFromChatCompletionChunk,
  RECOVERY_HOLD_FIELD,
} from "./openaiTypeConverters";

/**
 * The adapters' recovery stage marks the empty chunk that says a reply is held
 * with a field of its own; core turns it into a message that only carries
 * `recoveryHold`, as it does for a local server's prompt progress.
 */
const holdChunk = (phase: string) =>
  ({
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    [RECOVERY_HOLD_FIELD]: phase,
  }) as any;

describe("a held reply signal in the OpenAI-compatible stream", () => {
  it("becomes one empty assistant message with recoveryHold", () => {
    expect(messagesFromChatCompletionChunk(holdChunk("start"))).toEqual([
      { role: "assistant", content: "", recoveryHold: "start" },
    ]);
    expect(messagesFromChatCompletionChunk(holdChunk("end"))).toEqual([
      { role: "assistant", content: "", recoveryHold: "end" },
    ]);
  });

  it("ignores any other value, and a chunk without the field is unchanged", () => {
    expect(messagesFromChatCompletionChunk(holdChunk("later"))).toEqual([]);
    expect(
      messagesFromChatCompletionChunk({
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      } as any),
    ).toEqual([{ role: "assistant", content: "hi" }]);
  });

  it("uses the field name the adapters set", () => {
    expect(RECOVERY_HOLD_FIELD).toBe("x_continue_recovery_hold");
  });
});
