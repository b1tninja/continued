import { describe, expect, it } from "vitest";

import { ChatMessage } from "../index.js";
import { newAgeingState } from "../util/contextAgeing";
import { compileChatMessages } from "./countTokens";

const body = (i: number) => `result ${i} ` + "word ".repeat(500);

function session(rounds: number): ChatMessage[] {
  const out: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "fix it" },
  ];
  for (let i = 0; i < rounds; i++) {
    out.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `t${i}`,
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    });
    out.push({ role: "tool", content: body(i), toolCallId: `t${i}` });
  }
  return out;
}

const base = (msgs: ChatMessage[]) => ({
  modelName: "gpt-4",
  msgs,
  knownContextLength: 32000,
  maxTokens: 1000,
  supportsImages: false,
});

describe("compileChatMessages with history ageing", () => {
  it("is byte-identical to the request without the option when ageing is off", () => {
    for (const rounds of [2, 20, 60]) {
      const msgs = session(rounds);
      const without = compileChatMessages(base(msgs));
      const off = compileChatMessages({ ...base(msgs), ageing: undefined });
      expect(JSON.stringify(off)).toBe(JSON.stringify(without));
      expect("didAge" in off).toBe(false);
    }
  });

  it("does not modify the caller's messages", () => {
    const msgs = session(40);
    const copy = JSON.stringify(msgs);
    compileChatMessages({
      ...base(msgs),
      ageing: { state: newAgeingState(), now: 0 },
    });
    expect(JSON.stringify(msgs)).toBe(copy);
  });

  it("masks old results on a cold cache and reports it, then holds the bytes while warm", () => {
    const state = newAgeingState();
    const first = compileChatMessages({
      ...base(session(40)),
      ageing: { state, now: 0 },
    });
    expect(first.didAge).toBe(true);
    const text = JSON.stringify(first.compiledChatMessages);
    expect(text).toContain("tool result masked");
    expect(text).toContain("recall_masked_result");
    const second = compileChatMessages({
      ...base(session(41)),
      ageing: { state, now: 20_000 },
    });
    expect("didAge" in second).toBe(false);
    expect(
      JSON.stringify(second.compiledChatMessages).startsWith(text.slice(0, -1)),
    ).toBe(true);
  });

  it("leaves a short conversation alone even when switched on", () => {
    const msgs = session(3);
    const on = compileChatMessages({
      ...base(msgs),
      ageing: { state: newAgeingState(), now: 0 },
    });
    expect(JSON.stringify(on)).toBe(
      JSON.stringify(compileChatMessages(base(msgs))),
    );
  });
});
