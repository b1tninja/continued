import {
  CONFIG_DIR_NAMES,
  FOREIGN_CONFIG_DIR,
  FOREIGN_LOADED_DIRS,
  FOREIGN_LOADED_FILES,
  knownConfigNames,
  PRODUCT_LOADED_DIRS,
  PRODUCT_LOADED_FILES,
  PROJECT_ROOT_FILES,
  PROJECT_STATE_DIRS,
  RC_FILE,
} from "../../util/productPaths";

/**
 * Which paths are the product's own configuration, code, rules or hooks, read
 * from PRODUCT_LOADED_PATHS (core/util/productPaths.ts) rather than from a
 * list kept here. All on paths already normalised by `normalizeProtectedPath`
 * (forward slashes, `~` for the home directory, `..` resolved).
 *
 * - The global folder (`~/.continuous`, `~/.continue`, and the folder
 *   CONTINUOUS_GLOBAL_DIR or CONTINUE_GLOBAL_DIR names) is locked as a whole.
 * - A folder of that name in a project, at any depth, is locked as a whole
 *   except what the product writes itself (`plans`).
 * - `.claude/settings*.json`, `.claude/agents` and `.claude/skills`, which the
 *   product reads too, and `.continuerc.*` and `.continuerules` anywhere.
 *
 * A folder as broad as the home directory, a drive root, or one holding the
 * project is not locked as a whole; only the names the product reads in it.
 */

export interface LockOptions {
  /** Normalised global folders: the defaults and the one an env var names. */
  globalDirs?: string[];
  /** Normalised working directory, to tell a global folder from a project one. */
  cwd?: string;
}

const MAX_VARIANTS = 256;

const segmentsOf = (p: string): string[] =>
  p
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .map((s) => s.toLowerCase());

/** `PREFIX~1` or `PREFIX~1.EXT`: the 8.3 name Windows gives a long one. */
const SHORT_NAME = /^([^~.]{1,6})~[0-9]+(?:\.([^.]{1,3}))?$/;

const DIR_NAMES = new Set(Object.keys(PRODUCT_LOADED_DIRS).map(lower));
const FILE_NAMES = new Set(Object.keys(PRODUCT_LOADED_FILES).map(lower));
const FOREIGN_FILES = new Set(FOREIGN_LOADED_FILES);
const FOREIGN_DIRS = new Set(FOREIGN_LOADED_DIRS);
const ROOT_FILES = new Set(PROJECT_ROOT_FILES);
const CONFIG_DIRS = new Set(CONFIG_DIR_NAMES);
const STATE_DIRS = new Set(PROJECT_STATE_DIRS);

function lower(s: string): string {
  return s.toLowerCase();
}

/** Is `rest`, the path inside a config folder, one the product reads? */
function insideConfigDir(rest: string[], whole: boolean, project: boolean) {
  if (rest.length === 0) return true;
  if (project && STATE_DIRS.has(rest[0])) return false;
  if (whole) return true;
  return (
    FILE_NAMES.has(rest[0]) ||
    DIR_NAMES.has(rest[0]) ||
    RC_FILE.test(rest[rest.length - 1])
  );
}

function foreignHit(rest: string[]): boolean {
  if (rest.length === 0) return true;
  if (FOREIGN_DIRS.has(rest[0])) return true;
  return rest.length === 1 && FOREIGN_FILES.has(rest[0]);
}

function startsWith(segs: string[], prefix: string[]): boolean {
  return prefix.every((s, i) => segs[i] === s);
}

/** A global folder that holds the working directory is locked by name, not whole. */
function lockedWhole(gsegs: string[], cwd: string[] | undefined): boolean {
  // The home directory and a drive root are as broad as a folder gets.
  if (gsegs.length === 1) return false;
  return !(cwd && startsWith(cwd, gsegs));
}

function literalHit(segs: string[], opts: LockOptions): boolean {
  const cwd = opts.cwd ? segmentsOf(opts.cwd) : undefined;
  for (const dir of opts.globalDirs ?? []) {
    const gsegs = segmentsOf(dir);
    if (gsegs.length === 0 || !startsWith(segs, gsegs)) continue;
    const whole = lockedWhole(gsegs, cwd);
    const rest = segs.slice(gsegs.length);
    // The broad folder itself is not a config file.
    if (rest.length === 0 && !whole) continue;
    if (insideConfigDir(rest, whole, false)) return true;
  }
  const i = segs.findIndex((s) => CONFIG_DIRS.has(s));
  if (i >= 0 && insideConfigDir(segs.slice(i + 1), true, true)) return true;
  const f = segs.indexOf(FOREIGN_CONFIG_DIR);
  if (f >= 0 && foreignHit(segs.slice(f + 1))) return true;
  const base = segs[segs.length - 1] ?? "";
  return RC_FILE.test(base) || ROOT_FILES.has(base);
}

/** The long names a short one could stand for. */
function expansions(seg: string, names: string[]): string[] {
  const m = SHORT_NAME.exec(seg);
  if (!m) return [];
  const [, prefix, ext] = m;
  return names.filter((n) => {
    const dot = n.lastIndexOf(".");
    const stem = (dot > 0 ? n.slice(0, dot) : n).replace(/[.\s]/g, "");
    const e = dot > 0 ? n.slice(dot + 1) : "";
    return stem.startsWith(prefix) && (ext ? e.startsWith(ext) : true);
  });
}

/** Try each reading of every 8.3 segment, up to a cap. */
function shortNameHit(
  segs: string[],
  names: string[],
  opts: LockOptions,
): boolean {
  let budget = MAX_VARIANTS;
  const walk = (i: number, acc: string[]): boolean => {
    if (budget <= 0) return false;
    if (i === segs.length) {
      budget--;
      return literalHit(acc, opts);
    }
    const options = [segs[i], ...expansions(segs[i], names)];
    return options.some((o) => walk(i + 1, [...acc, o]));
  };
  return segs.some((s) => SHORT_NAME.test(s)) && walk(0, []);
}

/** Is this normalised path one the product loads as config, code, rules or hooks? */
export function isLockedProductPath(
  p: string,
  opts: LockOptions = {},
): boolean {
  const segs = segmentsOf(p);
  if (literalHit(segs, opts)) return true;
  const names = [
    ...knownConfigNames(),
    ...(opts.globalDirs ?? []).flatMap(segmentsOf),
  ];
  return shortNameHit(segs, names, opts);
}
