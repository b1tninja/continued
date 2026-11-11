import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCompletionChunk } from "openai/resources/index";
import { describe, expect, it } from "vitest";
import { recoverChatStream } from "./chatStream.js";
import { holdPhaseOf, RECOVERY_HOLD_FIELD } from "./holdSignal.js";
import { createTextToolRecovery, type HoldPhase } from "./recovery.js";

const tools = [
  {
    name: "Read",
    parameters: { properties: { p: { type: "string" } }, required: ["p"] },
  },
];
const call = (name = "Read") =>
  `<function=${name}>\n<parameter=p>\nx\n</parameter>\n</function>`;
const ask = { x_continue_recover_text_tool_calls: "force:qwen-xml" };

function stage() {
  const s = createTextToolRecovery("m", tools, ask, {});
  expect(s).toBeDefined();
  return s!;
}

/** Feeds `pieces`, polling the signal after every push and after the end. */
function phases(pieces: string[]): HoldPhase[] {
  const s = stage();
  const out: HoldPhase[] = [];
  const poll = () => {
    const p = s.takeHoldSignal?.();
    if (p) out.push(p);
  };
  for (const piece of pieces) {
    s.push(piece);
    poll();
  }
  s.end();
  poll();
  return out;
}

const chars = (text: string) => [...text];

describe("the hold signal of a recovery stage", () => {
  it("is start then end, once each, when the held reply becomes a call", () => {
    expect(phases(chars(call()))).toEqual(["start", "end"]);
  });

  it("is start then end, once each, when the held reply is released as text", () => {
    expect(phases(chars(`${call()} and then some prose`))).toEqual([
      "start",
      "end",
    ]);
  });

  it("is start then end, once each, when a call is refused (an unknown tool)", () => {
    expect(phases(chars(call("Delete")))).toEqual(["start", "end"]);
  });

  it("is the same whatever the chunking", () => {
    expect(phases([call()])).toEqual(["start", "end"]);
    expect(phases(call().match(/[^]{1,7}/g) ?? [])).toEqual(["start", "end"]);
  });

  it("says nothing for a reply that is never held", () => {
    expect(phases(["Hello", " there, ", "no call here"])).toEqual([]);
    expect(phases([])).toEqual([]);
  });

  it("says nothing before the reply is known to be a call", () => {
    // "<fun" could still be a call, but nothing is held until it is one
    expect(phases(["Look at <fun"])).toEqual([]);
  });

  it("gives a pair for each held reply when the stage is used again", () => {
    const s = stage();
    const out: HoldPhase[] = [];
    for (let i = 0; i < 2; i++) {
      for (const c of call()) {
        s.push(c);
        const p = s.takeHoldSignal?.();
        if (p) out.push(p);
      }
      s.end();
      const p = s.takeHoldSignal?.();
      if (p) out.push(p);
    }
    expect(out).toEqual(["start", "end", "start", "end"]);
  });

  it("is taken once: asking again returns nothing", () => {
    const s = stage();
    s.push(call());
    expect(s.takeHoldSignal?.()).toBe("start");
    expect(s.takeHoldSignal?.()).toBeUndefined();
  });
});

const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
): ChatCompletionChunk =>
  ({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) as ChatCompletionChunk;

async function* from(chunks: ChatCompletionChunk[]) {
  for (const c of chunks) yield c;
}

async function streamed(pieces: string[]) {
  const chunks = [
    chunk({ role: "assistant", content: "" }),
    ...pieces.map((p) => chunk({ content: p })),
    chunk({}, "stop"),
  ];
  const out: ChatCompletionChunk[] = [];
  for await (const c of recoverChatStream(from(chunks), stage())) out.push(c);
  return out;
}

const holdsOf = (chunks: ChatCompletionChunk[]) =>
  chunks.flatMap((c) => holdPhaseOf(c) ?? []);

describe("the OpenAI-compatible stream", () => {
  it.each([
    ["recovered as a call", chars(call())],
    ["released as text", chars(`${call()} and prose`)],
    ["refused", chars(call("Delete"))],
  ])(
    "carries one start and one end chunk for a reply %s",
    async (_n, pieces) => {
      const out = await streamed(pieces);
      expect(holdsOf(out)).toEqual(["start", "end"]);
      // the end comes after the start, and neither carries any reply text
      const holds = out.filter((c) => holdPhaseOf(c));
      for (const h of holds) {
        expect(h.choices[0].delta).toEqual({});
        expect(h.choices[0].finish_reason).toBeNull();
      }
    },
  );

  it("carries none for a reply that is not held", async () => {
    const out = await streamed(["Hello", " world"]);
    expect(holdsOf(out)).toEqual([]);
    expect(out.some((c) => RECOVERY_HOLD_FIELD in c)).toBe(false);
  });

  it("clears the hold before the recovered call arrives", async () => {
    const out = await streamed(chars(call()));
    const end = out.findIndex((c) => holdPhaseOf(c) === "end");
    const callAt = out.findIndex((c) => c.choices[0]?.delta?.tool_calls);
    expect(end).toBeGreaterThan(-1);
    expect(end).toBeLessThan(callAt);
  });
});

describe("the field name", () => {
  it("is the one core and the CLI read", () => {
    const root = path.resolve(__dirname, "../../../..");
    for (const file of [
      "core/llm/openaiTypeConverters.ts",
      "extensions/cli/src/stream/streamChatResponse.helpers.ts",
    ]) {
      const p = path.join(root, file);
      if (!fs.existsSync(p)) continue; // a packed install
      expect(fs.readFileSync(p, "utf8"), file).toContain(
        `"${RECOVERY_HOLD_FIELD}"`,
      );
    }
  });
});
