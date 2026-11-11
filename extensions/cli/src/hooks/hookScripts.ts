/**
 * Which workspace files a hook command runs, so trust can follow the file and
 * not only the command line.
 *
 * `node scripts/pre.js` is the same string after `git pull` rewrites
 * scripts/pre.js, so a fingerprint of the string alone approves whatever the
 * file becomes. This finds the files a command names and the fingerprint adds
 * a hash of each one's content.
 *
 * Best effort and deliberately simple: the program and the first few words
 * after it are looked at, in each part of a `&&`, `||`, `;` or `|` chain. A
 * word that resolves to a file inside the workspace counts, which covers
 * `./x.sh`, `bash x.sh`, `node x.js`, `python x.py`, `pwsh -File x.ps1` and
 * `npx tsx x.ts`. Not covered: files those scripts import or source, a script
 * outside the workspace, and a path built by the shell at run time.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Words after the program that are looked at, flags not counted. */
const MAX_WORDS_AFTER_PROGRAM = 4;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

/** Split a command into words, keeping quoted text together, one list per chained command. */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let quote: string | null = null;
  let inWord = false;
  const endWord = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      endWord();
    } else if (c === "&" || c === "|" || c === ";") {
      endWord();
      if (segments[segments.length - 1].length > 0) segments.push([]);
    } else {
      word += c;
      inWord = true;
    }
  }
  endWord();
  return segments.filter((s) => s.length > 0);
}

/** `$CLAUDE_PROJECT_DIR`, `${CONTINUE_PROJECT_DIR}` and `%CLAUDE_PROJECT_DIR%` become the folder. */
function expandProjectDir(word: string, cwd: string): string {
  return word.replace(
    /\$\{?(?:CLAUDE|CONTINUE)_PROJECT_DIR\}?|%(?:CLAUDE|CONTINUE)_PROJECT_DIR%/g,
    cwd,
  );
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The workspace files `command` appears to run: real paths inside `cwd`,
 * each once, in order of appearance.
 */
export function findWorkspaceScripts(command: string, cwd: string): string[] {
  let root: string;
  try {
    root = fs.realpathSync.native(cwd);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const words of splitSegments(command)) {
    // Leading NAME=value words set the environment; the program follows them.
    let start = 0;
    while (start < words.length && /^[A-Za-z_]\w*=/.test(words[start])) start++;
    const program = words.slice(start);
    if (program.length === 0) continue;
    const candidates = [
      program[0],
      ...program
        .slice(1)
        .filter((w) => !w.startsWith("-"))
        .slice(0, MAX_WORDS_AFTER_PROGRAM),
    ];
    for (const candidate of candidates) {
      if (candidate.startsWith("-")) continue;
      const resolved = path.resolve(cwd, expandProjectDir(candidate, cwd));
      let real: string;
      try {
        real = fs.realpathSync.native(resolved);
        if (!fs.statSync(real).isFile()) continue;
      } catch {
        continue;
      }
      if (isInside(real, root) && !found.includes(real)) found.push(real);
    }
  }
  return found;
}

/**
 * `path<NUL>sha256` lines for the script files `command` runs, or an empty
 * string when it runs none. A file too large to hash, or unreadable, is
 * recorded as such, so it cannot silently count as unchanged.
 */
export function scriptFingerprint(command: string, cwd: string): string {
  const lines: string[] = [];
  let root = cwd;
  try {
    root = fs.realpathSync.native(cwd);
  } catch {
    // keep the given folder
  }
  for (const file of findWorkspaceScripts(command, cwd)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    let digest: string;
    try {
      const size = fs.statSync(file).size;
      digest =
        size > MAX_SCRIPT_BYTES
          ? `too-large:${size}`
          : crypto
              .createHash("sha256")
              .update(fs.readFileSync(file))
              .digest("hex");
    } catch {
      digest = "unreadable";
    }
    lines.push(`${relative}\0${digest}`);
  }
  return lines.join("\n");
}
