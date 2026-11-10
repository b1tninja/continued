import { describe, expect, it } from "vitest";
import type { ChatHistoryItem } from "../index.js";
import {
  detectHost,
  hashText,
  historyOfSessionJson,
  looksLikeError,
  stepsFromCliHistory,
  stepsFromGuiHistory,
  stepsFromHistory,
} from "./stuckHistory.js";
import {
  HEALTHY_FIRE_LIMIT,
  formatMeasurement,
  measureRun,
  measureRuns,
} from "./stuckMeasure.js";
import { detectStuck } from "./stuckSignals.js";

// ---------------------------------------------------------------------
// CLI-shaped builders: assistant toolCalls + role:"tool" results

let n = 0;
const cliTurn = (
  calls: Array<{ name: string; args: object; result: string }>,
  text = "",
): ChatHistoryItem[] => {
  const ids = calls.map(() => `c${++n}`);
  return [
    {
      message: {
        role: "assistant",
        content: text,
        toolCalls: calls.map((c, i) => ({
          id: ids[i],
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
      contextItems: [],
    },
    ...calls.map((c, i) => ({
      message: {
        role: "tool" as const,
        content: c.result,
        toolCallId: ids[i],
      },
      contextItems: [],
    })),
  ];
};

// GUI-shaped builder: assistant item with toolCallStates
const guiTurn = (
  name: string,
  args: Record<string, unknown>,
  output: string,
  status: "done" | "errored" | "calling" = "done",
): ChatHistoryItem => ({
  message: { role: "assistant", content: "" },
  contextItems: [],
  toolCallStates: [
    {
      toolCallId: `g${++n}`,
      toolCall: {
        id: `g${n}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
      status,
      parsedArgs: args,
      output: [{ name: "out", description: "out", content: output }],
    },
  ],
});

describe("stepsFromCliHistory", () => {
  it("joins calls to their results by id and parses arguments", () => {
    const steps = stepsFromCliHistory(
      cliTurn([
        { name: "Read", args: { filepath: "a.ts" }, result: "text" },
        { name: "Bash", args: { command: "npm test" }, result: "Error: boom" },
      ]),
    );
    expect(steps).toHaveLength(1);
    const [read, bash] = steps[0].calls;
    expect(read).toMatchObject({
      tool: "Read",
      args: { filepath: "a.ts" },
      result: "text",
      error: false,
      read: ["a.ts"],
    });
    expect(bash.error).toBe(true);
  });

  it("drops calls with no result and keeps text-only turns", () => {
    const h = cliTurn([{ name: "Read", args: { filepath: "a" }, result: "x" }]);
    h.pop();
    h.push(...cliTurn([], "thinking out loud"));
    const steps = stepsFromCliHistory(h);
    expect(steps).toHaveLength(1);
    expect(steps[0].calls).toEqual([]);
    expect(steps[0].text).toBe("thinking out loud");
  });

  it("gives an edit and its reverse the same hash, so edit-revert fires", () => {
    const edit = (o: string, nw: string) =>
      cliTurn([
        {
          name: "Edit",
          args: { file_path: "src/a.ts", old_string: o, new_string: nw },
          result: "ok",
        },
      ]);
    const h = [
      ...edit("x = 1", "x = 2"),
      ...edit("x = 2", "x = 1"),
      ...edit("x = 1", "x = 2"),
    ];
    const steps = stepsFromCliHistory(h);
    const report = detectStuck(steps);
    expect(report.signals.some((s) => s.kind === "edit-revert")).toBe(true);
  });

  it("hashes a full write and expands MultiEdit", () => {
    const steps = stepsFromCliHistory(
      cliTurn([
        {
          name: "Write",
          args: { filepath: "w.ts", content: "hello" },
          result: "ok",
        },
        {
          name: "MultiEdit",
          args: {
            file_path: "w.ts",
            edits: [{ old_string: "hello", new_string: "bye" }],
          },
          result: "ok",
        },
      ]),
    );
    expect(steps[0].calls[0].changed).toEqual([
      { path: "w.ts", hash: hashText("hello") },
    ]);
    expect(steps[0].calls[1].changed?.at(-1)).toEqual({
      path: "w.ts",
      hash: hashText("bye"),
    });
  });

  it("does not count a failed edit as a change", () => {
    const steps = stepsFromCliHistory(
      cliTurn([
        {
          name: "Edit",
          args: { file_path: "a", old_string: "p", new_string: "q" },
          result: "Error: old_string not found",
        },
      ]),
    );
    expect(steps[0].calls[0].changed).toBeUndefined();
  });
});

describe("stepsFromGuiHistory", () => {
  it("reads parsedArgs, output and status", () => {
    const steps = stepsFromGuiHistory([
      guiTurn("read_file", { filepath: "a.ts" }, "content"),
      guiTurn(
        "run_terminal_command",
        { command: "npm test" },
        "fail",
        "errored",
      ),
    ]);
    expect(steps.map((s) => s.calls[0].tool)).toEqual([
      "read_file",
      "run_terminal_command",
    ]);
    expect(steps[0].calls[0]).toMatchObject({ read: ["a.ts"], error: false });
    expect(steps[1].calls[0].error).toBe(true);
  });

  it("leaves out calls that never finished", () => {
    const steps = stepsFromGuiHistory([
      guiTurn("read_file", { filepath: "a.ts" }, "", "calling"),
    ]);
    expect(steps).toEqual([]);
  });

  it("fires repeat-error on the same failing command", () => {
    const h = [1, 2, 3].map((i) =>
      guiTurn(
        "run_terminal_command",
        { command: `npm test -- --run ${i}` },
        "Error: cannot find module './x'",
        "errored",
      ),
    );
    const report = detectStuck(stepsFromGuiHistory(h));
    expect(report.signals.map((s) => s.kind)).toContain("repeat-error");
  });
});

describe("host detection", () => {
  it("picks the adapter from the shape of the history", () => {
    const gui = [guiTurn("read_file", { filepath: "a" }, "x")];
    const cli = cliTurn([
      { name: "Read", args: { filepath: "a" }, result: "x" },
    ]);
    expect(detectHost(gui)).toBe("gui");
    expect(detectHost(cli)).toBe("cli");
    expect(stepsFromHistory(gui)[0].calls[0].tool).toBe("read_file");
    expect(stepsFromHistory(cli)[0].calls[0].tool).toBe("Read");
  });

  it("finds a history in a session file, a bare array or a bench state", () => {
    const h = cliTurn([{ name: "Read", args: {}, result: "x" }]);
    expect(historyOfSessionJson({ history: h })).toBe(h);
    expect(historyOfSessionJson(h)).toBe(h);
    expect(historyOfSessionJson({ state: { history: h } })).toBe(h);
    expect(historyOfSessionJson({ other: 1 })).toBeUndefined();
    expect(historyOfSessionJson([1, 2])).toBeUndefined();
  });

  it("recognises error-looking results", () => {
    expect(looksLikeError("Error executing tool Read: nope")).toBe(true);
    expect(looksLikeError("Command failed with exit code 1")).toBe(true);
    expect(looksLikeError("all tests passed")).toBe(false);
  });
});

describe("measurement", () => {
  const failing = (i: number) =>
    cliTurn([
      {
        name: "Bash",
        args: { command: `npm test -- ${i}` },
        result: "Error: cannot find module './x'",
      },
    ]);
  const stuckRun = stepsFromCliHistory([1, 2, 3, 4, 5, 6].flatMap(failing));
  const healthyRun = stepsFromCliHistory([
    ...cliTurn([{ name: "Read", args: { filepath: "a" }, result: "x" }]),
    ...cliTurn([
      {
        name: "Edit",
        args: { file_path: "a", old_string: "1", new_string: "2" },
        result: "ok",
      },
    ]),
    ...cliTurn([{ name: "Bash", args: { command: "npm test" }, result: "ok" }]),
  ]);

  it("records the first step each signal fired, as a live session saw it", () => {
    const m = measureRun({ id: "s", steps: stuckRun, label: "stuck" });
    expect(m.steps).toBe(6);
    expect(m.signals["repeat-error"]?.note).toBe(2);
    expect(m.signals["repeat-error"]?.stuck).toBe(3);
    expect(m.overall.stuck).toBeDefined();
  });

  it("reports rates by label, lead time and the healthy limit", () => {
    const m = measureRuns([
      { id: "s", steps: stuckRun, label: "stuck" },
      { id: "h", steps: healthyRun, label: "healthy" },
    ]);
    expect(m.runs).toBe(2);
    const err = m.rows.find((r) => r.kind === "repeat-error")!;
    expect(err.stuck).toMatchObject({ fired: 1, of: 2 });
    expect(err.healthyStuck).toMatchObject({ fired: 0, of: 1 });
    expect(err.stuckStuck.rate).toBe(1);
    expect(err.meanLeadSteps).toBe(3);
    expect(err.overHealthyLimit).toBe(false);
    const overall = m.rows.find((r) => r.kind === "overall")!;
    expect(overall.healthyStuck.fired).toBe(0);

    // a signal that fires on a healthy run is over the limit
    const bad = measureRuns([{ id: "h", steps: stuckRun, label: "healthy" }]);
    expect(
      bad.rows.find((r) => r.kind === "repeat-error")!.overHealthyLimit,
    ).toBe(true);
    expect(HEALTHY_FIRE_LIMIT).toBe(0.05);
  });

  it("prints a table with a line per signal and the thresholds", () => {
    const text = formatMeasurement(
      measureRuns([{ id: "s", steps: stuckRun, label: "stuck" }]),
    );
    expect(text).toContain("| repeat-error |");
    expect(text).toContain("| overall |");
    expect(text).toContain("Thresholds:");
  });
});
