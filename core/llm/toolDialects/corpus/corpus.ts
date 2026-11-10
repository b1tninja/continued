import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The golden corpus for the tool-call dialect layer
 * (plans/tool-dialect-reference.md). Each fixture is one JSON file under
 * ./fixtures: the text a model or server emitted, how it may arrive in chunks,
 * and the calls a conformant parser recovers. `flag` says whether the text was
 * captured from a real run ("observed") or written from a template or a report
 * ("synthesised").
 */

export type CorpusFlag = "observed" | "synthesised";
export type CorpusPolicy = "must" | "should" | "either";

export interface CorpusTool {
  name: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

export interface CorpusStream {
  label: string;
  encoding: "utf8" | "base64";
  chunks: string[];
  /** The marker the split falls inside, or "utf8-codepoint". */
  splitInside: string | null;
}

export interface CorpusCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CorpusFixture {
  schemaVersion: 1;
  id: string;
  family: string;
  dialect: string;
  kind: "positive" | "negative";
  failureMode: string;
  flag: CorpusFlag;
  provenance: {
    source: string;
    retrieved: string;
    reportDate?: string;
    note: string;
  };
  /**
   * must: a conformant parser gets this right. should: recovery is wanted but
   * not required of every dialect. either: a policy choice; not scored.
   */
  policy: CorpusPolicy;
  tools: CorpusTool[];
  text: string;
  markers: string[];
  streams: CorpusStream[];
  expected: { calls: CorpusCall[]; text: string };
}

export const FIXTURE_DIR = path.join(__dirname, "fixtures");

export function loadRawCorpus(
  dir: string = FIXTURE_DIR,
): { file: string; raw: unknown }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      raw: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")),
    }));
}

export function loadCorpus(dir: string = FIXTURE_DIR): CorpusFixture[] {
  return loadRawCorpus(dir).map(({ file, raw }) => {
    const errors = validateFixture(raw);
    if (errors.length > 0) {
      throw new Error(`${file}: ${errors.join("; ")}`);
    }
    return raw as CorpusFixture;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text pieces of a stream, decoded the way a client would see them. */
export function decodeStream(stream: CorpusStream): string[] {
  if (stream.encoding === "utf8") return stream.chunks;
  const decoder = new TextDecoder("utf-8");
  const out = stream.chunks.map((c) =>
    decoder.decode(Buffer.from(c, "base64"), { stream: true }),
  );
  out.push(decoder.decode());
  return out;
}

function streamBytes(stream: CorpusStream): Buffer {
  return Buffer.concat(
    stream.chunks.map((c) =>
      stream.encoding === "base64"
        ? Buffer.from(c, "base64")
        : Buffer.from(c, "utf8"),
    ),
  );
}

/** Offsets (in UTF-16 units of the full text) where utf8 chunks join. */
function boundaries(stream: CorpusStream): number[] {
  const out: number[] = [];
  let at = 0;
  for (const c of stream.chunks.slice(0, -1)) {
    at += c.length;
    out.push(at);
  }
  return out;
}

function validateProvenance(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const prov = raw.provenance;
  if (!isObject(prov)) return ["provenance is required"];
  if (typeof prov.source !== "string" || prov.source.trim() === "") {
    errors.push("provenance.source is required");
  }
  if (typeof prov.retrieved !== "string") {
    errors.push("provenance.retrieved is required");
  }
  if (typeof prov.note !== "string") errors.push("provenance.note required");
  const source = typeof prov.source === "string" ? prov.source : "";
  if (raw.flag === "observed") {
    // A report is cited by its URL; our own runs are cited as "Observed live
    // on <where> <date>, model <id>".
    if (
      !/^https:\/\/|^Observed live on .+ \d{4}-\d{2}-\d{2}, model \S+/.test(
        source,
      )
    ) {
      errors.push(
        "an observed fixture needs a URL, or 'Observed live on ... <date>, model <id>', as its source",
      );
    }
    if (/synthesised/i.test(source)) {
      errors.push("an observed fixture must not call its source synthesised");
    }
    if (typeof prov.reportDate !== "string") {
      errors.push("an observed fixture needs provenance.reportDate");
    }
  }
  if (
    raw.flag === "synthesised" &&
    !/^https:\/\/|synthesised|our own code|core\//i.test(source)
  ) {
    errors.push("a synthesised fixture must say what it was made from");
  }
  return errors;
}

function validateExpected(
  raw: Record<string, unknown>,
  tools: CorpusTool[],
): string[] {
  const errors: string[] = [];
  const exp = raw.expected;
  if (
    !isObject(exp) ||
    !Array.isArray(exp.calls) ||
    typeof exp.text !== "string"
  ) {
    return ["expected needs calls and text"];
  }
  if ((raw.kind === "positive") !== exp.calls.length > 0) {
    errors.push("kind disagrees with expected.calls");
  }
  for (const call of exp.calls as CorpusCall[]) {
    const tool = tools.find((t) => t.name === call?.name);
    if (!tool) {
      errors.push(`expected call to undeclared tool ${call?.name}`);
      continue;
    }
    const props = Object.keys(tool.parameters?.properties ?? {});
    for (const key of Object.keys(call.arguments ?? {})) {
      if (!props.includes(key)) errors.push(`${call.name}: unknown arg ${key}`);
    }
    for (const key of tool.parameters?.required ?? []) {
      if (!(key in (call.arguments ?? {}))) {
        errors.push(`${call.name}: missing required arg ${key}`);
      }
    }
  }
  if (raw.kind === "negative" && exp.text !== raw.text) {
    errors.push("a negative fixture expects its whole text back");
  }
  return errors;
}

function validateStreams(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const streams = raw.streams;
  if (!Array.isArray(streams) || streams.length === 0) {
    return ["streams must be a non-empty array"];
  }
  const text = typeof raw.text === "string" ? raw.text : "";
  const bytes = Buffer.from(text, "utf8");
  const labels = new Set<string>();
  for (const s of streams as CorpusStream[]) {
    labels.add(s.label);
    if (!Array.isArray(s.chunks) || !["utf8", "base64"].includes(s.encoding)) {
      errors.push(`stream ${s.label}: bad shape`);
      continue;
    }
    if (!streamBytes(s).equals(bytes)) {
      errors.push(`stream ${s.label}: chunks do not add up to text`);
      continue;
    }
    if (s.splitInside && s.encoding === "utf8") {
      const marker = s.splitInside;
      const cuts = boundaries(s);
      const inside = [...text.matchAll(new RegExp(escapeRe(marker), "g"))].some(
        (m) =>
          cuts.some(
            (c) => c > (m.index ?? 0) && c < (m.index ?? 0) + marker.length,
          ),
      );
      if (!inside) errors.push(`stream ${s.label}: no split inside ${marker}`);
    }
    if (s.splitInside === "utf8-codepoint") {
      let at = 0;
      let mid = false;
      for (const c of s.chunks.slice(0, -1)) {
        at += Buffer.from(c, "base64").length;
        if (at < bytes.length && (bytes[at] & 0xc0) === 0x80) mid = true;
      }
      if (!mid) errors.push(`stream ${s.label}: no split inside a code point`);
    }
  }
  if (!labels.has("whole")) errors.push("a whole stream is required");
  if (!labels.has("char") && !labels.has("fixed-7")) {
    errors.push("a one-character (or fixed-size) stream is required");
  }
  if (/[^\u0000-\u007f]/.test(text) && !labels.has("inside-multibyte-char")) {
    errors.push("non-ASCII text needs an inside-multibyte-char stream");
  }
  const markers = Array.isArray(raw.markers) ? (raw.markers as string[]) : [];
  if (markers.some((m) => text.includes(m)) && !labels.has("inside-marker")) {
    errors.push("text with markers needs an inside-marker stream");
  }
  return errors;
}

/** Problems with one fixture; empty when it is valid. */
export function validateFixture(raw: unknown): string[] {
  if (!isObject(raw)) return ["not an object"];
  const errors: string[] = [];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  for (const k of ["id", "family", "dialect", "failureMode"]) {
    if (typeof raw[k] !== "string" || (raw[k] as string).length === 0) {
      errors.push(`${k} must be a non-empty string`);
    }
  }
  if (raw.kind !== "positive" && raw.kind !== "negative") {
    errors.push("kind must be positive or negative");
  }
  if (raw.flag !== "observed" && raw.flag !== "synthesised") {
    errors.push("flag must be observed or synthesised");
  }
  if (!["must", "should", "either"].includes(raw.policy as string)) {
    errors.push("policy must be must, should or either");
  }
  if (typeof raw.text !== "string") errors.push("text must be a string");
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    errors.push("tools must be a non-empty array");
  }
  const tools = (Array.isArray(raw.tools) ? raw.tools : []) as CorpusTool[];
  return [
    ...errors,
    ...validateProvenance(raw),
    ...validateExpected(raw, tools),
    ...validateStreams(raw),
  ];
}
