import { programName } from "./destinations";

/**
 * The built-in rule `no-fetch-and-run` (plans/command-analysis.md, P11): a
 * network command whose output, or the file it wrote, is then executed.
 *
 *   curl https://x/i.sh | sh            wget -qO- https://x/i.sh | bash
 *   curl -o f https://x && sh f         iwr https://x | iex
 *   bash <(curl https://x)              sh -c "$(curl https://x)"
 *   iex (iwr https://x)                 iex ((New-Object Net.WebClient).DownloadString('https://x'))
 *
 * A download alone is not a hit, and neither is a download piped to a
 * program that does not run it (`curl x | jq`, `curl -o f && cat f`).
 *
 * This reads the text with its own quote and parenthesis aware splitter and
 * does not need the command graph, which refuses substitutions and groups.
 * Like the protected-path scan it over-matches on purpose: a hit asks.
 * It cannot see a script that downloads and runs inside itself, a variable
 * holding the program, or a file renamed between the two steps.
 */

const FETCHERS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "aria2c",
  "invoke-webrequest",
  "invoke-restmethod",
  "start-bitstransfer",
]);

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
]);
const SCRIPTING =
  /^(python[\d.]*|perl|ruby|node|nodejs|php|lua|deno|bun|rscript)$/;
/** Run what they are given, as text: they do not read it from a pipe. */
const EVALUATORS = new Set(["eval", "source", ".", "invoke-expression"]);
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "exec",
  "command",
  "builtin",
  "nice",
  "stdbuf",
  "timeout",
]);
/** Flags that bring their own program text or script, so stdin is not read. */
const OWN_PROGRAM = /^-(c|e|m|p|f|file|command|encodedcommand|ec)$/i;
const DOTNET_DOWNLOAD =
  /\bDownload(?:String|Data|File)(?:Async)?\s*\(|\bInvoke-(?:WebRequest|RestMethod)\b/i;

const MAX_DEPTH = 6;

interface Segment {
  /** Raw text, quotes kept */
  text: string;
  /** The operator that joined it to the previous segment */
  join: string;
}

/** Split on `| && || ; & newline` outside quotes and parentheses. */
function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let cur = "";
  let join = "";
  let quote: "'" | '"' | "`" | null = null;
  let depth = 0;
  const flush = (next: string) => {
    if (cur.trim()) out.push({ text: cur.trim(), join });
    cur = "";
    join = next;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < text.length) {
        cur += text[++i];
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    if (depth === 0) {
      const two = text.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === "|&") {
        flush(two);
        i++;
        continue;
      }
      // `2>&1` and `>&` are redirects, not a background operator
      if (c === "&" && (text[i - 1] === ">" || text[i + 1] === ">")) {
        cur += c;
        continue;
      }
      if (c === "|" || c === ";" || c === "&" || c === "\n") {
        flush(c === "\n" ? ";" : c);
        continue;
      }
    }
    cur += c;
  }
  flush("");
  return out;
}

/** Words split on spaces outside quotes and parentheses; quotes removed from plain words. */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    if (/\s/.test(c) && depth === 0) {
      if (cur) words.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) words.push(cur);
  return words;
}

/** The contents of every `(...)` group in the text (only `$(...)` with dollarOnly), then backticks. */
function groupBodies(text: string, dollarOnly = false): string[] {
  const out: string[] = [];
  const starts: number[] = [];
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'") quote = c;
    else if (c === '"') {
      // Double quotes can hold `$(...)`; look inside them
    } else if (c === "(")
      starts.push(dollarOnly && text[i - 1] !== "$" ? -1 : i);
    else if (c === ")" && starts.length) {
      const at = starts.pop()!;
      if (at >= 0) out.push(text.slice(at + 1, i));
    }
  }
  for (const s of starts) if (s >= 0) out.push(text.slice(s + 1));
  // Backtick substitution
  for (const m of text.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  return out;
}

interface Simple {
  /** Canonical program name, or the path-like word as written */
  program: string;
  /** The program word as written, quotes removed */
  raw: string;
  args: string[];
}

function simpleOf(segment: string): Simple | undefined {
  let words = splitWords(segment);
  // A call operator, a leading group or substitution: `& ./f`, `(iwr x).Content`
  words = words.map((w, i) => (i === 0 ? w.replace(/^[(&$]+/, "") : w));
  while (words.length && !words[0]) words.shift();
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    const w = words[i]?.toLowerCase();
    if (w !== undefined && WRAPPERS.has(programName(w))) {
      i++;
      while (i < words.length && words[i].startsWith("-")) i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return undefined;
  const raw = words[i];
  return { program: programName(raw), raw, args: words.slice(i + 1) };
}

function isFetcher(s: Simple | undefined): s is Simple {
  return !!s && FETCHERS.has(s.program);
}

/** Does the text start a download anywhere inside it, in any nesting? */
function fetchesInside(text: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  if (DOTNET_DOWNLOAD.test(text) && /\bNet\.WebClient\b|\bDownload/i.test(text))
    return true;
  for (const seg of splitSegments(text)) {
    if (isFetcher(simpleOf(seg.text))) return true;
    for (const body of groupBodies(seg.text)) {
      if (fetchesInside(body, depth + 1)) return true;
    }
  }
  return false;
}

function isInterpreter(program: string): boolean {
  return SHELLS.has(program) || SCRIPTING.test(program);
}

/** Does this program read a script from its standard input when piped to? */
function runsPipedInput(s: Simple): boolean {
  if (s.program === "invoke-expression") return true;
  if (!isInterpreter(s.program)) {
    // `source /dev/stdin`, `. /dev/stdin`
    return (
      EVALUATORS.has(s.program) &&
      s.args.some((a) => a === "/dev/stdin" || a === "/dev/fd/0")
    );
  }
  let skipNext = false;
  for (const a of s.args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (a === "-" || a === "-s" || a === "/dev/stdin") return true;
    if (OWN_PROGRAM.test(a)) return false;
    if (a === "-o" || a === "-O" || a === "-W" || a === "-X") {
      skipNext = true;
      continue;
    }
    if (!a.startsWith("-")) return false;
  }
  return true;
}

/** Does this program run text given in its arguments, so a download inside them is run? */
function runsArgumentText(s: Simple): boolean {
  if (EVALUATORS.has(s.program)) return true;
  return (
    isInterpreter(s.program) &&
    s.args.some((a) => OWN_PROGRAM.test(a) && !/^-(m|f|file|p)$/i.test(a))
  );
}

/** Process substitution `<(...)` as an operand of an interpreter or `source`. */
function hasProcessSubstitution(text: string, depth: number): boolean {
  for (const m of text.matchAll(/<\(/g)) {
    const body = groupBodies(text.slice(m.index! + 1))[0];
    if (body !== undefined && fetchesInside(body, depth + 1)) return true;
  }
  return false;
}

const norm = (p: string) =>
  p
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .toLowerCase();
const base = (p: string) => norm(p).split("/").pop() ?? "";

/** The files a download command writes (a remote name is taken from the URL). */
function writtenFiles(s: Simple, nextIsTee?: Simple): string[] {
  const files: string[] = [];
  const url = s.args.find((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a));
  const urlName = () => {
    if (!url) return undefined;
    const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
    return path.split(/[?#]/)[0].split("/").filter(Boolean).pop();
  };
  let stdout = false;
  const a = s.args;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    let m: RegExpExecArray | null;
    if (s.program === "curl" || s.program === "http" || s.program === "https") {
      if (w === "-O" || w === "--remote-name" || w === "-J") {
        const n = urlName();
        if (n) files.push(n);
      } else if (w === "--output" || w === "-o") {
        if (a[i + 1]) files.push(a[++i]);
      } else if ((m = /^--output=(.+)$/.exec(w))) files.push(m[1]);
      else if ((m = /^-[A-Za-z]*o(.+)$/.exec(w)) && !w.startsWith("--")) {
        files.push(m[1]);
      } else if ((m = /^-[A-Za-z]*o$/.exec(w)) && !w.startsWith("--")) {
        if (a[i + 1]) files.push(a[++i]);
      } else if ((m = /^-[A-Za-z]*O$/.exec(w)) && !w.startsWith("--")) {
        const n = urlName();
        if (n) files.push(n);
      }
    } else if (s.program === "wget" || s.program === "aria2c") {
      if (w === "--output-document" || w === "-O" || w === "-o") {
        const v = a[++i];
        if (v === "-") stdout = true;
        else if (v) files.push(v);
      } else if ((m = /^--output-document=(.+)$/.exec(w))) {
        if (m[1] === "-") stdout = true;
        else files.push(m[1]);
      } else if ((m = /^-[A-Za-z]*O(.*)$/.exec(w)) && !w.startsWith("--")) {
        if (m[1] === "-") stdout = true;
        else if (m[1]) files.push(m[1]);
        else if (a[i + 1] && a[i + 1] !== "-") files.push(a[++i]);
        else stdout = true;
      }
    } else if (/^-(o|out\w*)(?::(.+))?$/i.test(w)) {
      m = /^-(?:o|out\w*)(?::(.+))?$/i.exec(w);
      const v = m?.[1] ?? a[++i];
      if (v) files.push(v);
    }
    // A redirect to a file
    if ((m = /^\d?>>?(.+)$/.exec(w)) && !/^&/.test(m[1])) files.push(m[1]);
    else if (/^\d?>>?$/.test(w) && a[i + 1]) files.push(a[++i]);
  }
  if (s.program === "wget" && !stdout && files.length === 0) {
    const n = urlName();
    files.push(n ?? "index.html");
  }
  if (nextIsTee) {
    const t = nextIsTee.args.filter((x) => !x.startsWith("-"));
    files.push(...t);
  }
  return files.filter(Boolean);
}

/** Does this segment run the named file (as a script argument or as the program)? */
function runsFile(s: Simple, files: string[]): boolean {
  const names = files.map(base);
  if (isInterpreter(s.program) || EVALUATORS.has(s.program)) {
    return s.args.some((a) => !a.startsWith("-") && names.includes(base(a)));
  }
  // `./f`, `.\f.ps1`, `/tmp/f`, `& ./f`
  if (/[\\/]/.test(s.raw)) return names.includes(base(s.raw));
  return false;
}

function hasFetchAndRun(text: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  const segs = splitSegments(text);
  const simples = segs.map((s) => simpleOf(s.text));
  for (let i = 0; i < segs.length; i++) {
    const s = simples[i];
    const raw = segs[i].text;

    // Something run on a downloaded text: `bash <(curl x)`, `sh -c "$(curl x)"`
    if (s && (isInterpreter(s.program) || EVALUATORS.has(s.program))) {
      if (hasProcessSubstitution(raw, depth)) return true;
      if (runsArgumentText(s) || s.program === "invoke-expression") {
        // Only `$(...)` and backticks in `bash -c "..."`; a bare group in a
        // `python -c` program is code
        const dollarOnly = s.program !== "invoke-expression";
        for (const body of groupBodies(raw, dollarOnly)) {
          if (fetchesInside(body, depth + 1)) return true;
        }
      }
    }
    // A nested script: `bash -c "curl x | sh"`
    if (s && runsArgumentText(s)) {
      for (const a of s.args) {
        if (/\s/.test(a) && hasFetchAndRun(a, depth + 1)) return true;
      }
    }

    // A download piped into something that runs it
    const fetchesHere =
      isFetcher(s) ||
      (s !== undefined &&
        /^\(.*\)(\.\w+)?$/.test(splitWords(raw)[0] ?? "") &&
        fetchesInside(raw, depth + 1));
    if (!fetchesHere) continue;
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[j].join !== "|" && segs[j].join !== "|&") break;
      const t = simples[j];
      if (t && runsPipedInput(t)) return true;
    }
    // A download written to a file that a later part runs
    if (s && isFetcher(s) && i + 1 < segs.length) {
      const tee =
        segs[i + 1].join === "|" && simples[i + 1]?.program === "tee"
          ? simples[i + 1]
          : undefined;
      const files = writtenFiles(s, tee);
      if (files.length) {
        for (let j = i + 1; j < segs.length; j++) {
          const t = simples[j];
          if (t && runsFile(t, files)) return true;
        }
      }
    }
  }
  // A group around the whole thing: `(curl x | sh)`, `{ ...; }`
  for (const seg of segs) {
    for (const body of groupBodies(seg.text)) {
      if (hasFetchAndRun(body, depth + 1)) return true;
    }
  }
  return false;
}

/** Whether the command downloads something and runs it. */
export function fetchAndRunHit(command: string): boolean {
  return hasFetchAndRun(command, 0);
}
