import type { PolicyArea, PolicyLevels } from "core/tools/permissions/policy";
import type {
  TestStep,
  ToolCallTestResult,
} from "core/tools/permissions/testToolCall";
import { useContext, useId, useState } from "react";
import { Button } from "../../../../components/ui";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { DecisionChip, SourceBadge } from "./badges";

interface Kind {
  tool: string;
  label: string;
  arg: "command" | "path" | "url" | "query" | "tool";
  placeholder: string;
}

export const KINDS_BY_AREA: Partial<Record<PolicyArea, Kind[]>> = {
  context: [
    {
      tool: "readFile",
      label: "Read a file",
      arg: "path",
      placeholder: "src/index.ts or ~/.aws/credentials",
    },
    {
      tool: "listDirectory",
      label: "List a folder",
      arg: "path",
      placeholder: "src",
    },
    {
      tool: "grepSearch",
      label: "Search the code",
      arg: "query",
      placeholder: "password",
    },
  ],
  tools: [
    {
      tool: "runTerminalCommand",
      label: "Run a command",
      arg: "command",
      placeholder: "git push origin main",
    },
    {
      tool: "fetchUrl",
      label: "Fetch a URL",
      arg: "url",
      placeholder: "https://example.com/data.json",
    },
    {
      tool: "searchWeb",
      label: "Search the web",
      arg: "query",
      placeholder: "vitest config",
    },
    {
      tool: "mcp",
      label: "Call an MCP tool",
      arg: "tool",
      placeholder: "mcp__github__create_issue",
    },
  ],
  edits: [
    {
      tool: "writeFile",
      label: "Edit a file",
      arg: "path",
      placeholder: ".github/workflows/ci.yml",
    },
  ],
};

const OUTCOME_TEXT: Record<TestStep["outcome"], string> = {
  decided: "Decided here",
  passed: "No match",
  skipped: "Not reached",
  info: "Note",
};

const DECISION_WORD = { allow: "Runs", ask: "Asks", deny: "Refused" } as const;

function StepList({ steps }: { steps: TestStep[] }) {
  return (
    <ol className="m-0 flex flex-col gap-1 pl-4 text-2xs">
      {steps.map((s) => (
        <li key={s.id} data-testid={`step-${s.id}`}>
          <span className="font-semibold">{s.label}</span>{" "}
          <span className="text-description-muted">
            ({OUTCOME_TEXT[s.outcome]})
          </span>
          {s.detail && <div className="break-words">{s.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

export function TestResult({ result }: { result: ToolCallTestResult }) {
  return (
    <div
      className="mt-2 rounded-sm border border-solid border-border p-2"
      role="status"
      aria-live="polite"
      data-testid="test-result"
    >
      <div className="flex flex-wrap items-center gap-1">
        <DecisionChip decision={result.decision} />
        <span className="text-xs font-semibold" data-testid="test-decision">
          {DECISION_WORD[result.decision]}
        </span>
        {result.source && (
          <span className="text-2xs text-description-muted">
            ({result.source})
          </span>
        )}
      </div>
      <p className="my-1 text-xs break-words" data-testid="test-reason">
        {result.reason}
      </p>
      {result.matchedRules.length > 0 && (
        <div data-testid="test-matched">
          <div className="text-2xs font-semibold">Rules that match</div>
          <ul className="m-0 flex flex-col gap-1 p-0">
            {result.matchedRules.map((m) => (
              <li key={`${m.source}:${m.raw}`} className="list-none text-2xs">
                <span className="flex flex-wrap items-center gap-1">
                  <DecisionChip decision={m.decision} />
                  <SourceBadge source={m.source} />
                  {m.deciding && <span>decided</span>}
                </span>
                <code className="block font-mono break-all">{m.raw}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.lint.length > 0 && (
        <p className="my-1 text-2xs text-warning" data-testid="test-lint">
          Command check: {result.lint.map((f) => f.message).join(" ")}
        </p>
      )}
      {result.notes.map((n) => (
        <p key={n} className="my-1 text-2xs text-description-muted">
          {n}
        </p>
      ))}
      <details className="mt-1">
        <summary className="cursor-pointer text-2xs">
          How this was decided
        </summary>
        <StepList steps={result.steps} />
      </details>
    </div>
  );
}

/** "Try a call": runs the real evaluator in core. Nothing runs and no model is asked. */
export function RuleTester({
  area,
  levels,
  onResult,
}: {
  area: PolicyArea;
  levels: PolicyLevels;
  onResult?: (result: ToolCallTestResult | undefined) => void;
}) {
  const kinds = KINDS_BY_AREA[area] ?? [];
  const ideMessenger = useContext(IdeMessengerContext);
  const id = useId();
  const [kindTool, setKindTool] = useState(kinds[0]?.tool ?? "");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"agent" | "plan" | "chat">("agent");
  const [result, setResult] = useState<ToolCallTestResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const kind = kinds.find((k) => k.tool === kindTool) ?? kinds[0];

  if (!kind) {
    return (
      <p className="text-2xs text-description" data-testid="no-tester">
        Nothing to try here: this area has a level and a few settings, not
        rules. The level and settings above decide.
      </p>
    );
  }

  const run = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    const call =
      kind.arg === "tool"
        ? { tool: text.trim() }
        : { tool: kind.tool, [kind.arg]: text };
    const res = await ideMessenger.request("policy/test", {
      ...call,
      mode,
      levels,
    } as never);
    setBusy(false);
    if (res.status !== "success") {
      setResult(undefined);
      onResult?.(undefined);
      setError("The test could not run.");
      return;
    }
    setResult(res.content);
    onResult?.(res.content);
  };

  return (
    <section
      aria-label={`Try a call: ${area}`}
      data-testid={`tester-${area}`}
      className="min-w-0"
    >
      <h5 className="my-1 text-xs font-semibold">Try a call</h5>
      <p className="mt-0 mb-1 text-2xs text-description-muted">
        Runs your rules and levels through the real check. Nothing is run or
        sent, and no model is asked.
      </p>
      <div className="flex min-w-0 flex-col gap-1">
        <label className="text-2xs" htmlFor={`${id}-kind`}>
          What to try
        </label>
        <select
          id={`${id}-kind`}
          value={kind.tool}
          onChange={(e) => {
            setKindTool(e.target.value);
            setResult(undefined);
            onResult?.(undefined);
          }}
          className="w-full min-w-0 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
        >
          {kinds.map((k) => (
            <option key={k.tool} value={k.tool}>
              {k.label}
            </option>
          ))}
        </select>
        <label className="text-2xs" htmlFor={`${id}-input`}>
          {kind.label}
        </label>
        <input
          id={`${id}-input`}
          className="w-full min-w-0 rounded-sm border border-solid border-border bg-input px-1 font-mono text-2xs text-foreground"
          placeholder={kind.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
        />
        <label className="text-2xs" htmlFor={`${id}-mode`}>
          Mode
        </label>
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          className="w-full min-w-0 rounded border border-solid border-border bg-input px-1 text-xs text-foreground"
        >
          <option value="agent">Agent</option>
          <option value="plan">Plan</option>
          <option value="chat">Chat</option>
        </select>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => void run()}
          >
            Test
          </Button>
        </div>
      </div>
      {error && (
        <p className="my-1 text-2xs text-error" role="alert">
          {error}
        </p>
      )}
      {result && <TestResult result={result} />}
    </section>
  );
}
