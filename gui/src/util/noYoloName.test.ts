import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The top level of every area is called IDGAF. `yolo` is what 2.14.x called
// it, and it is still read: the only places the word may stay are the ones
// that read it, listed here. A new use anywhere else fails this test.
const REPO = path.resolve(__dirname, "../../..");

const ROOTS = [
  "core",
  "gui/src",
  "extensions/cli/src",
  "extensions/vscode/src",
  "bench",
  "docs",
];

const ALLOWED = new Set([
  // the alias, and the 2.4.4 approval mode that is read as a permissive level
  "core/tools/permissions/policy.ts",
  "core/util/loopMode.ts",
  "core/tools/permissions/settingsFile.ts",
  "core/util/sandboxPolicy.ts",
  "core/tools/permissions/audit/reader.ts",
  // detects the phrase "yolo mode" in text a model is shown
  "core/tools/permissions/injection.ts",
  "extensions/cli/src/permissions/policyLevels.ts",
  "gui/src/pages/gui/ToolCallDiv/DecisionChip.tsx",
  "gui/src/redux/slices/uiSlice.ts",
  "bench/runner.mjs",
  // says once that earlier versions used the word
  "docs/ide-extensions/agent/permissions-page.mdx",
]);

const SKIP_DIR = new Set(["node_modules", "dist", "out", "build", ".git"]);
const TEXT = /\.(ts|tsx|js|mjs|json|md|mdx|yaml|yml)$/;
const IS_TEST = /\.(test|vitest)\.[tj]sx?$|\.measure\./;

function walk(dir: string, found: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // a folder a running test just removed
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (TEXT.test(entry.name) && !IS_TEST.test(entry.name)) {
      found.push(full);
    }
  }
}

describe("the name YOLO", () => {
  it("is not in user-visible text or new code outside the alias lines", () => {
    const files: string[] = [];
    for (const root of ROOTS) {
      const dir = path.join(REPO, root);
      if (fs.existsSync(dir)) walk(dir, files);
    }
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        try {
          return /yolo/i.test(fs.readFileSync(path.join(REPO, rel), "utf-8"));
        } catch {
          return false;
        }
      });
    expect(offenders).toEqual([]);
  });

  it("is never shown as a label, in an allowed file either", () => {
    for (const rel of ALLOWED) {
      const text = fs.readFileSync(path.join(REPO, rel), "utf-8");
      expect(text, rel).not.toMatch(/"YOLO"|>YOLO</);
    }
  });
});
