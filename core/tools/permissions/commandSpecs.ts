import { canonicalCmdlet } from "./powershell";

/**
 * What well-known commands do, as data (plans/command-analysis.md, P5): for a
 * program, and for the subcommand it runs, the effects it has. A rule can then
 * say `effect:network` or `effect:delete` instead of naming every program
 * that reaches the network or removes files.
 *
 * Effects are what a command is known to do. A program with no spec has no
 * effects here, which means "not known", never "safe": allow decisions do not
 * read this table. It serves deny and ask rules, which may match more but
 * never less than they are given.
 */
export type Effect = "network" | "write" | "delete" | "exec";

export const EFFECTS: readonly Effect[] = [
  "network",
  "write",
  "delete",
  "exec",
];

export interface CommandSpec {
  /** Effects of every use of the program. */
  base?: Effect[];
  /** Flags that take a value, so the subcommand is found after them. */
  valueFlags?: string[];
  /** Effects by subcommand (the first operand that is not a flag). */
  sub?: Record<string, Effect[]>;
  /** Effects of a subcommand this table does not list. */
  otherSub?: Effect[];
  /** Effects added when a flag is present (`-i` for sed, `-delete` for find). */
  flags?: Record<string, Effect[]>;
}

const NET: Effect[] = ["network"];
const WRITE: Effect[] = ["write"];
const DELETE: Effect[] = ["delete"];
const EXEC: Effect[] = ["exec"];
const FETCH_AND_WRITE: Effect[] = ["network", "write"];
/** Installing runs package scripts, writes the tree and reaches the network. */
const INSTALL: Effect[] = ["network", "write", "exec"];

const NODE_PM: CommandSpec = {
  sub: {
    install: INSTALL,
    i: INSTALL,
    add: INSTALL,
    ci: INSTALL,
    update: INSTALL,
    upgrade: INSTALL,
    remove: ["write"],
    uninstall: ["write"],
    publish: NET,
    run: EXEC,
    "run-script": EXEC,
    test: EXEC,
    t: EXEC,
    start: EXEC,
    exec: EXEC,
    dlx: ["network", "exec"],
    x: ["network", "exec"],
    view: NET,
    info: NET,
    outdated: NET,
    audit: NET,
    login: NET,
    logout: NET,
    ls: [],
    list: [],
  },
};

export const COMMAND_SPECS: Record<string, CommandSpec> = {
  git: {
    valueFlags: [
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--exec-path",
      "--config-env",
    ],
    sub: {
      push: ["network", "write"],
      pull: ["network", "write"],
      fetch: NET,
      clone: FETCH_AND_WRITE,
      "ls-remote": NET,
      submodule: FETCH_AND_WRITE,
      commit: WRITE,
      add: WRITE,
      rm: ["write", "delete"],
      mv: WRITE,
      reset: WRITE,
      restore: WRITE,
      checkout: WRITE,
      switch: WRITE,
      merge: WRITE,
      rebase: WRITE,
      "cherry-pick": WRITE,
      revert: WRITE,
      stash: WRITE,
      tag: WRITE,
      branch: WRITE,
      apply: WRITE,
      am: WRITE,
      init: WRITE,
      clean: ["write", "delete"],
      status: [],
      log: [],
      diff: [],
      show: [],
      blame: [],
      "ls-files": [],
      "rev-parse": [],
      remote: [],
      config: [],
    },
  },
  npm: NODE_PM,
  pnpm: NODE_PM,
  yarn: NODE_PM,
  bun: NODE_PM,
  npx: { base: ["network", "exec"] },
  pip: {
    sub: {
      install: INSTALL,
      download: FETCH_AND_WRITE,
      uninstall: DELETE,
      list: [],
      show: [],
      freeze: [],
    },
  },
  uv: {
    sub: {
      pip: INSTALL,
      sync: INSTALL,
      add: INSTALL,
      run: ["exec"],
      tool: ["network", "exec"],
      lock: NET,
      publish: NET,
    },
  },
  cargo: {
    sub: {
      build: ["write", "exec"],
      test: ["write", "exec"],
      run: ["write", "exec"],
      check: ["write", "exec"],
      install: INSTALL,
      fetch: NET,
      update: NET,
      publish: NET,
      clean: DELETE,
    },
  },
  go: {
    sub: {
      build: ["write", "exec"],
      test: ["write", "exec"],
      run: ["write", "exec"],
      get: INSTALL,
      install: INSTALL,
      mod: NET,
      clean: DELETE,
    },
  },
  docker: {
    sub: {
      run: ["network", "exec"],
      exec: EXEC,
      build: ["network", "write", "exec"],
      compose: ["network", "exec"],
      pull: FETCH_AND_WRITE,
      push: NET,
      rm: DELETE,
      rmi: DELETE,
      prune: DELETE,
      kill: EXEC,
      stop: EXEC,
      ps: [],
      images: [],
      logs: [],
      inspect: [],
    },
  },
  kubectl: {
    base: NET,
    sub: {
      apply: ["write"],
      create: ["write"],
      patch: ["write"],
      replace: ["write"],
      scale: ["write"],
      edit: ["write"],
      delete: ["delete"],
      exec: ["exec"],
      "port-forward": [],
    },
  },
  gh: { base: NET },
  curl: {
    base: NET,
    flags: { "-o": WRITE, "-O": WRITE, "--output": WRITE },
  },
  wget: { base: ["network", "write"] },
  ssh: { base: ["network", "exec"] },
  scp: { base: ["network", "write"] },
  rsync: { base: ["network", "write"] },
  nc: { base: NET },
  ncat: { base: NET },
  telnet: { base: NET },
  ftp: { base: NET },
  sftp: { base: NET },
  rm: { base: DELETE },
  rmdir: { base: DELETE },
  unlink: { base: DELETE },
  shred: { base: DELETE },
  mv: { base: ["write", "delete"] },
  cp: { base: WRITE },
  mkdir: { base: WRITE },
  touch: { base: WRITE },
  ln: { base: WRITE },
  chmod: { base: WRITE },
  chown: { base: WRITE },
  install: { base: WRITE },
  tee: { base: WRITE },
  dd: { base: WRITE },
  truncate: { base: WRITE },
  sed: { flags: { "-i": WRITE, "--in-place": WRITE } },
  find: {
    flags: {
      "-delete": DELETE,
      "-exec": EXEC,
      "-execdir": EXEC,
      "-ok": EXEC,
    },
  },
  xargs: { base: EXEC },
  sudo: { base: EXEC },
  su: { base: EXEC },
  eval: { base: EXEC },
  exec: { base: EXEC },
  bash: { base: EXEC },
  sh: { base: EXEC },
  zsh: { base: EXEC },
  dash: { base: EXEC },
  pwsh: { base: EXEC },
  powershell: { base: EXEC },
  cmd: { base: EXEC },
  python: { base: EXEC },
  python3: { base: EXEC },
  node: { base: EXEC },
  deno: { base: EXEC },
  perl: { base: EXEC },
  ruby: { base: EXEC },
  make: { base: EXEC },
  // PowerShell, by canonical cmdlet name in lower case (aliases are resolved)
  "remove-item": { base: DELETE },
  "set-content": { base: WRITE },
  "add-content": { base: WRITE },
  "out-file": { base: WRITE },
  "new-item": { base: WRITE },
  "copy-item": { base: WRITE },
  "move-item": { base: ["write", "delete"] },
  "rename-item": { base: WRITE },
  "invoke-webrequest": { base: NET },
  "invoke-restmethod": { base: NET },
  "invoke-expression": { base: EXEC },
  "start-process": { base: EXEC },
  "invoke-command": { base: ["network", "exec"] },
};

/**
 * The spec of a command word: by its own name first (no directory, no `.exe`,
 * lower case), then by the PowerShell cmdlet it is an alias of. The order
 * matters: `curl` is an alias of Invoke-WebRequest in PowerShell 5.1, but the
 * GNU curl spec knows its flags.
 */
function specOf(word: string): CommandSpec | undefined {
  const base = (word.split(/[\\/]/).pop() ?? word)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "");
  return COMMAND_SPECS[base] ?? COMMAND_SPECS[canonicalCmdlet(base) ?? ""];
}

/**
 * The effects a single command (one entry of `commandCandidates`, words
 * separated by spaces) is known to have. Empty when nothing is known.
 */
export function effectsOfCommand(command: string): Set<Effect> {
  const out = new Set<Effect>();
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return out;
  const spec = specOf(words[0]);
  if (!spec) return out;
  for (const e of spec.base ?? []) out.add(e);
  const tail = words.slice(1);
  for (const [flag, effects] of Object.entries(spec.flags ?? {})) {
    if (tail.some((w) => w === flag || w.startsWith(`${flag}=`))) {
      for (const e of effects) out.add(e);
    }
  }
  if (spec.sub) {
    let i = 0;
    while (i < tail.length && tail[i].startsWith("-")) {
      i += spec.valueFlags?.includes(tail[i]) ? 2 : 1;
    }
    const sub = tail[i]?.toLowerCase();
    if (sub !== undefined) {
      for (const e of spec.sub[sub] ?? spec.otherSub ?? []) out.add(e);
    }
  }
  return out;
}

/** Whether `name` is one of the effects a rule can name. */
export function isEffect(name: string): name is Effect {
  return (EFFECTS as readonly string[]).includes(name);
}

/**
 * Problems in the table itself: an unknown effect, a subcommand spelled in
 * capitals (lookups are lower case) and a flag that is also a subcommand.
 * The spec linter of the plan, run by a test.
 */
export function lintCommandSpecs(): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
    if (name !== name.toLowerCase()) {
      problems.push(`${name}: program names are lower case`);
    }
    const all = [
      ...(spec.base ?? []),
      ...(spec.otherSub ?? []),
      ...Object.values(spec.sub ?? {}).flat(),
      ...Object.values(spec.flags ?? {}).flat(),
    ];
    for (const e of all) {
      if (!isEffect(e)) problems.push(`${name}: unknown effect ${e}`);
    }
    for (const sub of Object.keys(spec.sub ?? {})) {
      if (sub !== sub.toLowerCase()) {
        problems.push(`${name}: subcommand ${sub} must be lower case`);
      }
      if (sub.startsWith("-")) {
        problems.push(`${name}: subcommand ${sub} looks like a flag`);
      }
    }
    for (const flag of Object.keys(spec.flags ?? {})) {
      if (!flag.startsWith("-")) {
        problems.push(`${name}: flag ${flag} must start with a dash`);
      }
    }
  }
  return problems;
}
