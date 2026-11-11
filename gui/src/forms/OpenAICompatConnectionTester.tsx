import { useContext, useState } from "react";
import type { OpenAICompatTestResult } from "core/util/openaiCompatTest";
import { Button } from "../components/ui/Button";
import Alert from "../components/gui/Alert";
import { IdeMessengerContext } from "../context/IdeMessenger";

interface Props {
  provider: string;
  apiBase?: string;
  /** The key as typed in the form; empty for a keyless local server or a stored key. */
  apiKey?: string;
  /** The model that will be saved; the first listed one is probed when it is not served. */
  model?: string;
  /** Required fields are filled in. */
  canTest: boolean;
}

/**
 * "Test connection" for an OpenAI-compatible endpoint: lists the models the
 * server serves, then sends one request with a made-up tool to see how the
 * model answers (the tool is never run). The same result Bedrock's tester shows.
 */
export function OpenAICompatConnectionTester({
  provider,
  apiBase,
  apiKey,
  model,
  canTest,
}: Props) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpenAICompatTestResult>();
  const [probedModel, setProbedModel] = useState<string>();

  async function run(withModel?: string) {
    const res = await ideMessenger.request("openaiCompat/testConnection", {
      provider,
      apiBase: apiBase || undefined,
      apiKey: apiKey || undefined,
      model: withModel,
    });
    return res.status === "success"
      ? res.content
      : ({
          ok: false,
          error: String(res.error ?? "Request failed"),
        } as OpenAICompatTestResult);
  }

  async function testConnection() {
    setBusy(true);
    setResult(undefined);
    setProbedModel(undefined);
    try {
      const listed = await run();
      if (!listed.ok || listed.models.length === 0) return setResult(listed);
      const pick =
        model && listed.models.includes(model) ? model : listed.models[0];
      setProbedModel(pick);
      setResult(await run(pick));
    } catch (e) {
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  const probe = result?.ok ? result.probe : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={testConnection}
          disabled={!canTest || busy}
        >
          {busy ? "Connecting…" : "Test connection"}
        </Button>
      </div>

      {result && !result.ok && (
        <Alert type="error" size="sm" role="alert">
          <span className="block text-xs font-medium">Could not connect</span>
          <code className="block text-xs break-all whitespace-pre-wrap">
            {result.error}
          </code>
        </Alert>
      )}

      {result?.ok && (
        <Alert type="success" size="sm" role="status">
          <span className="block text-xs font-medium">
            Connected. {result.models.length} model
            {result.models.length === 1 ? "" : "s"} listed.
          </span>
        </Alert>
      )}

      {probe && (
        <Alert
          type={probe.ok && probe.kind !== "none" ? "info" : "warning"}
          size="sm"
          role="status"
        >
          <span className="text-xs" data-testid="tool-calls-result">
            {probe.ok
              ? `${probe.label}${probedModel ? ` (${probedModel})` : ""}`
              : `Tool use: could not tell (${probe.error})`}
          </span>
          {probe.ok && probe.serverParses && (
            <span className="block text-xs opacity-80">
              The server parses this model's tool calls itself.
            </span>
          )}
          {probe.ok && probe.preset && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-preset"
            >
              Known format for this model family: {probe.preset}
            </span>
          )}
          {result?.ok && result.template && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-template"
            >
              {result.template}
            </span>
          )}
          {probe.ok && probe.facts && (
            <span
              className="block text-xs opacity-80"
              data-testid="tool-calls-facts"
            >
              {probe.facts}
            </span>
          )}
        </Alert>
      )}
    </div>
  );
}
