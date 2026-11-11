import { describe, expect, it } from "vitest";
import {
  actionAllowed,
  EVIDENCE_FLOOR,
  resolveFact,
  resolveSurfaceFacts,
  surfaceFactsLine,
  surfaceFamily,
  surfaceForProvider,
  SURFACE_FACTS,
  type Fact,
  type ResolvedFact,
  type SurfaceAction,
  type SurfaceRow,
} from "./surfaceFacts.js";

// Typed loosely on purpose: the helper builds a fact for whichever name the case uses.
const fact = (over: Partial<Fact>): never =>
  ({
    value: true,
    level: "declared",
    source: "test",
    readOn: "2026-01-01",
    ...over,
  }) as never;

const row = (
  id: string,
  facts: SurfaceRow["facts"],
  modelFamily?: string,
): SurfaceRow => ({
  id,
  provider: "p",
  engine: "*",
  api: "a",
  ...(modelFamily ? { modelFamily } : {}),
  facts,
});

describe("resolveSurfaceFacts: layers", () => {
  it("answers each fact on its own, so a surface does not hide the family's facts", () => {
    const rows = [
      row("s", { toolChoice: fact({ value: { required: false } }) }),
      row("f", { toolsHonoured: fact({ value: false }) }, "fam"),
    ];
    const r = resolveSurfaceFacts({
      provider: "p",
      api: "a",
      modelFamily: "fam",
      rows,
    });
    expect(r.toolChoice).toMatchObject({ layer: "surface", rowId: "s" });
    expect(r.toolsHonoured).toMatchObject({ layer: "family", value: false });
    expect(r.reasoningField).toMatchObject({
      layer: "none",
      value: undefined,
    });
  });

  it("prefers the family row over the surface row for the same fact", () => {
    const rows = [
      row("s", { toolsHonoured: fact({ value: true }) }),
      row("f", { toolsHonoured: fact({ value: false }) }, "fam"),
    ];
    const q = { provider: "p", api: "a", rows };
    expect(
      resolveFact("toolsHonoured", { ...q, modelFamily: "fam" }).value,
    ).toBe(false);
    expect(
      resolveFact("toolsHonoured", { ...q, modelFamily: "other" }).value,
    ).toBe(true);
  });

  it("orders user, measured, family, surface, and notes drift", () => {
    const rows = [row("s", { parallelCalls: fact({ value: false }) })];
    const base = { provider: "p", api: "a", rows };
    const measured = {
      parallelCalls: fact({ value: true, level: "measured", k: 8, n: 8 }),
    };
    const m = resolveFact("parallelCalls", { ...base, measured });
    expect(m).toMatchObject({ layer: "measured", value: true });
    expect(m.drift).toContain("contradicts s");
    const u = resolveFact("parallelCalls", {
      ...base,
      measured,
      userOverrides: { parallelCalls: false },
    });
    expect(u).toMatchObject({ layer: "user", value: false });
  });

  it("marks a measured fact stale after its expiry and keeps it", () => {
    const measured = {
      parallelCalls: fact({
        value: true,
        level: "measured",
        k: 8,
        n: 8,
        expires: "2026-02-01",
      }),
    };
    const r = resolveFact("parallelCalls", {
      provider: "p",
      api: "a",
      rows: [],
      measured,
      now: "2026-03-01",
    });
    expect(r).toMatchObject({ value: true, stale: true });
  });

  it("does not match a row for another provider or api", () => {
    const r = resolveFact("toolChoice", {
      provider: "ollama",
      engine: "ollama",
      api: "ollama-native",
    });
    expect(r.layer).toBe("none");
  });
});

const resolved = (over: Partial<ResolvedFact>): ResolvedFact => ({
  name: "toolsHonoured",
  value: true,
  layer: "surface",
  level: "declared",
  ...over,
});

describe("actionAllowed: the evidence floor", () => {
  const actions: SurfaceAction[] = [
    "warn",
    "disableTools",
    "enableTools",
    "enableRecovery",
  ];
  it.each([
    ["declared", { level: "declared" as const }, [true, true, false, false]],
    ["derived", { level: "derived" as const }, [true, false, false, false]],
    [
      "measured 8/8",
      { level: "measured" as const, k: 8, n: 8 },
      [true, true, true, false],
    ],
    [
      "measured 7/8",
      { level: "measured" as const, k: 7, n: 8 },
      [true, true, false, false],
    ],
    [
      "measured 3/3",
      { level: "measured" as const, k: 3, n: 3 },
      [true, true, false, false],
    ],
    [
      "measured 8/8 but stale",
      { level: "measured" as const, k: 8, n: 8, stale: true },
      [true, true, false, false],
    ],
    [
      "measured without k and n",
      { level: "measured" as const },
      [true, true, false, false],
    ],
    [
      "unknown",
      { value: undefined, layer: "none" as const },
      [false, false, false, false],
    ],
    [
      "user override",
      { layer: "user" as const, level: undefined },
      [true, true, true, true],
    ],
  ])("%s", (_n, over, expected) => {
    expect(actions.map((a) => actionAllowed(a, resolved(over)))).toEqual(
      expected,
    );
  });

  it("never lets a preset or a measurement turn recovery on", () => {
    for (const layer of ["measured", "family", "surface"] as const) {
      expect(
        actionAllowed(
          "enableRecovery",
          resolved({ layer, level: "measured", k: 8, n: 8 }),
        ),
      ).toBe(false);
    }
    expect(Object.keys(EVIDENCE_FLOOR)).toEqual(actions);
  });
});

describe("the shipped data", () => {
  it("states that Ollama /v1 has no tool_choice, declared, with a date", () => {
    const r = resolveFact("toolChoice", {
      provider: "ollama",
      engine: "ollama",
      api: "openai-chat",
    });
    expect(r).toMatchObject({ layer: "surface", level: "declared" });
    expect(r.value).toMatchObject({ required: false });
    expect(r.readOn).toBe("2026-11-10");
  });

  it("marks forced choice rejected for Claude 5.5-generation on Messages only", () => {
    const fam = surfaceFamily("claude", "anthropic.claude-opus-5-5-v1:0");
    expect(fam).toBe("claude-5.5-generation");
    const q = { provider: "anthropic", api: "messages" };
    expect(resolveFact("toolForce", { ...q, modelFamily: fam }).value).toBe(
      "rejected",
    );
    expect(
      resolveFact("toolForce", { ...q, modelFamily: "claude" }).layer,
    ).toBe("none");
  });

  it("keeps Llama 3.3 on Converse as measured: may disable tools, nothing more", () => {
    const r = resolveFact("toolsHonoured", {
      provider: "bedrock",
      api: "converse",
      modelFamily: "llama-3.3",
    });
    expect(r).toMatchObject({ value: false, level: "measured", k: 8, n: 8 });
    expect(actionAllowed("disableTools", r)).toBe(true);
    expect(actionAllowed("enableRecovery", r)).toBe(false);
  });

  it("only measured 8-of-8 rows may enable tools", () => {
    for (const r of SURFACE_FACTS.rows) {
      if (r.facts.toolsHonoured?.value !== true) continue;
      const f = resolveFact("toolsHonoured", {
        provider: r.provider,
        engine: r.engine === "*" ? undefined : r.engine,
        api: r.api,
        modelFamily: r.modelFamily,
      });
      const allowed = actionAllowed("enableTools", f);
      const k8 = f.level === "measured" && f.k === 8 && f.n === 8;
      expect(allowed).toBe(k8);
    }
  });

  it("knows Llama 4 refuses tools on ConverseStream", () => {
    const r = resolveFact("streamingToolArgs", {
      provider: "bedrock",
      api: "converse-stream",
      modelFamily: "llama-4",
    });
    expect(r.value).toBe("refused");
  });
});

describe("surfaceFactsLine", () => {
  it("writes the Ollama /v1 line", () => {
    const s = surfaceForProvider("ollama");
    expect(s && surfaceFactsLine(s.label, s.query)).toBe(
      "Provider facts: Ollama /v1: tools honoured (declared, read 2026-11-10); tool_choice required/named/none not supported (declared, read 2026-11-10)",
    );
  });

  it("is undefined for an unknown surface", () => {
    expect(
      surfaceFactsLine("X", { provider: "zzz", api: "zzz" }),
    ).toBeUndefined();
    expect(surfaceForProvider("zzz")).toBeUndefined();
  });

  it("shows k of n for a measured fact", () => {
    const line = surfaceFactsLine("Bedrock Converse", {
      provider: "bedrock",
      api: "converse",
      modelFamily: "llama-3.3",
    });
    expect(line).toContain(
      "tools not honoured as structured calls (measured 8/8, read 2026-11-10)",
    );
  });
});
