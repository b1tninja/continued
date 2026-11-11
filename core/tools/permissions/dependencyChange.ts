import type { ShellKind } from "../../util/shell";
import { commandCandidateSet } from "./candidates";
import { programName } from "./destinations";

/**
 * The built-in rule `ask-dependency-change` (ROADMAP B14): a call that changes
 * what the project depends on, or where it gets it from, asks with no model
 * call. Two shapes:
 *
 * - a write to a manifest, a lockfile or a registry setting (`package.json`,
 *   `package-lock.json`, `.npmrc`, `requirements.txt`, `Cargo.lock` ...);
 * - a command that adds, upgrades or removes a package, or points the package
 *   manager at another registry (`npm install lodash`, `pip install x`,
 *   `npm config set registry ...`).
 *
 * Installing what the lockfile already names (`npm ci`, a bare `npm install`,
 * `pip install -r requirements.txt`, `pip install -e .`) does not ask: it
 * adds nothing new. A package manager this does not know is not covered.
 */

const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "pipfile",
  "pipfile.lock",
  "setup.py",
  "setup.cfg",
  "pip.conf",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "packages.config",
  "nuget.config",
  "directory.packages.props",
  "directory.build.props",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "flake.lock",
]);

/** `requirements.txt`, `requirements-dev.txt`, `requirements/base.txt`, `*.csproj`. */
function isManifestPath(raw: string): string | undefined {
  const path = raw.replace(/\\/g, "/");
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (MANIFEST_NAMES.has(name)) return name;
  if (/^requirements[\w.-]*\.(txt|in)$/.test(name)) return name;
  if (/^constraints[\w.-]*\.txt$/.test(name)) return name;
  if (/\.(csproj|fsproj|vbproj)$/.test(name)) return name;
  if (/^requirements$/.test(path.split("/").slice(-2, -1)[0] ?? "")) {
    return name;
  }
  return undefined;
}

/** The manifest a file tool's target names, or undefined. */
export function dependencyFileHit(
  ...paths: (string | undefined)[]
): string | undefined {
  for (const p of paths) {
    const hit = p ? isManifestPath(p) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

const NODE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx"]);
const NODE_ADD = new Set(["install", "i", "add", "update", "upgrade", "up"]);
const NODE_REMOVE = new Set(["remove", "rm", "uninstall", "un", "unlink"]);
const NODE_RELINK = new Set(["link", "ln", "dedupe", "prune", "audit"]);
const PYTHON_INSTALLERS = new Set([
  "pip",
  "pip3",
  "pipx",
  "uv",
  "poetry",
  "pdm",
]);

const operands = (args: string[]) => args.filter((a) => !a.startsWith("-"));

function nodeHit(program: string, args: string[]): string | undefined {
  const sub = operands(args)[0]?.toLowerCase();
  if (!sub) return undefined;
  if (sub === "config" || sub === "set" || sub === "c") {
    const rest = operands(args).slice(1).join(" ");
    return /registry|_auth|\/\/|proxy|scope|ignore-scripts|script-shell/i.test(
      rest,
    ) || sub === "set"
      ? `${program} config`
      : undefined;
  }
  if (
    NODE_REMOVE.has(sub) ||
    (NODE_ADD.has(sub) && sub !== "install" && sub !== "i")
  ) {
    return `${program} ${sub}`;
  }
  if (NODE_RELINK.has(sub) && sub !== "audit") return `${program} ${sub}`;
  if (sub === "install" || sub === "i") {
    // Packages named after the subcommand are new dependencies; none means "what the lockfile says"
    const named = operands(args).slice(1);
    const global = args.some((a) => a === "-g" || a === "--global");
    return named.length > 0 || global
      ? `${program} install <package>`
      : undefined;
  }
  return undefined;
}

const PIP_FLAGS_WITH_VALUE = new Set([
  "-r",
  "-c",
  "-e",
  "-t",
  "--requirement",
  "--constraint",
  "--editable",
  "--target",
  "--prefix",
  "--python",
]);

/** `pip install` forms: a package name, an index flag or a URL ask; files and `.` do not. */
function pipInstallHit(program: string, args: string[]): string | undefined {
  if (
    args.some((a) =>
      /^--(index-url|extra-index-url|find-links|trusted-host)(=|$)|^-[if]$/.test(
        a,
      ),
    )
  ) {
    return `${program} install from another index`;
  }
  const named: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PIP_FLAGS_WITH_VALUE.has(a)) i++;
    else if (!a.startsWith("-")) named.push(a);
  }
  const local = (w: string) => w === "." || /^\.{1,2}\//.test(w);
  return named.every(local) ? undefined : `${program} install <package>`;
}

function pythonHit(program: string, args: string[]): string | undefined {
  const sub = operands(args)[0]?.toLowerCase();
  if (program === "uv" && sub === "pip") {
    return pythonHit("pip", args.slice(args.indexOf("pip") + 1));
  }
  if (program === "uv" || program === "poetry" || program === "pdm") {
    return sub && ["add", "remove", "update", "lock", "config"].includes(sub)
      ? `${program} ${sub}`
      : undefined;
  }
  if (sub === "config" || sub === "uninstall") return `${program} ${sub}`;
  if (sub !== "install") return undefined;
  return pipInstallHit(program, args.slice(args.indexOf("install") + 1));
}

function otherHit(program: string, args: string[]): string | undefined {
  const sub = operands(args)[0]?.toLowerCase();
  switch (program) {
    case "cargo":
      return sub === "add" ||
        sub === "remove" ||
        sub === "update" ||
        sub === "install"
        ? `cargo ${sub}`
        : undefined;
    case "go":
      return sub === "get" ||
        sub === "install" ||
        (sub === "mod" && operands(args)[1] === "edit")
        ? `go ${sub}`
        : undefined;
    case "gem":
    case "bundle":
      return sub === "install" && program === "gem"
        ? "gem install"
        : sub === "add" || sub === "update" || sub === "remove"
          ? `bundle ${sub}`
          : undefined;
    case "composer":
      return sub === "require" || sub === "update" || sub === "remove"
        ? `composer ${sub}`
        : undefined;
    case "dotnet":
      return sub === "add" || sub === "remove" || sub === "nuget"
        ? `dotnet ${sub}`
        : undefined;
    case "mvn":
    case "gradle":
    case "gradlew":
      return undefined;
    default:
      return undefined;
  }
}

function segmentHit(words: string[]): string | undefined {
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_]\w*=/.test(words[i]) ||
      ["sudo", "env", "time", "nohup", "command", "exec"].includes(
        programName(words[i]).toLowerCase(),
      ))
  ) {
    i++;
  }
  if (i >= words.length) return undefined;
  const program = programName(words[i]).toLowerCase();
  const args = words.slice(i + 1);
  if (NODE_MANAGERS.has(program)) return nodeHit(program, args);
  if (PYTHON_INSTALLERS.has(program)) return pythonHit(program, args);
  if (/^python[\d.]*$/.test(program) && args[0] === "-m" && args[1]) {
    const mod = args[1].toLowerCase();
    if (mod === "pip") return pythonHit("pip", args.slice(2));
  }
  return otherHit(program, args);
}

const SEGMENT_BREAK = /\s*(?:&&|\|\||[|;&\n])\s*/;
const strip = (w: string) => w.replace(/^['"({]+|['")}]+$/g, "");

/** What changes the dependencies, or undefined. */
export function dependencyCommandHit(
  command: string,
  shell?: ShellKind,
): string | undefined {
  for (const candidate of commandCandidateSet(command, shell).list) {
    for (const segment of candidate.split(SEGMENT_BREAK)) {
      const words = segment.trim().split(/\s+/).map(strip).filter(Boolean);
      const hit = words.length ? segmentHit(words) : undefined;
      if (hit) return hit;
    }
  }
  return undefined;
}
