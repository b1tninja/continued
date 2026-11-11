import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { canary } from "./scrubForDisk.vitest";
import { runSecretsScan } from "./secretsCli";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("secrets scan --history", () => {
  it("finds a canary in our stores, reads Claude Code only on request, never prints the value", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hist-"));
    dirs.push(base);
    const global = path.join(base, "g");
    const home = path.join(base, "h");
    fs.mkdirSync(path.join(global, "logs"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude", "projects", "p"), {
      recursive: true,
    });
    const c = canary();
    fs.writeFileSync(
      path.join(global, "logs", "cn.log"),
      `key=${c.anthropic}\n`,
    );
    const tr = path.join(home, ".claude", "projects", "p", "t.jsonl");
    const body = `{"text":"${c.github}"}\n`;
    fs.writeFileSync(tr, body);

    const run = (extra: object) => {
      const lines: string[] = [];
      const code = runSecretsScan(
        [],
        {
          history: true,
          globalDir: global,
          home,
          known: false,
          salt: "s",
          ...extra,
        },
        { out: (l) => lines.push(l), err: (l) => lines.push(l) },
      );
      return { code, text: lines.join("\n") };
    };
    const ours = run({});
    expect(ours.code).toBe(3);
    expect(ours.text).toContain("cn.log");
    expect(ours.text).not.toContain("t.jsonl");
    expect(ours.text).toContain("Rotate");
    const both = run({ includeClaudeCode: true });
    expect(both.text).toContain("t.jsonl");
    for (const v of Object.values(c)) {
      expect(both.text).not.toContain(v);
    }
    expect(fs.readFileSync(tr, "utf8")).toBe(body);
  });
});
