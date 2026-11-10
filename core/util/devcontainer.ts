import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

/**
 * Finding and reading a repository's dev container configuration
 * (plans/isolation.md, W3). Pure: it reads through a small fs-like object and
 * starts nothing. A dev container is a user-written environment, not a jail,
 * so the summary reports properties as found and risks as risks; nothing in
 * it is a guarantee.
 */
export interface DevcontainerFs {
  /** The file's text, or undefined when it is not there or cannot be read */
  readFile(path: string): string | undefined;
  /** The names of the subdirectories of a directory (empty when none) */
  listDirs(path: string): string[];
  /** Whether a file exists */
  isFile(path: string): boolean;
}

export const nodeDevcontainerFs: DevcontainerFs = {
  readFile(path) {
    try {
      return nodeFs.readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  listDirs(path) {
    try {
      return nodeFs
        .readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  },
  isFile(path) {
    try {
      return nodeFs.statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * Parse JSON with comments and trailing commas, as devcontainer.json allows.
 * Comments inside strings are kept. Returns undefined when it still is not
 * JSON, so one bad file does not hide the others.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else {
      if (c === "}" || c === "]") {
        // A trailing comma before the closer
        out = out.replace(/,\s*$/, "");
      }
      out += c;
      i++;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

export type DevcontainerRiskKind =
  | "privileged"
  | "docker-socket"
  | "host-network"
  | "host-pid"
  | "host-ipc"
  | "capability"
  | "security-opt"
  | "device"
  | "workspace-mount";

export interface DevcontainerRisk {
  kind: DevcontainerRiskKind;
  /** The property the risk was read from, and its value, as found */
  source: string;
  /** What it means, worded as a risk and never as a guarantee */
  message: string;
}

export interface DevcontainerMount {
  /** The string form, or a `key=value` rendering of the object form */
  raw: string;
  type?: string;
  source?: string;
  target?: string;
}

export const LIFECYCLE_NAMES = [
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
] as const;
export type LifecycleName = (typeof LIFECYCLE_NAMES)[number];

export interface DevcontainerSummary {
  image?: string;
  /** `build.dockerfile`/`dockerFile` and its context, when a build is used */
  build?: { dockerfile?: string; context?: string };
  dockerComposeFile?: string[];
  service?: string;
  features: Record<string, unknown>;
  mounts: DevcontainerMount[];
  remoteUser?: string;
  containerUser?: string;
  runArgs: string[];
  forwardPorts: (number | string)[];
  workspaceMount?: string;
  workspaceFolder?: string;
  /** Lifecycle commands present, with the value as written */
  lifecycle: Partial<Record<LifecycleName, unknown>>;
}

export interface DevcontainerConfig {
  /** Path of the file, joined onto the workspace directory given */
  path: string;
  /** Name of the folder for `.devcontainer/<folder>/devcontainer.json` */
  folder?: string;
  /** False when the file could not be read or is not a JSON object */
  parsed: boolean;
  summary?: DevcontainerSummary;
  risks: DevcontainerRisk[];
}

export interface DevcontainerDetection {
  /** In the spec's order; several means the person chooses */
  configs: DevcontainerConfig[];
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function parseMountString(raw: string): DevcontainerMount {
  const m: DevcontainerMount = { raw };
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (k === "type") m.type = v;
    else if (k === "source" || k === "src") m.source = v;
    else if (k === "target" || k === "dst" || k === "destination") m.target = v;
  }
  return m;
}

function readMounts(v: unknown): DevcontainerMount[] {
  if (!Array.isArray(v)) return [];
  const out: DevcontainerMount[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      out.push(parseMountString(item));
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const str = (k: string) =>
        typeof o[k] === "string" ? (o[k] as string) : undefined;
      out.push({
        raw: Object.entries(o)
          .map(([k, val]) => `${k}=${String(val)}`)
          .join(","),
        type: str("type"),
        source: str("source"),
        target: str("target"),
      });
    }
  }
  return out;
}

const DOCKER_SOCK =
  /docker\.sock|[\\/]var[\\/]run[\\/]docker|[\\/]{2}\.[\\/]pipe[\\/]docker_engine/i;

/** Values of a flag in runArgs, in both `--flag=value` and `--flag value` forms. */
function runArgValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag && i + 1 < args.length) out.push(args[i + 1]);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  }
  return out;
}

function summarize(obj: Record<string, unknown>): DevcontainerSummary {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const s: DevcontainerSummary = {
    features:
      obj.features &&
      typeof obj.features === "object" &&
      !Array.isArray(obj.features)
        ? (obj.features as Record<string, unknown>)
        : {},
    mounts: readMounts(obj.mounts),
    runArgs: asStrings(obj.runArgs),
    forwardPorts: Array.isArray(obj.forwardPorts)
      ? obj.forwardPorts.filter(
          (p): p is number | string =>
            typeof p === "number" || typeof p === "string",
        )
      : [],
    lifecycle: {},
  };
  const image = str(obj.image);
  if (image) s.image = image;
  const build =
    obj.build && typeof obj.build === "object"
      ? (obj.build as Record<string, unknown>)
      : undefined;
  const dockerfile = str(build?.dockerfile) ?? str(obj.dockerFile);
  const context = str(build?.context) ?? str(obj.context);
  if (dockerfile || context) s.build = { dockerfile, context };
  const compose = obj.dockerComposeFile;
  if (typeof compose === "string") s.dockerComposeFile = [compose];
  else if (Array.isArray(compose)) s.dockerComposeFile = asStrings(compose);
  s.service = str(obj.service);
  s.remoteUser = str(obj.remoteUser);
  s.containerUser = str(obj.containerUser);
  s.workspaceMount = str(obj.workspaceMount);
  s.workspaceFolder = str(obj.workspaceFolder);
  for (const name of LIFECYCLE_NAMES) {
    if (obj[name] !== undefined) s.lifecycle[name] = obj[name];
  }
  return s;
}

const SOCKET_MESSAGE =
  "Mounts the Docker socket: anything inside can start containers on the host, so it is not jailed.";

function findRisks(
  obj: Record<string, unknown>,
  s: DevcontainerSummary,
): DevcontainerRisk[] {
  const risks: DevcontainerRisk[] = [];
  const add = (kind: DevcontainerRiskKind, source: string, message: string) =>
    risks.push({ kind, source, message });
  const args = s.runArgs;

  if (obj.privileged === true || args.includes("--privileged")) {
    add(
      "privileged",
      obj.privileged === true ? "privileged: true" : "runArgs: --privileged",
      "Runs privileged: the container has nearly the host's kernel access, so it is not a jail.",
    );
  }
  for (const m of s.mounts) {
    if (DOCKER_SOCK.test(m.source ?? "") || DOCKER_SOCK.test(m.raw)) {
      add("docker-socket", `mounts: ${m.raw}`, SOCKET_MESSAGE);
    }
  }
  for (const v of [
    ...runArgValues(args, "-v"),
    ...runArgValues(args, "--volume"),
    ...runArgValues(args, "--mount"),
  ]) {
    if (DOCKER_SOCK.test(v)) {
      add("docker-socket", `runArgs: ${v}`, SOCKET_MESSAGE);
    }
  }
  const nets = [
    ...runArgValues(args, "--network"),
    ...runArgValues(args, "--net"),
  ];
  if (nets.includes("host")) {
    add(
      "host-network",
      "runArgs: --network=host",
      "Shares the host's network: services on localhost and the LAN are reachable.",
    );
  }
  if (runArgValues(args, "--pid").includes("host")) {
    add(
      "host-pid",
      "runArgs: --pid=host",
      "Shares the host's process namespace.",
    );
  }
  if (runArgValues(args, "--ipc").includes("host")) {
    add("host-ipc", "runArgs: --ipc=host", "Shares the host's IPC namespace.");
  }
  for (const cap of [
    ...asStrings(obj.capAdd),
    ...runArgValues(args, "--cap-add"),
  ]) {
    add(
      "capability",
      `capAdd/--cap-add: ${cap}`,
      `Adds the Linux capability ${cap}, which widens what the container can do to the host.`,
    );
  }
  for (const opt of [
    ...asStrings(obj.securityOpt),
    ...runArgValues(args, "--security-opt"),
  ]) {
    if (/unconfined|seccomp=|apparmor=|label[=:]disable/i.test(opt)) {
      add(
        "security-opt",
        `securityOpt/--security-opt: ${opt}`,
        "Relaxes the container's default confinement.",
      );
    }
  }
  for (const d of runArgValues(args, "--device")) {
    add(
      "device",
      `runArgs: --device ${d}`,
      "Gives the container access to a host device.",
    );
  }
  // The workspace is normally bind-mounted writable. It is how the person's
  // files are reached at all, but it means the container can change them.
  const wm = s.workspaceMount ?? "";
  if (/type=bind/.test(wm) && !/readonly|(^|,)ro(,|$)/.test(wm)) {
    add(
      "workspace-mount",
      `workspaceMount: ${wm}`,
      "The workspace is bind-mounted writable: commands in the container can change the host's files.",
    );
  }
  return risks;
}

export function readDevcontainerConfig(
  path: string,
  fs: DevcontainerFs,
  folder?: string,
): DevcontainerConfig {
  const text = fs.readFile(path);
  const json = text === undefined ? undefined : parseJsonc(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { path, folder, parsed: false, risks: [] };
  }
  const obj = json as Record<string, unknown>;
  const summary = summarize(obj);
  return {
    path,
    folder,
    parsed: true,
    summary,
    risks: findRisks(obj, summary),
  };
}

/**
 * The dev container configurations of a workspace, in the specification's
 * order: `.devcontainer/devcontainer.json`, `.devcontainer.json`, then
 * `.devcontainer/<folder>/devcontainer.json` (one level deep, sorted).
 */
export function detectDevcontainer(
  workspaceDir: string,
  fs: DevcontainerFs = nodeDevcontainerFs,
): DevcontainerDetection {
  const join = (...p: string[]) => nodePath.join(workspaceDir, ...p);
  const configs: DevcontainerConfig[] = [];
  for (const p of [
    join(".devcontainer", "devcontainer.json"),
    join(".devcontainer.json"),
  ]) {
    if (fs.isFile(p)) configs.push(readDevcontainerConfig(p, fs));
  }
  for (const folder of fs.listDirs(join(".devcontainer"))) {
    const p = join(".devcontainer", folder, "devcontainer.json");
    if (fs.isFile(p)) configs.push(readDevcontainerConfig(p, fs, folder));
  }
  return { configs };
}

// Status: whether the dev container CLI can be used, in the shape of
// containerStatus and wslStatus. Starts no container.

export type DevcontainerCliStatus =
  | { state: "unsupported-platform" }
  /** `devcontainer` is not on PATH */
  | { state: "not-installed"; installHint: string }
  /** The CLI is there but does not answer, or the container runtime it needs is not usable */
  | { state: "installed-but-unusable"; reason: string }
  | { state: "ready"; cliPath: string };

export const DEVCONTAINER_CLI_PACKAGE = "@devcontainers/cli";
export const DEVCONTAINER_INSTALL_COMMAND = `npm install -g ${DEVCONTAINER_CLI_PACKAGE}`;

/** Finds an executable on PATH; undefined when absent. Injectable for tests. */
export type WhichFn = (name: string) => string | undefined;

export function whichOnPath(
  name: string,
  opts: {
    platform?: NodeJS.Platform;
    pathEnv?: string;
    pathExt?: string;
    isFile?: (p: string) => boolean;
  } = {},
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? "";
  const exts = win
    ? (opts.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [""];
  const isFile = opts.isFile ?? nodeDevcontainerFs.isFile;
  const joiner = win ? nodePath.win32 : nodePath.posix;
  for (const dir of pathEnv.split(win ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      const p = joiner.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

export function devcontainerStatus(
  opts: {
    platform?: NodeJS.Platform;
    which?: WhichFn;
    /** Answers whether `devcontainer --version` runs; default assumes it does */
    versionProbe?: (cliPath: string) => boolean;
    /** The container runtime's usability, e.g. from containerStatus */
    runtimeUsable?: { usable: boolean; reason?: string };
  } = {},
): DevcontainerCliStatus {
  const platform = opts.platform ?? process.platform;
  if (!["win32", "darwin", "linux"].includes(platform)) {
    return { state: "unsupported-platform" };
  }
  const which = opts.which ?? ((n) => whichOnPath(n, { platform }));
  const cliPath = which("devcontainer");
  if (!cliPath) {
    return {
      state: "not-installed",
      installHint: `Install the dev container CLI with \`${DEVCONTAINER_INSTALL_COMMAND}\` (needs Node.js and a container runtime; see https://github.com/devcontainers/cli).`,
    };
  }
  if (opts.versionProbe && !opts.versionProbe(cliPath)) {
    return {
      state: "installed-but-unusable",
      reason: "`devcontainer --version` did not answer.",
    };
  }
  if (opts.runtimeUsable && !opts.runtimeUsable.usable) {
    return {
      state: "installed-but-unusable",
      reason:
        opts.runtimeUsable.reason ??
        "The container runtime the dev container CLI needs is not usable.",
    };
  }
  return { state: "ready", cliPath };
}
