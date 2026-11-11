import { describe, expect, test } from "vitest";
import { NEGATIVE, POSITIVE } from "./toolDialectDetect.fixtures.js";
import {
  ACCEPT_THRESHOLD,
  ADVISORY_THRESHOLD,
  type Classification,
  PROBE_TOOL_NAME,
  classifyToolReply,
  dialectFromChatTemplate,
  probeRequestFor,
  verifyProbeCalls,
} from "./toolDialectDetect.js";

const cls = (
  dialect: Classification["dialect"],
  confidence = 0.95,
): Classification => ({ dialect, confidence, evidence: [], thinking: "none" });

describe("classifyToolReply: golden fixtures", () => {
  for (const f of POSITIVE) {
    test(f.name, () => {
      const r = classifyToolReply({
        content: f.text,
        knownTools: ["get_weather", "Read"],
      });
      expect(r.dialect).toBe(f.dialect);
      // A bare JSON object may be an answer, so it stays advisory by design.
      expect(r.confidence).toBeGreaterThanOrEqual(
        f.dialect === "llama-json" ? ADVISORY_THRESHOLD : ACCEPT_THRESHOLD,
      );
      expect(r.evidence.length).toBeGreaterThan(0);
    });
  }

  test("every fixture has a source", () => {
    for (const f of POSITIVE) expect(f.source.length).toBeGreaterThan(10);
  });

  test("a chunk of the call, split anywhere after the marker, still classifies", () => {
    const f = POSITIVE.find((x) => x.name === "qwen3-coder call")!;
    const cut = f.text.indexOf("<parameter=") + 12;
    expect(classifyToolReply({ content: f.text.slice(0, cut) }).dialect).toBe(
      "qwen-xml",
    );
  });
});

describe("classifyToolReply: negatives", () => {
  for (const n of NEGATIVE) {
    test(n.name, () => {
      const r = classifyToolReply({ content: n.text, knownTools: ["Read"] });
      expect(["prose", "unknown"]).toContain(r.dialect);
    });
  }

  test("pythonic with an unknown tool name stays below the accept bar", () => {
    const r = classifyToolReply({
      content: "do_stuff(a=1)",
      knownTools: ["Read"],
    });
    expect(r.dialect).toBe("pythonic");
    expect(r.confidence).toBeLessThan(ACCEPT_THRESHOLD);
  });
});

describe("classifyToolReply: structured and mixed", () => {
  test("structured calls are native", () => {
    const r = classifyToolReply({
      content: "",
      toolCalls: [{ id: "a", name: "Read", arguments: '{"path":"a"}' }],
      knownTools: ["Read"],
    });
    expect(r.dialect).toBe("native-structured");
    expect(r.confidence).toBeGreaterThanOrEqual(ACCEPT_THRESHOLD);
  });

  test("structured call with broken JSON arguments lowers confidence", () => {
    const r = classifyToolReply({
      content: "",
      toolCalls: [{ id: "a", name: "Read", arguments: '{"path":' }],
    });
    expect(r.dialect).toBe("native-structured");
    expect(r.confidence).toBeLessThan(ACCEPT_THRESHOLD);
  });

  test("structured call plus leaked markup is noted", () => {
    const r = classifyToolReply({
      content: "<tool_call>\n<function=Read>\n</function>\n</tool_call>",
      toolCalls: [{ id: "a", name: "Read", arguments: "{}" }],
    });
    expect(r.evidence.join(" ")).toMatch(/markup also left/);
  });

  test("thinking conventions", () => {
    expect(classifyToolReply({ content: "<think>x</think>hi" }).thinking).toBe(
      "think-tags",
    );
    expect(
      classifyToolReply({ content: "<thinking>x</thinking>hi" }).thinking,
    ).toBe("thinking-tags");
    expect(classifyToolReply({ content: "hi" }).thinking).toBe("none");
  });
});

describe("dialectFromChatTemplate", () => {
  test("qwen3-coder template literals", () => {
    expect(
      dialectFromChatTemplate("'<function=' + name + '>' '<parameter='")
        ?.dialect,
    ).toBe("qwen-xml");
  });
  test("glm", () => {
    expect(
      dialectFromChatTemplate("<tool_call>{{ n }}<arg_key>k</arg_key>")
        ?.dialect,
    ).toBe("glm-xml");
  });
  test("hermes", () => {
    expect(dialectFromChatTemplate('<tool_call>\\n{"name": ')?.dialect).toBe(
      "hermes-json",
    );
  });
  test("minimax m2 and m3 templates", () => {
    expect(
      dialectFromChatTemplate("'<minimax:tool_call>' invoke")?.dialect,
    ).toBe("minimax-xml");
    expect(
      dialectFromChatTemplate("ns_token ~ ']<]minimax[>[<tool_call>'")?.dialect,
    ).toBe("minimax-ns-xml");
  });
  test("nothing", () => {
    expect(dialectFromChatTemplate("{{ messages }}")).toBeUndefined();
    expect(dialectFromChatTemplate(null)).toBeUndefined();
  });
});

describe("probe", () => {
  test("is deterministic and offers one inert tool", () => {
    const p = probeRequestFor();
    expect(p.params.temperature).toBe(0);
    expect(p.tools).toHaveLength(1);
    expect(p.tools[0].function.name).toBe(PROBE_TOOL_NAME);
    expect(probeRequestFor()).toEqual(p);
  });

  test("verifyProbeCalls accepts a faithful reply", () => {
    const e = probeRequestFor().expected;
    const calls = e.map((x, i) => ({
      id: `id${i}`,
      name: x.name,
      arguments: JSON.stringify(x.arguments),
    }));
    const v = verifyProbeCalls(calls);
    expect(v).toMatchObject({
      parallel: true,
      argumentsIntact: true,
      idsPresent: true,
    });
  });

  test("verifyProbeCalls flags lost escaping, one call, no ids", () => {
    const e = probeRequestFor().expected;
    const v = verifyProbeCalls([
      {
        name: e[0].name,
        arguments: JSON.stringify({ text: "say hi", count: 1 }),
      },
    ]);
    expect(v.parallel).toBe(false);
    expect(v.argumentsIntact).toBe(false);
    expect(v.idsPresent).toBe(false);
  });
});
