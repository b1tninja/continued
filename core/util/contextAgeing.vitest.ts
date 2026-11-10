import { describe, expect, it } from "vitest";
import type { ChatMessage } from "..";
import {
  AGEING_CACHE_LIFETIME_MS,
  AGEING_ENV,
  AGEING_KEEP_RECENT_TOOL_RESULTS,
  AGEING_METADATA_KEY,
  AGEING_MIN_RESULT_CHARS,
  AGEING_PROTECTED_TOOLS,
  ageRequest,
  historyAgeingEnabled,
  isMaskedToolResult,
  newAgeingState,
  maskOldToolResults,
  recallHandle,
  unmaskToolResults,
} from "./contextAgeing";

const big = (n = 2000) => "y".repeat(n);

/** user, then n pairs of assistant call + tool result. */
function convo(n: number, tool = "read_file", chars = 2000): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "user", content: "task" }];
  for (let i = 0; i < n; i++) {
    out.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: tool, arguments: "{}" },
        },
      ],
    });
    out.push({ role: "tool", toolCallId: `c${i}`, content: big(chars) + i });
  }
  return out;
}

describe("maskOldToolResults", () => {
  it("masks all but the newest keepRecent results", () => {
    const input = convo(8);
    const out = maskOldToolResults(input);
    const tools = out.messages.filter((m) => m.role === "tool");
    expect(out.masked).toHaveLength(8 - AGEING_KEEP_RECENT_TOOL_RESULTS);
    expect(tools.filter(isMaskedToolResult)).toHaveLength(3);
    expect(isMaskedToolResult(tools[3])).toBe(false);
    expect(out.masked.map((m) => m.toolCallId)).toEqual(["c0", "c1", "c2"]);
    expect(out.masked[0].toolName).toBe("read_file");
  });

  it("does not modify its input", () => {
    const input = convo(8);
    const copy = JSON.parse(JSON.stringify(input));
    maskOldToolResults(input);
    expect(input).toEqual(copy);
  });

  it("keeps everything else identical", () => {
    const input = convo(8);
    const out = maskOldToolResults(input).messages;
    out.forEach((m, i) => {
      if (m.role !== "tool") expect(m).toBe(input[i]);
    });
    expect(out).toHaveLength(input.length);
  });

  it("writes a stub with tool, size and handle, and reports the body", () => {
    const input = convo(8);
    const out = maskOldToolResults(input);
    const first = out.masked[0];
    const stub = out.messages[first.index];
    expect(stub.role === "tool" && stub.content).toBe(
      `[tool result masked: read_file, ${first.originalChars} chars. Call recall_masked_result with handle ${first.handle} to read it again]`,
    );
    expect(first.original).toBe((input[first.index] as any).content);
    expect(first.handle).toBe(recallHandle("c0", first.original));
    expect(stub.role === "tool" && stub.metadata?.[AGEING_METADATA_KEY]).toBe(
      first.handle,
    );
    expect(out.freedChars).toBeGreaterThan(0);
    expect(out.freedTokensEstimate).toBe(Math.ceil(out.freedChars / 4));
  });

  it("is deterministic and idempotent", () => {
    const input = convo(9);
    const a = maskOldToolResults(input);
    const b = maskOldToolResults(input);
    expect(a.messages).toEqual(b.messages);
    const again = maskOldToolResults(a.messages);
    expect(again.messages).toEqual(a.messages);
    expect(again.masked).toHaveLength(0);
  });

  it("leaves small results, protected tools and vetoed results", () => {
    const small = maskOldToolResults(
      convo(8, "read_file", AGEING_MIN_RESULT_CHARS - 10),
    );
    expect(small.masked).toHaveLength(0);
    const prot = maskOldToolResults(convo(8, AGEING_PROTECTED_TOOLS[0]));
    expect(prot.masked).toHaveLength(0);
    const vetoed = maskOldToolResults(convo(8), {
      keep: (_m, tool) => tool === "read_file",
    });
    expect(vetoed.masked).toHaveLength(0);
  });

  it("honours keepRecent, including 0", () => {
    expect(maskOldToolResults(convo(4), { keepRecent: 0 }).masked).toHaveLength(
      4,
    );
    expect(
      maskOldToolResults(convo(4), { keepRecent: 10 }).masked,
    ).toHaveLength(0);
  });

  it("masks a result whose tool name is unknown", () => {
    const noCalls = convo(7).map((m) =>
      m.role === "assistant" ? { ...m, toolCalls: undefined } : m,
    ) as ChatMessage[];
    const out = maskOldToolResults(noCalls);
    expect(out.masked).toHaveLength(2);
    expect(out.masked[0].toolName).toBeUndefined();
    expect((out.messages[out.masked[0].index] as any).content).toContain(
      "unknown tool",
    );
  });
});

describe("unmaskToolResults", () => {
  it("restores bodies and drops the marker", () => {
    const input = convo(8);
    const out = maskOldToolResults(input);
    const store = new Map(out.masked.map((m) => [m.handle, m.original]));
    expect(unmaskToolResults(out.messages, store)).toEqual(input);
  });

  it("leaves a stub whose body is unknown", () => {
    const out = maskOldToolResults(convo(8));
    expect(unmaskToolResults(out.messages, new Map())).toEqual(out.messages);
  });
});

describe("recall", () => {
  it("the stub names the tool that the built-in list carries, and recall returns the body", async () => {
    const { BuiltInToolNames } = await import("../tools/builtIn");
    const { RECALL_TOOL_NAME, recallMasked, rememberMasked, clearRecallStore } =
      await import("./contextAgeing");
    expect(BuiltInToolNames.RecallMaskedResult).toBe(RECALL_TOOL_NAME);
    clearRecallStore();
    const out = maskOldToolResults(convo(8));
    rememberMasked(out.masked);
    const stub = out.messages[out.masked[0].index] as any;
    expect(stub.content).toContain(
      `Call ${RECALL_TOOL_NAME} with handle ${out.masked[0].handle}`,
    );
    expect(recallMasked(out.masked[0].handle)).toBe(out.masked[0].original);
    expect(recallMasked("mask-00000000")).toContain("No stored result");
  });

  it("drops the oldest bodies past the entry cap", async () => {
    const m = await import("./contextAgeing");
    m.clearRecallStore();
    const items = Array.from(
      { length: m.AGEING_STORE_MAX_ENTRIES + 3 },
      (_, i) => ({
        handle: `mask-${i}`,
        toolCallId: `c${i}`,
        toolName: "t",
        index: i,
        original: "b",
        originalChars: 1,
      }),
    );
    m.rememberMasked(items);
    expect(m.recallMasked("mask-0")).toContain("No stored result");
    expect(m.recallMasked(`mask-${items.length - 1}`)).toBe("b");
  });
});

describe("ageRequest", () => {
  const AVAILABLE = 40000; // tokens; convo(40) is about 20k tokens, past the 0.5 trigger
  const run = (
    msgs: ChatMessage[],
    state: any,
    now: number,
    available = AVAILABLE,
  ) => ageRequest(msgs, { state, availableTokens: available, now });

  it("does nothing below the trigger", () => {
    const state = newAgeingState();
    const out = run(convo(3), state, 0);
    expect(out.didAge).toBe(false);
    expect(out.messages).toEqual(convo(3));
  });

  it("ages on a cold cache, in steps, and not again while warm", () => {
    const state = newAgeingState();
    const first = run(convo(40), state, 0);
    expect(first.didAge).toBe(true);
    expect(state.maskedThrough).toBe(35);
    // one more tool round, cache warm: the same 35 stay masked, nothing new
    const second = run(convo(41), state, 30_000);
    expect(second.didAge).toBe(false);
    expect(second.masked).toHaveLength(35);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    // the cache expired: the next batch may move the floor
    const third = run(convo(46), state, 30_000 + AGEING_CACHE_LIFETIME_MS + 1);
    expect(third.didAge).toBe(true);
    expect(state.maskedThrough).toBe(40);
  });

  it("ages on a warm cache when the window is nearly full", () => {
    const state = newAgeingState();
    run(convo(40), state, 0, 1e9); // below trigger for a huge window: nothing, state warm
    const out = run(convo(40), state, 1000, 21000);
    expect(out.didAge).toBe(true);
  });

  it("resets for a different conversation", () => {
    const state = newAgeingState();
    run(convo(40), state, 0);
    const other: ChatMessage[] = [
      { role: "user", content: "another task" },
      ...convo(40).slice(1),
    ];
    const out = run(other, state, 1000);
    expect(out.didAge).toBe(true); // cold again: a new conversation has no cache
  });
});

describe("historyAgeingEnabled", () => {
  it("is off unless the variable says on", () => {
    expect(historyAgeingEnabled({})).toBe(false);
    expect(historyAgeingEnabled({ [AGEING_ENV]: "0" })).toBe(false);
    expect(historyAgeingEnabled({ [AGEING_ENV]: "yes please" })).toBe(false);
    for (const v of ["1", "true", "ON"])
      expect(historyAgeingEnabled({ [AGEING_ENV]: v })).toBe(true);
  });
});
