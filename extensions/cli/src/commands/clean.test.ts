import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanCommand } from "./clean.js";

let root: string;
let out: string[];
let err: string[];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-clean-"));
  fs.mkdirSync(path.join(root, "logs"));
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function oldLog(name: string) {
  const f = path.join(root, "logs", name);
  fs.writeFileSync(f, "private contents");
  const t = new Date(Date.now() - 90 * 86_400_000);
  fs.utimesSync(f, t, t);
  return f;
}

describe("continuous clean", () => {
  it("is a dry run by default and never prints contents", () => {
    const f = oldLog("cn.log");
    expect(cleanCommand({ root }, io())).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
    expect(out.join("\n")).toContain("Dry run");
    expect(out.join("\n")).toContain("not secure erasure");
    expect(out.join("\n")).not.toContain("private contents");
  });

  it("deletes with --yes, but not with --yes --dry-run", () => {
    const f = oldLog("cn.log");
    cleanCommand({ root, yes: true, dryRun: true }, io());
    expect(fs.existsSync(f)).toBe(true);
    expect(cleanCommand({ root, yes: true }, io())).toBe(0);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("rejects a bad age", () => {
    expect(cleanCommand({ root, olderThan: "soon" }, io())).toBe(2);
    expect(err.join("")).toContain("Bad --older-than");
  });
});
