import {
  CAPTURE_SYSTEM,
  estimateTokens,
  type CapturePrompt,
  type WireTool,
} from "./tools";

export type Transport = "bedrock" | "openai";

export interface ModelSpec {
  transport: Transport;
  modelId: string;
}

/** `bedrock:<model id>` or `openai:<model id>`; the id may itself contain colons. */
export function parseModelSpec(spec: string): ModelSpec {
  const at = spec.indexOf(":");
  const transport = spec.slice(0, at);
  const modelId = spec.slice(at + 1);
  if (
    at < 0 ||
    (transport !== "bedrock" && transport !== "openai") ||
    !modelId
  ) {
    throw new Error(
      `bad --model ${JSON.stringify(spec)}: use bedrock:<id> or openai:<id>`,
    );
  }
  return { transport, modelId };
}

/** `default` leaves temperature unset, so the model's own default applies. */
export type Temperature = "default" | 0;

export interface PlanOptions {
  models: ModelSpec[];
  prompts: CapturePrompt[];
  tools: WireTool[];
  passes: number;
  temperatures: Temperature[];
  streaming: boolean[];
  /** Assumed output tokens per call; a tool call reply is short. */
  outputTokens: number;
  /** USD per million tokens, when known. */
  priceInPerM?: number;
  priceOutPerM?: number;
}

export interface Cell {
  model: ModelSpec;
  prompt: CapturePrompt;
  stream: boolean;
  temperature: Temperature;
  pass: number;
}

export interface CapturePlan {
  cells: Cell[];
  perCallInputTokens: number;
  toolTokens: number;
  callsPerModel: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | undefined;
}

export function buildPlan(o: PlanOptions): CapturePlan {
  if (o.passes < 1) throw new RangeError("passes must be at least 1");
  const cells: Cell[] = [];
  for (const model of o.models)
    for (const stream of o.streaming)
      for (const temperature of o.temperatures)
        for (let pass = 1; pass <= o.passes; pass++)
          for (const prompt of o.prompts)
            cells.push({ model, prompt, stream, temperature, pass });
  const toolTokens = estimateTokens(JSON.stringify(o.tools));
  const systemTokens = estimateTokens(CAPTURE_SYSTEM);
  const promptTokens = o.prompts.length
    ? Math.round(
        o.prompts.reduce((s, p) => s + estimateTokens(p.text), 0) /
          o.prompts.length,
      )
    : 0;
  const perCallInputTokens = toolTokens + systemTokens + promptTokens;
  const inputTokens = perCallInputTokens * cells.length;
  const outputTokens = o.outputTokens * cells.length;
  const priced = o.priceInPerM !== undefined && o.priceOutPerM !== undefined;
  return {
    cells,
    perCallInputTokens,
    toolTokens,
    callsPerModel: o.models.length ? cells.length / o.models.length : 0,
    inputTokens,
    outputTokens,
    usd: priced
      ? (inputTokens * o.priceInPerM! + outputTokens * o.priceOutPerM!) / 1e6
      : undefined,
  };
}

export function formatPlan(plan: CapturePlan, o: PlanOptions): string {
  const models =
    o.models.map((m) => `${m.transport}:${m.modelId}`).join(", ") || "(none)";
  return [
    "Cost plan (dry run: no model is called without --run)",
    `  models:        ${models}`,
    `  tools:         ${o.tools.length} (about ${plan.toolTokens} tokens in every request)`,
    `  prompts:       ${o.prompts.length}`,
    `  passes:        ${o.passes}`,
    `  temperatures:  ${o.temperatures.join(", ")}`,
    `  streaming:     ${o.streaming.map((s) => (s ? "stream" : "whole")).join(", ")}`,
    `  calls:         ${plan.cells.length} (${plan.callsPerModel} per model)`,
    `  input tokens:  about ${plan.inputTokens} (${plan.perCallInputTokens} per call)`,
    `  output tokens: about ${plan.outputTokens} (assuming ${o.outputTokens} per call)`,
    plan.usd === undefined
      ? "  cost:          unpriced; pass --price-in and --price-out (USD per million tokens)"
      : `  cost:          about $${plan.usd.toFixed(2)}`,
  ].join("\n");
}
