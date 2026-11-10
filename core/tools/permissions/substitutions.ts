import type { ShellKind } from "../../util/shell";

/**
 * The commands a shell runs inside a command's own text (plans/command-shell-dialects.md).
 * What counts is the shell's: a backtick is command substitution in bash, zsh
 * and sh but PowerShell's escape character (`` `n ``, `` `$x ``, a line
 * continuation) and nothing in cmd; `$(...)` is substitution in POSIX shells
 * and a subexpression in PowerShell (also `@(...)`, and inside double quotes);
 * `<(...)` and `>(...)` are POSIX only; a single quote suppresses all of it in
 * POSIX and PowerShell; `\$(` is escaped in POSIX; `$((1+2))` is arithmetic.
 *
 * Fail-closed: an unterminated quote or substitution is read as if it were
 * not a quote, so what follows is still scanned; anything the scanner cannot
 * resolve (a zsh `${(e)x}`) is reported as `dynamic` for the caller to treat
 * as "could be anything". With no shell the result is the union of every
 * grammar, which is what a caller that does not know its shell gets.
 */
export type Grammar = "posix" | "zsh" | "powershell" | "cmd";

export interface SubstitutionScan {
  /** The text of each substitution, outer before inner, nested ones included */
  subs: string[];
  /** Constructs that run code the text does not show */
  dynamic: string[];
}

/** The grammars a shell reads; every grammar when the shell is not known. */
export function grammarsOf(shell?: ShellKind): Grammar[] {
  switch (shell) {
    case "bash":
    case "sh":
      return ["posix"];
    case "zsh":
      return ["zsh"];
    case "powershell":
      return ["powershell"];
    case "cmd":
      return ["cmd"];
    default:
      return ["zsh", "powershell", "cmd"];
  }
}

interface Out {
  subs: string[];
  dynamic: string[];
}

const PS_SINGLE = /['‘’‚‛]/;
const PS_DOUBLE = /["“”„]/;
const MAX_NEST = 24;

export function scanSubstitutions(
  text: string,
  shell?: ShellKind,
): SubstitutionScan {
  const out: Out = { subs: [], dynamic: [] };
  for (const g of grammarsOf(shell)) {
    if (g === "powershell") scanPowerShell(text, out, {}, 0);
    else if (g === "cmd") scanCmd(text, out);
    else scanPosix(text, g === "zsh", out, {}, 0);
  }
  return { subs: [...new Set(out.subs)], dynamic: [...new Set(out.dynamic)] };
}

export function extractSubstitutions(
  text: string,
  shell?: ShellKind,
): string[] {
  return scanSubstitutions(text, shell).subs;
}

interface Mode {
  /** Heredoc body or here-string: quotes are plain text, expansions are live */
  body?: boolean;
  /** Inside `$(( ))`: `<(` and `<<` are operators */
  arith?: boolean;
}

/** The index of the `)` that closes a `$(` whose body starts at `start`, or -1. */
function closeParenPosix(s: string, start: number): number {
  let depth = 1;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'") {
      const e = s.indexOf("'", j + 1);
      if (e < 0) return -1;
      j = e;
    } else if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "$" && s[j + 1] === "(") {
          const e = closeParenPosix(s, j + 2);
          if (e < 0) return -1;
          j = e;
        } else if (s[j] === "`") {
          j = endBacktick(s, j);
        }
      }
    } else if (c === "`") {
      j = endBacktick(s, j);
    } else if (c === "#" && /[\s;|&(]/.test(s[j - 1] ?? " ")) {
      const nl = s.indexOf("\n", j);
      if (nl < 0) return -1;
      j = nl;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

/** The index of the closing backtick of one starting at `start`, or the end. */
function endBacktick(s: string, start: number): number {
  let j = start + 1;
  for (; j < s.length && s[j] !== "`"; j++) if (s[j] === "\\") j++;
  return Math.min(j, s.length);
}

const HEREDOC =
  /^<<(-?)[ \t]*(\\?)(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z_][\w.-]*))/;

const ZSH_QUALIFIER_CLOSE: Record<string, string> = {
  "{": "}",
  "[": "]",
  "<": ">",
  "(": ")",
};

function scanPosix(
  s: string,
  zsh: boolean,
  out: Out,
  mode: Mode,
  nest: number,
): void {
  if (nest > MAX_NEST) {
    out.dynamic.push("substitutions nested too deeply to read");
    return;
  }
  const n = s.length;
  const emit = (body: string) => {
    out.subs.push(body);
    scanPosix(body, zsh, out, {}, nest + 1);
  };
  const pending: { delim: string; quoted: boolean; strip: boolean }[] = [];
  let dq = !!mode.body;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (!mode.body) {
      if (!dq && c === "'") {
        const e = s.indexOf("'", i + 1);
        // an unterminated quote is not a quote: keep reading what follows
        i = e < 0 ? i + 1 : e + 1;
        continue;
      }
      if (!dq && c === "$" && s[i + 1] === "'") {
        let j = i + 2;
        while (j < n && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
        i = j >= n ? i + 2 : j + 1;
        continue;
      }
      if (c === '"') {
        dq = !dq;
        i++;
        continue;
      }
      if (!dq && c === "#" && (i === 0 || /[\s;|&(]/.test(s[i - 1]))) {
        const nl = s.indexOf("\n", i);
        i = nl < 0 ? n : nl;
        continue;
      }
      if (!dq && !mode.arith && c === "<" && s[i + 1] === "<") {
        const m = s[i + 2] === "<" ? null : HEREDOC.exec(s.slice(i));
        if (m) {
          pending.push({
            delim: m[3] ?? m[4] ?? m[5],
            quoted: m[2] === "\\" || m[3] !== undefined || m[4] !== undefined,
            strip: m[1] === "-",
          });
          i += m[0].length;
        } else {
          i += s[i + 2] === "<" ? 3 : 2;
        }
        continue;
      }
      if (c === "\n" && pending.length) {
        let pos = i + 1;
        for (const h of pending) {
          let bodyEnd = -1;
          let next = n;
          for (let p = pos; p <= n;) {
            let nl = s.indexOf("\n", p);
            if (nl < 0) nl = n;
            const line = s.slice(p, nl).replace(/\r$/, "");
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
              bodyEnd = p;
              next = Math.min(nl + 1, n);
              break;
            }
            if (nl >= n) break;
            p = nl + 1;
          }
          // A quoted delimiter makes the body literal, but only a body that
          // ends is known to be one: an open one is read as live text
          if (!(h.quoted && bodyEnd >= 0)) {
            scanPosix(
              s.slice(pos, bodyEnd < 0 ? n : bodyEnd),
              zsh,
              out,
              {
                body: true,
              },
              nest + 1,
            );
          }
          pos = bodyEnd < 0 ? n : next;
        }
        pending.length = 0;
        i = pos;
        continue;
      }
    }
    if (c === "$" && s[i + 1] === "(") {
      if (s[i + 2] === "(") {
        // `$((1+2))` is arithmetic, unless the text inside is a command
        let depth = 2;
        let j = i + 3;
        for (; j < n && depth > 0; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") depth--;
        }
        const end = j - 1;
        const inner = s.slice(i + 3, end - 1);
        if (
          depth === 0 &&
          s[end - 1] === ")" &&
          !/[;|`]|[A-Za-z_]\w*[ \t]+[A-Za-z_$"'./-]/.test(
            inner.replace(/\$\(.*\)/s, ""),
          )
        ) {
          scanPosix(inner, zsh, out, { arith: true }, nest + 1);
          i = end + 1;
          continue;
        }
      }
      const close = closeParenPosix(s, i + 2);
      emit(s.slice(i + 2, close < 0 ? n : close));
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (
      !dq &&
      !mode.arith &&
      (c === "<" || c === ">" || (zsh && c === "=")) &&
      s[i + 1] === "("
    ) {
      if (c !== "=" || i === 0 || /[\s;|&(]/.test(s[i - 1])) {
        const close = closeParenPosix(s, i + 2);
        emit(s.slice(i + 2, close < 0 ? n : close));
        i = close < 0 ? n : close + 1;
        continue;
      }
    }
    if (c === "`") {
      const end = endBacktick(s, i);
      const raw = s.slice(i + 1, end);
      emit(raw.replace(dq ? /\\([`\\$"])/g : /\\([`\\$])/g, "$1"));
      i = end + 1;
      continue;
    }
    if (zsh && c === "$" && s[i + 1] === "{" && s[i + 2] === "(") {
      const m = /^\$\{\(([^)]*)\)/.exec(s.slice(i));
      if (m && m[1].includes("e")) {
        out.dynamic.push("${(e)...} evaluates its value as shell code (zsh)");
      }
    }
    if (zsh && c === "(" && !dq && i > 0 && !/[\s$(|&;]/.test(s[i - 1])) {
      // a glob qualifier: `*(e:'cmd':)` runs cmd for every match
      const m = /^\([A-Za-z0-9.^@/\-+,%=*#~]*?e([^\sA-Za-z0-9)])/.exec(
        s.slice(i),
      );
      if (m) {
        const start = i + m[0].length;
        const close = ZSH_QUALIFIER_CLOSE[m[1]] ?? m[1];
        const e = s.indexOf(close, start);
        if (e < 0) out.dynamic.push("a glob qualifier that runs code (zsh)");
        else emit(s.slice(start, e));
      } else if (/^\([A-Za-z0-9.^@/\-+,%=*#~]*\+\w+\)/.test(s.slice(i))) {
        out.dynamic.push("a glob qualifier that calls a function (zsh)");
      }
    }
    i++;
  }
}

function closeParenPowerShell(s: string, start: number): number {
  let depth = 1;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (c === "`") j++;
    else if (PS_SINGLE.test(c)) {
      for (j++; j < s.length; j++) {
        if (PS_SINGLE.test(s[j])) {
          if (PS_SINGLE.test(s[j + 1] ?? "")) j++;
          else break;
        }
      }
    } else if (PS_DOUBLE.test(c)) {
      for (j++; j < s.length && !PS_DOUBLE.test(s[j]); j++) {
        if (s[j] === "`") j++;
        else if (s[j] === "$" && s[j + 1] === "(") {
          const e = closeParenPowerShell(s, j + 2);
          if (e < 0) return -1;
          j = e;
        }
      }
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return -1;
}

function scanPowerShell(s: string, out: Out, mode: Mode, nest: number): void {
  if (nest > MAX_NEST) {
    out.dynamic.push("subexpressions nested too deeply to read");
    return;
  }
  const n = s.length;
  const emit = (body: string) => {
    out.subs.push(body);
    scanPowerShell(body, out, {}, nest + 1);
  };
  let dq = !!mode.body;
  let i = 0;
  while (i < n) {
    const c = s[i];
    // the escape character: `$ is a dollar sign, `n a newline, `<newline> a continuation
    if (c === "`") {
      i += 2;
      continue;
    }
    if (!mode.body) {
      if (!dq && c === "@" && (s[i + 1] === "'" || s[i + 1] === '"')) {
        const q = s[i + 1];
        const open = /^@['"][ \t]*\r?\n/.exec(s.slice(i));
        const end = open ? s.search(new RegExp(`\\r?\\n${q}@`)) : -1;
        if (open && end > i) {
          if (q === '"') {
            scanPowerShell(
              s.slice(i + open[0].length, end),
              out,
              { body: true },
              nest + 1,
            );
          }
          i = end + 3;
          continue;
        }
      }
      if (!dq && PS_SINGLE.test(c)) {
        let j = i + 1;
        let closed = false;
        for (; j < n; j++) {
          if (PS_SINGLE.test(s[j])) {
            if (PS_SINGLE.test(s[j + 1] ?? "")) j++;
            else {
              closed = true;
              break;
            }
          }
        }
        // an unterminated quote is not a quote: keep reading what follows
        i = closed ? j + 1 : i + 1;
        continue;
      }
      if (PS_DOUBLE.test(c)) {
        dq = !dq;
        i++;
        continue;
      }
      if (!dq && c === "<" && s[i + 1] === "#") {
        const e = s.indexOf("#>", i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (!dq && c === "#" && (i === 0 || /[\s;|&({]/.test(s[i - 1]))) {
        const nl = s.indexOf("\n", i);
        i = nl < 0 ? n : nl;
        continue;
      }
    }
    if ((c === "$" || (c === "@" && !dq)) && s[i + 1] === "(") {
      const close = closeParenPowerShell(s, i + 2);
      emit(s.slice(i + 2, close < 0 ? n : close));
      i = close < 0 ? n : close + 1;
      continue;
    }
    i++;
  }
}

/** cmd has no substitution, but `for /f ... in ('command')` runs one. */
function scanCmd(s: string, out: Out): void {
  const re = /\bfor\s+\/f\b[^()]*?\bin\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/gi;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out.subs.push(m[2]);
  }
}
