// Reads core/util/toolDialectPresetTable.ts as text. Nothing is imported from
// core and no TypeScript is executed: the file is data, laid out one row per
// two-space-indented object, and anything that does not parse is an error
// (exit 2), never a silent skip.
import { readFileSync } from "node:fs";

function constString(text, name) {
  const m = new RegExp(`^const ${name} = "([^"]*)";`, "m").exec(text);
  return m ? m[1] : null;
}

/** Regex literals inside the `match: [ ... ]` source. */
export function parseRegexList(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "/") {
      i++;
      continue;
    }
    let j = i + 1;
    let inClass = false;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === "[") ((inClass = true), j++);
      else if (c === "]") ((inClass = false), j++);
      else if (c === "/" && !inClass) break;
      else j++;
    }
    if (j >= src.length) throw new Error(`unterminated regex in: ${src}`);
    const pattern = src.slice(i + 1, j);
    let k = j + 1;
    while (/[a-z]/.test(src[k] ?? "")) k++;
    out.push(new RegExp(pattern, src.slice(j + 1, k)));
    i = k;
  }
  return out;
}

export function parseTable(text) {
  const start = text.indexOf("export const TOOL_DIALECT_PRESETS");
  if (start < 0) throw new Error("TOOL_DIALECT_PRESETS not found");
  const lines = text.slice(start).split("\n");
  const READ = constString(text, "READ");
  const rows = [];
  let cur = null;
  for (const line of lines) {
    if (line === "  {") cur = [];
    else if (cur && /^ {2}\},?$/.test(line)) {
      rows.push(cur.join("\n"));
      cur = null;
    } else if (cur) cur.push(line);
  }
  const ids = [...text.slice(start).matchAll(/^ {4}id: "/gm)].length;
  if (rows.length === 0 || rows.length !== ids) {
    throw new Error(`row count ${rows.length} does not match id count ${ids}`);
  }
  return rows.map((r) => {
    const id = /^ {4}id: "([^"]+)"/m.exec(r)?.[1];
    const dialect = /^ {4}textDialect: "([^"]+)"/m.exec(r)?.[1];
    const m = /^ {4}match: \[([\s\S]*?)\],\n/m.exec(r);
    if (!id || !dialect || !m)
      throw new Error(`cannot parse a row near id=${id}`);
    const readOn =
      /^ {4}readOn: (?:"([^"]+)"|READ)/m.exec(r)?.slice(1)[0] ?? READ;
    const sources = [...r.matchAll(/"(https?:\/\/[^"]+)"/g)].map((x) => x[1]);
    return {
      id,
      textDialect: dialect,
      match: parseRegexList(m[1]),
      vllm: /serverParser: \{[^}]*?vllm: "([^"]+)"/.exec(r)?.[1] ?? null,
      readOn,
      sources,
    };
  });
}

export function loadTable(path) {
  return parseTable(readFileSync(path, "utf8"));
}

/** Mirrors resolveToolDialectPreset: lowercase, first row with any matching regex. */
export function resolveRow(rows, modelId) {
  const id = String(modelId).toLowerCase();
  return rows.find((r) => r.match.some((re) => re.test(id)));
}
