import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { secretsCommand } from "./secrets.js";

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomFrom(seed: number, alphabet: string, n: number): string {
  let s = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out += alphabet[(s >>> 8) % alphabet.length];
  }
  return out;
}

let dir: string;
let out: string[];
let err: string[];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-secrets-"));
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Built at runtime: no secret-shaped literal in this file.
const token = () => ["gh", "p_", randomFrom(2, ALNUM, 36)].join("");

describe("continuous secrets scan", () => {
  it("exits 3, names rule, file, line and fingerprint, and never prints the value", () => {
    const file = path.join(dir, "capture.txt");
    const t = token();
    fs.writeFileSync(file, `one\ntwo token=${t}\n`);
    const code = secretsCommand(
      "scan",
      [dir],
      { profile: "outbound", known: false },
      io(),
    );
    expect(code).toBe(3);
    const text = out.join("\n");
    expect(text).toContain("capture.txt:2:11");
    expect(text).toContain("github-pat");
    expect(text).not.toContain(t);
    expect(text).not.toContain(t.slice(0, 10));
  });

  it("exits 0 on clean files and prints JSON with --json", () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "nothing here\n");
    const code = secretsCommand(
      "scan",
      [dir],
      { json: true, known: false },
      io(),
    );
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.findings).toEqual([]);
    expect(report.filesScanned).toBe(1);
  });

  it("skips binary files and says so, and uses 2 for usage errors", () => {
    fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 3]));
    expect(secretsCommand("scan", [dir], { known: false }, io())).toBe(0);
    expect(out.join("\n")).toContain("skipped (binary)");
    expect(secretsCommand("scan", [], {}, io())).toBe(2);
    expect(secretsCommand("scan", [dir], { profile: "x" }, io())).toBe(2);
    expect(secretsCommand("nope", [], {}, io())).toBe(2);
    expect(secretsCommand("scan", [path.join(dir, "missing")], {}, io())).toBe(
      2,
    );
  });

  it("finds a value from the machine's own files by value", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
    const secret = randomFrom(4, ALNUM, 40);
    fs.writeFileSync(
      path.join(home, ".aws", "credentials"),
      `[default]\naws_secret_access_key = ${secret}\n`,
    );
    const target = path.join(dir, "scan-me.txt");
    fs.writeFileSync(target, `leak: ${secret}\n`);
    const code = secretsCommand(
      "scan",
      [target],
      { home, profile: "outbound" },
      io(),
    );
    expect(code).toBe(3);
    expect(out.join("\n")).toContain("known-value");
    expect(out.join("\n")).not.toContain(secret);
  });
});
