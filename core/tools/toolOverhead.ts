/**
 * Measurement of what the tool list costs a request (plans/tool-overhead.md).
 * Pure: takes tool definitions as the model sees them (name, description,
 * parameters) and a token counter, and returns rows and a markdown report.
 * The scenarios are built by tests that read the real tool lists of the IDE
 * (gui selectActiveTools) and the CLI (getAllAvailableTools).
 */

export interface MeasuredTool {
  name: string;
  description: string;
  parameters?: unknown;
}

export type TokenCounter = (text: string) => number;

export const charsOver4: TokenCounter = (text) => Math.ceil(text.length / 4);

/** The text a provider receives for one tool, as JSON. */
export function serializeMeasured(tool: MeasuredTool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
}

export interface ToolRow {
  name: string;
  tokens: number;
  est: number;
  descriptionTokens: number;
}

export interface SetMeasurement {
  label: string;
  count: number;
  tokens: number;
  est: number;
  perTool: number;
  rows: ToolRow[];
}

export function measureSet(
  label: string,
  tools: MeasuredTool[],
  count: TokenCounter,
): SetMeasurement {
  const rows = tools.map((t) => {
    const text = serializeMeasured(t);
    return {
      name: t.name,
      tokens: count(text),
      est: charsOver4(text),
      descriptionTokens: count(t.description ?? ""),
    };
  });
  const tokens = rows.reduce((n, r) => n + r.tokens, 0);
  const est = rows.reduce((n, r) => n + r.est, 0);
  return {
    label,
    count: rows.length,
    tokens,
    est,
    perTool: rows.length ? Math.round(tokens / rows.length) : 0,
    rows,
  };
}

export function biggestDescriptions(
  sets: SetMeasurement[],
  n = 10,
): { name: string; descriptionTokens: number; set: string }[] {
  const seen = new Set<string>();
  const all: { name: string; descriptionTokens: number; set: string }[] = [];
  for (const s of sets) {
    for (const r of s.rows) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      all.push({
        name: r.name,
        descriptionTokens: r.descriptionTokens,
        set: s.label,
      });
    }
  }
  return all
    .sort(
      (a, b) =>
        b.descriptionTokens - a.descriptionTokens || (a.name < b.name ? -1 : 1),
    )
    .slice(0, n);
}

export function formatReport(title: string, sets: SetMeasurement[]): string {
  const lines = [
    `## ${title}`,
    "",
    "| scenario | tools | tokens (repo tokenizer) | tokens (chars/4) | tokens per tool |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...sets.map(
      (s) =>
        `| ${s.label} | ${s.count} | ${s.tokens} | ${s.est} | ${s.perTool} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export function formatBiggest(
  rows: { name: string; descriptionTokens: number; set: string }[],
): string {
  return [
    "| tool | description tokens | first seen in |",
    "| --- | ---: | --- |",
    ...rows.map((r) => `| ${r.name} | ${r.descriptionTokens} | ${r.set} |`),
    "",
  ].join("\n");
}
