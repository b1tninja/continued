/**
 * The default aliases of Windows PowerShell 5.1 and PowerShell 7, as data, and
 * the function that reads them (plans/command-analysis.md, P3; ROADMAP R8). A
 * rule written about `Remove-Item` has to see `rm`, `del`, `ri`, `rd`, `erase`
 * and `rmdir`, so every command word is resolved to the cmdlet it stands for
 * before a rule, a floor or an effect table looks at it.
 *
 * Sources, read 2026-11-10:
 *  - Windows PowerShell 5.1.26100.9711 on Windows 11 (started with -NoProfile), `Get-Alias | Select-Object
 *    Name, Definition`: 153 aliases, the table ALIASES_5_1 below, verbatim
 *    (lower-cased). The table this replaces held 63 of them, and had `md` as
 *    `new-item` where the live definition is `mkdir`.
 *  - PowerShell 7 (not installed where this was written, so not run): the
 *    default alias list in `InitialSessionState.cs` (`BuiltInAliases`, with its
 *    `#if !UNIX` and `#if !CORECLR` blocks) and the `AliasesToExport` of the
 *    Management and Utility module manifests, both in GitHub
 *    PowerShell/PowerShell master. `about_Aliases` (Microsoft Learn, page
 *    updated 2025-09-29) only says that `Get-Alias` lists them and names a few,
 *    so the source is the evidence. 7 adds `gerr` and drops ALIASES_5_1_ONLY
 *    (snap-ins, WMI, `sc`, `curl` and `wget`, among others).
 *  - On Linux and macOS, PowerShell 7 also drops UNIX_ABSENT (`ls`, `cat`,
 *    `rm`, `cp`, `mv`, `ps`, `kill`, `sort`, ...): there they are the native
 *    programs.
 *
 * Platform assumption: the platform is not known here, so a word is resolved
 * as the union of 5.1 and 7 on Windows, including the names that are only
 * native programs elsewhere. That is the safe direction: a rule or a floor for
 * the cmdlet is at least as strict as the same rule for the native binary
 * (`rm`, `cp`, `mv`, `kill`, `ls`, `cat`, `sort`), and the one place an alias
 * could loosen something, read-only vouching, still checks every parameter
 * against the cmdlet's own list. Where 5.1 has an alias for a name that is a
 * different program in 7 (`sc` is `sc.exe`, the service controller; `curl` and
 * `wget` are the real programs), the alias reading is again the stricter one
 * for the floors that name Set-Content and Invoke-WebRequest. `curl.exe`, a
 * path and any word with an extension are not aliases; callers strip those
 * before asking.
 *
 * Aliases are not fixed: `Set-Alias`, `New-Alias`, `Import-Alias`, a
 * `function` and the `Alias:` drive define or replace them at run time, and a
 * profile can too. Nothing here sees that. ALIAS_DEFINERS lists the cmdlets
 * that do it, so a caller can refuse to trust a name that follows one.
 *
 * Pure data and pure functions, so the GUI can import this file.
 */

/** Windows PowerShell 5.1: alias to definition, as `Get-Alias` prints them, lower case. */
export const ALIASES_5_1: Readonly<Record<string, string>> = {
  "?": "where-object",
  "%": "foreach-object",
  ac: "add-content",
  asnp: "add-pssnapin",
  cat: "get-content",
  cd: "set-location",
  cfs: "convertfrom-string",
  chdir: "set-location",
  clc: "clear-content",
  clear: "clear-host",
  clhy: "clear-history",
  cli: "clear-item",
  clp: "clear-itemproperty",
  cls: "clear-host",
  clv: "clear-variable",
  cnsn: "connect-pssession",
  compare: "compare-object",
  copy: "copy-item",
  cp: "copy-item",
  cpi: "copy-item",
  cpp: "copy-itemproperty",
  curl: "invoke-webrequest",
  cvpa: "convert-path",
  dbp: "disable-psbreakpoint",
  del: "remove-item",
  diff: "compare-object",
  dir: "get-childitem",
  dnsn: "disconnect-pssession",
  ebp: "enable-psbreakpoint",
  echo: "write-output",
  epal: "export-alias",
  epcsv: "export-csv",
  epsn: "export-pssession",
  erase: "remove-item",
  etsn: "enter-pssession",
  exsn: "exit-pssession",
  fc: "format-custom",
  fhx: "format-hex",
  fl: "format-list",
  foreach: "foreach-object",
  ft: "format-table",
  fw: "format-wide",
  gal: "get-alias",
  gbp: "get-psbreakpoint",
  gc: "get-content",
  gci: "get-childitem",
  gcm: "get-command",
  gcs: "get-pscallstack",
  gdr: "get-psdrive",
  ghy: "get-history",
  gi: "get-item",
  gjb: "get-job",
  gl: "get-location",
  gm: "get-member",
  gmo: "get-module",
  gp: "get-itemproperty",
  gps: "get-process",
  gpv: "get-itempropertyvalue",
  group: "group-object",
  gsn: "get-pssession",
  gsnp: "get-pssnapin",
  gsv: "get-service",
  gu: "get-unique",
  gv: "get-variable",
  gwmi: "get-wmiobject",
  h: "get-history",
  history: "get-history",
  icm: "invoke-command",
  iex: "invoke-expression",
  ihy: "invoke-history",
  ii: "invoke-item",
  ipal: "import-alias",
  ipcsv: "import-csv",
  ipmo: "import-module",
  ipsn: "import-pssession",
  irm: "invoke-restmethod",
  ise: "powershell_ise.exe",
  iwmi: "invoke-wmimethod",
  iwr: "invoke-webrequest",
  kill: "stop-process",
  lp: "out-printer",
  ls: "get-childitem",
  man: "help",
  md: "mkdir",
  measure: "measure-object",
  mi: "move-item",
  mount: "new-psdrive",
  move: "move-item",
  mp: "move-itemproperty",
  mv: "move-item",
  nal: "new-alias",
  ndr: "new-psdrive",
  ni: "new-item",
  nmo: "new-module",
  npssc: "new-pssessionconfigurationfile",
  nsn: "new-pssession",
  nv: "new-variable",
  ogv: "out-gridview",
  oh: "out-host",
  popd: "pop-location",
  ps: "get-process",
  pushd: "push-location",
  pwd: "get-location",
  r: "invoke-history",
  rbp: "remove-psbreakpoint",
  rcjb: "receive-job",
  rcsn: "receive-pssession",
  rd: "remove-item",
  rdr: "remove-psdrive",
  ren: "rename-item",
  ri: "remove-item",
  rjb: "remove-job",
  rm: "remove-item",
  rmdir: "remove-item",
  rmo: "remove-module",
  rni: "rename-item",
  rnp: "rename-itemproperty",
  rp: "remove-itemproperty",
  rsn: "remove-pssession",
  rsnp: "remove-pssnapin",
  rujb: "resume-job",
  rv: "remove-variable",
  rvpa: "resolve-path",
  rwmi: "remove-wmiobject",
  sajb: "start-job",
  sal: "set-alias",
  saps: "start-process",
  sasv: "start-service",
  sbp: "set-psbreakpoint",
  sc: "set-content",
  select: "select-object",
  set: "set-variable",
  shcm: "show-command",
  si: "set-item",
  sl: "set-location",
  sleep: "start-sleep",
  sls: "select-string",
  sort: "sort-object",
  sp: "set-itemproperty",
  spjb: "stop-job",
  spps: "stop-process",
  spsv: "stop-service",
  start: "start-process",
  sujb: "suspend-job",
  sv: "set-variable",
  swmi: "set-wmiinstance",
  tee: "tee-object",
  trcm: "trace-command",
  type: "get-content",
  wget: "invoke-webrequest",
  where: "where-object",
  wjb: "wait-job",
  write: "write-output",
};

/** Defined by PowerShell 7 and not by 5.1. */
export const ALIASES_7_ADDED: Readonly<Record<string, string>> = {
  gcb: "get-clipboard",
  gerr: "get-error",
  gin: "get-computerinfo",
  gtz: "get-timezone",
  scb: "set-clipboard",
  stz: "set-timezone",
};

/** In 5.1 and not in PowerShell 7 on Windows (`#if !CORECLR`, the snap-in, and later removals). */
export const ALIASES_5_1_ONLY: readonly string[] = [
  "asnp",
  "cfs",
  "curl",
  "epsn",
  "gsnp",
  "gwmi",
  "ipsn",
  "ise",
  "iwmi",
  "lp",
  "npssc",
  "rsnp",
  "rujb",
  "rwmi",
  "sc",
  "sujb",
  "swmi",
  "trcm",
  "wget",
];

/** Not aliases in PowerShell 7 on Linux and macOS (`#if !UNIX`): the native program runs instead. */
export const UNIX_ABSENT: readonly string[] = [
  "ac",
  "cat",
  "clear",
  "cnsn",
  "compare",
  "cp",
  "cpp",
  "diff",
  "dnsn",
  "gsv",
  "kill",
  "ls",
  "man",
  "mount",
  "mv",
  "ogv",
  "ps",
  "rm",
  "rmdir",
  "sasv",
  "shcm",
  "sleep",
  "sort",
  "spsv",
  "start",
  "tee",
  "write",
];

/**
 * Functions PowerShell ships that wrap a cmdlet, which an alias can point at:
 * `md` is `mkdir`, and `mkdir` is a function over New-Item (5.1 and 7 on
 * Windows). On Linux `mkdir` is the native program; reading it as New-Item is
 * the stricter reading.
 */
const WRAPPER_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ["help", "get-help"],
  ["mkdir", "new-item"],
]);

/** Cmdlets that create, replace or remove an alias at run time. */
export const ALIAS_DEFINERS: ReadonlySet<string> = new Set([
  "set-alias",
  "new-alias",
  "import-alias",
  "remove-alias",
]);

const TABLE: ReadonlyMap<string, string> = new Map(
  Object.entries({ ...ALIASES_5_1, ...ALIASES_7_ADDED }),
);

/** The definition an alias has, as `Get-Alias` prints it (`md` is `mkdir`), or undefined. */
export function aliasDefinition(word: string): string | undefined {
  return TABLE.get(word.toLowerCase());
}

/**
 * The cmdlet an alias, or a function that wraps a cmdlet, stands for, lower
 * case; undefined for any other word. Case-insensitive, like PowerShell.
 * `md` is `new-item` (through `mkdir`); `ise` is the program it opens.
 */
export function resolveAlias(word: string): string | undefined {
  const w = word.toLowerCase();
  const definition = TABLE.get(w) ?? w;
  return (
    WRAPPER_FUNCTIONS.get(definition) ?? (TABLE.has(w) ? definition : undefined)
  );
}

/** True when the word is an alias, or a function that wraps a cmdlet, rather than a cmdlet name. */
export function isAliasName(word: string): boolean {
  return resolveAlias(word) !== undefined;
}

/**
 * True when the word runs a cmdlet that defines or replaces aliases, spelled
 * as an alias (`sal`, `nal`, `ipal`), as the cmdlet, or module-qualified
 * (`Microsoft.PowerShell.Utility\Set-Alias`).
 */
export function isAliasDefiner(word: string): boolean {
  const bare = word.toLowerCase().replace(/^[a-z0-9_.]+\\/, "");
  return ALIAS_DEFINERS.has(resolveAlias(bare) ?? bare);
}
