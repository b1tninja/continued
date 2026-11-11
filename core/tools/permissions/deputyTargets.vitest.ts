import { describe, expect, it } from "vitest";
import { deputyCallHit } from "./deputyCall";
import { deputyTargets, literalPrefix } from "./deputyTargets";

describe("literalPrefix", () => {
  it.each([
    ["/etc/**", "/etc"],
    ["../../**/.env", "../.."],
    ["src/**/*.ts", "src"],
    ["**/*.ts", undefined],
    ["*.ts", undefined],
    ["src/a.ts", "src"],
    ["/**", "/"],
    ["C:/Users/**", "C:/Users"],
  ])("%s", (pattern, expected) => {
    expect(literalPrefix(pattern)).toBe(expected);
  });
});

describe("deputyTargets", () => {
  it("reads a search path and a glob prefix", () => {
    expect(
      deputyTargets("grep_search", { query: "x", path: "/etc" }, false),
    ).toEqual({
      paths: ["/etc"],
      single: true,
    });
    expect(deputyTargets("grep_search", { query: "x" }, false)).toBeUndefined();
    expect(
      deputyTargets("file_glob_search", { pattern: "../**/*.key" }, false)
        ?.paths,
    ).toEqual([".."]);
  });

  it("reads path-named MCP arguments only", () => {
    const t = deputyTargets(
      "mcp__s__t",
      {
        path: "/a",
        content: "/b",
        nested: { target_dir: "/c", other: "/d" },
        files: ["/e", 3, "https://x/y"],
        url: "https://x",
      },
      true,
    );
    expect(t?.paths.sort()).toEqual(["/a", "/c", "/e"]);
  });
});

describe("deputyCallHit for search and MCP calls", () => {
  const at = {
    cwd: "/home/me/proj",
    home: "/home/me",
    flavor: "posix",
  } as const;

  it("asks for a glob that climbs out or starts elsewhere, not for one inside", () => {
    for (const pattern of ["../**/*.ts", "/etc/**", "~/.continuous/**"]) {
      expect(
        deputyCallHit({
          toolName: "file_glob_search",
          parsedArgs: { pattern },
          ...at,
        })?.kind,
        pattern,
      ).toBe("file-deputy");
    }
    for (const pattern of ["**/*.ts", "src/**/*.ts"]) {
      expect(
        deputyCallHit({
          toolName: "file_glob_search",
          parsedArgs: { pattern },
          ...at,
        }),
      ).toBeUndefined();
    }
  });

  it("asks for a search path elsewhere, honouring the switch", () => {
    const parsedArgs = { query: "x", path: "/srv" };
    expect(
      deputyCallHit({ toolName: "grep_search", parsedArgs, ...at }),
    ).toBeDefined();
    expect(
      deputyCallHit({
        toolName: "grep_search",
        parsedArgs,
        approval: { builtin: { "ask-outside-paths": false } },
        ...at,
      }),
    ).toBeUndefined();
  });

  it("asks for an MCP path argument, on both flavors' spellings", () => {
    expect(
      deputyCallHit({
        toolName: "mcp__s__t",
        parsedArgs: { path: "/srv/x" },
        mcp: true,
        ...at,
      }),
    ).toBeDefined();
    expect(
      deputyCallHit({
        toolName: "mcp__s__t",
        parsedArgs: { file: "NUL" },
        mcp: true,
        cwd: "C:/proj",
        home: "C:/Users/me",
        flavor: "win32",
      })?.path,
    ).toContain("device");
    expect(
      deputyCallHit({
        toolName: "mcp__s__t",
        parsedArgs: { path: "src/a.ts" },
        mcp: true,
        ...at,
      }),
    ).toBeUndefined();
  });
});
