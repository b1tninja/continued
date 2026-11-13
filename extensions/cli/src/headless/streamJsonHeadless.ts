import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";

import { RUN_STOP_EXIT_CODE, type RunStop } from "../budget/runBudget.js";
import * as runLimits from "../budget/runLimits.js";
import { stripThinkTags } from "../commands/chatOutput.js";
import { safeStdout } from "../init.js";
import { services } from "../services/index.js";
import { getSessionUsage } from "../session.js";
import type { StreamChatResponseOptions } from "../stream/streamChatResponse.js";
import type { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import { hadUnhandledError } from "../util/errorState.js";
import { describeNetworkFailure } from "../util/networkError.js";
import { getVersion } from "../version.js";

import {
  isStreamJson,
  type RunErrorKind,
  type RunStatus,
} from "./streamJsonEvents.js";
import {
  activeStreamJson,
  setActiveStreamJson,
  StreamJsonRun,
} from "./streamJsonRun.js";

export { isStreamJson, type HeadlessFormat } from "./streamJsonEvents.js";

function sessionUsage() {
  try {
    return getSessionUsage();
  } catch {
    return undefined;
  }
}

/**
 * The run's stream, made once. Two handlers make sure a `result` line ends
 * the stream however the process leaves: Ctrl+C (the process handler exits
 * with 130 after its cleanup, so the line is written here, before that), and
 * any exit that did not write one.
 */
function ensureRun(): StreamJsonRun {
  const existing = activeStreamJson();
  if (existing) return existing;
  const run = new StreamJsonRun({ write: safeStdout, usage: sessionUsage });
  setActiveStreamJson(run);
  process.once("SIGINT", () => {
    run.finish({ status: "interrupted", exitCode: 130 });
  });
  process.once("exit", (code) => {
    run.finish({
      status: code === 0 ? "success" : code === 130 ? "interrupted" : "error",
      exitCode: code,
    });
  });
  return run;
}

/** Call at the start of a headless run: with `--format stream-json` the stream exists from here on. */
export function beginStreamJson(format: string | undefined): void {
  if (isStreamJson(format)) ensureRun();
}

interface HistorySource {
  on(event: "stateChanged", listener: (state: unknown) => void): unknown;
  getHistory(): ChatHistoryItem[];
}

/**
 * Starts the stream of a `--format stream-json` run: writes `init` and
 * follows the conversation for tool calls and their results.
 */
export function startStreamJson(
  format: string | undefined,
  facts: {
    sessionId: string;
    model: string;
    provider: string;
    mode: string;
    limits?: {
      maxBudgetUsd?: number;
      maxTurns?: number;
      maxDurationMinutes?: number;
    };
  },
  history: HistorySource,
): void {
  if (!isStreamJson(format)) return;
  const run = ensureRun();
  run.init(
    {
      sessionId: facts.sessionId,
      cliVersion: getVersion(),
      model: facts.model,
      provider: facts.provider,
      cwd: process.cwd(),
      mode: facts.mode,
      ...(facts.limits && Object.keys(facts.limits).length > 0
        ? { limits: facts.limits }
        : {}),
    },
    history.getHistory(),
  );
  history.on("stateChanged", () => {
    try {
      run.observeHistory(history.getHistory());
    } catch {
      // the stream never breaks the run
    }
  });
}

/** `startStreamJson` for a headless run, with the facts read from the services. */
export function startStreamJsonRun(
  format: string | undefined,
  model: Pick<ModelConfig, "model" | "provider">,
): void {
  if (!isStreamJson(format)) return;
  startStreamJson(
    format,
    {
      sessionId: services.chatHistory.getSessionId(),
      model: model.model,
      provider: model.provider,
      mode: services.toolPermissions.getCurrentMode(),
      limits: runLimits.activeRunBudget()?.limits,
    },
    services.chatHistory,
  );
}

/** The final answer of a stream-json run, for its `result` line. */
let streamJsonAnswer = "";

/**
 * With `--format stream-json` keeps the final answer for the `result` line
 * and returns true: nothing but events goes to stdout. Otherwise false.
 */
export function noteHeadlessAnswer(
  answer: string,
  silent: boolean | undefined,
  format: string | undefined,
): boolean {
  if (!isStreamJson(format)) return false;
  streamJsonAnswer = silent ? stripThinkTags(answer) : answer;
  return true;
}

/**
 * The exit code of a headless run that reached its end: a run limit's code,
 * else 1 when an unhandled error happened on the way (as gracefulExit
 * decides), else 0. With stream-json the `run_limit` and `result` lines.
 */
export function endHeadlessRun(format: string | undefined): number {
  const limitCode = runLimits.exitCodeOfRun(format);
  const stop = runLimits.currentRunStop();
  streamJsonRunLimit(stop);
  const exitCode = limitCode === 0 && hadUnhandledError() ? 1 : limitCode;
  finishStreamJson({
    status: stop ? "stopped" : exitCode === 0 ? "success" : "error",
    exitCode,
    result: streamJsonAnswer,
  });
  return exitCode;
}

/** The exit code of a run that failed with `error`; with stream-json its `error` and `result` lines. */
export function failHeadlessRun(
  options: { headless?: boolean; format?: string },
  error: Error,
): number {
  if (!options.headless) return 1;
  const network = describeNetworkFailure(error);
  failStreamJson(options.format, {
    kind: network ? "provider" : "internal",
    message: network?.message ?? (error.message || String(error)),
    code: network?.code,
    exitCode: 1,
  });
  return 1;
}

/** What the model loop is given so the stream hears each reply and each finished request. */
export function streamJsonHooks(): {
  callbacks?: StreamCallbacks;
  options?: StreamChatResponseOptions;
} {
  const run = activeStreamJson();
  if (!run) return {};
  return {
    callbacks: { onContentComplete: (content) => run.message(content) },
    options: { onRequest: () => run.requestDone() },
  };
}

/** A run limit ended the run: the `run_limit` line, before `result`. */
export function streamJsonRunLimit(stop: RunStop | undefined): void {
  if (!stop) return;
  activeStreamJson()?.runLimit({
    reason: stop.reason,
    phase: stop.phase,
    detail: stop.detail,
    spentUsd: stop.spentUsd,
    exitCode: RUN_STOP_EXIT_CODE[stop.reason],
  });
}

/** The last line of a run that reached its end. */
export function finishStreamJson(end: {
  status: RunStatus;
  exitCode: number;
  result?: string;
}): void {
  activeStreamJson()?.finish(end);
}

/** A failed run: `error`, then `result`. Makes the stream if the run failed before `init`. */
export function failStreamJson(
  format: string | undefined,
  failure: {
    kind: RunErrorKind;
    message: string;
    code?: string;
    exitCode: number;
  },
): void {
  if (!isStreamJson(format)) return;
  const run = ensureRun();
  run.error(failure.kind, failure.message, failure.code);
  run.finish({
    status: failure.kind === "refused" ? "refused" : "error",
    exitCode: failure.exitCode,
  });
}
