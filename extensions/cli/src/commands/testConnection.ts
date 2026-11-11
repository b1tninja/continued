/**
 * `continuous test-connection --provider P [--api-base URL] [--api-key-env NAME]
 * [--model M] [--json]`: the add-model form's Test connection for any
 * OpenAI-compatible endpoint (core/util/openaiCompatTest.ts). It lists the
 * served models and, with --model, sends one request offering a made-up tool
 * (never run). The key is read from the named environment variable and is
 * never printed.
 */

import {
  testOpenAICompatConnection,
  type OpenAICompatTestResult,
  type TestFetch,
} from "core/util/openaiCompatTest.js";

export interface TestConnectionOptions {
  provider?: string;
  apiBase?: string;
  apiKeyEnv?: string;
  model?: string;
  json?: boolean;
  /** For tests. */
  fetchFn?: TestFetch;
  env?: Record<string, string | undefined>;
}

export function formatTestResult(r: OpenAICompatTestResult): string[] {
  if (!r.ok) return [`Could not connect: ${r.error}`];
  const lines = [
    `Connected. ${r.models.length} model${r.models.length === 1 ? "" : "s"} listed${
      r.models.length ? `: ${r.models.slice(0, 10).join(", ")}` : ""
    }${r.models.length > 10 ? ", ..." : ""}`,
  ];
  if (r.probe) {
    lines.push(
      r.probe.ok
        ? r.probe.label
        : `Tool use: could not tell (${r.probe.error})`,
    );
    if (r.probe.ok && r.probe.serverParses) {
      lines.push("The server parses this model's tool calls itself.");
    }
    if (r.probe.ok && r.probe.preset) {
      lines.push(`Known format for this model family: ${r.probe.preset}`);
    }
    if (r.probe.ok && r.probe.facts) lines.push(r.probe.facts);
  }
  if (r.template) lines.push(r.template);
  return lines;
}

/** Exit code: 0 connected, 1 failed, 2 bad arguments. */
export async function testConnectionCommand(
  options: TestConnectionOptions,
): Promise<number> {
  if (!options.provider) {
    process.stderr.write("test-connection needs --provider\n");
    return 2;
  }
  const env = options.env ?? process.env;
  const apiKey = options.apiKeyEnv ? env[options.apiKeyEnv] : undefined;
  if (options.apiKeyEnv && !apiKey) {
    process.stderr.write(
      `The environment variable ${options.apiKeyEnv} is not set\n`,
    );
    return 2;
  }
  const result = await testOpenAICompatConnection({
    provider: options.provider,
    apiBase: options.apiBase,
    apiKey,
    model: options.model,
    fetchFn: options.fetchFn,
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatTestResult(result).join("\n")}\n`,
  );
  return result.ok ? 0 : 1;
}
