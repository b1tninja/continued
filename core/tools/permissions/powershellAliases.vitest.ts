import { describe, expect, it } from "vitest";
import {
  ALIAS_DEFINERS,
  ALIASES_5_1,
  ALIASES_5_1_ONLY,
  ALIASES_7_ADDED,
  UNIX_ABSENT,
  aliasDefinition,
  isAliasDefiner,
  isAliasName,
  resolveAlias,
} from "./powershellAliases";

/** What the table this file replaced held, so nothing it resolved stops resolving. */
const LEGACY: Record<string, string> = {
  ac: "add-content",
  cat: "get-content",
  cd: "set-location",
  chdir: "set-location",
  clc: "clear-content",
  copy: "copy-item",
  cp: "copy-item",
  cpi: "copy-item",
  curl: "invoke-webrequest",
  del: "remove-item",
  dir: "get-childitem",
  diff: "compare-object",
  echo: "write-output",
  erase: "remove-item",
  fl: "format-list",
  foreach: "foreach-object",
  ft: "format-table",
  gc: "get-content",
  gci: "get-childitem",
  gi: "get-item",
  gl: "get-location",
  gp: "get-itemproperty",
  gps: "get-process",
  gsv: "get-service",
  iex: "invoke-expression",
  ii: "invoke-item",
  irm: "invoke-restmethod",
  iwr: "invoke-webrequest",
  kill: "stop-process",
  ls: "get-childitem",
  measure: "measure-object",
  mi: "move-item",
  move: "move-item",
  mv: "move-item",
  ni: "new-item",
  popd: "pop-location",
  ps: "get-process",
  pushd: "push-location",
  pwd: "get-location",
  rd: "remove-item",
  ri: "remove-item",
  rm: "remove-item",
  rmdir: "remove-item",
  rni: "rename-item",
  rp: "remove-itemproperty",
  rvpa: "resolve-path",
  sc: "set-content",
  select: "select-object",
  si: "set-item",
  sl: "set-location",
  sls: "select-string",
  sort: "sort-object",
  sp: "set-itemproperty",
  start: "start-process",
  saps: "start-process",
  spps: "stop-process",
  tee: "tee-object",
  type: "get-content",
  wget: "invoke-webrequest",
  where: "where-object",
  "%": "foreach-object",
  "?": "where-object",
};

const VERB_NOUN = /^[a-z]+-[a-z][a-z0-9]*$/;

describe("the alias tables keep their shape", () => {
  it("5.1 has the 153 aliases Get-Alias listed on 2026-11-10", () => {
    expect(Object.keys(ALIASES_5_1)).toHaveLength(153);
  });

  it("every name and definition is lower case, trimmed and not empty", () => {
    for (const [name, definition] of [
      ...Object.entries(ALIASES_5_1),
      ...Object.entries(ALIASES_7_ADDED),
    ]) {
      expect(name, name).toBe(name.trim().toLowerCase());
      expect(name.length, name).toBeGreaterThan(0);
      expect(definition, name).toBe(definition.trim().toLowerCase());
      expect(definition, name).not.toMatch(/\s/);
    }
  });

  it("every definition is a cmdlet, except the three that are not", () => {
    const notCmdlets = Object.entries({
      ...ALIASES_5_1,
      ...ALIASES_7_ADDED,
    }).filter(([, d]) => !VERB_NOUN.test(d));
    expect(notCmdlets.sort()).toEqual([
      ["ise", "powershell_ise.exe"],
      ["man", "help"],
      ["md", "mkdir"],
    ]);
  });

  it("the 5.1-only, 7-added and Unix-absent lists name aliases the tables hold", () => {
    const known = new Set([
      ...Object.keys(ALIASES_5_1),
      ...Object.keys(ALIASES_7_ADDED),
    ]);
    for (const name of [...ALIASES_5_1_ONLY, ...UNIX_ABSENT]) {
      expect(known.has(name), name).toBe(true);
    }
    for (const name of ALIASES_5_1_ONLY) {
      expect(name in ALIASES_5_1, name).toBe(true);
    }
    for (const name of Object.keys(ALIASES_7_ADDED)) {
      expect(name in ALIASES_5_1_ONLY, name).toBe(false);
    }
  });

  it("the two versions do not disagree about a definition they share", () => {
    for (const [name, definition] of Object.entries(ALIASES_7_ADDED)) {
      expect(ALIASES_5_1[name] ?? definition, name).toBe(definition);
    }
  });

  it("curl, wget and sc are 5.1 aliases that PowerShell 7 does not define", () => {
    for (const name of ["curl", "wget", "sc"]) {
      expect(ALIASES_5_1_ONLY).toContain(name);
    }
  });

  it("ls, cat, rm, cp, mv, ps, kill and sort are not aliases on Linux or macOS", () => {
    for (const name of ["ls", "cat", "rm", "cp", "mv", "ps", "kill", "sort"]) {
      expect(UNIX_ABSENT).toContain(name);
    }
    // cd, dir, echo, pwd and type are kept on every platform
    for (const name of ["cd", "dir", "echo", "pwd", "type", "ri", "del"]) {
      expect(UNIX_ABSENT).not.toContain(name);
    }
  });
});

describe("resolveAlias", () => {
  it("resolves everything the old table did, to the same cmdlet", () => {
    for (const [name, cmdlet] of Object.entries(LEGACY)) {
      expect(resolveAlias(name), name).toBe(cmdlet);
    }
  });

  it("resolves every alias of 5.1 and 7 to its definition", () => {
    for (const [name, definition] of Object.entries({
      ...ALIASES_5_1,
      ...ALIASES_7_ADDED,
    })) {
      expect(aliasDefinition(name), name).toBe(definition);
      expect(isAliasName(name), name).toBe(true);
      const resolved = resolveAlias(name);
      expect(resolved, name).toBeDefined();
      if (VERB_NOUN.test(definition)) expect(resolved, name).toBe(definition);
    }
  });

  it("ignores case, as PowerShell does", () => {
    expect(resolveAlias("RM")).toBe("remove-item");
    expect(resolveAlias("Iex")).toBe("invoke-expression");
    expect(resolveAlias("SAL")).toBe("set-alias");
  });

  it("md is mkdir, which wraps New-Item (the old table said new-item directly)", () => {
    expect(aliasDefinition("md")).toBe("mkdir");
    expect(resolveAlias("md")).toBe("new-item");
    expect(resolveAlias("mkdir")).toBe("new-item");
    expect(resolveAlias("man")).toBe("get-help");
  });

  it("knows the aliases the old table missed, among them the ones that matter", () => {
    const missed: Record<string, string> = {
      icm: "invoke-command",
      sal: "set-alias",
      nal: "new-alias",
      ipal: "import-alias",
      sajb: "start-job",
      gwmi: "get-wmiobject",
      iwmi: "invoke-wmimethod",
      swmi: "set-wmiinstance",
      rwmi: "remove-wmiobject",
      ren: "rename-item",
      sasv: "start-service",
      spsv: "stop-service",
      ipmo: "import-module",
      nv: "new-variable",
      sv: "set-variable",
      set: "set-variable",
      sleep: "start-sleep",
      gcm: "get-command",
      r: "invoke-history",
      ihy: "invoke-history",
      gerr: "get-error",
    };
    for (const [name, cmdlet] of Object.entries(missed)) {
      expect(LEGACY[name], `${name} was missing`).toBeUndefined();
      expect(resolveAlias(name), name).toBe(cmdlet);
    }
  });

  it.each([
    ["remove-item", ["ri", "rm", "rmdir", "del", "erase", "rd"]],
    ["invoke-expression", ["iex"]],
    ["invoke-webrequest", ["iwr", "curl", "wget"]],
    ["invoke-restmethod", ["irm"]],
    ["start-process", ["start", "saps"]],
    ["stop-process", ["kill", "spps"]],
    ["set-content", ["sc"]],
    ["copy-item", ["copy", "cp", "cpi"]],
    ["move-item", ["move", "mv", "mi"]],
    ["invoke-command", ["icm"]],
    ["set-alias", ["sal"]],
    ["new-alias", ["nal"]],
  ])(
    "%s has every alias that matters to a floor or a rule",
    (cmdlet, aliases) => {
      for (const alias of aliases)
        expect(resolveAlias(alias), alias).toBe(cmdlet);
    },
  );

  it("is undefined for a cmdlet name, a program and a path", () => {
    for (const word of [
      "Remove-Item",
      "git",
      "node",
      ".\\rm",
      "rm.exe",
      "curl.exe",
      "a-b-c",
    ]) {
      expect(resolveAlias(word), word).toBeUndefined();
    }
  });

  it("is not fooled by the names of Object.prototype", () => {
    for (const word of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(resolveAlias(word), word).toBeUndefined();
      expect(isAliasName(word), word).toBe(false);
    }
  });
});

describe("isAliasDefiner", () => {
  it.each([
    "Set-Alias",
    "set-alias",
    "New-Alias",
    "Import-Alias",
    "Remove-Alias",
    "sal",
    "NAL",
    "ipal",
    "Microsoft.PowerShell.Utility\\Set-Alias",
    "microsoft.powershell.utility\\sal",
  ])("%s defines aliases", (word) => {
    expect(isAliasDefiner(word)).toBe(true);
  });

  it.each([
    "Get-Alias",
    "gal",
    "Export-Alias",
    "epal",
    "rm",
    "git",
    "Set-Content",
    "sc",
  ])("%s does not", (word) => {
    expect(isAliasDefiner(word)).toBe(false);
  });

  it("the definers are the four alias cmdlets", () => {
    expect([...ALIAS_DEFINERS].sort()).toEqual([
      "import-alias",
      "new-alias",
      "remove-alias",
      "set-alias",
    ]);
  });
});
