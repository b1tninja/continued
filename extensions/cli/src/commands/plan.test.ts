import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planListCommand, preparePlanBuild } from "./plan.js";

let cwd: string;
let dir: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plancmd-"));
  dir = path.join(cwd, ".continuous", "plans");
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const io = () => {
  const lines: string[] = [];
  return {
    lines,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(l),
  };
};

describe("plan list", () => {
  it("prints rows and json", () => {
    fs.writeFileSync(
      path.join(dir, "a.md"),
      "# A\n\n## To-dos\n\n- [x] one <!-- id: 1 -->\n- [ ] two <!-- id: 2 -->\n",
    );
    const text = io();
    expect(planListCommand({}, cwd, text)).toBe(0);
    expect(text.lines[1]).toMatch(
      /^in-progress\s+1\/2\s+\S+ \S+\s+\.continuous\/plans\/a\.md\s+A$/,
    );
    const json = io();
    planListCommand({ json: true }, cwd, json);
    const [row] = JSON.parse(json.lines[0]);
    expect(row).toMatchObject({
      name: "a",
      status: "in-progress",
      done: 1,
      total: 2,
    });
    expect(row.file).toBeUndefined();
  });

  it("says so when there are no plans", () => {
    const text = io();
    planListCommand({}, path.join(cwd, "x"), text);
    expect(text.lines[0]).toContain("No plans");
  });
});

describe("plan build preparation", () => {
  it("refuses traversal, drafts and done plans", () => {
    fs.writeFileSync(path.join(dir, "d.md"), "# D\n");
    fs.writeFileSync(path.join(dir, "ok.md"), "# O\n\n## To-dos\n\n- [x] a\n");
    expect(preparePlanBuild("../d", {}, cwd).ok).toBe(false);
    expect(preparePlanBuild("d", {}, cwd)).toMatchObject({ ok: false });
    expect(preparePlanBuild("ok", {}, cwd)).toMatchObject({
      ok: false,
      error: expect.stringContaining("done"),
    });
    expect(preparePlanBuild("d", { force: true }, cwd).ok).toBe(true);
  });

  it("builds an approved plan", () => {
    fs.writeFileSync(path.join(dir, "a.md"), "# A\n\n## To-dos\n\n- [ ] one\n");
    const r = preparePlanBuild("a", {}, cwd);
    expect(r.ok && r.prompt).toContain("Start at step 1.");
  });
});
