import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MODEL_CATEGORIES } from "../categories";
import { REVIEWER_SYSTEM_PROMPT } from "../prompt";
import {
  parseDataset,
  parseGuidance,
  POLICY_AREAS,
  type LabelledCase,
  type ReviewDataset,
} from "./reviewEvalDataset";
import { formatCostPlan, formatGate, formatPaired } from "./reviewEvalReport";
import {
  messagesFor,
  planCost,
  runReviewEval,
  type ReviewerClient,
} from "./reviewEvalRun";
import { comparePaired, gate, score } from "./reviewEvalScore";
import { signTestP, wilson } from "./wilson";

const starter: ReviewDataset = parseDataset(
  readFileSync(join(__dirname, "datasets", "reviewer-starter.json"), "utf8"),
);

const reply = (content: string, usage?: unknown) =>
  ({ role: "assistant", content, ...(usage ? { usage } : {}) }) as any;

function verdictFor(c: LabelledCase) {
  return c.expected === "allow"
    ? { decision: "allow", reason: "ok" }
    : {
        decision: c.expected,
        category: c.category ?? "uncertain",
        reason: "labelled",
      };
}

/** Finds which case a request is about from the text of its messages. */
function caseOf(messages: any[], cases: LabelledCase[]): LabelledCase {
  const text = String(messages[messages.length - 1].content);
  const hit = cases.find(
    (c) =>
      text.includes(`arguments: ${JSON.stringify(c.args)}`) &&
      text.includes(`1. ${c.history.userMessages[0]}`),
  );
  if (!hit) throw new Error("no case matches the request");
  return hit;
}

/** A scripted reviewer: `script` turns a case into the raw reply text. */
function scripted(
  cases: LabelledCase[],
  script: (c: LabelledCase) => string,
): ReviewerClient & { chat: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn(async (messages: any[]) =>
      reply(script(caseOf(messages, cases))),
    ),
  } as any;
}

const oracle = (cases = starter.cases) =>
  scripted(cases, (c) => JSON.stringify(verdictFor(c)));

const tiny = (rows: Partial<LabelledCase>[]): ReviewDataset => ({
  version: 1,
  name: "tiny",
  environment: starter.environment,
  cases: rows.map((r, i) => ({
    id: `t${i}`,
    area: "other",
    tool: "run_terminal_command",
    args: { command: `echo ${i}` },
    history: { userMessages: [`request ${i}`] },
    expected: "allow",
    rationale: "test",
    floor: false,
    ...r,
  })),
});

describe("Wilson and sign-test maths", () => {
  it("matches the known intervals", () => {
    const zero60 = wilson(0, 60)!;
    expect(zero60.low).toBe(0);
    expect(zero60.high).toBeCloseTo(0.0602, 3);
    expect(wilson(0, 74)!.high).toBeCloseTo(0.0494, 3);
    const eighth = wilson(1, 8)!;
    expect(eighth.low).toBeCloseTo(0.0224, 3);
    expect(eighth.high).toBeCloseTo(0.4709, 3);
  });

  it("returns null with no trials and rejects an impossible count", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(5, 3)).toThrow(RangeError);
  });

  it("gives an exact two-sided sign test", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(5, 5)).toBe(1);
    expect(signTestP(0, 5)).toBeCloseTo(0.0625, 4);
    expect(signTestP(0, 10)).toBeCloseTo(0.00195, 4);
  });
});

describe("starter dataset", () => {
  it("has at least 60 valid, hand-labelled cases with unique ids", () => {
    expect(starter.cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(starter.cases.map((c) => c.id)).size).toBe(
      starter.cases.length,
    );
    for (const c of starter.cases)
      expect(c.rationale.length).toBeGreaterThanOrEqual(8);
  });

  it("covers every policy area except the catch-all, with floor and open cases", () => {
    for (const area of POLICY_AREAS.filter((a) => a !== "other")) {
      const rows = starter.cases.filter((c) => c.area === area);
      expect(rows.length, area).toBeGreaterThanOrEqual(5);
    }
    expect(starter.cases.some((c) => c.floor)).toBe(true);
    expect(starter.cases.some((c) => !c.floor)).toBe(true);
    expect(starter.cases.some((c) => c.expected === "allow")).toBe(true);
  });

  it("never expects a floor case to be allowed, and uses real categories", () => {
    for (const c of starter.cases) {
      if (c.floor) expect(c.expected, c.id).not.toBe("allow");
      if (c.category) expect(c.category in MODEL_CATEGORIES, c.id).toBe(true);
      if (c.category && c.category in MODEL_CATEGORIES) {
        // A deny label names a deny category; an ask label an ask one.
        const outcome =
          MODEL_CATEGORIES[c.category as keyof typeof MODEL_CATEGORIES].outcome;
        if (c.expected === "deny") expect(outcome, c.id).toBe("deny");
      }
    }
  });

  it("is told apart from a bad dataset by the validator", () => {
    const bad = JSON.stringify({
      version: 1,
      name: "x",
      cases: [
        {
          id: "a",
          area: "nope",
          tool: "t",
          args: {},
          history: { userMessages: [] },
          expected: "allow",
          rationale: "",
          floor: true,
        },
      ],
    });
    expect(() => parseDataset(bad)).toThrow(/area must be one of/);
    expect(() => parseDataset(bad)).toThrow(/floor case cannot be expected/);
    expect(() => parseDataset("{")).toThrow(/not valid json/);
  });

  it("reads YAML too", () => {
    const yaml = `version: 1
name: y
cases:
  - id: a
    area: benign-dev
    tool: run_terminal_command
    args: {command: ls}
    history: {userMessages: [list files]}
    expected: allow
    rationale: harmless
    floor: false
`;
    expect(parseDataset(yaml, "yaml").cases).toHaveLength(1);
  });
});

describe("guidance files", () => {
  it("reads block and allow from text", () => {
    const g = parseGuidance(
      "- Ask before touching infra/\nNever print tokens\n\nFine to allow:\n- Running npm test\n",
      "g.md",
    );
    expect(g.block).toEqual([
      "Ask before touching infra/",
      "Never print tokens",
    ]);
    expect(g.allow).toEqual(["Running npm test"]);
  });

  it("reads JSON and YAML objects", () => {
    expect(parseGuidance('{"block":["a"]}', "g.json").block).toEqual(["a"]);
    expect(parseGuidance("allow:\n  - b\n", "g.yaml").allow).toEqual(["b"]);
    expect(() => parseGuidance('{"block":"a"}', "g.json")).toThrow(/list/);
  });
});

describe("runner", () => {
  it("sends the real reviewer messages, with guidance in the trusted block", async () => {
    const client = oracle();
    await runReviewEval(
      client,
      tiny([{}]),
      { label: "g", guidance: { block: ["Never touch infra/"] } },
      { concurrency: 1 },
    );
    const sent = client.chat.mock.calls[0][0] as any[];
    expect(sent[0].content).toBe(REVIEWER_SYSTEM_PROMPT);
    expect(sent[1].content).toContain("[[USER-GUIDANCE]]");
    expect(sent[1].content).toContain("Never touch infra/");
    expect(sent[1].content).toContain("1. request 0");
  });

  it("applies a case's environment override", () => {
    const ds = tiny([{ environment: { productionMarkers: ["prd"] } }]);
    const text = String(messagesFor(ds.cases[0], ds, {})[1].content);
    expect(text).toContain(
      "Production markers (names that mean production): prd",
    );
  });

  it("scores a perfect reviewer on the starter set", async () => {
    const { outcomes } = await runReviewEval(oracle(), starter, {
      label: "oracle",
      profile: "p1",
    });
    const m = score(starter.cases, outcomes);
    expect(m.agreement.k).toBe(m.n);
    expect(m.falseAllow.k).toBe(0);
    expect(m.overBlock.k).toBe(0);
    expect(m.formatFailure.k).toBe(0);
    // 0 of the non-allow cases allowed: an upper bound, not a zero.
    expect(m.falseAllow.high).toBeGreaterThan(0.03);
    expect(m.byArea.length).toBeGreaterThanOrEqual(9);
    expect(m.byCategory.some((g) => g.label === "credential-access")).toBe(
      true,
    );
  });

  it("counts format failures apart from errors and fails them closed to ask", async () => {
    const ds = tiny([{}, {}, {}, { expected: "ask", category: "uncertain" }]);
    let n = 0;
    const client: ReviewerClient = {
      chat: async () => {
        n++;
        if (n === 1) return reply("Sure, go ahead.");
        if (n === 2) throw new Error("HTTP 429");
        if (n === 3) return reply('{"decision":"allow"}');
        return reply('{"decision":"maybe"}');
      },
    };
    const run = await runReviewEval(
      client,
      ds,
      { label: "x" },
      { concurrency: 1 },
    );
    const m = score(ds.cases, run.outcomes);
    expect(run.outcomes.map((o) => o.decision)).toEqual([
      "ask",
      "ask",
      "allow",
      "ask",
    ]);
    expect(m.formatFailure.k).toBe(2); // prose, unknown decision
    expect(m.errors).toBe(1); // the 429, not a format failure
    expect(m.overBlock.k).toBe(2); // the prose and the 429 on allow cases
  });

  it("reports tokens, latency and cache reads when the provider gives them", async () => {
    const ds = tiny([{}, {}]);
    const client: ReviewerClient = {
      chat: async () =>
        reply('{"decision":"allow","reason":"ok"}', {
          promptTokens: 1000,
          completionTokens: 20,
          promptTokensDetails: { cachedTokens: 600 },
        }),
    };
    const m = score(
      ds.cases,
      (await runReviewEval(client, ds, { label: "x" })).outcomes,
    );
    expect(m.meanInputTokens).toBe(1000);
    expect(m.meanOutputTokens).toBe(20);
    expect(m.cacheReadShare).toBeCloseTo(0.6);
    expect(m.meanLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("omits the cache share when nothing is reported", async () => {
    const ds = tiny([{}]);
    const m = score(
      ds.cases,
      (await runReviewEval(oracle(ds.cases), ds, { label: "x" })).outcomes,
    );
    expect(m.cacheReadShare).toBeUndefined();
  });
});

describe("gate", () => {
  const run = (client: ReviewerClient, ds = starter) =>
    runReviewEval(client, ds, { label: "x" }).then((r) => r.outcomes);

  it("detects a floor false-allow and fails the gate", async () => {
    const allowAll = scripted(starter.cases, () =>
      JSON.stringify({ decision: "allow", reason: "fine" }),
    );
    const outcomes = await run(allowAll);
    const m = score(starter.cases, outcomes);
    const floorN = starter.cases.filter((c) => c.floor).length;
    expect(m.floorFalseAllow.k).toBe(floorN);
    expect(m.floorFalseAllow.ids).toHaveLength(floorN);
    const base = await run(oracle());
    const bm = score(starter.cases, base);
    const g = gate(starter.cases, m, {
      metrics: bm,
      paired: comparePaired(starter.cases, base, outcomes),
    });
    expect(g.verdict).toBe("not safe to adopt");
    expect(g.checks[0].pass).toBe(false);
    expect(formatGate(g)).toContain("FAIL");
  });

  it("fails one floor false-allow even when everything else is better", async () => {
    const victim = starter.cases.find((c) => c.floor)!;
    const oneLeak = scripted(starter.cases, (c) =>
      JSON.stringify(
        c.id === victim.id
          ? { decision: "allow", reason: "ok" }
          : verdictFor(c),
      ),
    );
    const base = await run(
      scripted(starter.cases, () =>
        JSON.stringify({ decision: "ask", category: "uncertain", reason: "?" }),
      ),
    );
    const out = await run(oneLeak);
    const g = gate(starter.cases, score(starter.cases, out), {
      metrics: score(starter.cases, base),
      paired: comparePaired(starter.cases, base, out),
    });
    expect(g.verdict).toBe("not safe to adopt");
    expect(g.checks[0].detail).toContain(victim.id);
  });

  it("says safe to adopt for a candidate as good as the baseline", async () => {
    const a = await run(oracle());
    const b = await run(oracle());
    const g = gate(starter.cases, score(starter.cases, b), {
      metrics: score(starter.cases, a),
      paired: comparePaired(starter.cases, a, b),
    });
    expect(g.verdict).toBe("safe to adopt");
  });

  it("fails a candidate that over-blocks far more than the baseline", async () => {
    const base = await run(oracle());
    const askAll = await run(
      scripted(starter.cases, () =>
        JSON.stringify({ decision: "ask", category: "uncertain", reason: "?" }),
      ),
    );
    const g = gate(starter.cases, score(starter.cases, askAll), {
      metrics: score(starter.cases, base),
      paired: comparePaired(starter.cases, base, askAll),
    });
    expect(g.verdict).toBe("not safe to adopt");
    expect(g.checks.find((c) => c.name.startsWith("Over-block"))?.pass).toBe(
      false,
    );
  });

  it("fails on too many format failures", async () => {
    const garbage = await run(scripted(starter.cases, () => "no idea"));
    const g = gate(starter.cases, score(starter.cases, garbage), undefined);
    expect(g.verdict).toBe("not safe to adopt");
    expect(g.checks[1].pass).toBe(false);
  });

  it("does not call it safe without a baseline or without floor cases", async () => {
    const out = await run(oracle());
    expect(
      gate(starter.cases, score(starter.cases, out), undefined).verdict,
    ).toBe("insufficient data");
    const ds = tiny([{}, {}]);
    const o = await run(oracle(ds.cases), ds);
    const m = score(ds.cases, o);
    const g = gate(ds.cases, m, {
      metrics: m,
      paired: comparePaired(ds.cases, o, o),
    });
    expect(g.verdict).toBe("insufficient data");
  });
});

describe("A/B comparison", () => {
  it("counts paired flips and keeps the significance note conservative", async () => {
    const ds = tiny([
      {},
      {},
      { expected: "deny", category: "credential-access", floor: true },
    ]);
    const a = (await runReviewEval(oracle(ds.cases), ds, { label: "a" }))
      .outcomes;
    // The candidate over-blocks case t0 and leaks the floor case.
    const b = (
      await runReviewEval(
        scripted(ds.cases, (c) =>
          JSON.stringify(
            c.id === "t0"
              ? { decision: "ask", category: "uncertain", reason: "?" }
              : c.floor
                ? { decision: "allow", reason: "ok" }
                : verdictFor(c),
          ),
        ),
        ds,
        { label: "b" },
      )
    ).outcomes;
    const p = comparePaired(ds.cases, a, b);
    expect(p.overBlock).toMatchObject({
      n: 2,
      onlyCandidate: 1,
      onlyBaseline: 0,
    });
    expect(p.falseAllow).toMatchObject({ n: 1, onlyCandidate: 1 });
    expect(p.flips.map((f) => f.id)).toEqual(["t0", "t2"]);
    expect(p.agreement).toMatchObject({ both: 1, onlyBaseline: 2 });
    const text = formatPaired(p);
    expect(text).toContain("unproven rather than equal");
    expect(text).toContain("| t2 | deny | deny | allow |");
  });

  it("rejects outcomes that do not line up with the cases", () => {
    expect(() => score(tiny([{}]).cases, [])).toThrow(/must match/);
  });
});

describe("dry run planning", () => {
  it("plans cost without a client", () => {
    const plan = planCost(starter, [{}, { guidance: { block: ["x"] } }], 2);
    expect(plan.calls).toBe(starter.cases.length * 2);
    expect(plan.estInputTokens).toBeGreaterThan(starter.cases.length * 500);
    expect(plan.maxOutputTokens).toBe(plan.calls * 300);
    const text = formatCostPlan(plan, "nova");
    expect(text).toContain("no model was called");
    expect(text).toContain("--run");
  });
});
