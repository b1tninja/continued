import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { reviewEvalCommand, type ReviewEvalDeps } from "./reviewEval.js";

const DATASET = join(
  __dirname,
  "../../../../core/tools/permissions/auto/evaluation/datasets/reviewer-starter.json",
);
const text = readFileSync(DATASET, "utf8");
const dataset = JSON.parse(text);

function setup(chat?: ReviewEvalDeps["createClient"]) {
  const out: string[] = [];
  const err: string[] = [];
  const createClient = vi.fn(
    chat ??
      (async () => ({
        model: "fake-model",
        client: {
          chat: async (messages: any[]) => {
            const body = String(messages[1].content);
            const hit = dataset.cases.find(
              (c: any) =>
                body.includes(`arguments: ${JSON.stringify(c.args)}`) &&
                body.includes(`1. ${c.history.userMessages[0]}`),
            );
            return {
              role: "assistant",
              content: JSON.stringify(
                hit?.expected === "allow"
                  ? { decision: "allow", reason: "ok" }
                  : {
                      decision: hit?.expected ?? "ask",
                      category: hit?.category ?? "uncertain",
                      reason: "labelled",
                    },
              ),
            };
          },
        } as any,
      })),
  );
  const deps: ReviewEvalDeps = {
    readFile: (p) => {
      if (p === "ds.json") return text;
      if (p === "g.md") return "- Ask before touching infra/\n";
      throw new Error(`ENOENT ${p}`);
    },
    createClient,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, createClient };
}

describe("continuous review-eval", () => {
  it("is a dry run by default: prints a cost plan and builds no client", async () => {
    const { deps, out, createClient } = setup();
    const code = await reviewEvalCommand({ dataset: "ds.json" }, deps);
    expect(code).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    const all = out.join("\n");
    expect(all).toContain("Dry run: no model was called");
    expect(all).toContain("--run");
    expect(all).toMatch(/Calls: 80 /);
  });

  it("dry run with --json is machine-readable and still calls nothing", async () => {
    const { deps, out, createClient } = setup();
    await reviewEvalCommand(
      { dataset: "ds.json", compare: "default", json: true },
      deps,
    );
    expect(createClient).not.toHaveBeenCalled();
    const j = JSON.parse(out.join("\n"));
    expect(j.dryRun).toBe(true);
    expect(j.plan.configs).toBe(2);
    expect(j.plan.calls).toBe(160);
  });

  it("--run scores, prints the cost plan first and exits 0 on a clean run", async () => {
    const { deps, out, createClient } = setup();
    const code = await reviewEvalCommand(
      { dataset: "ds.json", reviewer: "fake", run: true },
      deps,
    );
    expect(code).toBe(0);
    expect(createClient).toHaveBeenCalledWith("fake");
    const all = out.join("\n");
    expect(all.indexOf("Estimated input")).toBeLessThan(
      all.indexOf("Agreement with labels"),
    );
    expect(all).toContain("False-allow on floor cases");
    expect(all).toContain("Format-failure rate");
    expect(all).toContain("By policy area");
    expect(all).toContain("insufficient data"); // no baseline given
  });

  it("A/B with --compare reports paired counts and a safe verdict", async () => {
    const { deps, out } = setup();
    const code = await reviewEvalCommand(
      {
        dataset: "ds.json",
        guidance: "g.md",
        compare: "default",
        run: true,
        json: true,
      },
      deps,
    );
    expect(code).toBe(0);
    const j = JSON.parse(out.join("\n"));
    expect(j.gate.verdict).toBe("safe to adopt");
    expect(j.paired.falseAllow.n).toBeGreaterThan(0);
    expect(j.metrics.floorFalseAllow.k).toBe(0);
  });

  it("exits 1 when the candidate allows a floor case", async () => {
    const { deps, out } = setup(async () => ({
      model: "bad",
      client: {
        chat: async () => ({
          role: "assistant",
          content: '{"decision":"allow","reason":"fine"}',
        }),
      } as any,
    }));
    const code = await reviewEvalCommand(
      { dataset: "ds.json", run: true, compare: "default" },
      deps,
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("not safe to adopt");
  });

  it("reports a missing dataset, a bad file and a missing reviewer", async () => {
    const a = setup();
    expect(await reviewEvalCommand({}, a.deps)).toBe(1);
    expect(a.err.join("\n")).toContain("--dataset");

    const b = setup();
    expect(await reviewEvalCommand({ dataset: "nope.json" }, b.deps)).toBe(1);
    expect(b.err.join("\n")).toContain("ENOENT");

    const c = setup(async () => null);
    expect(
      await reviewEvalCommand({ dataset: "ds.json", run: true }, c.deps),
    ).toBe(1);
    expect(c.err.join("\n")).toContain("No reviewer model");
  });
});
