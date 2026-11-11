import { describe, expect, it } from "vitest";
import {
  type PromptSegment,
  type SegmentSpec,
  assertValidManifest,
  commonPrefixLength,
  createSegmentDump,
  describeSegments,
  firstChangedVsPrev,
  makeSegment,
  overBudget,
  promptSegmentsEnabled,
  validateManifest,
  visibleOffenders,
  volatileEarly,
} from "./promptSegments";

const seg = (
  id: string,
  stability: SegmentSpec["stability"],
  region: SegmentSpec["region"],
  text = id,
  extra: Partial<SegmentSpec> = {},
): PromptSegment =>
  makeSegment({ id, source: "builtin", stability, region, text, ...extra });

const GOOD = [
  seg("tools.builtin", "static", "tools"),
  seg("tools.mcp", "session", "tools"),
  seg("turn.act", "static", "system"),
  seg("rules.session", "session", "system"),
  seg("env", "session", "first-user"),
  seg("history", "turn", "history"),
  seg("tail.turn", "turn", "tail"),
  seg("task-list", "request", "tail"),
];

describe("segments", () => {
  it("hashes text, counts chars/4 and never keeps the text", () => {
    const s = makeSegment({
      id: "a",
      source: "mode",
      stability: "static",
      region: "system",
      text: "x".repeat(41),
    });
    expect(s.tokens).toBe(11);
    expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(s)).not.toContain("xxxx");
  });

  it("accepts the canonical order", () => {
    expect(validateManifest(GOOD)).toEqual([]);
    expect(() => assertValidManifest(GOOD)).not.toThrow();
  });

  describe("negative controls: the validator bites", () => {
    it("a volatile segment before a static one in a region", () => {
      const bad = [
        seg("date", "request", "system"),
        seg("turn.act", "static", "system"),
      ];
      const v = validateManifest(bad);
      expect(v.map((x) => x.rule)).toContain("request-outside-tail");
      expect(v.map((x) => x.rule)).toContain("rank-inversion");
      expect(() => assertValidManifest(bad)).toThrow(/Invalid prompt manifest/);
    });

    it("a session segment before a static one in the same region", () => {
      const v = validateManifest([
        seg("rules.session", "session", "system"),
        seg("turn.act", "static", "system"),
      ]);
      expect(v.map((x) => x.rule)).toEqual(["rank-inversion"]);
    });

    it("regions out of order", () => {
      const v = validateManifest([
        seg("history", "turn", "history"),
        seg("turn.act", "static", "system"),
      ]);
      expect(v.map((x) => x.rule)).toEqual(["region-order"]);
    });

    it("a format segment together with native tools", () => {
      const v = validateManifest([
        seg("tools.builtin", "static", "tools"),
        seg("format.agent", "static", "system", "x", { source: "format" }),
      ]);
      expect(v.map((x) => x.rule)).toEqual(["format-with-native-tools"]);
    });

    it("a format segment without native tools is fine", () => {
      expect(
        validateManifest([
          seg("format.agent", "static", "system", "x", { source: "format" }),
        ]),
      ).toEqual([]);
    });

    it("duplicate ids", () => {
      const v = validateManifest([
        seg("a", "static", "system"),
        seg("a", "static", "system"),
      ]);
      expect(v.map((x) => x.rule)).toEqual(["duplicate-id"]);
    });

    it("a timestamp in a static segment breaks the shared prefix", () => {
      const base = GOOD;
      const stamped = GOOD.map((s) =>
        s.id === "turn.act" ? seg("turn.act", "static", "system", "t=1") : s,
      );
      expect(commonPrefixLength(base, stamped)).toBe(2);
    });

    it("a shuffled tool list changes the tools hash", () => {
      const a = seg("tools.builtin", "static", "tools", '["a","b"]');
      const b = seg("tools.builtin", "static", "tools", '["b","a"]');
      expect(a.hash).not.toBe(b.hash);
    });
  });

  it("names volatile-early segments and the offenders they expose", () => {
    const withSummary = [
      ...GOOD.slice(0, 4),
      seg("summary.compaction", "turn", "system", "s", {
        exposedTo: ["summary-in-system"],
      }),
      ...GOOD.slice(4),
    ];
    expect(volatileEarly(GOOD)).toEqual([]);
    expect(volatileEarly(withSummary).map((s) => s.id)).toEqual([
      "summary.compaction",
    ]);
    expect(visibleOffenders(withSummary)).toEqual(["summary-in-system"]);
  });

  it("first_changed_vs_prev names the first prefix segment that differs", () => {
    expect(firstChangedVsPrev(GOOD, undefined)).toBe("first");
    expect(firstChangedVsPrev(GOOD, GOOD)).toBe("none");
    const changed = GOOD.map((s) =>
      s.id === "rules.session"
        ? seg("rules.session", "session", "system", "new")
        : s,
    );
    expect(firstChangedVsPrev(changed, GOOD)).toBe("rules.session");
    // history and the tail are not compared
    const grown = GOOD.map((s) =>
      s.id === "history" ? seg("history", "turn", "history", "more") : s,
    );
    expect(firstChangedVsPrev(grown, GOOD)).toBe("none");
  });

  it("checks budgets by base id", () => {
    const s = [
      seg("rules.session:style", "session", "system", "x".repeat(400)),
    ];
    expect(overBudget(s, { "rules.session": { maxTokens: 100 } })).toEqual([]);
    expect(overBudget(s, { "rules.session": { maxTokens: 99 } })).toHaveLength(
      1,
    );
    expect(overBudget(s, {})).toEqual([]);
  });
});

describe("the dump", () => {
  it("is enabled by 1 or true only", () => {
    expect(promptSegmentsEnabled("1")).toBe(true);
    expect(promptSegmentsEnabled("true")).toBe(true);
    expect(promptSegmentsEnabled(undefined)).toBe(false);
    expect(promptSegmentsEnabled("0")).toBe(false);
  });

  it("prints one line per segment, never contents", () => {
    const secret = "SECRET-PROMPT-TEXT";
    const segs = [
      seg("turn.act", "static", "system", secret),
      ...GOOD.slice(4),
    ];
    const lines = describeSegments(segs);
    expect(lines).toHaveLength(segs.length + 1);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines[0]).toMatch(
      /^ {2}turn\.act region=system stability=static tokens=5 hash8=[0-9a-f]{8}$/,
    );
  });

  it("remembers the previous request and builds nothing when not called", () => {
    const out: string[] = [];
    const dump = createSegmentDump((l) => out.push(l));
    let built = 0;
    const build = (rules: string) => () => {
      built++;
      return GOOD.map((s) =>
        s.id === "rules.session" ? seg(s.id, "session", "system", rules) : s,
      );
    };
    expect(built).toBe(0);
    dump("model=m mode=agent", build("a"));
    dump("model=m mode=agent", build("a"));
    dump("model=m mode=agent", build("b"));
    const marks = out.filter((l) => l.includes("first_changed_vs_prev"));
    expect(marks.map((l) => l.split("first_changed_vs_prev=")[1])).toEqual([
      "first",
      "none",
      "rules.session",
    ]);
    expect(out[0]).toBe("[prompt-segments] req=1 model=m mode=agent");
  });
});
