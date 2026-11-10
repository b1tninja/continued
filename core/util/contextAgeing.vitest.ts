import { describe, expect, it } from "vitest";
import type { ChatMessage } from "..";
import {
  AGEING_KEEP_RECENT_TOOL_RESULTS,
  AGEING_METADATA_KEY,
  AGEING_MIN_RESULT_CHARS,
  AGEING_PROTECTED_TOOLS,
  isMaskedToolResult,
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
      `[tool result masked: read_file, ${first.originalChars} chars, recall ${first.handle}]`,
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
