import type { ToolCallLike } from "../../../util/toolDialectDetect";
import type { CorpusFixture, CorpusStream, CorpusTool } from "../corpus/corpus";
import type { Classified } from "./classify";
import type { Temperature } from "./plan";
import type { WireTool } from "./tools";

/** One reply as received, before any parsing of ours. */
export interface RawReply {
  text: string;
  toolCalls: ToolCallLike[];
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Text delta boundaries, when the reply was streamed. */
  chunks?: string[];
  error?: string;
}

export interface FixtureContext {
  id: string;
  model: string;
  transport: "bedrock" | "openai";
  /** The capture date, YYYY-MM-DD. */
  date: string;
  streamed: boolean;
  temperature: Temperature;
  tools: WireTool[];
  classified: Classified;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

export function fixtureId(parts: {
  model: string;
  transport: string;
  streamed: boolean;
  temperature: Temperature;
  pass: number;
  promptId: string;
}): string {
  const mode = parts.streamed ? "stream" : "whole";
  return `live-${slug(parts.model)}-${parts.transport}-${mode}-t${parts.temperature}-p${parts.pass}-${parts.promptId}`;
}

export function toCorpusTools(tools: WireTool[]): CorpusTool[] {
  return tools.map((t) => {
    const params = t.parameters as {
      properties?: Record<string, { type?: unknown }>;
      required?: string[];
    };
    const properties: Record<string, { type: string }> = {};
    for (const [k, v] of Object.entries(params.properties ?? {})) {
      properties[k] = { type: typeof v?.type === "string" ? v.type : "string" };
    }
    return {
      name: t.name,
      parameters: {
        type: "object",
        properties,
        required: params.required ?? [],
      },
    };
  });
}

/** Split between the bytes of the first multibyte character, or null for ASCII. */
function insideMultibyte(text: string): string[] | null {
  const bytes = Buffer.from(text, "utf8");
  const lead = bytes.findIndex((b) => b >= 0xc0);
  if (lead < 0) return null;
  return [bytes.subarray(0, lead + 1), bytes.subarray(lead + 1)].map((b) =>
    b.toString("base64"),
  );
}

export function buildStreams(
  text: string,
  observed?: string[],
): CorpusStream[] {
  const streams: CorpusStream[] = [
    { label: "whole", encoding: "utf8", chunks: [text], splitInside: null },
    {
      label: "char",
      encoding: "utf8",
      chunks: Array.from(text),
      splitInside: null,
    },
  ];
  const mb = insideMultibyte(text);
  if (mb) {
    streams.push({
      label: "inside-multibyte-char",
      encoding: "base64",
      chunks: mb,
      splitInside: "utf8-codepoint",
    });
  }
  if (observed && observed.length > 0 && observed.join("") === text) {
    streams.push({
      label: "observed",
      encoding: "utf8",
      chunks: observed,
      splitInside: null,
    });
  }
  return streams;
}

const FAILURE_MODE = {
  leak: "live-capture-leak",
  structured: "live-capture-text-beside-call",
  refused: "live-capture-no-call",
  error: "live-capture-error",
} as const;

/**
 * An observed corpus fixture for one reply, or undefined when the reply has no
 * text (nothing for a text parser to read; the raw record still keeps it).
 * Every capture is written as an unreviewed negative with policy "either": it
 * says what the model wrote, and a person promotes a leak to a positive
 * fixture once the calls it should yield are agreed. Markers are left empty
 * for the same reason.
 */
export function buildFixture(
  reply: RawReply,
  ctx: FixtureContext,
): CorpusFixture | undefined {
  if (!reply.text || ctx.classified.outcome === "error") return undefined;
  const where =
    ctx.transport === "bedrock"
      ? "Bedrock Converse"
      : "an OpenAI-compatible endpoint";
  const mode = ctx.streamed ? "streamed" : "non-streaming";
  return {
    schemaVersion: 1,
    id: ctx.id,
    family: "unreviewed",
    dialect: ctx.classified.dialect,
    kind: "negative",
    failureMode: FAILURE_MODE[ctx.classified.outcome],
    flag: "observed",
    provenance: {
      source: `Observed live on ${where} ${ctx.date}, model ${ctx.model}`,
      retrieved: ctx.date,
      reportDate: ctx.date,
      note: `Captured by the live-capture harness: ${mode}, temperature ${ctx.temperature}, stop reason ${reply.stopReason ?? "unknown"}, classified ${ctx.classified.outcome}. Unreviewed: promote to a positive fixture by hand once the calls it should yield are agreed.`,
    },
    policy: "either",
    tools: toCorpusTools(ctx.tools),
    text: reply.text,
    markers: [],
    streams: buildStreams(reply.text, ctx.streamed ? reply.chunks : undefined),
    expected: { calls: [], text: reply.text },
  };
}
