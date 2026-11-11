import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCompletionChunk } from "openai/resources/index";
import { describe, expect, it } from "vitest";
import { recoverChatCompletion, recoverChatStream } from "./chatStream.js";
import { createTextToolRecovery, recoverFromText } from "./recovery.js";

const DIALECTS = [
  "qwen-xml",
  "pythonic",
  "llama-json",
  "hermes-json",
  "glm-xml",
];
const FIXTURES = path.resolve(
  __dirname,
  "../../../../core/llm/toolDialects/corpus/fixtures",
);
const MODEL = "some-local-model";

interface Fixture {
  id: string;
  dialect: string;
  kind: string;
  tools: { name: string; parameters: unknown }[];
  streams: { encoding: string; chunks: string[] }[];
  expected: { calls: { name: string; arguments: unknown }[] };
}

const fixtures: Fixture[] = fs.existsSync(FIXTURES)
  ? fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")))
  : [];

function chunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
): ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as ChatCompletionChunk;
}

function textChunks(pieces: string[]): ChatCompletionChunk[] {
  return [
    chunk({ role: "assistant", content: "" }),
    ...pieces.map((p) => chunk({ content: p })),
    chunk({}, "stop"),
  ];
}

async function* from(chunks: ChatCompletionChunk[]) {
  for (const c of chunks) yield c;
}

async function run(
  chunks: ChatCompletionChunk[],
  tools: Fixture["tools"],
  setting = "force:qwen-xml",
) {
  const stage = createTextToolRecovery(MODEL, tools, {
    x_continue_recover_text_tool_calls: setting,
  });
  expect(stage).toBeDefined();
  const out: ChatCompletionChunk[] = [];
  for await (const c of recoverChatStream(from(chunks), stage!)) out.push(c);
  const text = out.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  const calls = out.flatMap((c) =>
    (c.choices[0]?.delta?.tool_calls ?? []).map((t) => ({
      name: t.function?.name,
      arguments: JSON.parse(t.function?.arguments ?? "{}"),
    })),
  );
  const finish = out.map((c) => c.choices[0]?.finish_reason).filter(Boolean);
  return { out, text, calls, finish };
}

describe("chat stream recovery against the corpus", () => {
  it("has the corpus to run", () => {
    // Skipped silently when the repository layout is not there (a packed install).
    if (fixtures.length > 0) expect(fixtures.length).toBeGreaterThan(50);
  });

  for (const dialect of DIALECTS) {
    it(`${dialect}: the stream gives what the whole reply gives, in every chunking`, async () => {
      const own = fixtures.filter((f) => f.dialect === dialect);
      const negatives = fixtures.filter(
        (f) => f.kind === "negative" && f.dialect !== dialect,
      );
      for (const f of [...own, ...negatives]) {
        for (const s of f.streams) {
          if (s.encoding !== "utf8") continue;
          const text = s.chunks.join("");
          const whole = recoverFromText(
            MODEL,
            text,
            f.tools,
            { x_continue_recover_text_tool_calls: `force:${dialect}` },
            {},
          );
          const got = await run(
            textChunks(s.chunks),
            f.tools,
            `force:${dialect}`,
          );
          expect(got.text, `${f.id} text`).toBe(whole.text);
          expect(
            got.calls.map((c) => c.name),
            `${f.id} calls`,
          ).toEqual(whole.calls.map((c) => c.name));
          expect(got.calls.map((c) => c.arguments)).toEqual(
            whole.calls.map((c) => c.arguments),
          );
          if (whole.calls.length > 0)
            expect(got.finish).toEqual(["tool_calls"]);
          else expect(got.finish).toEqual(["stop"]);
        }
      }
    });
  }

  it("recovers the expected calls of a canonical qwen-xml fixture", async () => {
    const f = fixtures.find((x) => x.id === "qwen3-coder-canonical");
    if (!f) return;
    const got = await run(textChunks(f.streams.at(-1)!.chunks), f.tools);
    expect(got.calls).toEqual(f.expected.calls);
    expect(got.text.trim()).toBe("");
  });
});

describe("chat stream recovery behaviour", () => {
  const tools = [
    {
      name: "Read",
      parameters: {
        type: "object",
        properties: { p: { type: "string" } },
        required: ["p"],
      },
    },
  ];
  const call = "<function=Read>\n<parameter=p>\nx\n</parameter>\n</function>";

  it("keeps the usage chunk and puts calls before the finish", async () => {
    const usage = {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    } as unknown as ChatCompletionChunk;
    const got = await run(
      [...textChunks([call.slice(0, 9), call.slice(9)]), usage],
      tools,
    );
    expect(got.calls).toEqual([{ name: "Read", arguments: { p: "x" } }]);
    expect(got.out.at(-1)).toBe(usage);
    const kinds = got.out.map((c) =>
      c.choices[0]?.delta?.tool_calls
        ? "call"
        : (c.choices[0]?.finish_reason ?? "-"),
    );
    expect(kinds.indexOf("call")).toBeLessThan(kinds.indexOf("tool_calls"));
  });

  it("makes no call when the server made its own", async () => {
    const own = chunk({
      tool_calls: [
        {
          index: 0,
          id: "a",
          type: "function",
          function: { name: "Read", arguments: "{}" },
        },
      ],
    });
    const got = await run(
      [
        chunk({ role: "assistant" }),
        own,
        chunk({ content: call }),
        chunk({}, "tool_calls"),
      ],
      tools,
    );
    expect(got.calls).toHaveLength(1);
    // As in the Bedrock handlers, the span that parsed as a call is not shown.
    expect(got.text).toBe("");
  });

  it("leaves ordinary text and reasoning alone, in order", async () => {
    const got = await run(
      [
        chunk({ reasoning_content: "hmm" }),
        chunk({ content: "Hello " }),
        chunk({ content: "world" }),
        chunk({}, "stop"),
      ],
      tools,
    );
    expect(got.text).toBe("Hello world");
    expect(got.out[0].choices[0].delta).toEqual({ reasoning_content: "hmm" });
    expect(got.calls).toEqual([]);
  });

  it("keeps a call that is not whole as text", async () => {
    const got = await run(textChunks([call.slice(0, -12)]), tools);
    expect(got.calls).toEqual([]);
    expect(got.text).toBe(call.slice(0, -12));
  });

  it("is off without a setting and without tools", () => {
    expect(createTextToolRecovery(MODEL, tools, {}, {})).toBeUndefined();
  });

  it("recovers a whole reply, once, only without calls of its own", () => {
    const completion = (extra: object) =>
      ({
        id: "x",
        model: MODEL,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: call, ...extra },
          },
        ],
      }) as never;
    const ask = { x_continue_recover_text_tool_calls: "force:qwen-xml" };
    const r = recoverChatCompletion(completion({}), tools, ask, {});
    expect(r.choices[0].finish_reason).toBe("tool_calls");
    expect(r.choices[0].message.tool_calls).toHaveLength(1);
    expect(r.choices[0].message.content).toBeNull();
    const own = recoverChatCompletion(
      completion({ tool_calls: [{ id: "a" }] }),
      tools,
      ask,
      {},
    );
    expect(own.choices[0].finish_reason).toBe("stop");
  });
});
