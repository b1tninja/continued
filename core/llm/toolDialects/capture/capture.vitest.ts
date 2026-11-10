import { describe, expect, it } from "vitest";

import { validateFixture } from "../corpus/corpus";
import { classifyReply } from "./classify";
import {
  bedrockInput,
  collectChatStream,
  collectConverseStream,
  createOpenAiClient,
  openAiBody,
  parseChatCompletion,
  parseConverse,
  type CaptureClient,
  type CaptureRequest,
} from "./clients";
import { buildFixture, fixtureId, type RawReply } from "./fixture";
import { buildPlan, formatPlan, parseModelSpec } from "./plan";
import { formatReport, runCapture } from "./run";
import { formatRate, wilson } from "./stats";
import {
  CAPTURE_PROMPTS,
  realAgentTools,
  toWireTools,
  type WireTool,
} from "./tools";

const tools: WireTool[] = [
  {
    name: "read_file",
    description: "read",
    parameters: {
      type: "object",
      properties: { filepath: { type: "string" } },
      required: ["filepath"],
    },
  },
  {
    name: "run_terminal_command",
    description: "run",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "integer" } },
      required: ["command"],
    },
  },
];

describe("wilson", () => {
  it("matches hand-computed intervals", () => {
    const a = wilson(1, 8);
    expect(a.lo).toBeCloseTo(0.0224, 3);
    expect(a.hi).toBeCloseTo(0.4708, 3);
    const b = wilson(2, 8);
    expect(b.lo).toBeCloseTo(0.0711, 3);
    expect(b.hi).toBeCloseTo(0.5908, 3);
  });
  it("is not zero-width at the ends and stays in range", () => {
    const zero = wilson(0, 10);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0.25);
    const all = wilson(10, 10);
    expect(all.hi).toBeCloseTo(1, 10);
    expect(all.lo).toBeLessThan(0.75);
  });
  it("is the whole range for n = 0 and rejects bad input", () => {
    expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1 });
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(-1, 2)).toThrow(RangeError);
  });
  it("formats", () => {
    expect(formatRate(wilson(2, 8))).toBe("2/8 = 25% [7%, 59%]");
    expect(formatRate(wilson(0, 0))).toBe("0/0 = n/a");
  });
});

describe("plan", () => {
  const base = {
    models: [
      parseModelSpec("bedrock:us.meta.llama3-3-70b-instruct-v1:0"),
      parseModelSpec("openai:qwen3-coder:30b"),
    ],
    prompts: CAPTURE_PROMPTS,
    tools,
    passes: 3,
    temperatures: ["default", 0] as ("default" | 0)[],
    streaming: [false, true],
    outputTokens: 300,
  };
  it("parses model specs, keeping colons in the id", () => {
    expect(parseModelSpec("openai:qwen3-coder:30b")).toEqual({
      transport: "openai",
      modelId: "qwen3-coder:30b",
    });
    expect(() => parseModelSpec("llama")).toThrow();
    expect(() => parseModelSpec("ollama:x")).toThrow();
  });
  it("counts calls as models x streaming x temperatures x passes x prompts", () => {
    const plan = buildPlan(base);
    expect(plan.cells).toHaveLength(2 * 2 * 2 * 3 * CAPTURE_PROMPTS.length);
    expect(plan.callsPerModel).toBe(2 * 2 * 3 * CAPTURE_PROMPTS.length);
    expect(plan.inputTokens).toBe(plan.perCallInputTokens * plan.cells.length);
    expect(plan.usd).toBeUndefined();
  });
  it("prices only when both prices are given", () => {
    const priced = { ...base, priceInPerM: 1, priceOutPerM: 2 };
    const plan = buildPlan(priced);
    const want = (plan.inputTokens * 1 + plan.outputTokens * 2) / 1e6;
    expect(plan.usd).toBeCloseTo(want, 8);
    expect(formatPlan(buildPlan(base), base)).toContain("unpriced");
    expect(formatPlan(plan, priced)).toContain("$");
  });
  it("rejects zero passes", () => {
    expect(() => buildPlan({ ...base, passes: 0 })).toThrow();
  });
});

describe("the real tool list", () => {
  it("comes from core, not a toy list", async () => {
    const names = toWireTools(await realAgentTools()).map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const n of ["read_file", "run_terminal_command", "present_plan"]) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("wire shapes", () => {
  const req: CaptureRequest = {
    model: "m",
    stream: true,
    temperature: "default",
    system: "s",
    prompt: "p",
    tools,
    maxTokens: 10,
  };
  it("leaves temperature out for default and sets it for 0", () => {
    expect(bedrockInput(req).inferenceConfig).toEqual({ maxTokens: 10 });
    expect(bedrockInput({ ...req, temperature: 0 }).inferenceConfig).toEqual({
      maxTokens: 10,
      temperature: 0,
    });
    expect(openAiBody(req)).not.toHaveProperty("temperature");
    expect(openAiBody({ ...req, temperature: 0 })).toHaveProperty(
      "temperature",
      0,
    );
  });
  it("sends every tool", () => {
    expect(bedrockInput(req).toolConfig.tools).toHaveLength(2);
    expect(openAiBody(req).tools).toHaveLength(2);
  });
  it("parses a Converse reply", () => {
    const r = parseConverse({
      output: {
        message: {
          content: [
            { text: "ok " },
            {
              toolUse: {
                toolUseId: "1",
                name: "read_file",
                input: { filepath: "a" },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    expect(r.text).toBe("ok ");
    expect(r.toolCalls).toEqual([
      { id: "1", name: "read_file", arguments: '{"filepath":"a"}' },
    ]);
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });
  it("folds ConverseStream events and keeps chunk boundaries", async () => {
    async function* events() {
      yield {
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: "he" } },
      };
      yield {
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: "llo" } },
      };
      yield {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t", name: "read_file" } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"filepath"' } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: ':"a"}' } },
        },
      };
      yield { messageStop: { stopReason: "tool_use" } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 2 } } };
    }
    const r = await collectConverseStream(events());
    expect(r.chunks).toEqual(["he", "llo"]);
    expect(r.text).toBe("hello");
    expect(r.toolCalls).toEqual([
      { id: "t", name: "read_file", arguments: '{"filepath":"a"}' },
    ]);
    expect(r.stopReason).toBe("tool_use");
  });
  it("parses chat completions, whole and streamed", async () => {
    const whole = parseChatCompletion({
      choices: [
        {
          message: {
            content: "x",
            tool_calls: [{ id: "c", function: { name: "n", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(whole.toolCalls).toHaveLength(1);
    async function* lines() {
      yield 'data: {"choices":[{"delta":{"content":"<tool"}}]}';
      yield "";
      yield 'data: {"choices":[{"delta":{"content":"_call>"}}]}';
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read_","arguments":"{\\"a\\""}}]}}]}';
      yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":":1}"}}]},"finish_reason":"tool_calls"}]}';
      yield "data: [DONE]";
    }
    const r = await collectChatStream(lines());
    expect(r.chunks).toEqual(["<tool", "_call>"]);
    expect(r.toolCalls).toEqual([
      { id: "c", name: "read_file", arguments: '{"a":1}' },
    ]);
    expect(r.stopReason).toBe("tool_calls");
  });
  it("posts to the base URL with a mocked fetch", async () => {
    let seen: { url: string; body: any; auth: string | undefined } | undefined;
    const fetchImpl = (async (url: string, init: any) => {
      seen = {
        url,
        body: JSON.parse(init.body),
        auth: init.headers.authorization,
      };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        }),
      };
    }) as unknown as typeof fetch;
    const client = createOpenAiClient({
      baseUrl: "http://h/v1/",
      apiKey: "k",
      fetchImpl,
    });
    const r = await client.send({ ...req, stream: false, temperature: 0 });
    expect(r.text).toBe("hi");
    expect(seen?.url).toBe("http://h/v1/chat/completions");
    expect(seen?.auth).toBe("Bearer k");
    expect(seen?.body.temperature).toBe(0);
  });
});

describe("classification", () => {
  const known = ["read_file"];
  const qwen =
    "<tool_call><function=read_file><parameter=filepath>a</parameter></function></tool_call>";
  it("separates structured, leak, refused and error", () => {
    const call = [{ name: "read_file", arguments: "{}" }];
    expect(
      classifyReply({ text: "", toolCalls: call, knownTools: known }).outcome,
    ).toBe("structured");
    expect(
      classifyReply({ text: qwen, toolCalls: [], knownTools: known }),
    ).toEqual({ outcome: "leak", dialect: "qwen-xml" });
    expect(
      classifyReply({
        text: "I cannot do that.",
        toolCalls: [],
        knownTools: known,
      }).outcome,
    ).toBe("refused");
    expect(
      classifyReply({ text: "", toolCalls: [], knownTools: known, error: "x" })
        .outcome,
    ).toBe("error");
  });
  it("does not count markup inside a code fence", () => {
    const text = "Use:\n```\n" + qwen + "\n```";
    expect(
      classifyReply({ text, toolCalls: [], knownTools: known }).outcome,
    ).toBe("refused");
  });
});

describe("fixture writer", () => {
  const leakText =
    "<tool_call><function=read_file><parameter=filepath>café.ts</parameter></function></tool_call>";
  const ctx = (streamed: boolean, text: string) => ({
    id: "live-x",
    model: "us.meta.llama3-3-70b-instruct-v1:0",
    transport: "bedrock" as const,
    date: "2026-11-10",
    streamed,
    temperature: 0 as const,
    tools,
    classified: classifyReply({
      text,
      toolCalls: [],
      knownTools: ["read_file"],
    }),
  });
  it("writes a fixture the corpus validator accepts, with the observed chunks", () => {
    const chunks = [leakText.slice(0, 10), leakText.slice(10)];
    const reply: RawReply = {
      text: leakText,
      toolCalls: [],
      chunks,
      stopReason: "end_turn",
    };
    const f = buildFixture(reply, ctx(true, leakText))!;
    expect(validateFixture(f)).toEqual([]);
    expect(f.flag).toBe("observed");
    expect(f.dialect).toBe("qwen-xml");
    expect(f.streams.map((s) => s.label)).toEqual([
      "whole",
      "char",
      "inside-multibyte-char",
      "observed",
    ]);
  });
  it("omits observed chunks when not streamed; skips empty text and errors", () => {
    const reply: RawReply = {
      text: "plain answer",
      toolCalls: [],
      chunks: ["plain answer"],
    };
    const f = buildFixture(reply, ctx(false, "plain answer"))!;
    expect(validateFixture(f)).toEqual([]);
    expect(f.streams.map((s) => s.label)).toEqual(["whole", "char"]);
    expect(
      buildFixture({ text: "", toolCalls: [] }, ctx(false, "")),
    ).toBeUndefined();
    const errored = {
      ...ctx(false, "x"),
      classified: { outcome: "error" as const, dialect: "none" },
    };
    expect(
      buildFixture({ text: "x", toolCalls: [], error: "e" }, errored),
    ).toBeUndefined();
  });
  it("builds stable ids", () => {
    expect(
      fixtureId({
        model: "Qwen3-Coder:30B",
        transport: "openai",
        streamed: true,
        temperature: "default",
        pass: 2,
        promptId: "read",
      }),
    ).toBe("live-qwen3-coder-30b-openai-stream-tdefault-p2-read");
  });
});

describe("runCapture with a mocked client", () => {
  it("writes raw records and fixtures, tallies outcomes, survives errors", async () => {
    const files = new Map<string, string>();
    let n = 0;
    const replies: (RawReply | Error)[] = [
      { text: "", toolCalls: [{ name: "read_file", arguments: "{}" }] },
      {
        text: '{"name": "read_file", "parameters": {"filepath": "a"}}',
        toolCalls: [],
      },
      { text: "No.", toolCalls: [] },
      new Error("throttled"),
    ];
    const client: CaptureClient = {
      async send() {
        const r = replies[n++];
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const plan = buildPlan({
      models: [parseModelSpec("bedrock:m1")],
      prompts: CAPTURE_PROMPTS.slice(0, 4),
      tools,
      passes: 1,
      temperatures: [0],
      streaming: [false],
      outputTokens: 10,
    });
    const tallies = await runCapture(
      plan.cells,
      { tools },
      {
        clientFor: () => client,
        writer: { write: (p, c) => void files.set(p, c) },
        date: "2026-11-10",
        maxTokens: 10,
      },
    );
    expect(n).toBe(4);
    expect(tallies).toHaveLength(1);
    expect(tallies[0].counts).toEqual({
      structured: 1,
      leak: 1,
      refused: 1,
      error: 1,
    });
    const keys = [...files.keys()];
    expect(keys.filter((k) => k.startsWith("raw/"))).toHaveLength(4);
    const fixtures = keys.filter((k) => k.startsWith("fixtures/"));
    expect(fixtures).toHaveLength(2);
    for (const k of fixtures) {
      expect(validateFixture(JSON.parse(files.get(k)!))).toEqual([]);
    }
    const report = formatReport(tallies);
    expect(report).toContain("leak       1/3 = 33%");
    expect(report).toContain("errors     1");
  });
});

describe("cli", () => {
  it("plans without calling anything unless --run is given", async () => {
    const { parseCli, main } = await import("./cli");
    expect(parseCli(["--model", "openai:x"], tools).run).toBe(false);
    expect(parseCli(["--model", "openai:x", "--run"], tools).run).toBe(true);
    expect(parseCli(["--model", "openai:x"], tools)).toMatchObject({
      passes: 3,
      temperatures: ["default", 0],
      streaming: [false, true],
    });
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const code = await main(["--model", "openai:x"]);
      expect(code).toBe(0);
    } finally {
      console.log = orig;
    }
    const out = lines.join("\n");
    expect(out).toContain("Cost plan");
    expect(out).toContain("Dry run");
  });
});
