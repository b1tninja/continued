import path from "path";
import { fileURLToPath } from "url";

import { describe, expect, it } from "vitest";

import {
  loopStatsOf,
  messagesOfRequest,
  nudgeKindsOf,
  prefixChurn,
  prefixChurnOf,
  readJson,
} from "../src/common.mjs";

/**
 * Tier 0 of the model benchmark (plans/model-benchmark.md): the scorer's
 * columns for the tail measurement (plans/ROADMAP.md row I6) on fixture
 * dumps and a fixture history, no provider needed. The fixtures are written
 * by fixtures/make.mjs, which says what each one is shaped like.
 *
 * Run from extensions/cli: npx vitest run --dir ../../bench/tier0
 */
const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const dumps = (name: string) => path.join(fixtures, "dumps", name);

describe("prefix churn from the request dumps", () => {
  it("counts no churn when every request extends the one before", () => {
    const churn = prefixChurnOf(dumps("extends"));
    expect(churn).toMatchObject({ requests: 4, churned: 0, first: null });
    expect(churn.all).toEqual([]);
  });

  it("counts each request that does not extend its predecessor, with the first differing message", () => {
    const churn = prefixChurnOf(dumps("churn"));
    expect(churn.requests).toBe(5);
    expect(churn.churned).toBe(3);
    // The system text changed at the plan to act switch
    expect(churn.first).toMatchObject({
      request: 3,
      message: 0,
      file: "request-003.json",
    });
    expect(churn.all.map((c) => [c.request, c.message])).toEqual([
      [3, 0],
      // A tail added to the first user message rewrites it
      [4, 1],
      // A shorter request differs at its own length
      [5, 2],
    ]);
    expect(churn.all[2]).toMatchObject({ previousLength: 6, length: 2 });
  });

  it("puts a system field of its own first, so an extension still reads as one", () => {
    const churn = prefixChurnOf(dumps("system-field"));
    expect(churn).toMatchObject({ requests: 2, churned: 0 });
    const body = readJson(path.join(dumps("system-field"), "request-001.json"));
    expect(messagesOfRequest(body)[0]).toEqual({
      role: "system",
      content: "S",
    });
  });

  it("compares the JSON of each earlier message, not only the text", () => {
    const a = { role: "user", content: "x" };
    const churn = prefixChurn([
      [a],
      [a, { role: "assistant", content: "", tool_calls: [{ id: "1" }] }],
      [a, { role: "assistant", content: "", tool_calls: [{ id: "2" }] }],
    ]);
    expect(churn.churned).toBe(1);
    expect(churn.first).toMatchObject({ request: 3, message: 1 });
  });

  it("is null for a run without dumps", () => {
    expect(prefixChurnOf(path.join(fixtures, "no-such-folder"))).toBeNull();
    expect(prefixChurnOf(null)).toBeNull();
  });
});

describe("nudges by kind and requests per item attempt", () => {
  it("reads the three CLI nudges and the harness's own from the result", () => {
    expect(
      nudgeKindsOf({
        nudges: { harness: 1, cli: { act: 2, finishItem: 3, presentPlan: 0 } },
      }),
    ).toEqual({ harness: 1, act: 2, finishItem: 3, presentPlan: 0 });
    expect(nudgeKindsOf({})).toEqual({
      harness: 0,
      act: 0,
      finishItem: 0,
      presentPlan: 0,
    });
  });

  it("splits a loop history into plan requests and item attempts, answers and nudges included", () => {
    const history = readJson(path.join(fixtures, "loop-history.json"));
    const result = {
      kind: "loop",
      nudges: { harness: 0, cli: { act: 0, finishItem: 1, presentPlan: 0 } },
      loop: {
        items: [
          { id: "1", status: "done" },
          { id: "2", status: "done" },
          { id: "3", status: "failed" },
        ],
      },
    };
    const stats = loopStatsOf(result, history);
    expect(stats).toMatchObject({
      items: 3,
      itemsByStatus: { done: 2, failed: 1 },
      attempts: 3,
      withoutFinishItem: 1,
      // Two plan requests before the first item, one re-plan after the last
      planRequests: 3,
      itemRequests: 7,
      perAttempt: [3, 3, 1],
    });
    expect(stats.requestsPerAttempt).toBeCloseTo(7 / 3);
  });

  it("is null for a run that is not a loop", () => {
    expect(loopStatsOf({ kind: "agent" }, [])).toBeNull();
  });
});
