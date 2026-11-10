import { describe, expect, it } from "vitest";
import {
  PythonicRecovery,
  recoverPythonicCalls,
  recoverPythonicFromText,
  renderPythonicCall,
} from "./pythonic.js";
import type { DialectTool } from "./qwenXml.js";

const tools: DialectTool[] = [
  {
    name: "present_plan",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        decisions: { type: "array" },
        confirm: { type: "boolean" },
        budget: { type: "number" },
      },
      required: ["title"],
    },
  },
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  { name: "list_tasks", parameters: { type: "object", properties: {} } },
];

// Golden cases are written from the form the bench logged for Nova 2 Lite
// (plans/tool-call-styles.md, H13: `present_plan(title=..., decisions=[...])`)
// and from Python's literal syntax. They are not captured model output.
const golden: {
  name: string;
  text: string;
  text_after: string;
  calls: { name: string; arguments: Record<string, unknown> }[];
}[] = [
  {
    name: "the logged form",
    text: 'present_plan(title="Rename the helper", decisions=[{"question": "Keep the old name?", "options": ["yes", "no"]}])',
    text_after: "",
    calls: [
      {
        name: "present_plan",
        arguments: {
          title: "Rename the helper",
          decisions: [
            { question: "Keep the old name?", options: ["yes", "no"] },
          ],
        },
      },
    ],
  },
  {
    name: "Python literals: True, None, single quotes, a tuple, a float",
    text: "present_plan(title='It\\'s a plan', decisions=(1, 2.5, None), confirm=True, budget=1e3)",
    text_after: "",
    calls: [
      {
        name: "present_plan",
        arguments: {
          title: "It's a plan",
          decisions: [1, 2.5, null],
          confirm: true,
          budget: 1000,
        },
      },
    ],
  },
  {
    name: "arguments over several lines with a trailing comma",
    text: 'present_plan(\n    title="Plan",\n    decisions=[\n        {"q": "a"},\n    ],\n)',
    text_after: "",
    calls: [
      {
        name: "present_plan",
        arguments: { title: "Plan", decisions: [{ q: "a" }] },
      },
    ],
  },
  {
    name: "prose on an earlier line, then the call",
    text: 'Here is the plan.\n\npresent_plan(title="x")\n',
    text_after: "Here is the plan.\n\n",
    calls: [{ name: "present_plan", arguments: { title: "x" } }],
  },
  {
    name: "two calls",
    text: 'read_file(path="a.ts")\nread_file(path="b.ts", limit=20)',
    text_after: "",
    calls: [
      { name: "read_file", arguments: { path: "a.ts" } },
      { name: "read_file", arguments: { path: "b.ts", limit: 20 } },
    ],
  },
  {
    name: "a tool with no arguments",
    text: "list_tasks()",
    text_after: "",
    calls: [{ name: "list_tasks", arguments: {} }],
  },
];

const negatives: { name: string; text: string }[] = [
  {
    name: "prose that mentions a call mid-line",
    text: 'Call present_plan(title="x") when the plan is ready.',
  },
  {
    name: "a call inside a code fence (an example)",
    text: 'Example:\n\n```python\npresent_plan(title="x")\n```\n\nThat is all.',
  },
  {
    name: "a call followed by prose",
    text: 'present_plan(title="x")\nThat is how you call it.',
  },
  { name: "an indented call", text: '    present_plan(title="x")' },
  { name: "a tool that does not exist", text: 'delete_all(path="/")' },
  { name: "positional arguments", text: 'read_file("a.ts")' },
  {
    name: "an argument the schema does not declare",
    text: 'read_file(path="a", mode="rw")',
  },
  { name: "a missing required argument", text: "read_file(limit=3)" },
  {
    name: "an argument of the wrong type",
    text: 'read_file(path="a", limit="3")',
  },
  { name: "a repeated keyword", text: 'read_file(path="a", path="b")' },
  { name: "an unterminated call", text: 'present_plan(title="x", decisions=[' },
  { name: "an unterminated string", text: 'present_plan(title="x' },
  {
    name: "a call as a value",
    text: "read_file(path=os.getcwd())",
  },
  { name: "an expression as a value", text: 'read_file(path="a" + "b")' },
  { name: "an f-string", text: 'read_file(path=f"{x}.ts")' },
  {
    name: "an import smuggled into a value",
    text: "read_file(path=__import__('os').getcwd())",
  },
  { name: "a name as a value", text: "read_file(path=filename)" },
  { name: "a triple-quoted string", text: 'read_file(path="""a""")' },
  { name: "a set literal", text: 'present_plan(title="x", decisions={1, 2})' },
  {
    name: "a dict with a non-string key",
    text: 'present_plan(title="x", decisions={1: 2})',
  },
  {
    name: "a call in Qwen's XML form (not this dialect)",
    text: "<function=read_file><parameter=path>a</parameter></function>",
  },
  {
    name: "JSON naming a tool (not this dialect)",
    text: '{"name": "read_file", "arguments": {"path": "a"}}',
  },
  {
    name: "ordinary code that has a similar name",
    text: "present_plan_v2(title='x')",
  },
  {
    name: "nesting past the limit",
    text: `read_file(path=${"[".repeat(40)}${"]".repeat(40)})`,
  },
];

function runSplit(text: string, cuts: number[]) {
  const parser = new PythonicRecovery(tools);
  const events = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    events.push(...parser.push(text.slice(from, cut)));
    from = cut;
  }
  events.push(...parser.end());
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) =>
      e.type === "call"
        ? [{ name: e.call.name, arguments: e.call.arguments }]
        : [],
    ),
  };
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("pythonic recovery: golden cases", () => {
  for (const g of golden) {
    it(g.name, () => {
      const out = recoverPythonicFromText(g.text, tools);
      expect(
        out.calls.map((c) => ({ name: c.name, arguments: c.arguments })),
      ).toEqual(g.calls);
      expect(out.text).toBe(g.text_after);
    });
  }
});

describe("pythonic recovery: text that must stay text", () => {
  for (const n of negatives) {
    it(n.name, () => {
      const out = recoverPythonicFromText(n.text, tools);
      expect(out.calls).toEqual([]);
      expect(out.text).toBe(n.text);
    });
  }

  it("recoverPythonicCalls refuses a span that is not only calls", () => {
    expect(recoverPythonicCalls("hello", tools)).toBeUndefined();
    expect(recoverPythonicCalls("", tools)).toBeUndefined();
  });
});

describe("pythonic recovery: round trip", () => {
  const cases = [
    { name: "present_plan", arguments: { title: "t" } },
    {
      name: "present_plan",
      arguments: { title: 'quote " and \\ slash', decisions: [] },
    },
    {
      name: "present_plan",
      arguments: { title: "line\nbreak\ttab", confirm: false },
    },
    { name: "present_plan", arguments: { title: "ünïcödé — ✓", budget: 2.5 } },
    {
      name: "present_plan",
      arguments: {
        title: "nested",
        decisions: [
          { q: "a", options: ["x", "y"], meta: { n: null, ok: true } },
        ],
      },
    },
    { name: "read_file", arguments: { path: "src/a.ts", limit: 0 } },
    { name: "read_file", arguments: { path: "src/a.ts", limit: -4 } },
    { name: "list_tasks", arguments: {} },
  ];
  it.each(cases.map((c, i) => [i, c] as const))(
    "case %i parses back to what was rendered",
    (_i, c) => {
      const out = recoverPythonicFromText(renderPythonicCall(c), tools);
      expect(out.text).toBe("");
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0].name).toBe(c.name);
      expect(out.calls[0].arguments).toEqual(c.arguments);
    },
  );
});

describe("pythonic recovery: chunk boundaries do not change the result", () => {
  const all = [
    ...golden.map((g) => ({ name: g.name, text: g.text })),
    ...negatives,
  ];
  for (const c of all) {
    it(`${c.name}: every single cut, one character at a time, and 60 random splits`, () => {
      const whole = runSplit(c.text, []);
      for (let cut = 1; cut < c.text.length; cut++) {
        expect(runSplit(c.text, [cut])).toEqual(whole);
      }
      const chars = Array.from({ length: c.text.length - 1 }, (_, i) => i + 1);
      expect(runSplit(c.text, chars)).toEqual(whole);
      const next = rng(c.text.length * 7919 + 13);
      for (let k = 0; k < 60; k++) {
        expect(
          runSplit(
            c.text,
            chars.filter(() => next() < 0.15),
          ),
        ).toEqual(whole);
      }
    });
  }

  it("shows a line that starts like a call only once it cannot be one", () => {
    const parser = new PythonicRecovery(tools);
    const shown: string[] = [];
    for (const ch of "present_pl") {
      for (const e of parser.push(ch))
        if (e.type === "text") shown.push(e.text);
    }
    expect(shown.join("")).toBe(""); // could still be present_plan(
    for (const e of parser.push("us is not a call\n")) {
      if (e.type === "text") shown.push(e.text);
    }
    expect(shown.join("")).toBe("present_plus is not a call\n");
  });
});
