import { describe, expect, test } from "vitest";
import { NEGATIVE, POSITIVE } from "./toolDialectDetect.fixtures.js";
import {
  ACCEPT_THRESHOLD,
  ADVISORY_THRESHOLD,
  type Classification,
  PROBE_TOOL_NAME,
  classifyToolReply,
  decideDialect,
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

describe("decideDialect", () => {
  test("nothing known: default, as today", () => {
    const d = decideDialect({});
    expect(d).toMatchObject({ mode: "default", dialect: null, level: "none" });
  });

  test("table alone is advisory-or-better but never switches transport", () => {
    const d = decideDialect({ table: { dialect: "qwen-xml" } });
    expect(d.dialect).toBe("qwen-xml");
    expect(d.mode).toBe("default");
    expect(d.confidence).toBeGreaterThanOrEqual(ADVISORY_THRESHOLD);
    expect(d.level).toBe("advisory");
  });

  test("native probe on a custom endpoint: native, accept", () => {
    const d = decideDialect({ probe: cls("native-structured") });
    expect(d).toMatchObject({ mode: "native", level: "accept" });
  });

  test("probe leak of qwen markup on an unknown model: recover", () => {
    const d = decideDialect({ probe: cls("qwen-xml", 0.97) });
    expect(d).toMatchObject({
      mode: "recover",
      dialect: "qwen-xml",
      level: "accept",
    });
  });

  test("a live leak beats a clean probe", () => {
    const d = decideDialect({
      probe: cls("native-structured"),
      leaks: [cls("qwen-xml", 0.97)],
    });
    expect(d.mode).toBe("recover");
    expect(d.dialect).toBe("qwen-xml");
  });

  test("table and template agree: family confidence rises", () => {
    const one = decideDialect({ table: { dialect: "glm-xml" } });
    const two = decideDialect({
      table: { dialect: "glm-xml" },
      metadata: { dialect: "glm-xml" },
    });
    expect(two.confidence).toBeGreaterThan(one.confidence);
  });

  test("table and metadata disagree: conflict, no family, default", () => {
    const d = decideDialect({
      table: { dialect: "hermes-json" },
      metadata: { dialect: "qwen-xml" },
    });
    expect(d.conflict).toBe(true);
    expect(d.dialect).toBeNull();
    expect(d.mode).toBe("default");
  });

  test("a probe settles a table/metadata conflict", () => {
    const d = decideDialect({
      table: { dialect: "hermes-json" },
      metadata: { dialect: "qwen-xml" },
      probe: cls("qwen-xml", 0.97),
    });
    expect(d.dialect).toBe("qwen-xml");
    expect(d.mode).toBe("recover");
  });

  test("prose probe with a known family: render", () => {
    const d = decideDialect({
      metadata: { dialect: "pythonic" },
      table: { dialect: "pythonic" },
      probe: cls("prose", 0.8),
    });
    expect(d.mode).toBe("render");
    expect(d.dialect).toBe("pythonic");
  });

  test("prose probe with no family: falls back to default", () => {
    const d = decideDialect({ probe: cls("prose", 0.8) });
    expect(d.mode).toBe("default");
  });

  test("a weak, unclosed fingerprint does not trigger recovery", () => {
    const d = decideDialect({ probe: cls("hermes-json", 0.6) });
    expect(d.mode).toBe("default");
  });
});
