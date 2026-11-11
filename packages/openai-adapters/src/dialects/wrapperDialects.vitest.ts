import { describe, expect, it } from "vitest";
import { recoverFromText } from "./recovery.js";
import type { DialectTool, RecoveryEvent } from "./qwenXml.js";
import {
  recoverWrapped,
  recoverWrappedFromText,
  WRAPPER_ROWS,
  WrapperRecovery,
  wrapperRowFor,
} from "./wrapperDialects.js";

const tools: DialectTool[] = [
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
];
const call = { name: "read_file", arguments: { path: "a.txt", limit: 10 } };

/** One reply per row that is exactly `call`, written the way the family does. */
const REPLIES: Record<string, string> = {
  "granite-tokens":
    '<|tool_call|>[{"name": "read_file", "arguments": {"path": "a.txt", "limit": 10}}]',
  "lfm-tokens":
    "<|tool_call_start|>[read_file(path='a.txt', limit=10)]<|tool_call_end|>",
  "hy3-tags":
    "<tool_calls:opensource>\n<tool_call:opensource>read_file<tool_sep:opensource>\n<arg_key:opensource>path</arg_key:opensource>\n<arg_value:opensource>a.txt</arg_value:opensource>\n<arg_key:opensource>limit</arg_key:opensource>\n<arg_value:opensource>10</arg_value:opensource>\n</tool_call:opensource>\n</tool_calls:opensource>",
  "solar-tokens":
    '<|tool_calls|><|tool_call:begin|>a1b2c3d4e5<|tool_call:name|>read_file<|tool_call:args|>{"path": "a.txt", "limit": 10}<|tool_call:end|><|calls|>',
  "longcat-json":
    '<longcat_tool_call>\n{"name": "read_file", "arguments": {"path": "a.txt", "limit": 10}}\n</longcat_tool_call>',
  "olmo-function-calls":
    '<function_calls>read_file(path="a.txt", limit=10)</function_calls>',
  "seed-xml":
    "<seed:tool_call>\n<function=read_file>\n<parameter=path>a.txt</parameter>\n<parameter=limit>10</parameter>\n</function>\n</seed:tool_call>",
  "cohere-action":
    '<|START_ACTION|> [ {"tool_call_id": "0", "tool_name": "read_file", "parameters": {"path": "a.txt", "limit": 10}} ] <|END_ACTION|>',
};

describe("every wrapper row", () => {
  it("has a reply under test, a source comment's worth of markers and a name rule", () => {
    expect(WRAPPER_ROWS.map((r) => r.dialect).sort()).toEqual(
      Object.keys(REPLIES).sort(),
    );
    expect(new Set(WRAPPER_ROWS.map((r) => r.dialect)).size).toBe(
      WRAPPER_ROWS.length,
    );
  });

  for (const row of WRAPPER_ROWS) {
    const reply = REPLIES[row.dialect];

    it(`${row.dialect}: recovers its form whole, and nothing is left as text`, () => {
      const got = recoverWrappedFromText(row.dialect, reply, tools);
      expect(got.text).toBe("");
      expect(got.calls.map((c) => [c.name, c.arguments])).toEqual([
        [call.name, call.arguments],
      ]);
      expect(got.calls[0].raw.length).toBeGreaterThan(10);
    });

    it(`${row.dialect}: leaves prose, a fence, an unknown tool and a cut reply as text`, () => {
      const unknown = reply.replaceAll("read_file", "rm_rf");
      for (const text of [
        `Sure.\n${reply}`,
        `${reply}\nDone.`,
        "```\n" + reply + "\n```",
        unknown,
        reply.slice(0, reply.length - 8),
      ]) {
        const got = recoverWrappedFromText(row.dialect, text, tools);
        expect(got, text).toEqual({ text, calls: [] });
      }
    });

    it(`${row.dialect}: is chosen by a plain setting only for its own models`, () => {
      const own = row.nameRe.source.split("|")[0].replace(/[^a-z0-9]/gi, "");
      const body = { x_continue_recover_text_tool_calls: row.dialect };
      expect(
        recoverFromText(`vendor/${own}-model`, reply, tools, body, {}).calls,
      ).toHaveLength(1);
      expect(
        recoverFromText("some-other-model", reply, tools, body, {}).calls,
      ).toHaveLength(0);
      expect(
        recoverFromText(
          "some-other-model",
          reply,
          tools,
          { x_continue_recover_text_tool_calls: `force:${row.dialect}` },
          {},
        ).calls,
      ).toHaveLength(1);
    });
  }

  it("does not hold a <think> reply for a row with no think block of its own", () => {
    const row = wrapperRowFor("granite-tokens")!;
    expect(row.think).toBeUndefined();
    const text = "<think>hmm</think>\n" + REPLIES["granite-tokens"];
    expect(recoverWrapped(text, tools, row)).toBeUndefined();
  });
});

describe("framing", () => {
  it("keeps a leading think block as text, in the family's own markers", () => {
    const row = wrapperRowFor("seed-xml")!;
    const text = "<seed:think>plan</seed:think>\n\n" + REPLIES["seed-xml"];
    const got = recoverWrapped(text, tools, row)!;
    expect(got.lead).toBe("<seed:think>plan</seed:think>\n\n");
    expect(got.calls).toHaveLength(1);
    expect(
      recoverWrapped("<think>plan</think>\n" + REPLIES["seed-xml"], tools, row),
    ).toBeUndefined();
  });

  it("takes several blocks where the family writes one per call", () => {
    const one = REPLIES["longcat-json"];
    expect(
      recoverWrappedFromText("longcat-json", one + one, tools).calls,
    ).toHaveLength(2);
  });

  it("takes one block only where the family writes one", () => {
    const one = REPLIES["cohere-action"];
    expect(
      recoverWrappedFromText("cohere-action", one + one, tools).calls,
    ).toEqual([]);
  });

  it("reads a close marker inside a string value as the value's own", () => {
    const text =
      '<longcat_tool_call>\n{"name": "read_file", "arguments": {"path": "x</longcat_tool_call>y"}}\n</longcat_tool_call>';
    const got = recoverWrappedFromText("longcat-json", text, tools);
    expect(got.calls[0].arguments).toEqual({ path: "x</longcat_tool_call>y" });
  });

  it("makes the one repair every dialect makes: a string for an integer", () => {
    const text = REPLIES["granite-tokens"].replace(
      '"limit": 10',
      '"limit": "10"',
    );
    const got = recoverWrappedFromText("granite-tokens", text, tools);
    expect(got.calls[0].arguments.limit).toBe(10);
    expect(got.calls[0].repairs).toHaveLength(1);
  });

  it("accepts the Solar markers with or without the optional outer ones", () => {
    const bare = REPLIES["solar-tokens"]
      .replace("<|tool_calls|>", "")
      .replace("<|calls|>", "");
    expect(
      recoverWrappedFromText("solar-tokens", bare, tools).calls,
    ).toHaveLength(1);
    expect(
      recoverWrappedFromText(
        "solar-tokens",
        REPLIES["solar-tokens"] + "x",
        tools,
      ).calls,
    ).toEqual([]);
  });

  it("refuses an unknown dialect name", () => {
    expect(recoverWrappedFromText("nope", "x", tools)).toEqual({
      text: "x",
      calls: [],
    });
  });
});

describe("streaming", () => {
  it("gives the whole-reply result in every chunk size, and holds until the end", () => {
    for (const row of WRAPPER_ROWS) {
      const reply = REPLIES[row.dialect];
      for (const size of [1, 3, 7, 1000]) {
        const stage = new WrapperRecovery(tools, row);
        const events: RecoveryEvent[] = [];
        for (const piece of reply.match(new RegExp(`[^]{1,${size}}`, "g")) ??
          []) {
          events.push(...stage.push(piece));
        }
        expect(events, `${row.dialect} ${size} shown early`).toEqual([]);
        events.push(...stage.end());
        expect(
          events.map((e) => e.type),
          `${row.dialect} ${size}`,
        ).toEqual(["call"]);
      }
    }
  });

  it("releases text that cannot be a call at once", () => {
    const stage = new WrapperRecovery(tools, wrapperRowFor("lfm-tokens")!);
    expect(stage.push("Hello there")).toEqual([
      { type: "text", text: "Hello there" },
    ]);
  });
});
