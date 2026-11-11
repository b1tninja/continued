import { sha256Hex } from "../util/secretScan/sha256";

/**
 * Prompt segments (K18, slice 1): a manifest that describes what a chat
 * request carries, without changing the request. Plain TypeScript with no
 * node imports, so the GUI webview can use it.
 *
 * A request is read by the provider as three regions, in this order: tools,
 * system, messages. A prompt cache reads a prefix, so what changes least must
 * come first. Every segment has a stability class, and the canonical order has
 * non-decreasing stability: static, session, turn, request. A segment holds no
 * text, only its size and hash: the dump never prints contents.
 */

export type Stability = "static" | "session" | "turn" | "request";
export type Region = "tools" | "system" | "first-user" | "history" | "tail";
export type SegmentSource =
  | "tools"
  | "builtin"
  | "mcp"
  | "mode"
  | "profile"
  | "format"
  | "rules"
  | "memory"
  | "environment"
  | "summary"
  | "loop"
  | "history"
  | "tail"
  | "task-list";

/**
 * The volatile-early offenders of plans/prompt-segment-plan.md section 6: events
 * that rewrite a prefix. A segment carries the ones its inputs expose it to.
 */
export type Offender =
  | "mode-switch"
  | "scoped-rule-appended"
  | "tool-list-event"
  | "mcp-order"
  | "registry-in-tool-description"
  | "instruction-file-edit"
  | "uncapped-git-status"
  | "summary-in-system";

export interface PromptSegment {
  /** Stable id, e.g. "turn.act@full", "rules.session", "env.date+git". */
  id: string;
  source: SegmentSource;
  stability: Stability;
  region: Region;
  /** chars / 4, the repo's conservative proxy. */
  tokens: number;
  /** First 12 hex of sha256 of the text. */
  hash: string;
  /** Offenders this segment's inputs expose the prefix to. */
  exposedTo?: Offender[];
}

export interface SegmentSpec {
  id: string;
  source: SegmentSource;
  stability: Stability;
  region: Region;
  text: string;
  exposedTo?: Offender[];
}

const STABILITY_RANK: Record<Stability, number> = {
  static: 0,
  session: 1,
  turn: 2,
  request: 3,
};
const REGION_RANK: Record<Region, number> = {
  tools: 0,
  system: 1,
  "first-user": 2,
  history: 3,
  tail: 4,
};

export const stabilityRank = (s: Stability): number => STABILITY_RANK[s];
export const regionRank = (r: Region): number => REGION_RANK[r];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function hashText(text: string): string {
  return sha256Hex(text).slice(0, 12);
}

export function makeSegment(spec: SegmentSpec): PromptSegment {
  const { text, ...rest } = spec;
  return { ...rest, tokens: estimateTokens(text), hash: hashText(text) };
}

/** The canonical text of a tool list: what its segment hashes. */
export function canonicalTools(tools: readonly unknown[]): string {
  return JSON.stringify(tools);
}

export interface Violation {
  rule:
    | "region-order"
    | "rank-inversion"
    | "format-with-native-tools"
    | "request-outside-tail"
    | "duplicate-id";
  id: string;
  message: string;
}

/** Everything wrong with a manifest; empty when it is in canonical order. */
export function validateManifest(
  segments: readonly PromptSegment[],
): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  const hasNativeTools = segments.some(
    (s) => s.region === "tools" && s.source !== "format",
  );
  let prev: PromptSegment | undefined;
  for (const s of segments) {
    if (seen.has(s.id)) {
      out.push({
        rule: "duplicate-id",
        id: s.id,
        message: `${s.id} appears twice`,
      });
    }
    seen.add(s.id);
    if (s.stability === "request" && s.region !== "tail") {
      out.push({
        rule: "request-outside-tail",
        id: s.id,
        message: `${s.id} is per-request but sits in ${s.region}`,
      });
    }
    if (s.source === "format" && hasNativeTools) {
      out.push({
        rule: "format-with-native-tools",
        id: s.id,
        message: `${s.id} renders a call format while native tools are sent`,
      });
    }
    if (prev) {
      if (regionRank(s.region) < regionRank(prev.region)) {
        out.push({
          rule: "region-order",
          id: s.id,
          message: `${s.id} (${s.region}) follows ${prev.id} (${prev.region})`,
        });
      } else if (stabilityRank(s.stability) < stabilityRank(prev.stability)) {
        out.push({
          rule: "rank-inversion",
          id: s.id,
          message: `${s.id} (${s.stability}) follows ${prev.id} (${prev.stability})`,
        });
      }
    }
    prev = s;
  }
  return out;
}

/** Throws on the first violation, naming all of them. */
export function assertValidManifest(segments: readonly PromptSegment[]): void {
  const v = validateManifest(segments);
  if (v.length > 0) {
    throw new Error(
      `Invalid prompt manifest: ${v.map((x) => x.message).join("; ")}`,
    );
  }
}

/**
 * Segments in front of the last cache point (tools, system, first user
 * message) that are not static or session, or that name an offender their
 * inputs expose: where the manifest shows a prefix that can be rewritten.
 */
export function volatileEarly(
  segments: readonly PromptSegment[],
): PromptSegment[] {
  return segments.filter(
    (s) =>
      (regionRank(s.region) <= regionRank("first-user") &&
        stabilityRank(s.stability) >= stabilityRank("turn")) ||
      (s.exposedTo?.length ?? 0) > 0,
  );
}

/** The offenders visible in a manifest, without repeats. */
export function visibleOffenders(
  segments: readonly PromptSegment[],
): Offender[] {
  const out = new Set<Offender>();
  for (const s of segments) for (const o of s.exposedTo ?? []) out.add(o);
  return [...out];
}

/** How many leading segments two manifests share (same id and hash). */
export function commonPrefixLength(
  a: readonly PromptSegment[],
  b: readonly PromptSegment[],
): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[i].id === b[i].id &&
    a[i].hash === b[i].hash
  ) {
    i++;
  }
  return i;
}

/**
 * The id of the first prefix segment (tools, system, first user message) that
 * differs from the previous request's, or "none". History and the tail are
 * not compared: they grow or change on every request by design.
 */
export function firstChangedVsPrev(
  segments: readonly PromptSegment[],
  prev: readonly PromptSegment[] | undefined,
): string {
  if (!prev) return "first";
  const prefix = (xs: readonly PromptSegment[]) =>
    xs.filter((s) => regionRank(s.region) <= regionRank("first-user"));
  const a = prefix(segments);
  const b = prefix(prev);
  const n = commonPrefixLength(a, b);
  if (n === a.length && n === b.length) return "none";
  return (a[n] ?? b[n]).id;
}

export function describeSegments(
  segments: readonly PromptSegment[],
  prev?: readonly PromptSegment[],
): string[] {
  const lines = segments.map(
    (s) =>
      `  ${s.id} region=${s.region} stability=${s.stability} tokens=${s.tokens} hash8=${s.hash.slice(0, 8)}`,
  );
  const total = segments.reduce((n, s) => n + s.tokens, 0);
  lines.push(
    `  total_tokens=${total} first_changed_vs_prev=${firstChangedVsPrev(segments, prev)}`,
  );
  return lines;
}

/** True when the debug dump is asked for (the value of CONTINUE_PROMPT_SEGMENTS). */
export function promptSegmentsEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * A dump writer that remembers the previous request's manifest. Build the
 * segments inside `build` so that nothing is computed when the dump is off:
 * callers create the dump only when `promptSegmentsEnabled`, else pass nothing.
 */
export function createSegmentDump(
  sink: (line: string) => void,
): (meta: string, build: () => PromptSegment[]) => void {
  let prev: PromptSegment[] | undefined;
  let n = 0;
  return (meta, build) => {
    const segments = build();
    sink(`[prompt-segments] req=${++n} ${meta}`);
    for (const line of describeSegments(segments, prev)) sink(line);
    prev = segments;
  };
}
