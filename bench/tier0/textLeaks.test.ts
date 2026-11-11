import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";

import {
  isTextLeak,
  leakForm,
  parseDialectOption,
  RECOVERY_DIALECTS,
  textLeakForms,
  textLeaks,
} from "../src/common.mjs";

/**
 * The bench's `textLeaks` column (plans/ROADMAP.md H13): replies that wrote a
 * tool call as text instead of making it. Qwen's markup and JSON were seen
 * from the start; Nova 2 Lite's Python-syntax `present_plan(...)` is the form
 * this file added. The samples are written from the logged shapes, not
 * captured output.
 *
 * Run from extensions/cli: npx vitest run --dir ../../bench/tier0
 */
const reply = (text: string) => ({
  message: { role: "assistant", content: text },
});

describe("isTextLeak", () => {
  it.each([
    ["Qwen markup", "<tool_call><function=Write></function></tool_call>"],
    [
      "Qwen one-line markup",
      "<function=present_plan><parameter=title>x</parameter></function>",
    ],
    ["JSON naming a tool", '{"name": "Read", "arguments": {"filepath": "a"}}'],
    [
      "Nova's Python form",
      'present_plan(title="Rename", decisions=[{"q": "a"}])',
    ],
    ["a CamelCase Python call", 'PresentPlan(title="x")'],
    [
      "a Python call after prose",
      'Here is the plan.\n\npresent_plan(title="x")',
    ],
    [
      "a call with the arguments on later lines",
      "FinishItem(\n  summary='done',\n)",
    ],
    ["an IDE tool name", 'read_file(filepath="a.ts")'],
    ["positional arguments", 'present_plan("x")'],
    [
      "GLM tags",
      "<tool_call>Read<arg_key>filepath</arg_key><arg_value>a</arg_value></tool_call>",
    ],
    [
      "Llama JSON naming a tool the old pattern did not know",
      '{"type": "function", "name": "run_command", "parameters": {"command": "ls"}}',
    ],
    ["DeepSeek DSML", "<｜DSML｜function_calls>"],
  ])("sees %s", (_name, text) => {
    expect(isTextLeak(text)).toBe(true);
  });

  it.each([
    ["plain prose", "I read the file and found two helpers."],
    ["a call mid-line in prose", 'Call present_plan(title="x") when ready.'],
    [
      "a call in a code fence",
      'Example:\n```python\npresent_plan(title="x")\n```\nDone.',
    ],
    [
      "an unterminated fence still hides its call",
      'Example:\n```python\npresent_plan(title="x")',
    ],
    ["an indented call", '    present_plan(title="x")'],
    ["a different function", 'print(value="x")'],
    ["a longer name", 'present_plan_v2(title="x")'],
    ["the tool name without a call", "I will use PresentPlan next."],
  ])("does not see %s", (_name, text) => {
    expect(isTextLeak(text)).toBe(false);
  });
});

describe("leakForm", () => {
  it.each([
    ["qwen-xml", "<function=Read><parameter=filepath>a</parameter></function>"],
    ["pythonic", 'present_plan(title="x")'],
    ["llama-json", '{"name": "Read", "parameters": {"filepath": "a"}}'],
    ["hermes-json", '{"name": "Read", "arguments": {"filepath": "a"}}'],
    [
      "glm-xml",
      "<tool_call>Read<arg_key>k</arg_key><arg_value>a</arg_value></tool_call>",
    ],
  ])("names the form %s as the detector does", (form, text) => {
    expect(leakForm(text)).toBe(form);
  });

  it("is undefined for prose, and for markup that is only quoted", () => {
    expect(leakForm("All done.")).toBeUndefined();
    expect(leakForm("Use `<function=Read>` to read.")).toBeUndefined();
  });

  it("finds a call that follows a sentence", () => {
    expect(leakForm('Here is the plan.\n\npresent_plan(title="x")')).toBe(
      "pythonic",
    );
  });

  it("trusts a call expression only for a tool that was offered", () => {
    expect(leakForm('lookup(key="x")')).toBeUndefined();
    expect(leakForm('lookup(key="x")', ["lookup"])).toBe("pythonic");
  });
});

describe("textLeakForms", () => {
  it("lists the form of every leaked reply, and counts tools the run called as offered", () => {
    const history = [
      reply("Looking at it."),
      reply('{"name": "Read", "parameters": {"filepath": "a"}}'),
      { message: { role: "assistant", content: 'lookup(key="x")' } },
      {
        message: { role: "assistant", content: "" },
        toolCallStates: [{ toolCall: { function: { name: "lookup" } } }],
      },
    ];
    expect(textLeakForms(history)).toEqual(["llama-json", "pythonic"]);
  });
});

describe("--dialect", () => {
  it("accepts off and every recovery dialect, alone or in a list", () => {
    expect(parseDialectOption("off")).toBe("off");
    for (const d of RECOVERY_DIALECTS) {
      expect(parseDialectOption(d)).toBe(d);
      expect(parseDialectOption(`force:${d}`)).toBe(`force:${d}`);
    }
    expect(parseDialectOption("llama-json, qwen-xml")).toBe(
      "llama-json,qwen-xml",
    );
  });

  it.each(["", "xml", "qwen-xml,", "auto", "native", "off,qwen-xml"])(
    "refuses %j",
    (v) => {
      expect(() => parseDialectOption(v)).toThrow(/--dialect must be/);
    },
  );

  it("lists exactly the dialects the toolDialect config accepts", () => {
    // packages/config-yaml/src/schemas/models.ts: besides these, auto, native and off
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../packages/config-yaml/src/schemas/models.ts",
      ),
      "utf-8",
    );
    const block = /TOOL_DIALECT_VALUES = \[([^\]]*)\]/.exec(source);
    const values = [...(block?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    );
    expect(values.length).toBeGreaterThan(5);
    expect(
      values.filter((v) => !["auto", "native", "off"].includes(v)),
    ).toEqual(RECOVERY_DIALECTS);
  });
});

describe("textLeaks", () => {
  it("counts assistant replies only, and keeps the first 200 characters", () => {
    const long = `present_plan(title="${"x".repeat(300)}")`;
    const history = [
      {
        message: {
          role: "user",
          content: 'present_plan(title="from the user")',
        },
      },
      reply("Looking at it."),
      reply(long),
      reply("<function=Read><parameter=filepath>a</parameter></function>"),
    ];
    const leaks = textLeaks(history);
    expect(leaks).toHaveLength(2);
    expect(leaks[0]).toHaveLength(200);
    expect(textLeaks(undefined)).toEqual([]);
  });
});
