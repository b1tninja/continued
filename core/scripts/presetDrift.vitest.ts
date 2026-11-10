import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_DIALECT_PRESETS } from "../util/toolDialectPresetTable";

const SCRIPT = path.resolve(__dirname, "preset-drift.mjs");
const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("preset-drift script", () => {
  it("reads every row of the table, with its date and sources", () => {
    const out = run("--today", "2099-01-01", "--days", "1");
    expect(out.stdout).toContain(`${TOOL_DIALECT_PRESETS.length} rows`);
    for (const p of TOOL_DIALECT_PRESETS) {
      expect(out.stdout, p.id).toContain(`${p.id}  readOn ${p.readOn}`);
      for (const url of p.source.filter((s) => s.startsWith("http"))) {
        expect(out.stdout, p.id).toContain(`recheck ${url}`);
      }
    }
  });

  it("is quiet and exits 0 while every row is fresh", () => {
    const out = run("--today", "2026-11-11", "--days", "90");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("0 read more than");
  });

  it("exits 1 past the threshold and 0 within it", () => {
    expect(run("--today", "2099-01-01").status).toBe(1);
    const n = String(TOOL_DIALECT_PRESETS.length);
    expect(run("--today", "2099-01-01", "--max-stale", n).status).toBe(0);
  });

  it("is not wired into CI", () => {
    const root = path.resolve(__dirname, "../..");
    const hits = execFileSync(
      process.execPath,
      [
        "-e",
        `const fs=require("fs"),p=require("path");let hit=[];` +
          `const d=p.join(${JSON.stringify(root)},".github","workflows");` +
          `for(const f of fs.existsSync(d)?fs.readdirSync(d):[])` +
          `if(fs.readFileSync(p.join(d,f),"utf8").includes("preset-drift"))hit.push(f);` +
          `console.log(hit.join(","))`,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(hits).toBe("");
  });
});
