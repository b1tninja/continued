/**
 * Live tool-call capture (plans/live-capture.md). Plans by default: without
 * --run it prints the cost plan and exits without calling any model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  createBedrockClient,
  createOpenAiClient,
  type CaptureClient,
} from "./clients";
import {
  buildPlan,
  formatPlan,
  parseModelSpec,
  type ModelSpec,
  type PlanOptions,
  type Temperature,
} from "./plan";
import { formatReport, runCapture, type Writer } from "./run";
import { CAPTURE_PROMPTS, realAgentTools, toWireTools } from "./tools";

export const HELP = `Usage: capture --model <bedrock:ID|openai:ID> [--model ...] [options]

  --model <spec>      repeatable; bedrock:<model id> or openai:<model id>
  --passes <n>        passes per prompt, default 3
  --temps <list>      default,0 (default); "default" leaves temperature unset
  --streaming <m>     both (default), stream or whole
  --profile <name>    AWS profile for bedrock models
  --region <name>     AWS region, default us-east-1
  --base-url <url>    OpenAI-compatible base URL, default http://127.0.0.1:11434/v1
  --api-key-env <v>   name of the env var holding the key for --base-url
  --max-tokens <n>    reply limit per call, default 1024
  --price-in <usd>    USD per million input tokens (for the cost plan)
  --price-out <usd>   USD per million output tokens
  --max-calls <n>     refuse to run a plan larger than this, default 500
  --out <dir>         output directory, default a new folder under the temp dir
  --run               send the requests. Without it nothing is called.
`;

export interface CliOptions extends PlanOptions {
  run: boolean;
  profile?: string;
  region: string;
  baseUrl: string;
  apiKeyEnv?: string;
  maxTokens: number;
  maxCalls: number;
  out?: string;
}

const STREAMING = { both: [false, true], stream: [true], whole: [false] };

export function parseCli(
  argv: string[],
  tools: PlanOptions["tools"],
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string", multiple: true },
      passes: { type: "string" },
      temps: { type: "string" },
      streaming: { type: "string" },
      profile: { type: "string" },
      region: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "max-tokens": { type: "string" },
      "price-in": { type: "string" },
      "price-out": { type: "string" },
      "max-calls": { type: "string" },
      out: { type: "string" },
      run: { type: "boolean" },
    },
  });
  const streamingKey = (values.streaming ?? "both") as keyof typeof STREAMING;
  if (!STREAMING[streamingKey])
    throw new Error("--streaming is both, stream or whole");
  const temperatures = (values.temps ?? "default,0")
    .split(",")
    .map((t): Temperature => {
      if (t === "default") return "default";
      if (t === "0") return 0;
      throw new Error(`--temps takes default and 0, got ${t}`);
    });
  const num = (v: string | undefined) =>
    v === undefined ? undefined : Number(v);
  return {
    models: (values.model ?? []).map(parseModelSpec),
    prompts: CAPTURE_PROMPTS,
    tools,
    passes: num(values.passes) ?? 3,
    temperatures,
    streaming: STREAMING[streamingKey],
    outputTokens: 300,
    priceInPerM: num(values["price-in"]),
    priceOutPerM: num(values["price-out"]),
    run: values.run === true,
    profile: values.profile,
    region: values.region ?? "us-east-1",
    baseUrl: values["base-url"] ?? "http://127.0.0.1:11434/v1",
    apiKeyEnv: values["api-key-env"],
    maxTokens: num(values["max-tokens"]) ?? 1024,
    maxCalls: num(values["max-calls"]) ?? 500,
    out: values.out,
  };
}

function diskWriter(root: string): Writer {
  return {
    write(rel, content) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
  };
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(HELP);
    return 0;
  }
  const tools = toWireTools(await realAgentTools());
  const opts = parseCli(argv, tools);
  if (opts.models.length === 0) throw new Error("give at least one --model");
  const plan = buildPlan(opts);
  console.log(formatPlan(plan, opts));
  if (!opts.run) {
    console.log("\nDry run. Add --run to send these requests.");
    return 0;
  }
  if (plan.cells.length > opts.maxCalls) {
    console.error(
      `\nRefusing: ${plan.cells.length} calls exceeds --max-calls ${opts.maxCalls}.`,
    );
    return 2;
  }
  const out =
    opts.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "live-capture-"));
  console.log(`\nWriting to ${out}\n`);
  const clients = new Map<string, CaptureClient>();
  const clientFor = (m: ModelSpec): CaptureClient => {
    const c = clients.get(m.transport);
    if (!c) throw new Error(`client for ${m.transport} not ready`);
    return c;
  };
  if (opts.models.some((m) => m.transport === "bedrock")) {
    clients.set(
      "bedrock",
      await createBedrockClient({ region: opts.region, profile: opts.profile }),
    );
  }
  if (opts.models.some((m) => m.transport === "openai")) {
    clients.set(
      "openai",
      createOpenAiClient({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined,
      }),
    );
  }
  const tallies = await runCapture(plan.cells, opts, {
    clientFor,
    writer: diskWriter(out),
    date: new Date().toISOString().slice(0, 10),
    maxTokens: opts.maxTokens,
    log: console.log,
  });
  const report = formatReport(tallies);
  diskWriter(out).write("report.txt", report + "\n");
  console.log("\n" + report);
  return 0;
}
