import { describe, expect, it } from "vitest";
import type { ChatMessage } from "..";
import {
  compareReplayPolicies,
  formatReplayReport,
  messageTokens,
  normalizeHistory,
  policyMaskBatched,
  policyMaskEveryRequest,
  policyNone,
  replayHistory,
  requestPoints,
  syntheticHistory,
} from "./cacheReplay";

describe("requestPoints and normalizeHistory", () => {
  it("makes a request at each assistant message after the first", () => {
    const h = syntheticHistory({ turns: 3 });
    expect(requestPoints(h)).toEqual([1, 3, 5, 7]);
  });

  it("accepts messages, history items and sessions", () => {
    const h = syntheticHistory({ turns: 1 });
    expect(normalizeHistory(h)).toEqual(h);
    expect(normalizeHistory(h.map((message) => ({ message })))).toEqual(h);
    expect(
      normalizeHistory({ history: h.map((message) => ({ message })) }),
    ).toEqual(h);
    expect(() => normalizeHistory({})).toThrow();
  });
});

describe("replayHistory with no policy", () => {
  it("reads the whole previous request when warm and writes only the new part", () => {
    const h = syntheticHistory({ turns: 10, largeShare: 0 });
    const { perRequest, summary } = replayHistory(h, policyNone());
    expect(perRequest[0].cacheRead).toBe(0);
    expect(perRequest[0].coldStart).toBe(true);
    for (const r of perRequest.slice(1)) {
      expect(r.rebuild).toBe(false);
      expect(r.cacheRead + r.cacheWrite).toBe(r.tokens);
      expect(r.cacheRead).toBe(perRequest[r.index - 1].tokens);
    }
    expect(summary.rebuilds).toBe(0);
    expect(summary.requests).toBe(perRequest.length);
    expect(summary.readShare).toBeGreaterThan(0.8);
  });

  it("counts a request after the lifetime as cold, with no read", () => {
    const h = syntheticHistory({ turns: 3, largeShare: 0 });
    const { perRequest, summary } = replayHistory(h, policyNone(), {
      gapSeconds: [30, 30, 400, 30],
    });
    expect(perRequest[2].cacheAlive).toBe(false);
    expect(perRequest[2].cacheRead).toBe(0);
    expect(perRequest[2].rebuild).toBe(false);
    expect(summary.coldRequests).toBe(1);
  });

  it("prices a 1 hour lifetime higher on writes", () => {
    const h = syntheticHistory({ turns: 3 });
    const five = replayHistory(h, policyNone()).summary.cost;
    const hour = replayHistory(h, policyNone(), { ttlSeconds: 3600 }).summary
      .cost;
    expect(hour).toBeGreaterThan(five);
  });
});

describe("ageing policies in the replay", () => {
  const h = syntheticHistory({ turns: 80, seed: 3 });

  it("masking every request rewrites the prefix on most requests", () => {
    const { summary } = replayHistory(
      h,
      policyMaskEveryRequest({ keepRecent: 5 }),
    );
    expect(summary.rebuilds).toBeGreaterThan(40);
  });

  it("batched masking rebuilds rarely and sends fewer tokens", () => {
    const none = replayHistory(h, policyNone()).summary;
    const batched = replayHistory(
      h,
      policyMaskBatched({ triggerTokens: 30000, keepRecent: 5 }),
    );
    expect(batched.summary.rebuilds).toBeGreaterThan(0);
    expect(batched.summary.rebuilds).toBeLessThan(10);
    expect(batched.summary.peakTokens).toBeLessThan(none.peakTokens);
    expect(batched.summary.masked).toBeGreaterThan(0);
  });

  it("batched masking costs less than masking every request", () => {
    const rows = compareReplayPolicies(h, [
      policyNone,
      () => policyMaskEveryRequest({ keepRecent: 5 }),
      () => policyMaskBatched({ triggerTokens: 30000, keepRecent: 5 }),
    ]);
    expect(rows[2].cost).toBeLessThan(rows[1].cost);
  });

  it("a cold-only policy never rewrites a warm cache", () => {
    const { summary } = replayHistory(
      h,
      policyMaskBatched({ triggerTokens: 20000, onlyWhenCold: true }),
    );
    expect(summary.rebuilds).toBe(0);
    expect(summary.masked).toBe(0);
  });

  it("a cold-only policy masks when a cold gap arrives", () => {
    const gaps = Array(200).fill(30);
    gaps[60] = 900;
    const { summary } = replayHistory(
      h,
      policyMaskBatched({ triggerTokens: 20000, onlyWhenCold: true }),
      { gapSeconds: gaps },
    );
    expect(summary.masked).toBeGreaterThan(0);
    expect(summary.rebuilds).toBe(0);
  });

  it("keeps the stub bytes stable between batches", () => {
    const policy = policyMaskBatched({ triggerTokens: 30000, keepRecent: 5 });
    const ctx = { requestIndex: 0, tokens: 0, cacheAlive: false };
    const a = policy.apply(h.slice(0, 120), ctx);
    const b = policy.apply(h.slice(0, 122), { ...ctx, cacheAlive: true });
    const stubs = (m: ChatMessage[]) =>
      m.filter(
        (x) => x.role === "tool" && x.content.startsWith("[tool result masked"),
      );
    expect(stubs(b).slice(0, stubs(a).length)).toEqual(stubs(a));
  });
});

describe("helpers", () => {
  it("estimates image parts and tool call arguments", () => {
    const img = {
      role: "user",
      content: [{ type: "imageUrl", imageUrl: { url: "data:x" } }],
    } as ChatMessage;
    expect(messageTokens(img)).toBeGreaterThan(900);
    const call: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ function: { name: "a", arguments: "b".repeat(400) } }],
    };
    expect(messageTokens(call)).toBeGreaterThan(100);
  });

  it("formats a table with a delta against the first row", () => {
    const rows = compareReplayPolicies(syntheticHistory({ turns: 10 }), [
      policyNone,
      () => policyMaskBatched({ triggerTokens: 1000, keepRecent: 2 }),
    ]);
    const text = formatReplayReport(rows);
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("| none |");
    expect(text).toContain("0.0%");
  });

  it("the synthetic history is deterministic", () => {
    expect(syntheticHistory({ seed: 7 })).toEqual(
      syntheticHistory({ seed: 7 }),
    );
    expect(syntheticHistory({ seed: 7 })).not.toEqual(
      syntheticHistory({ seed: 8 }),
    );
  });
});
