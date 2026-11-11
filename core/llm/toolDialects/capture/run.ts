import { classifyReply, type Outcome } from "./classify";
import type { CaptureClient, CaptureRequest } from "./clients";
import { buildFixture, fixtureId, type RawReply } from "./fixture";
import type { Cell, ModelSpec, PlanOptions } from "./plan";
import { CAPTURE_SYSTEM } from "./tools";
import { formatRate, wilson } from "./stats";

/** Where files go. The CLI writes to disk; the tests keep a map. */
export interface Writer {
  write(relPath: string, content: string): void;
}

export interface RunDeps {
  clientFor(model: ModelSpec): CaptureClient;
  writer: Writer;
  /** YYYY-MM-DD. */
  date: string;
  maxTokens: number;
  log?(line: string): void;
}

export interface Tally {
  key: string;
  counts: Record<Outcome, number>;
}

const OUTCOMES: Outcome[] = ["structured", "leak", "refused", "error"];

const groupKey = (c: Cell) =>
  `${c.model.transport}:${c.model.modelId} | ${c.stream ? "stream" : "whole"} | t=${c.temperature}`;

/**
 * Send every cell of the plan, one at a time, and write for each reply a raw
 * record under raw/ and, when it has text, an observed corpus fixture under
 * fixtures/. A failed request is recorded as an error and the run goes on.
 */
export async function runCapture(
  cells: Cell[],
  options: Pick<PlanOptions, "tools">,
  deps: RunDeps,
): Promise<Tally[]> {
  const tallies = new Map<string, Tally>();
  const knownTools = options.tools.map((t) => t.name);
  for (const cell of cells) {
    const req: CaptureRequest = {
      model: cell.model.modelId,
      stream: cell.stream,
      temperature: cell.temperature,
      system: CAPTURE_SYSTEM,
      prompt: cell.prompt.text,
      tools: options.tools,
      maxTokens: deps.maxTokens,
    };
    let reply: RawReply;
    try {
      reply = await deps.clientFor(cell.model).send(req);
    } catch (e) {
      reply = {
        text: "",
        toolCalls: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const classified = classifyReply({
      text: reply.text,
      toolCalls: reply.toolCalls,
      knownTools,
      error: reply.error,
    });
    const id = fixtureId({
      model: cell.model.modelId,
      transport: cell.model.transport,
      streamed: cell.stream,
      temperature: cell.temperature,
      pass: cell.pass,
      promptId: cell.prompt.id,
    });
    deps.writer.write(
      `raw/${id}.json`,
      JSON.stringify(
        {
          id,
          request: { ...req, tools: undefined, toolCount: req.tools.length },
          reply,
          classified,
        },
        null,
        2,
      ) + "\n",
    );
    const fixture = buildFixture(reply, {
      id,
      model: cell.model.modelId,
      transport: cell.model.transport,
      date: deps.date,
      streamed: cell.stream,
      temperature: cell.temperature,
      tools: options.tools,
      classified,
    });
    if (fixture) {
      deps.writer.write(
        `fixtures/${id}.json`,
        JSON.stringify(fixture, null, 2) + "\n",
      );
    }
    const key = groupKey(cell);
    const tally = tallies.get(key) ?? {
      key,
      counts: { structured: 0, leak: 0, refused: 0, error: 0 },
    };
    tally.counts[classified.outcome]++;
    tallies.set(key, tally);
    deps.log?.(
      `${id}: ${classified.outcome}${reply.error ? ` (${reply.error})` : ""}`,
    );
  }
  return [...tallies.values()];
}

/** One line per group: leak, structured and refused with 95 percent Wilson intervals. */
export function formatReport(tallies: Tally[]): string {
  const lines = ["Per group (errors are excluded from every rate):"];
  for (const t of tallies) {
    const n = OUTCOMES.filter((o) => o !== "error").reduce(
      (s, o) => s + t.counts[o],
      0,
    );
    lines.push(
      `  ${t.key}`,
      `    leak       ${formatRate(wilson(t.counts.leak, n))}`,
      `    structured ${formatRate(wilson(t.counts.structured, n))}`,
      `    refused    ${formatRate(wilson(t.counts.refused, n))}`,
      ...(t.counts.error ? [`    errors     ${t.counts.error}`] : []),
    );
  }
  return lines.join("\n");
}
