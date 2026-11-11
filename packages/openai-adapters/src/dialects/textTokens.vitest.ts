import { describe, expect, it } from "vitest";
import {
  recoverDeepseekR1FromText,
  renderDeepseekR1Calls,
} from "./deepseekR1.js";
import {
  recoverDeepseekV31FromText,
  renderDeepseekV31Call,
} from "./deepseekV31.js";
import { DsmlRecovery, recoverDsmlFromText, renderDsmlCall } from "./dsml.js";
import { recoverHarmonyFromText, renderHarmonyCall } from "./harmony.js";
import { recoverMistralFromText, renderMistralCall } from "./mistral.js";
import { recoverPythonicFromText } from "./pythonic.js";
import { type DialectTool } from "./qwenXml.js";
import { createTextToolRecovery } from "./recovery.js";

const tools: DialectTool[] = [
  {
    name: "run_command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer" },
        env: { type: "object" },
        tags: { type: "array" },
        verbose: { type: "boolean" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

const call = {
  name: "run_command",
  arguments: {
    command: 'echo "a b" && ls',
    timeout: 10,
    env: { A: "1" },
    tags: ["x", "y"],
    verbose: true,
  },
};

/** Every chunking of `text` a client could see, whole to one character. */
function chunkings(text: string): string[][] {
  const chars = Array.from(text);
  const bySize = (n: number) =>
    Array.from({ length: Math.ceil(chars.length / n) }, (_, i) =>
      chars.slice(i * n, (i + 1) * n).join(""),
    );
  return [[text], bySize(1), bySize(3), bySize(7)];
}

const forms: [string, string, (t: string) => { text: string; calls: any[] }][] =
  [
    [
      "harmony",
      renderHarmonyCall(call),
      (t) => recoverHarmonyFromText(t, tools),
    ],
    [
      "mistral v11",
      renderMistralCall(call),
      (t) => recoverMistralFromText(t, tools),
    ],
    ["dsml", renderDsmlCall(call), (t) => recoverDsmlFromText(t, tools)],
    [
      "dsml v4",
      renderDsmlCall(call, "tool_calls"),
      (t) => recoverDsmlFromText(t, tools),
    ],
    [
      "deepseek-v31",
      renderDeepseekV31Call(call),
      (t) => recoverDeepseekV31FromText(t, tools),
    ],
    [
      "deepseek-r1",
      renderDeepseekR1Calls([call]),
      (t) => recoverDeepseekR1FromText(t, tools),
    ],
  ];

describe.each(forms)("%s round trip", (_name, text, recover) => {
  it("recovers every argument type, whole", () => {
    const out = recover(text);
    expect(out.text).toBe("");
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].name).toBe("run_command");
    expect(out.calls[0].arguments).toEqual(call.arguments);
    expect(out.calls[0].repairs).toBeUndefined();
  });

  it("recovers the same call under every chunking when streamed", () => {
    for (const chunks of chunkings(text)) {
      const stage = recoverStage(_name, chunks);
      expect(stage.text).toBe("");
      expect(stage.calls).toHaveLength(1);
    }
  });

  it("leaves the text alone when it is cut short", () => {
    for (const cut of [text.length - 1, Math.floor(text.length / 2), 5]) {
      const part = text.slice(0, cut);
      expect(recover(part)).toEqual({ text: part, calls: [] });
    }
  });

  it("leaves prose around the call as text", () => {
    for (const t of [`Sure. ${text}`, `${text}\nDone.`]) {
      expect(recover(t)).toEqual({ text: t, calls: [] });
    }
  });

  it("never recovers a call to a tool that is not declared", () => {
    const other = text.replaceAll("run_command", "rm_rf");
    expect(recover(other)).toEqual({ text: other, calls: [] });
  });
});

function recoverStage(name: string, chunks: string[]) {
  const setting = {
    harmony: "harmony",
    "mistral v11": "mistral",
    dsml: "dsml",
    "dsml v4": "dsml",
    "deepseek-v31": "deepseek-v31",
    "deepseek-r1": "deepseek-r1",
  }[name]!;
  const model = "local-model";
  const env = { CONTINUE_RECOVER_TEXT_TOOL_CALLS: `force:${setting}` };
  const stage = createTextToolRecovery(model, tools, undefined, env)!;
  const events = chunks.flatMap((c) => stage.push(c));
  events.push(...stage.end());
  return {
    text: events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""),
    calls: events.flatMap((e) => (e.type === "call" ? [e.call] : [])),
  };
}

describe("harmony", () => {
  const body = '{"command":"ls"}';
  const head = "<|channel|>commentary to=functions.run_command";

  it("reads the recipient in the role part, with or without the constrain token", () => {
    for (const t of [
      `<|start|>assistant to=functions.run_command<|channel|>commentary json<|message|>${body}<|call|>`,
      `${head}<|constrain|>json<|message|>${body}<|call|>`,
      `${head}<|message|>${body}<|call|>`,
    ]) {
      expect(recoverHarmonyFromText(t, tools).calls).toHaveLength(1);
    }
  });

  it("drops analysis, refuses a preamble, and refuses text after a call", () => {
    const call1 = `${head} <|constrain|>json<|message|>${body}<|call|>`;
    const withAnalysis = recoverHarmonyFromText(
      `<|channel|>analysis<|message|>hmm<|end|><|start|>assistant${call1}`,
      tools,
    );
    expect(withAnalysis.text).toBe("");
    expect(withAnalysis.calls).toHaveLength(1);
    const preamble = `<|channel|>commentary<|message|>Looking.<|end|><|start|>assistant${call1}`;
    expect(recoverHarmonyFromText(preamble, tools)).toEqual({
      text: preamble,
      calls: [],
    });
    const after = `${call1}<|start|>assistant<|channel|>commentary<|message|>More<|end|>`;
    expect(recoverHarmonyFromText(after, tools).calls).toEqual([]);
  });

  it("refuses a message that is not a function call or a preamble", () => {
    for (const t of [
      `<|channel|>final<|message|>${body}<|return|>`,
      `<|channel|>commentary to=functions.run_command <|constrain|>json<|message|>${body}<|end|>`,
      `<|channel|>commentary to=functions.run_command <|constrain|>json<|message|>[1]<|call|>`,
      `<|channel|>analysis to=functions.run_command<|message|>${body}<|call|>`,
      `<|start|>user<|channel|>commentary to=functions.run_command<|message|>${body}<|call|>`,
    ]) {
      expect(recoverHarmonyFromText(t, tools)).toEqual({ text: t, calls: [] });
    }
  });
});

describe("mistral", () => {
  it("reads both layouts and refuses a mixture", () => {
    const v3 =
      '[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a"}, "id": "AbCdEf123"}]';
    expect(recoverMistralFromText(v3, tools).calls).toHaveLength(1);
    const v11 = '[TOOL_CALLS]read_file[CALL_ID]AbCdEf123[ARGS]{"path": "a"}';
    expect(recoverMistralFromText(v11, tools).calls).toHaveLength(1);
    const two =
      '[TOOL_CALLS]read_file[ARGS]{"path": "a"}[TOOL_CALLS]read_file[ARGS]{"path": "b"}';
    expect(recoverMistralFromText(two, tools).calls).toHaveLength(2);
    const mixed = `${v3}[TOOL_CALLS]read_file[ARGS]{"path": "a"}`;
    expect(recoverMistralFromText(mixed, tools).calls).toEqual([]);
  });

  it("refuses an id that is not a string, an extra key and an empty array", () => {
    for (const t of [
      '[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a"}, "id": 7}]',
      '[TOOL_CALLS] [{"name": "read_file", "arguments": {"path": "a"}, "x": 1}]',
      "[TOOL_CALLS] []",
      "[TOOL_CALLS]",
    ]) {
      expect(recoverMistralFromText(t, tools)).toEqual({ text: t, calls: [] });
    }
  });

  it("keeps a leading think block as text", () => {
    const out = recoverMistralFromText(
      '<think>hm</think>\n[TOOL_CALLS]read_file[ARGS]{"path": "a"}',
      tools,
    );
    expect(out.text).toBe("<think>hm</think>\n");
    expect(out.calls).toHaveLength(1);
  });
});

describe("dsml", () => {
  it("holds a block that starts with the marker and releases other text at once", () => {
    const stage = new DsmlRecovery(tools);
    expect(stage.push("Hello")).toEqual([{ type: "text", text: "Hello" }]);
    const held = new DsmlRecovery(tools);
    expect(held.push("<｜DSML｜function_calls>\n")).toEqual([]);
    expect(held.isHolding()).toBe(true);
  });

  it("refuses a fragment left by a server that sent the call structured", () => {
    const t = "I'll read it.\n\n<｜DSML｜function_calls";
    expect(recoverDsmlFromText(t, tools)).toEqual({ text: t, calls: [] });
  });

  it("makes a string=true integer literal into the integer and says so", () => {
    const t = renderDsmlCall({
      name: "run_command",
      arguments: { command: "ls", timeout: "10" },
    });
    const out = recoverDsmlFromText(t, tools);
    expect(out.calls[0].arguments).toEqual({ command: "ls", timeout: 10 });
    expect(out.calls[0].repairs).toHaveLength(1);
  });
});

describe("pythonic, Llama layouts", () => {
  it("reads a bracketed list, as Llama 4 writes it", () => {
    const out = recoverPythonicFromText(
      '[run_command(command="ls", timeout=3), read_file(path="a")]',
      tools,
    );
    expect(out.calls.map((c) => c.name)).toEqual(["run_command", "read_file"]);
  });

  it("reads a python_tag call and only with .call", () => {
    const ok = recoverPythonicFromText(
      '<|python_tag|>read_file.call(path="a")',
      tools,
    );
    expect(ok.calls).toHaveLength(1);
    const bad = '<|python_tag|>read_file(path="a")';
    expect(recoverPythonicFromText(bad, tools)).toEqual({
      text: bad,
      calls: [],
    });
  });

  it("does not hold a markdown link or a plain list", () => {
    const t = "[docs](https://x.y)\n[1, 2]\n";
    expect(recoverPythonicFromText(t, tools)).toEqual({ text: t, calls: [] });
  });
});
