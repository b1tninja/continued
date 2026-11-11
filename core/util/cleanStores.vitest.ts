import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS, parseAge, planClean, runClean } from "./cleanStores";

const roots: string[] = [];
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-"));
  roots.push(root);
  for (const d of ["sessions", "dev_data/0.2.0", "logs"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}
const aged = (f: string, days: number) => {
  const t = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(f, t, t);
};
afterEach(() => {
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

describe("clean", () => {
  it("parses ages", () => {
    expect(parseAge("30d")).toBe(30 * DAY_MS);
    expect(parseAge("2w")).toBe(14 * DAY_MS);
    expect(parseAge("x")).toBeUndefined();
    expect(parseAge("0")).toBeUndefined();
  });

  it("plans without touching anything, then deletes only old own files", () => {
    const root = tree();
    const oldS = path.join(root, "sessions", "a.json");
    const newS = path.join(root, "sessions", "b.json");
    const list = path.join(root, "sessions", "sessions.json");
    const log = path.join(root, "logs", "core.log");
    const other = path.join(root, "config.yaml");
    const jl = path.join(root, "dev_data", "0.2.0", "toolUsage.jsonl");
    fs.writeFileSync(oldS, "{}");
    fs.writeFileSync(newS, "{}");
    fs.writeFileSync(
      list,
      JSON.stringify([{ sessionId: "a" }, { sessionId: "b" }]),
    );
    fs.writeFileSync(log, "x");
    fs.writeFileSync(other, "keep");
    const old = new Date(Date.now() - 60 * DAY_MS).toISOString();
    const recent = new Date().toISOString();
    fs.writeFileSync(
      jl,
      `${JSON.stringify({ timestamp: old })}\n${JSON.stringify({ timestamp: recent })}\nnot json\n`,
    );
    aged(oldS, 40);
    aged(log, 40);
    aged(other, 400);

    const plan = planClean(root, 30 * DAY_MS);
    expect(plan.entries.map((e) => path.basename(e.file)).sort()).toEqual([
      "a.json",
      "core.log",
      "toolUsage.jsonl",
    ]);
    expect(fs.existsSync(oldS)).toBe(true);

    const res = runClean(plan);
    expect(res.failed).toEqual([]);
    expect(fs.existsSync(oldS)).toBe(false);
    expect(fs.existsSync(newS)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(
      fs.readFileSync(jl, "utf8").split("\n").filter(Boolean),
    ).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(list, "utf8"))).toEqual([
      { sessionId: "b" },
    ]);
  });

  it("refuses a path outside the root", () => {
    const root = tree();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    roots.push(outside);
    const victim = path.join(outside, "v.json");
    fs.writeFileSync(victim, "{}");
    const r = runClean({
      root,
      cutoff: new Date(),
      bytes: 0,
      skipped: [],
      entries: [{ store: "sessions", file: victim, bytes: 2, action: "file" }],
    });
    expect(r.failed).toEqual([victim]);
    expect(fs.existsSync(victim)).toBe(true);
  });
});
