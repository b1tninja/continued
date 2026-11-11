import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOREIGN_LOADED_DIRS,
  FOREIGN_LOADED_FILES,
  PRODUCT_LOADED_PATHS,
  PRODUCT_STATE_PATHS,
} from "../../util/productPaths";
import { policyFileHit } from "./selfProtect";

const home = "C:/Users/jane";
const cwd = "C:/work/proj";
const hit = (filepath: string, tool = "create_new_file") =>
  !!policyFileHit({
    toolName: tool,
    parsedArgs: { filepath },
    home,
    cwd,
  });
const mcp = (parsedArgs: Record<string, unknown>) =>
  policyFileHit({
    toolName: "write",
    parsedArgs,
    mcp: { readonly: false },
    home,
    cwd,
  });

function withGlobalDir(dir: string | undefined, run: () => void) {
  const saved = process.env.CONTINUOUS_GLOBAL_DIR;
  if (dir === undefined) delete process.env.CONTINUOUS_GLOBAL_DIR;
  else process.env.CONTINUOUS_GLOBAL_DIR = dir;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.CONTINUOUS_GLOBAL_DIR;
    else process.env.CONTINUOUS_GLOBAL_DIR = saved;
  }
}

describe("the lock follows the effective global folder", () => {
  const saved = {
    a: process.env.CONTINUOUS_GLOBAL_DIR,
    b: process.env.CONTINUE_GLOBAL_DIR,
  };
  beforeEach(() => {
    delete process.env.CONTINUOUS_GLOBAL_DIR;
    delete process.env.CONTINUE_GLOBAL_DIR;
  });
  afterEach(() => {
    for (const [k, v] of [
      ["CONTINUOUS_GLOBAL_DIR", saved.a],
      ["CONTINUE_GLOBAL_DIR", saved.b],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("locks a custom folder, whatever is in it, and still the defaults", () => {
    process.env.CONTINUOUS_GLOBAL_DIR = "D:/cfg";
    for (const f of [
      "D:/cfg/config.yaml",
      "D:/cfg/permissions.yaml",
      "D:/cfg/trusted-hooks.json",
      "D:/cfg/mcp-tool-pins.json",
      "D:/cfg/audit/a.jsonl",
      "D:/cfg/.env",
      "D:/cfg/config.ts",
      "D:/cfg/agents/x.md",
      "D:\\CFG\\Config.YAML",
      "D:/cfg/sub/../config.yaml",
      "D:/cfg",
      "~/.continuous/config.yaml",
      "~/.continue/.env",
    ]) {
      expect(hit(f), f).toBe(true);
    }
    expect(hit("D:/cfgother/config.yaml")).toBe(false);
  });

  it("follows the legacy variable name too", () => {
    process.env.CONTINUE_GLOBAL_DIR = "E:/old";
    expect(hit("E:/old/permissions.yaml")).toBe(true);
  });

  it("locks 8.3 short names of a custom folder's name", () => {
    process.env.CONTINUOUS_GLOBAL_DIR = "D:/continuous-config";
    expect(hit("D:/CONTIN~1/config.yaml")).toBe(true);
  });

  it("does not lock a whole folder as broad as the home directory", () => {
    process.env.CONTINUOUS_GLOBAL_DIR = home;
    expect(hit("C:/Users/jane/notes.txt")).toBe(false);
    expect(hit("C:/Users/jane/config.yaml")).toBe(true);
    expect(hit("C:/Users/jane/.claude/settings.json")).toBe(true);
  });

  it("locks by name when the project lives inside the global folder", () => {
    process.env.CONTINUOUS_GLOBAL_DIR = "C:/work";
    expect(hit("C:/work/proj/src/a.ts")).toBe(false);
    expect(hit("C:/work/config.yaml")).toBe(true);
  });
});

describe("what is and is not locked", () => {
  it.each([
    "C:/Users/jane/.claude/settings.json",
    "C:/Users/jane/.claude/settings.local.json",
    "C:/work/proj/.claude/settings.json",
    "C:/work/proj/.claude/settings.local.json",
    "C:/work/proj/.claude/agents/a.md",
    "C:/Users/jane/.claude/skills/s/SKILL.md",
    "C:/work/proj/.continuous/settings.json",
    "C:/work/proj/.continue/worktrees.json",
    "C:/work/proj/.continue/.env",
    "C:/work/proj/.continue/hooks/pre.sh",
    "C:/work/proj/.continuous/reviewer/guidance.md",
    "C:/work/proj/.continuerules",
    "C:/Users/jane/.continue/config.ts",
    "C:/Users/jane/.continue/prompts/p.prompt",
    "C:/Users/jane/.continue/checks/c.md",
    "C:/Users/jane/.continuous/agents/a.md",
    "\\\\?\\C:\\Users\\jane\\.continue\\config.yaml",
    "\\\\.\\C:\\Users\\jane\\.continue\\config.yaml",
    "\\\\?\\UNC\\localhost\\C$\\Users\\jane\\.continue\\config.yaml",
    "file:///C:/Users/jane/.continue/config.yaml",
    "C:/Users/jane/CONTIN~1/CONFIG~1.YAM",
    "C:/Users/JANE~1/CONTIN~1/config.yaml",
    "C:/work/proj/.CLAUDE/Settings.json",
    "C:/work/proj/.claude./settings.json",
  ])("locks %s", (f) => {
    expect(hit(f)).toBe(true);
  });

  it.each([
    "C:/work/proj/src/a.ts",
    "C:/work/proj/.claude/commands/x.md",
    "C:/work/proj/.continuous/plans/p.md",
    "C:/work/proj/CLAUDE.md",
    "C:/work/proj/AGENTS.md",
    "C:/work/proj/.cursor/rules/x.mdc",
    "C:/work/proj/README~1.md",
  ])("leaves %s to the switchable rules", (f) => {
    expect(hit(f)).toBe(false);
  });

  it("locks the config folder itself, so deleting it is caught", () => {
    expect(hit("C:/work/proj/.continue")).toBe(true);
    expect(hit("C:/Users/jane/.claude")).toBe(true);
  });
});

describe("MCP arguments are scanned whole", () => {
  const target = "C:/Users/jane/.continue/config.yaml";

  it("finds a path however deep it sits", () => {
    expect(mcp({ a: { b: { c: target } } })).toBeTruthy();
    expect(mcp({ files: [{ path: target }] })).toBeTruthy();
    expect(mcp({ a: [[[{ d: { e: [target] } }]]] })).toBeTruthy();
  });

  it("finds a path used as a key", () => {
    expect(mcp({ files: { [target]: "x" } })).toBeTruthy();
  });

  it("finds a path inside a sentence", () => {
    expect(mcp({ note: `write to "${target}" now` })).toBeTruthy();
  });

  it("asks, and does not refuse, when the tree is too deep", () => {
    let deep: unknown = "harmless";
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(mcp({ deep })?.capped).toBe(true);
  });

  it("asks when there are too many strings", () => {
    const list = Array.from({ length: 2500 }, (_, i) => `s${i}`);
    expect(mcp({ list })?.capped).toBe(true);
  });

  it("leaves an ordinary call alone", () => {
    expect(mcp({ a: { b: { c: "C:/work/proj/src/a.ts" } } })).toBeUndefined();
  });
});

/** Source files that read config, listed from the repository. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "out", "build", "vendor"].includes(e.name)) {
      continue;
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (
      /\.tsx?$/.test(e.name) &&
      !/\.(vitest|test|d)\.tsx?$/.test(e.name) &&
      !p.includes("__tests__") &&
      !p.includes(`${path.sep}test${path.sep}`)
    ) {
      out.push(p);
    }
  }
  return out;
}

describe("every path a loader reads is in the registry", () => {
  const root = path.resolve(__dirname, "../../..");
  const known = new Set(
    [
      ...Object.keys(PRODUCT_LOADED_PATHS.files),
      ...Object.keys(PRODUCT_LOADED_PATHS.dirs),
      ...PRODUCT_STATE_PATHS,
    ].map((n) => n.toLowerCase()),
  );
  const files = [
    ...sourceFiles(path.join(root, "core")),
    ...sourceFiles(path.join(root, "extensions/cli/src")),
  ];
  /** A name joined onto the global folder or a project's config folder. */
  const patterns = [
    /getGlobalFolderWithName\(\s*"([^"]+)"/g,
    /(?:getContinueGlobalPath\(\)|continueHome|globalDir|global)\s*,\s*"([^"]+)"/g,
    /"\.continu(?:e|ous)"\s*,\s*"([A-Za-z_.-]+)"/g,
    /WORKSPACE_DIRS?\b[^\n]*?,\s*"([^"]+)"/g,
    /joinPathsToUri\([^,\n]+,\s*(?:name|WORKSPACE_DIR),\s*"([^"]+)"/g,
  ];

  it("finds the loaders it is meant to scan, and each name is registered", () => {
    const found = new Map<string, string>();
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const re of patterns) {
        for (const m of text.matchAll(re)) found.set(m[1], f);
      }
    }
    expect(found.size).toBeGreaterThan(15);
    const missing = [...found].filter(
      ([n]) => !known.has(n.toLowerCase()) && !n.startsWith(".continu"),
    );
    // A new loader's name goes in core/util/productPaths.ts, so the lock has it.
    expect(missing.map(([n, f]) => `${n} (${path.relative(root, f)})`)).toEqual(
      [],
    );
  });

  it("covers every constant of core/util/paths.ts that names a file", () => {
    const text = fs.readFileSync(path.join(root, "core/util/paths.ts"), "utf8");
    const names = [...text.matchAll(/getContinueGlobalPath\(\),\s*"([^"]+)"/g)];
    expect(names.length).toBeGreaterThan(10);
    for (const [, n] of names) expect(known.has(n.toLowerCase()), n).toBe(true);
  });
});

describe("the descriptor and the lock agree", () => {
  const names = [
    ...Object.keys(PRODUCT_LOADED_PATHS.files),
    ...Object.keys(PRODUCT_LOADED_PATHS.dirs),
  ];

  it.each(names)(
    "locks %s in the global folder, a project and by name",
    (n) => {
      expect(hit(`~/.continuous/${n}`), n).toBe(true);
      expect(hit(`C:/work/proj/.continue/${n}`), n).toBe(true);
      // A global folder that holds the project is locked by name only.
      withGlobalDir("C:/work", () => expect(hit(`C:/work/${n}`), n).toBe(true));
    },
  );

  it.each(PRODUCT_STATE_PATHS)("locks the state path %s", (n) => {
    expect(hit(`~/.continuous/${n}/x`), n).toBe(true);
  });

  it.each([...FOREIGN_LOADED_FILES, ...FOREIGN_LOADED_DIRS])(
    "locks .claude/%s at home and in a project",
    (n) => {
      expect(hit(`~/.claude/${n}`), n).toBe(true);
      expect(hit(`C:/work/proj/.claude/${n}`), n).toBe(true);
    },
  );
});
