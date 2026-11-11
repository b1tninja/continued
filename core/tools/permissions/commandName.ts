import type { ShellKind } from "../../util/shell";

/**
 * Is the program a command runs named by a variable? Then no rule written
 * about programs (`git push*`, `rm *`) can say what it is: the text holds
 * `$cmd`, not the name it will have when the shell runs it. A command like
 * that always asks, at every level, and Automatic does not hand it to the
 * reviewer model.
 *
 * What counts depends on the shell, because the same characters mean
 * different things:
 *
 *   bash, zsh, sh   `$cmd args`, `${prog}`, `"$cmd" args`, `"$@"`, `A=1 $cmd`,
 *                   `$HOME/bin/tool`, and the same after `do`, `then`, `{`, `(`
 *   PowerShell      `& $cmd`, `. $script`, `& "$dir\tool.exe"`, `& (expr)`.
 *                   A statement that starts with `$` is an expression or an
 *                   assignment (`$x = 1`, `$env:A = 'b'`, `$_.Name`) and never
 *                   names a command: PowerShell reports a syntax error for
 *                   `$x arg`. A variable used as an argument is not hit.
 *   cmd             `$x` is an ordinary character, not an expansion.
 *   unknown         the bash and the PowerShell reading, whichever hits
 *
 * Quoted text and here-strings are data and are not read. This is a text
 * scan, not a parser; like the other scans it over-matches rather than
 * under-matches, and a hit only asks.
 */
export function hiddenCommandName(
  command: string,
  shell?: ShellKind,
): string | undefined {
  if (shell === "cmd") return undefined;
  if (shell === "powershell") return powershellHit(command);
  const bash = posixHit(command);
  if (bash || (shell !== undefined && shell !== "unknown")) return bash;
  return powershellHit(command);
}

const REASON_VAR = "a command whose name is a variable";
const REASON_CALL = "a command run from a variable or an expression";

/** The characters that end a word outside quotes. */
const WORD_END = /[\s;|&<>()]/;

/** The end of the word that starts at `i`: quotes, `${...}` and `$(...)` stay inside it. */
function wordEnd(text: string, start: number, powershell: boolean): number {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return text.length;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === (powershell ? "`" : "\\")) i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === (powershell ? "`" : "\\")) {
      i += 2;
      continue;
    }
    if (c === "$" && (text[i + 1] === "{" || text[i + 1] === "(")) {
      i = closing(text, i + 1);
      continue;
    }
    if (WORD_END.test(c)) break;
    i++;
  }
  return Math.min(i, text.length);
}

/** One past the bracket that closes the one at `open`. */
function closing(text: string, open: number): number {
  const pair: Record<string, string> = { "{": "}", "(": ")" };
  const want = pair[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === want && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The index of the newline that ends the last pending here-document body. */
function skipHeredocBodies(
  command: string,
  from: number,
  pending: string[],
): number {
  let i = from;
  for (const delimiter of pending.splice(0)) {
    for (;;) {
      const nl = command.indexOf("\n", i);
      const line = command.slice(i, nl === -1 ? command.length : nl);
      i = nl === -1 ? command.length : nl + 1;
      if (line.trim() === delimiter || nl === -1) break;
    }
  }
  return i - 1;
}

/** The same statement-start positions for both dialects. */
function statementStarts(command: string, powershell: boolean): number[] {
  const starts = [0];
  let quote: "'" | '"' | null = null;
  const heredocs: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === (powershell ? "`" : "\\") && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (powershell && (c === "@" || c === "$") && command[i + 1] === "{") {
      // `${name}` is a variable; `@{` opens a hashtable, whose keys are not commands
      if (c === "$") i = closing(command, i + 1) - 1;
      continue;
    }
    if (
      powershell &&
      c === "@" &&
      (command[i + 1] === "'" || command[i + 1] === '"')
    ) {
      const close = command.indexOf(`\n${command[i + 1]}@`, i + 2);
      i = close === -1 ? command.length : close + 2;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === (powershell ? "`" : "\\")) i++;
    else if (c === "#" && (i === 0 || /[\s;|&(]/.test(command[i - 1]))) {
      const nl = command.indexOf("\n", i);
      i = nl === -1 ? command.length : nl - 1;
    } else if (c === "$" && !powershell && command[i + 1] === "{") {
      i = closing(command, i + 1) - 1;
    } else if (
      !powershell &&
      command.startsWith("<<", i) &&
      command[i + 2] !== "<"
    ) {
      const m = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([\w.-]+))/.exec(
        command.slice(i),
      );
      if (m) heredocs.push(m[1] ?? m[2] ?? m[3]);
      i++;
    } else if (c === "\n" && heredocs.length > 0) {
      i = skipHeredocBodies(command, i + 1, heredocs);
      starts.push(i + 1);
    } else if (c === "&" && command[i + 1] === "&") {
      starts.push(i + 2);
      i++;
    } else if (!powershell && c === "(" && command[i + 1] === "(") {
      // `(( ... ))` is arithmetic: its variables are operands
      i = closing(command, i) - 1;
    } else if (!powershell && command.startsWith("$((", i)) {
      i = closing(command, i + 1) - 1;
    } else if (/[\n;|{}(]/.test(c)) {
      starts.push(i + 1);
    } else if (!powershell && c === "&" && !/[<>]/.test(command[i - 1] ?? "")) {
      starts.push(i + 1);
    } else if (powershell && c === "=") {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** An expansion outside single quotes: `$name`, `${...}`, `$1`, `$@`, `$*`. */
function expands(word: string, powershell: boolean): boolean {
  let single = false;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "'" && !word.slice(0, i).endsWith("\\")) single = !single;
    else if (
      !single &&
      c === "$" &&
      /[{A-Za-z_0-9@*]/.test(word[i + 1] ?? "")
    ) {
      return true;
    } else if (!single && powershell && c === "`") i++;
  }
  return false;
}

const KEYWORDS = new Set([
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
]);

function posixHit(command: string): string | undefined {
  for (const start of statementStarts(command, false)) {
    let i = start;
    for (;;) {
      while (i < command.length && /[ \t]/.test(command[i])) i++;
      if (i >= command.length || /[\n;|&<>()]/.test(command[i])) break;
      const end = wordEnd(command, i, false);
      if (end === i) break;
      const word = command.slice(i, end);
      i = end;
      if (/^[A-Za-z_][A-Za-z0-9_]*(\+?=|\[[^\]]*\]=)/.test(word)) continue;
      if (KEYWORDS.has(word)) continue;
      if (expands(word, false)) return REASON_VAR;
      break;
    }
  }
  return undefined;
}

function powershellHit(command: string): string | undefined {
  for (const start of statementStarts(command, true)) {
    let i = start;
    while (i < command.length && /\s/.test(command[i])) i++;
    const op = command[i];
    if (op !== "&" && op !== ".") continue;
    // `.\run.ps1` and `..\x` are paths; the call operator stands alone
    if (op === "." ? !/\s/.test(command[i + 1] ?? "") : command[i + 1] === "&")
      continue;
    i++;
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) continue;
    const next = command[i];
    if (next === "{") continue;
    if (next === "(" || next === "@" || next === "[") return REASON_CALL;
    const word = command.slice(i, wordEnd(command, i, true));
    if (expands(word, true) || /^["']?\$/.test(word)) return REASON_CALL;
  }
  return undefined;
}
