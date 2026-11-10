/**
 * Pure recovery for an exact-string edit whose old_string was not found.
 *
 * Models get the exact string wrong in a few repeatable ways (see
 * plans/edit-formats.md): line endings, trailing or collapsed whitespace, a
 * block copied at the wrong indentation, a snippet whose middle lines drifted,
 * or a near-miss typo. Each strategy below is tried in order and applies only
 * when it yields exactly one location. Two or more locations is an error that
 * names them, never a guess. When nothing matches, the error says which line of
 * old_string diverged and what the file has near it, so the next call can fix it.
 */

export type RecoverStrategy =
  "lineEndings" | "whitespace" | "indentation" | "anchored" | "fuzzy";

export interface RecoveredMatch {
  startIndex: number;
  endIndex: number;
  strategy: RecoverStrategy;
  /** new_string re-indented and re-terminated to fit the matched region. */
  newString: string;
  /** One line for the tool result, e.g. "matched after shifting indentation". */
  note: string;
}

export type RecoverResult =
  | { ok: true; match: RecoveredMatch }
  | { ok: false; reason: "notFound" | "ambiguous"; message: string };

/** A fuzzy match needs every line this similar on average, and none below. */
export const FUZZY_MEAN_BAR = 0.92;
export const FUZZY_MIN_LINE_BAR = 0.75;
/** The anchored strategy: interior lines must be this similar on average. */
export const ANCHOR_INTERIOR_BAR = 0.8;
/** Windows scored for the diagnosis are capped so a huge file stays cheap. */
const MAX_SCORED_CELLS = 3_000_000;

interface Line {
  text: string;
  start: number;
  end: number; // exclusive, before the line terminator
  eolEnd: number; // exclusive, after the line terminator
}

function splitFile(content: string): { lines: Line[]; crlf: boolean } {
  const lines: Line[] = [];
  let pos = 0;
  let crlfCount = 0;
  let lfCount = 0;
  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) {
      lines.push({
        text: content.slice(pos),
        start: pos,
        end: content.length,
        eolEnd: content.length,
      });
      break;
    }
    const hasCr = nl > pos && content[nl - 1] === "\r";
    if (hasCr) crlfCount++;
    else lfCount++;
    lines.push({
      text: content.slice(pos, hasCr ? nl - 1 : nl),
      start: pos,
      end: hasCr ? nl - 1 : nl,
      eolEnd: nl + 1,
    });
    pos = nl + 1;
  }
  return { lines, crlf: crlfCount > lfCount };
}

function splitOld(oldString: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  const lines = oldString.split(/\r?\n/);
  let trailingNewline = false;
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
    trailingNewline = true;
  }
  return { lines, trailingNewline };
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const indentOf = (s: string) => /^[ \t]*/.exec(s)![0];

/** Levenshtein ratio in [0, 1] on whitespace-collapsed text. */
export function lineSimilarity(a: string, b: string): number {
  const x = collapse(a);
  const y = collapse(b);
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  const MAX = 300;
  const s = x.length > MAX ? x.slice(0, MAX) : x;
  const t = y.length > MAX ? y.slice(0, MAX) : y;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length);
}

function windows(
  fileLines: Line[],
  n: number,
  pred: (w: Line[]) => boolean,
): number[] {
  const out: number[] = [];
  for (let i = 0; i + n <= fileLines.length; i++) {
    if (pred(fileLines.slice(i, i + n))) out.push(i);
  }
  return out;
}

function reindent(newString: string, fileIndent: string, oldIndent: string) {
  if (fileIndent === oldIndent) return newString;
  return newString
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      if (line.startsWith(oldIndent)) {
        return fileIndent + line.slice(oldIndent.length);
      }
      // The model dedented this line more than the first: keep what it wrote.
      return line;
    })
    .join("\n");
}

function fitLineEndings(text: string, crlf: boolean): string {
  const lf = text.replace(/\r\n/g, "\n");
  return crlf ? lf.replace(/\n/g, "\r\n") : lf;
}

const lineNo = (i: number) => i + 1;

function ambiguous(
  starts: number[],
  how: string,
  fileLines: Line[],
): RecoverResult {
  const where = starts
    .slice(0, 5)
    .map((i) => `line ${lineNo(i)}`)
    .join(", ");
  const preview = starts
    .slice(0, 3)
    .map(
      (i) => `  line ${lineNo(i)}: ${fileLines[i].text.trim().slice(0, 100)}`,
    )
    .join("\n");
  return {
    ok: false,
    reason: "ambiguous",
    message: `old_string is not an exact match, and it matches ${starts.length} places ${how} (${where}${starts.length > 5 ? ", ..." : ""}), so no edit was made. Include more surrounding lines to make it unique.\n${preview}`,
  };
}

/** Why a model's old_string commonly misses, from the string alone. */
export function shapeHints(oldString: string): string[] {
  const hints: string[] = [];
  if (!oldString.includes("\n") && /\\n/.test(oldString)) {
    hints.push(
      'old_string contains a literal backslash-n and no real newline: send actual line breaks, not the two characters "\\n".',
    );
  }
  if (/\\"/.test(oldString)) {
    hints.push(
      'old_string contains \\" : send the plain quote character, do not escape it.',
    );
  }
  if (/[‘’“”]/.test(oldString)) {
    hints.push(
      "old_string contains curly quotes; the file may use straight quotes (or the reverse).",
    );
  }
  if (
    oldString
      .split(/\r?\n/)
      .some((l) => /^\s*(\/\/|#|\/\*)?\s*(\.\.\.|…)/.test(l)) ||
    /existing (code|content)/i.test(oldString)
  ) {
    hints.push(
      'old_string contains a "..." or "existing code" placeholder: old_string must be the literal file text, with every line written out.',
    );
  }
  if (/^\s*\d+\s*[|:→\t]/m.test(oldString)) {
    hints.push(
      "old_string looks like it starts lines with line numbers from a file view; drop the line-number prefix.",
    );
  }
  return hints;
}

function diagnose(
  fileLines: Line[],
  oldLines: string[],
  oldString: string,
): RecoverResult {
  const m = Math.min(oldLines.length, 200);
  let bestStart = -1;
  let bestScore = -1;
  if (fileLines.length * m <= MAX_SCORED_CELLS) {
    const cache = new Map<string, number>();
    for (let j = 0; j < fileLines.length; j++) {
      let score = 0;
      let run = 0;
      let inRun = true;
      for (let i = 0; i < m; i++) {
        const f = fileLines[j + i];
        if (!f) break;
        if (inRun && f.text === oldLines[i]) run++;
        else inRun = false;
        const k = oldLines[i] + "\u0000" + f.text;
        let s = cache.get(k);
        if (s === undefined) {
          s = lineSimilarity(oldLines[i], f.text);
          cache.set(k, s);
        }
        // Emphasise near-equal lines so one aligned line outweighs a spread of
        // weak partial matches.
        score += s ** 4;
      }
      // Models usually get a prefix right and then drift or elide, so an
      // exact leading run is the strongest sign of the intended region.
      score += 2 * run;
      if (score > bestScore) {
        bestScore = score;
        bestStart = j;
      }
    }
  }

  const lines: string[] = [];
  const show = (s: string) =>
    JSON.stringify(s.length > 160 ? s.slice(0, 160) + "..." : s);
  if (bestStart >= 0 && bestScore / m >= 0.35) {
    let d = 0;
    while (
      d < m &&
      fileLines[bestStart + d] &&
      fileLines[bestStart + d].text === oldLines[d]
    ) {
      d++;
    }
    if (d >= oldLines.length) {
      lines.push(
        "old_string's lines all exist in the file, but not as one block; the text after the last line probably differs.",
      );
    } else {
      const f = fileLines[bestStart + d];
      lines.push(
        `Closest region in the file starts at line ${lineNo(bestStart)}. Line ${lineNo(d)} of old_string is the first that differs:`,
        `  old_string line ${lineNo(d)}: ${show(oldLines[d])}`,
        f
          ? `  file line ${lineNo(bestStart + d)}: ${show(f.text)}`
          : "  the file ends before this line (old_string is longer than the text left).",
      );
      if (d > 0) {
        lines.push(`Lines 1 to ${d} of old_string matched exactly.`);
      }
      const target = oldLines[d];
      if (target.trim().length > 2) {
        const near = fileLines
          .map((l, idx) => ({ idx, s: lineSimilarity(target, l.text) }))
          .filter((c) => c.s >= 0.5 && c.idx !== bestStart + d)
          .sort((a, b) => b.s - a.s)
          .slice(0, 3);
        if (near.length) {
          lines.push("Other lines like it:");
          for (const c of near) {
            lines.push(
              `  line ${lineNo(c.idx)}: ${show(fileLines[c.idx].text)}`,
            );
          }
        }
      }
    }
  } else {
    lines.push(
      "No region of the file is close to old_string. Re-read the file and copy the lines you want to change.",
    );
  }
  for (const h of shapeHints(oldString)) lines.push(`Hint: ${h}`);
  return { ok: false, reason: "notFound", message: lines.join("\n") };
}

/**
 * Called only when `oldString` does not occur exactly in `fileContent`.
 */
export function recoverMatch(
  fileContent: string,
  oldString: string,
  newString: string,
): RecoverResult {
  const { lines: fileLines, crlf } = splitFile(fileContent);
  const { lines: oldLines, trailingNewline } = splitOld(oldString);
  const n = oldLines.length;
  const firstNonBlank = oldLines.findIndex((l) => l.trim() !== "");

  const build = (
    first: number,
    strategy: RecoverStrategy,
    note: string,
    adjust: (s: string) => string = (s) => s,
  ): RecoverResult => {
    const last = fileLines[first + n - 1];
    const startIndex = fileLines[first].start;
    const endIndex = trailingNewline ? last.eolEnd : last.end;
    return {
      ok: true,
      match: {
        startIndex,
        endIndex,
        strategy,
        newString: fitLineEndings(adjust(newString), crlf),
        note,
      },
    };
  };

  const reindentFrom = (first: number) => (s: string) =>
    firstNonBlank === -1
      ? s
      : reindent(
          s,
          indentOf(fileLines[first + firstNonBlank].text),
          indentOf(oldLines[firstNonBlank]),
        );

  const tiers: Array<{
    strategy: RecoverStrategy;
    how: string;
    note: string;
    find: () => number[];
    adjust?: (first: number) => (s: string) => string;
  }> = [
    {
      strategy: "lineEndings",
      how: "after normalising line endings",
      note: "matched after normalising line endings",
      find: () =>
        windows(fileLines, n, (w) => w.every((l, i) => l.text === oldLines[i])),
    },
    {
      strategy: "indentation",
      how: "ignoring a uniform indentation shift",
      note: "matched after shifting indentation",
      find: () => {
        if (firstNonBlank === -1) return [];
        const oi = indentOf(oldLines[firstNonBlank]);
        return windows(fileLines, n, (w) => {
          const fi = indentOf(w[firstNonBlank].text);
          return w.every((l, i) => {
            const o = oldLines[i];
            if (o.trim() === "" || l.text.trim() === "") {
              return o.trim() === l.text.trim();
            }
            return (
              o.startsWith(oi) &&
              l.text.startsWith(fi) &&
              l.text.slice(fi.length) === o.slice(oi.length)
            );
          });
        });
      },
      adjust: reindentFrom,
    },
    {
      strategy: "whitespace",
      how: "after normalising whitespace",
      note: "matched after normalising whitespace within lines",
      find: () =>
        windows(fileLines, n, (w) =>
          w.every((l, i) => collapse(l.text) === collapse(oldLines[i])),
        ),
      adjust: reindentFrom,
    },
    {
      strategy: "anchored",
      how: "by its first and last lines",
      note: "matched by its first and last lines; the middle lines differed slightly",
      adjust: reindentFrom,
      find: () => {
        if (n < 3) return [];
        const a = collapse(oldLines[0]);
        const z = collapse(oldLines[n - 1]);
        if (a === "" || z === "") return [];
        return windows(fileLines, n, (w) => {
          if (collapse(w[0].text) !== a || collapse(w[n - 1].text) !== z) {
            return false;
          }
          let sum = 0;
          for (let i = 1; i < n - 1; i++) {
            sum += lineSimilarity(w[i].text, oldLines[i]);
          }
          return sum / (n - 2) >= ANCHOR_INTERIOR_BAR;
        });
      },
    },
    {
      strategy: "fuzzy",
      how: "with a similarity above the bar",
      note: "matched by similarity; lines differed slightly",
      adjust: reindentFrom,
      find: () => {
        if (oldString.trim().length < 12) return [];
        return windows(fileLines, n, (w) => {
          let sum = 0;
          for (let i = 0; i < n; i++) {
            const s = lineSimilarity(w[i].text, oldLines[i]);
            if (s < FUZZY_MIN_LINE_BAR) return false;
            sum += s;
          }
          return sum / n >= FUZZY_MEAN_BAR;
        });
      },
    },
  ];

  for (const t of tiers) {
    const starts = t.find();
    if (starts.length === 1) {
      return build(starts[0], t.strategy, t.note, t.adjust?.(starts[0]));
    }
    if (starts.length > 1) return ambiguous(starts, t.how, fileLines);
  }
  return diagnose(fileLines, oldLines, oldString);
}
