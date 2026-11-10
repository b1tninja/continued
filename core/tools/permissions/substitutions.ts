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

interface Heredoc {
  delim: string;
  quoted: boolean;
  strip: boolean;
}

/** The state of one POSIX scan: the text, the position, and what is open. */
interface Posix {
  s: string;
  zsh: boolean;
  out: Out;
  mode: Mode;
  nest: number;
  pending: Heredoc[];
  /** Inside double quotes (always, in a heredoc body) */
  dq: boolean;
  i: number;
}

const WORD_START = /[\s;|&(]/;

/** Reads a substitution body at the cursor, then moves past its end. */
function emitPosix(p: Posix, bodyStart: number, close: number): void {
  const body = p.s.slice(bodyStart, close < 0 ? p.s.length : close);
  p.out.subs.push(body);
  scanPosix(body, p.zsh, p.out, {}, p.nest + 1);
  p.i = close < 0 ? p.s.length : close + 1;
}

/** Single quotes and `$'...'`: nothing inside is read. */
function posixSingleQuote(p: Posix): boolean {
  const { s, i } = p;
  if (p.dq) return false;
  if (s[i] === "'") {
    const e = s.indexOf("'", i + 1);
    // an unterminated quote is not a quote: keep reading what follows
    p.i = e < 0 ? i + 1 : e + 1;
    return true;
  }
  if (s[i] === "$" && s[i + 1] === "'") {
    let j = i + 2;
    while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
    p.i = j >= s.length ? i + 2 : j + 1;
    return true;
  }
  return false;
}

function posixComment(p: Posix): boolean {
  const { s, i } = p;
  if (p.dq || s[i] !== "#") return false;
  if (i > 0 && !WORD_START.test(s[i - 1])) return false;
  const nl = s.indexOf("\n", i);
  p.i = nl < 0 ? s.length : nl;
  return true;
}

/** `<<WORD` queues a heredoc whose body starts after the line ends. */
function posixHeredocStart(p: Posix): boolean {
  const { s, i } = p;
  if (p.dq || p.mode.arith || s[i] !== "<" || s[i + 1] !== "<") return false;
  const m = s[i + 2] === "<" ? null : HEREDOC.exec(s.slice(i));
  if (m) {
    p.pending.push({
      delim: m[3] ?? m[4] ?? m[5],
      quoted: m[2] === "\\" || m[3] !== undefined || m[4] !== undefined,
      strip: m[1] === "-",
    });
    p.i += m[0].length;
  } else {
    p.i += s[i + 2] === "<" ? 3 : 2;
  }
  return true;
}

/** Where a heredoc body ends: the start of its closing line and the text after it. */
function heredocEnd(
  s: string,
  pos: number,
  h: Heredoc,
): { bodyEnd: number; next: number } {
  const n = s.length;
  for (let q = pos; q <= n;) {
    let nl = s.indexOf("\n", q);
    if (nl < 0) nl = n;
    const line = s.slice(q, nl).replace(/\r$/, "");
    if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
      return { bodyEnd: q, next: Math.min(nl + 1, n) };
    }
    if (nl >= n) break;
    q = nl + 1;
  }
  return { bodyEnd: -1, next: n };
}

/** At the newline that ends a line with heredocs: read their bodies. */
function posixHeredocBodies(p: Posix): boolean {
  const { s } = p;
  if (s[p.i] !== "\n" || p.pending.length === 0) return false;
  let pos = p.i + 1;
  for (const h of p.pending) {
    const { bodyEnd, next } = heredocEnd(s, pos, h);
    // A quoted delimiter makes the body literal, but only a body that
    // ends is known to be one: an open one is read as live text
    if (!(h.quoted && bodyEnd >= 0)) {
      const body = s.slice(pos, bodyEnd < 0 ? s.length : bodyEnd);
      scanPosix(body, p.zsh, p.out, { body: true }, p.nest + 1);
    }
    pos = bodyEnd < 0 ? s.length : next;
  }
  p.pending.length = 0;
  p.i = pos;
  return true;
}

/** `$((1+2))` is arithmetic unless the text inside is a command. */
function posixArithmetic(p: Posix): boolean {
  const { s, i } = p;
  let depth = 2;
  let j = i + 3;
  for (; j < s.length && depth > 0; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") depth--;
  }
  const end = j - 1;
  const inner = s.slice(i + 3, end - 1);
  const command = /[;|`]|[A-Za-z_]\w*[ \t]+[A-Za-z_$"'./-]/.test(
    inner.replace(/\$\(.*\)/s, ""),
  );
  if (depth !== 0 || s[end - 1] !== ")" || command) return false;
  scanPosix(inner, p.zsh, p.out, { arith: true }, p.nest + 1);
  p.i = end + 1;
  return true;
}

/** `$(...)`, and `<(...)`, `>(...)`, zsh `=(...)` outside quotes. */
function posixSubstitution(p: Posix): boolean {
  const { s, i } = p;
  const c = s[i];
  if (c === "$" && s[i + 1] === "(") {
    if (s[i + 2] === "(" && posixArithmetic(p)) return true;
    emitPosix(p, i + 2, closeParenPosix(s, i + 2));
    return true;
  }
  const process =
    !p.dq &&
    !p.mode.arith &&
    (c === "<" || c === ">" || (p.zsh && c === "=")) &&
    s[i + 1] === "(";
  if (process && (c !== "=" || i === 0 || WORD_START.test(s[i - 1]))) {
    emitPosix(p, i + 2, closeParenPosix(s, i + 2));
    return true;
  }
  if (c === "`") {
    const end = endBacktick(s, i);
    const raw = s.slice(i + 1, end);
    const body = raw.replace(p.dq ? /\\([`\\$"])/g : /\\([`\\$])/g, "$1");
    p.out.subs.push(body);
    scanPosix(body, p.zsh, p.out, {}, p.nest + 1);
    p.i = end + 1;
    return true;
  }
  return false;
}

const ZSH_QUALIFIER = "[A-Za-z0-9.^@/\\-+,%=*#~]*";

/** zsh code the text only hints at: `${(e)x}` and glob qualifiers `*(e:cmd:)`. */
function zshCodeHints(p: Posix): void {
  const { s, i } = p;
  if (s[i] === "$" && s[i + 1] === "{" && s[i + 2] === "(") {
    const m = /^\$\{\(([^)]*)\)/.exec(s.slice(i));
    if (m && m[1].includes("e")) {
      p.out.dynamic.push("${(e)...} evaluates its value as shell code (zsh)");
    }
    return;
  }
  if (s[i] !== "(" || p.dq || i === 0 || /[\s$(|&;]/.test(s[i - 1])) return;
  // a glob qualifier: `*(e:'cmd':)` runs cmd for every match
  const m = new RegExp(`^\\(${ZSH_QUALIFIER}?e([^\\sA-Za-z0-9)])`).exec(
    s.slice(i),
  );
  if (m) {
    const start = i + m[0].length;
    const close = ZSH_QUALIFIER_CLOSE[m[1]] ?? m[1];
    const e = s.indexOf(close, start);
    if (e < 0) p.out.dynamic.push("a glob qualifier that runs code (zsh)");
    else {
      const body = s.slice(start, e);
      p.out.subs.push(body);
      scanPosix(body, p.zsh, p.out, {}, p.nest + 1);
    }
  } else if (new RegExp(`^\\(${ZSH_QUALIFIER}\\+\\w+\\)`).test(s.slice(i))) {
    p.out.dynamic.push("a glob qualifier that calls a function (zsh)");
  }
}

/** The constructs that only apply outside a heredoc body or here-string. */
function posixQuoting(p: Posix): boolean {
  if (posixSingleQuote(p)) return true;
  if (p.s[p.i] === '"') {
    p.dq = !p.dq;
    p.i++;
    return true;
  }
  return posixComment(p) || posixHeredocStart(p) || posixHeredocBodies(p);
}

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
  const p: Posix = {
    s,
    zsh,
    out,
    mode,
    nest,
    pending: [],
    dq: !!mode.body,
    i: 0,
  };
  while (p.i < s.length) {
    if (s[p.i] === "\\") {
      p.i += 2;
      continue;
    }
    if (!mode.body && posixQuoting(p)) continue;
    if (posixSubstitution(p)) continue;
    if (zsh) zshCodeHints(p);
    p.i++;
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
