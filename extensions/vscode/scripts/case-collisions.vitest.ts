import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "../../..");

const CODE = /\.[cm]?[jt]sx?$/;

/**
 * Two tracked files that a case-insensitive file system (Windows, macOS)
 * cannot tell apart: the same directory and the same name, ignoring case, and
 * either the same extension or two code extensions that resolve from the same
 * import specifier (`McpAppTurn.tsx` and `mcpAppTurn.ts` are both
 * `./mcpAppTurn`). Linux CI cannot see these; the Windows build breaks.
 */
export function caseCollisions(files: string[]): string[][] {
  const identity = (file: string) => {
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file);
    return `${dir}/${CODE.test(base) ? base.replace(CODE, "") : base}`;
  };
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = identity(file).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  // A collision needs a difference in case; `a.js` beside `a.mjs` is fine.
  return [...groups.values()].filter(
    (group) => new Set(group.map(identity)).size > 1,
  );
}

describe("case collisions", () => {
  it("finds files that differ only in case", () => {
    expect(
      caseCollisions(["a/Readme.md", "a/README.md", "a/other.md"]),
    ).toEqual([["a/Readme.md", "a/README.md"]]);
  });

  it("finds modules that resolve from one specifier on a case-insensitive file system", () => {
    expect(
      caseCollisions(["gui/McpAppTurn.tsx", "gui/mcpAppTurn.ts", "gui/x.ts"]),
    ).toEqual([["gui/McpAppTurn.tsx", "gui/mcpAppTurn.ts"]]);
  });

  it("leaves a module and its test, and different directories, alone", () => {
    expect(
      caseCollisions([
        "a/foo.ts",
        "a/foo.test.ts",
        "a/foo.vitest.ts",
        "a/Foo/index.ts",
        "b/Foo.ts",
        "a/foo.md",
      ]),
    ).toEqual([]);
  });

  it("has none in the tracked files", () => {
    const files = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    expect(caseCollisions(files)).toEqual([]);
  });
});
