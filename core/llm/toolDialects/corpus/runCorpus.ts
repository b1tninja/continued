import {
  decodeStream,
  loadCorpus,
  type CorpusCall,
  type CorpusFixture,
  type CorpusPolicy,
  type CorpusTool,
} from "./corpus";

/** What a parser under test returns for one stream of one fixture. */
export interface ParsedResult {
  calls: CorpusCall[];
  /** The visible text left after calls are removed. */
  text: string;
}

/**
 * A parser under test. It receives the stream's chunks in order, as a client
 * would see them, and the tools that were offered. Returning undefined means
 * the parser does not handle this fixture's dialect (it is skipped).
 */
export type CorpusParser = (input: {
  chunks: string[];
  tools: CorpusTool[];
  fixture: CorpusFixture;
}) => ParsedResult | undefined;

export interface CorpusRunOptions {
  /** Only fixtures whose dialect is listed; negatives of other dialects are
   * also run when `negativesFromAllDialects` is set. */
  dialects?: string[];
  negativesFromAllDialects?: boolean;
  fixtures?: CorpusFixture[];
}

export type CorpusOutcome = "pass" | "fail" | "skipped";

export interface CorpusStreamResult {
  fixture: string;
  stream: string;
  outcome: CorpusOutcome;
  policy: CorpusPolicy;
  /** Why it failed, as a short diff. */
  detail?: string;
}

export interface CorpusReport {
  results: CorpusStreamResult[];
  /** Fixtures whose result changed with the chunking. */
  chunkSensitive: string[];
  summary: Record<CorpusPolicy, { pass: number; fail: number }> & {
    skipped: number;
  };
}

function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : 1,
          ),
        )
      : v,
  );
}

/** A short description of how two results differ; undefined when equal. */
export function diffResult(
  expected: ParsedResult,
  actual: ParsedResult,
): string | undefined {
  const parts: string[] = [];
  if (canon(expected.calls) !== canon(actual.calls)) {
    parts.push(
      `calls: expected ${canon(expected.calls)} got ${canon(actual.calls)}`,
    );
  }
  if (expected.text !== actual.text) {
    parts.push(
      `text: expected ${JSON.stringify(expected.text)} got ${JSON.stringify(actual.text)}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Feeds every fixture, through every one of its streams, to `parse`, and
 * compares the result with the fixture's expected calls and text. Nothing is
 * thrown for a mismatch: the report says what the parser got wrong, by policy
 * (`must`, `should`, `either`), so a caller decides what is a failure.
 */
export function runCorpus(
  parse: CorpusParser,
  options: CorpusRunOptions = {},
): CorpusReport {
  const fixtures = options.fixtures ?? loadCorpus();
  const results: CorpusStreamResult[] = [];
  const chunkSensitive: string[] = [];
  for (const fixture of fixtures) {
    const wanted =
      !options.dialects ||
      options.dialects.includes(fixture.dialect) ||
      (options.negativesFromAllDialects && fixture.kind === "negative");
    if (!wanted) continue;
    const seen = new Set<string>();
    for (const stream of fixture.streams) {
      const chunks = decodeStream(stream);
      const actual = parse({ chunks, tools: fixture.tools, fixture });
      if (!actual) {
        results.push({
          fixture: fixture.id,
          stream: stream.label,
          outcome: "skipped",
          policy: fixture.policy,
        });
        continue;
      }
      seen.add(canon(actual));
      const detail = diffResult(fixture.expected, actual);
      results.push({
        fixture: fixture.id,
        stream: stream.label,
        outcome: detail ? "fail" : "pass",
        policy: fixture.policy,
        detail,
      });
    }
    if (seen.size > 1) chunkSensitive.push(fixture.id);
  }
  const summary = {
    must: { pass: 0, fail: 0 },
    should: { pass: 0, fail: 0 },
    either: { pass: 0, fail: 0 },
    skipped: 0,
  };
  for (const r of results) {
    if (r.outcome === "skipped") summary.skipped++;
    else summary[r.policy][r.outcome]++;
  }
  return { results, chunkSensitive, summary };
}

/** The failing fixtures, one entry per fixture, for a policy. */
export function failures(
  report: CorpusReport,
  policy: CorpusPolicy,
): { fixture: string; streams: string[]; detail: string }[] {
  const byFixture = new Map<string, { streams: string[]; detail: string }>();
  for (const r of report.results) {
    if (r.outcome !== "fail" || r.policy !== policy) continue;
    const entry = byFixture.get(r.fixture) ?? {
      streams: [],
      detail: r.detail ?? "",
    };
    entry.streams.push(r.stream);
    byFixture.set(r.fixture, entry);
  }
  return [...byFixture].map(([fixture, v]) => ({ fixture, ...v }));
}
