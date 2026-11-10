import { describe, expect, it } from "vitest";

import { isTextLeak, textLeaks } from "../src/common.mjs";

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
    ["positional arguments (not the logged form)", 'present_plan("x")'],
    ["a different function", 'print(value="x")'],
    ["a longer name", 'present_plan_v2(title="x")'],
    ["the tool name without a call", "I will use PresentPlan next."],
  ])("does not see %s", (_name, text) => {
    expect(isTextLeak(text)).toBe(false);
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
