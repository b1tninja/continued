import { describe, expect, it } from "vitest";
import { detectInstructionLikeText } from "./injection";
import { INJECTION_CORPUS } from "./injectionCorpus";

function score(split: "dev" | "held" | "fresh" | "all") {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const misses: string[] = [];
  for (const s of INJECTION_CORPUS) {
    if (split !== "all" && s.split !== split) continue;
    const hit = detectInstructionLikeText(s.text).length > 0;
    if (s.injected && hit) tp++;
    else if (s.injected) {
      fn++;
      misses.push("FN " + s.text.slice(0, 70));
    } else if (hit) {
      fp++;
      misses.push("FP " + s.text.slice(0, 70));
    } else tn++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  return { tp, fp, fn, tn, precision, recall, misses };
}

describe("injection detector on the labelled corpus", () => {
  for (const split of ["dev", "held", "fresh", "all"] as const) {
    it(`reports ${split}`, () => {
      const r = score(split);
      console.log(
        split,
        JSON.stringify({ ...r, misses: undefined }),
        "\n" + r.misses.join("\n"),
      );
      expect(r.tp + r.fp + r.fn + r.tn).toBeGreaterThan(0);
      // Regression floors, not claims: the fresh split scores 0 of 10 on
      // purpose (see plans/prompt-injection.md), so only dev, held and all
      // are held to a number.
      if (split === "all") {
        expect(r.precision).toBeGreaterThanOrEqual(0.85);
        expect(r.recall).toBeGreaterThanOrEqual(0.7);
      }
      if (split === "dev" || split === "held") {
        expect(r.recall).toBe(1);
      }
    });
  }
});
