import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bedrockRepairsStreamedToolInput,
  repairStreamedToolInput,
  REPAIR_STREAMED_TOOL_INPUT_ENV,
  ToolInputGate,
  toolInputParses,
  toolSchemaKeys,
} from "./bedrockHelpers.js";

const READ = ["path"];

/**
 * Every ConverseStream tool input that did not parse in
 * bench/evidence/bedrock-stream-force-2026-11-10/records.jsonl (stream cell,
 * one tool read_file{path}), with what Converse returned for the same prompt.
 */
const RECORDED = [
  ...Array.from({ length: 4 }, () => ({
    model: "qwen.qwen3-32b-v1:0",
    broken: 'path": "src/main.ts"}',
    converse: '{"path":"src/main.ts"}',
    repaired: '{"path": "src/main.ts"}',
  })),
  {
    model: "qwen.qwen3-coder-30b-a3b-v1:0",
    broken: "{",
    converse: '{"path":"src/main.ts"}',
    repaired: undefined,
  },
];

describe("repairStreamedToolInput: the recorded broken streams", () => {
  it.each(RECORDED)(
    "$model: $broken is repaired to what Converse returned, or left alone",
    ({ broken, converse, repaired }) => {
      const out = repairStreamedToolInput(broken, { allowedKeys: READ });
      expect(out).toBe(repaired);
      // never a wrong call: a repair equals the Converse retry or is absent
      if (out !== undefined) {
        expect(JSON.parse(out)).toEqual(JSON.parse(converse));
      }
    },
  );

  const recordsFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../bench/evidence/bedrock-stream-force-2026-11-10/records.jsonl",
  );
  it.skipIf(!fs.existsSync(recordsFile))(
    "recovers the 4 Qwen3 32B records and turns none into a wrong call",
    () => {
      const rows = fs
        .readFileSync(recordsFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      // every Converse answer to the same prompt, per model
      const answers = new Map<string, Set<string>>();
      for (const r of rows) {
        if (r.cell === "stream" || !r.request.prompt.startsWith("Read the")) {
          continue;
        }
        for (const c of r.response.calls ?? []) {
          if (typeof c.input !== "string" || !c.input.startsWith("{")) continue;
          const set = answers.get(r.model) ?? new Set<string>();
          set.add(JSON.stringify(JSON.parse(c.input)));
          answers.set(r.model, set);
        }
      }
      let broken = 0;
      let recovered = 0;
      let wrong = 0;
      for (const r of rows) {
        if (r.cell !== "stream") continue;
        for (const c of r.response.calls ?? []) {
          if (c.parseOk) continue;
          broken++;
          const out = repairStreamedToolInput(c.joined, { allowedKeys: READ });
          if (out === undefined) continue;
          recovered++;
          const same = answers
            .get(r.model)
            ?.has(JSON.stringify(JSON.parse(out)));
          if (!same) wrong++;
        }
      }
      expect(wrong).toBe(0);
      expect(recovered).toBe(4);
      expect(broken).toBe(5);
    },
  );
});

describe("repairStreamedToolInput: rules", () => {
  it.each([
    ['{"path": "a.ts"', '{"path": "a.ts"}'],
    ['{"a": 1, "b": [true, null]', '{"a": 1, "b": [true, null]}'],
    ['{"a": {"b": "c"}', '{"a": {"b": "c"}}'],
    ['{"a": [{"b": "c"}', '{"a": [{"b": "c"}]}'],
    ['{"a": "x"  ', '{"a": "x"}'],
  ])("closes brackets after a complete value: %s", (input, expected) => {
    expect(repairStreamedToolInput(input)).toBe(expected);
  });

  it.each([
    "{",
    '{"',
    '{"path',
    '{"path"',
    '{"path":',
    '{"path": ',
    '{"path": "a.t',
    '{"a": 1,',
    '{"a": 12',
    '{"a": tru',
    '{"a": nul',
    '{"a": "x"}}',
    '{"a": ["x"}',
    "[",
    '["a"',
    "null}",
    "path",
    'ath": "a"}',
    "{path: 1}",
  ])("rejects %j", (input) => {
    expect(repairStreamedToolInput(input, { allowedKeys: READ })).toBe(
      undefined,
    );
  });

  it("restores a missing opening only for keys the tool declares", () => {
    expect(repairStreamedToolInput('path": "a"}', { allowedKeys: READ })).toBe(
      '{"path": "a"}',
    );
    expect(repairStreamedToolInput('path": "a"}')).toBe(undefined);
    expect(
      repairStreamedToolInput('path": "a"}', { allowedKeys: ["filepath"] }),
    ).toBe(undefined);
    expect(
      repairStreamedToolInput('path": "a", "x": 1}', { allowedKeys: READ }),
    ).toBe(undefined);
  });

  it("rejects closed input whose keys the tool does not declare", () => {
    expect(repairStreamedToolInput('{"nope": "a"', { allowedKeys: READ })).toBe(
      undefined,
    );
  });

  it("returns input that parses, and empty input, unchanged", () => {
    expect(repairStreamedToolInput('{"a":1}')).toBe('{"a":1}');
    expect(repairStreamedToolInput("")).toBe("");
  });
});

// A small seeded generator, so the properties are reproducible without a
// property-testing dependency.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = Math.floor(next() * (depth > 2 ? 4 : 6));
  switch (pick) {
    case 0:
      return Math.floor(next() * 1000) - 500;
    case 1:
      return ["a", 'q"uote', "back\\slash", "unié\n", ""][
        Math.floor(next() * 5)
      ];
    case 2:
      return next() < 0.5;
    case 3:
      return null;
    case 4:
      return Array.from({ length: Math.floor(next() * 3) }, () =>
        randomValue(next, depth + 1),
      );
    default:
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 3) }, (_, i) => [
          `k${i}`,
          randomValue(next, depth + 1),
        ]),
      );
  }
}

describe("repairStreamedToolInput: properties", () => {
  const next = rng(20261111);
  const docs = Array.from({ length: 300 }, () => ({
    a: randomValue(next, 0),
    b: randomValue(next, 0),
    c: randomValue(next, 0),
  }));

  it("every cut of valid JSON: a repair parses and extends the cut with closers only", () => {
    let repairedCount = 0;
    for (const doc of docs) {
      const text = JSON.stringify(doc);
      for (let i = 1; i < text.length; i++) {
        const cut = text.slice(0, i);
        const out = repairStreamedToolInput(cut);
        if (out === undefined) continue;
        repairedCount++;
        // the repaired output always parses
        expect(toolInputParses(out)).toBe(true);
        // and the cut is a prefix of it: only closers were added
        expect(out.startsWith(cut.trimEnd())).toBe(true);
        expect(out.slice(cut.trimEnd().length)).toMatch(/^[}\]]*$/);
        // every member before the last one is exactly the document's own
        const parsed = JSON.parse(out) as Record<string, unknown>;
        const full = doc as Record<string, unknown>;
        for (const k of Object.keys(parsed).slice(0, -1)) {
          expect(parsed[k]).toEqual(full[k]);
        }
      }
    }
    expect(repairedCount).toBeGreaterThan(100);
  });

  it("a cut at a top-level member boundary equals the document minus its later members", () => {
    for (const doc of docs) {
      const text = JSON.stringify({ a: doc.a, b: doc.b });
      const boundary = text.indexOf(',"b":');
      const out = repairStreamedToolInput(text.slice(0, boundary));
      if (out === undefined) continue; // e.g. a ends in a number
      expect(JSON.parse(out)).toEqual({ a: doc.a });
    }
  });

  it("input that parses is never changed, and no input ever throws", () => {
    for (const doc of docs) {
      const text = JSON.stringify(doc);
      expect(repairStreamedToolInput(text)).toBe(text);
    }
    const junk = rng(7);
    const alphabet = '{}[]":,\\ ab1-truefalsn\n';
    for (let n = 0; n < 2000; n++) {
      const s = Array.from(
        { length: Math.floor(junk() * 24) },
        () => alphabet[Math.floor(junk() * alphabet.length)],
      ).join("");
      const out = repairStreamedToolInput(s, { allowedKeys: ["a", "b"] });
      if (out !== undefined) expect(toolInputParses(out)).toBe(true);
    }
  });
});

describe("opt-in", () => {
  it("is off unless the variable is 1, and only for the listed families", () => {
    expect(bedrockRepairsStreamedToolInput("qwen.qwen3-32b-v1:0", {})).toBe(
      false,
    );
    const on = { [REPAIR_STREAMED_TOOL_INPUT_ENV]: "1" };
    expect(bedrockRepairsStreamedToolInput("qwen.qwen3-32b-v1:0", on)).toBe(
      true,
    );
    expect(
      bedrockRepairsStreamedToolInput("mistral.mistral-large-3-675b", on),
    ).toBe(false);
    expect(
      bedrockRepairsStreamedToolInput("qwen.qwen3-32b-v1:0", {
        [REPAIR_STREAMED_TOOL_INPUT_ENV]: "true",
      }),
    ).toBe(false);
  });

  it("reads the declared keys of a tool", () => {
    const tools = [
      {
        toolSpec: {
          name: "Read",
          inputSchema: { json: { properties: { filepath: {} } } },
        },
      },
    ];
    expect(toolSchemaKeys(tools, "Read")).toEqual(["filepath"]);
    expect(toolSchemaKeys(tools, "Other")).toBeUndefined();
    expect(toolSchemaKeys(undefined, "Read")).toBeUndefined();
  });
});

describe("ToolInputGate with a repair", () => {
  const repair = {
    input: (s: string) => repairStreamedToolInput(s, { allowedKeys: READ }),
    fragment: (s: string) => `frag:${s}`,
  };

  it("releases the start and one repaired fragment, not a retry", () => {
    const gate = new ToolInputGate<string>(true, repair);
    gate.open("start");
    gate.add("f1", 'path": "a"}');
    expect(gate.close()).toEqual({
      parts: ["start", 'frag:{"path": "a"}'],
      broken: false,
      retry: false,
    });
  });

  it("still retries what cannot be repaired", () => {
    const gate = new ToolInputGate<string>(true, repair);
    gate.open("start");
    gate.add("f1", "{");
    expect(gate.close()).toEqual({ parts: [], broken: true, retry: true });
  });

  it("without a repair behaves as before", () => {
    const gate = new ToolInputGate<string>(true);
    gate.open("start");
    gate.add("f1", 'path": "a"}');
    expect(gate.close().retry).toBe(true);
  });
});
