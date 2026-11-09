/**
 * The instructions for each kind of turn, shared by the IDE and the CLI
 * (plans/policy-areas.md, "Modes are sequences of turns"). An act turn is
 * Agent mode or a Loop item run; a plan turn is Plan mode or a Loop re-plan.
 * The text names the turn, never the mode that launched it or the surface.
 * Each surface adds its own preamble: the CLI its environment block, the IDE
 * its code-block rules.
 *
 * Everything here is constant for a conversation, so it belongs in the system
 * message, where it stays cached. Anything that changes per turn (the plan
 * block, a Questions level that changes how the model should ask) goes at the
 * end of the turn's first user message instead.
 *
 * Design, sources and the evidence for each line: policy-areas-prompts.md in
 * the session notes. In short: the "Stopping" group is the three moves every
 * agent that finishes work carries (the turn lasts until done, stopping costs
 * the person, a closed list of stop conditions) plus the two cures for
 * listing steps and stopping (a reply with no tool call is final; check the
 * last paragraph). The plan text's "two kinds of unknowns" is the one rule
 * that replaces most "when to ask" prose.
 */

import { BuiltInToolNames } from "../../tools/builtIn.js";

/** The names the model knows the tools by on a surface. */
export interface TurnToolNames {
  presentPlan: string;
  taskList: string;
  /** The file-reading tool, for the tailored profile's worked example. */
  read: string;
  /** The file-writing tool, for the tailored profile's shell-route line. */
  write: string;
}

export const IDE_TURN_TOOL_NAMES: TurnToolNames = {
  presentPlan: BuiltInToolNames.PresentPlan,
  taskList: BuiltInToolNames.TaskList,
  read: BuiltInToolNames.ReadFile,
  write: BuiltInToolNames.CreateNewFile,
};

export const CLI_TURN_TOOL_NAMES: TurnToolNames = {
  presentPlan: "PresentPlan",
  taskList: "TaskList",
  read: "Read",
  write: "Write",
};

/** An act turn: Agent mode, or a Loop item run. */
export function actTurn(names: TurnToolNames = IDE_TURN_TOOL_NAMES): string {
  return `You are in agent mode. You do the work with the tools you have, and your turn lasts until the request is done.

Work
- Act on the request: find what you need in the code, make the changes, run the project's checks for what you changed (tests, type check, lint), and fix what fails.
- Search before you add; one search that finds nothing does not mean something is missing. Read a file before you edit it.
- Finish the whole request. If a part cannot be done, do the rest and say what you left out and why.

Stopping
- A reply with no tool call ends your turn, and the person then comes back to unchanged code. Stop only when the request is done, when you are blocked on something only they have, or before a step that is hard to undo.
- Do not describe steps and then stop. If the next step is decided, take it. "Plan, then build" is not a stopping point.
- When one part is blocked, the rest usually is not. Try the step you expect to fail before reporting it; finish everything that does not depend on the stuck part; then open your report with what is stuck, what you ruled out, and what would settle it.
- Before you end, read your last paragraph. A plan, a list, a question you could answer yourself, or a promise means there is work left: do it.

Refusals
- A tool call can come back refused or held. The result says who stopped it and what to do next. Never retry a refused call or reach the same result another way. If it says to carry on, finish what else the request needs and report what you could not do. If it says to ask, stop and ask.

Questions
- Ask only when a choice would change the result and reading the code cannot settle it. Give two to four options and say which you would pick. Otherwise choose, and name the choice when you report.
- If a task list is shown, it came from a plan: keep it current with the ${names.taskList} tool as you work. Do not make a list otherwise.

Report
- Say "done", "fixed" or "tested" only when a tool's output shows it. Compiling, the app starting, or a related feature working is not evidence that your new code ran. If you did not run it, say so.
- When you are done, say what you changed, what you ran and what it showed, and anything you could not verify. Separate what you verified from what you believe.

You can call several read-only tools at once.`;
}

/**
 * Which turn text a model gets. "short" is the same rules in a third of the
 * words with the finish rule stated twice, for models whose instruction
 * following falls off as rules pile up. Measured on 2026-11-08
 * (research-qwen-harness.md): on Qwen3 the short turns won or tied in every
 * scenario, and on Qwen3-Coder-30B the full plan turn took 22 requests with
 * seven tool calls leaked as text where the short one took 10 and none.
 *
 * "tailored" is the short text plus a "Tool calls" group that names the
 * tool-call markup the model was trained on and says it does nothing as
 * text. Measured on 2026-11-09 (research-qwen-tailoring.md) on Bedrock:
 * Qwen3-Coder-30B leaked tool calls as text in 3 of 6 short plan-ask runs
 * and 0 of 6 tailored ones, and finished the loop scenario in 1 of 3 short
 * runs against 3 of 3 tailored; dropping only the markup line brought the
 * leaks back (2 of 3). Qwen3-Coder-Next and Qwen3-Next-80B presented no plan
 * at all under the full text and presented one under short and tailored,
 * with tailored the cheapest. Dense Qwen3-32B and the local Qwen3.8 never
 * leaked under any text, and the extra group cost them turns, so they stay
 * on short. Other families keep the full text until they are measured; a
 * model's own `baseAgentSystemMessage` or `basePlanSystemMessage` wins over
 * all three.
 */
export type PromptProfile = "full" | "short" | "tailored";

const SHORT_PROMPT_MODELS = /qwen/i;
const TAILORED_PROMPT_MODELS = /qwen3[-._]?coder|coder-next|qwen3[-._]?next/i;

/**
 * Set to "full", "short" or "tailored", picks the profile for every model, so
 * the benchmark (bench/runner.mjs --profile) can compare the texts on one
 * model. Any other value is ignored. A `promptProfile` field per model in
 * config is Track K and not this.
 */
export const PROMPT_PROFILE_ENV = "CONTINUE_PROMPT_PROFILE";

/** The built-in texts, by the names config and the override know them by. */
export const PROMPT_PROFILES: readonly PromptProfile[] = [
  "full",
  "short",
  "tailored",
];

/** The environment override, when the runtime has one (not the browser). */
function promptProfileOverride(): PromptProfile | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[PROMPT_PROFILE_ENV];
  return PROMPT_PROFILES.find((profile) => profile === value);
}

export function promptProfile(model: string | undefined): PromptProfile {
  const override = promptProfileOverride();
  if (override) return override;
  if (!model) return "full";
  if (TAILORED_PROMPT_MODELS.test(model)) return "tailored";
  return SHORT_PROMPT_MODELS.test(model) ? "short" : "full";
}

/** The act turn for a model, by its profile. */
export function actTurnFor(
  model: string | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  switch (promptProfile(model)) {
    case "tailored":
      return actTurnTailored(model, names);
    case "short":
      return actTurnShort(names);
    default:
      return actTurn(names);
  }
}

/** The plan turn for a model, by its profile. */
export function planTurnFor(
  model: string | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  switch (promptProfile(model)) {
    case "tailored":
      return planTurnTailored(model, names);
    case "short":
      return planTurnShort(names);
    default:
      return planTurn(names);
  }
}

/**
 * The tool-call markup a Qwen model was trained on, so the tailored text can
 * name the exact string it must not write. Qwen3-Coder and the Flash line
 * use the XML function format; the other Qwen3 models the Hermes JSON one.
 */
function qwenToolCallMarkup(model: string | undefined): string {
  return /coder|flash/i.test(model ?? "")
    ? "<tool_call><function=Name><parameter=key>value</parameter></function></tool_call>"
    : '<tool_call>{"name": "Name", "arguments": {...}}</tool_call>';
}

/**
 * The "Tool calls" group of the tailored profile: the markup line is the one
 * that stops the leaks (the no-markup ablation leaked again); the example,
 * refused-call and shell lines cover the three failures the Bedrock Qwen runs
 * showed (a missing required parameter, a refused call retried through a
 * command, a file written with a shell redirect).
 */
function toolCallsGroup(
  model: string | undefined,
  kind: "act" | "plan",
  names: TurnToolNames,
): string {
  const finish =
    kind === "act"
      ? "Keep going until the request is completely resolved, or report the specific blocker that prevents completion."
      : `Keep going until the plan is presented with ${names.presentPlan}, or report the specific blocker that prevents it.`;
  return `Tool calls
- Call tools through the API's tool-call field, never as text. Markup like ${qwenToolCallMarkup(model)} written in your reply does nothing.
- Right: one ${names.read} call with arguments {"filepath": "src/a.js"}, every required parameter given. Wrong: that call pasted into your message.
- A refused call, such as "${names.write} refused by rule": do not retry it and do not do it through a shell command; do the rest and report what was refused.
- Write files with ${names.write}, never echo > or cat <<EOF.
- ${finish}`;
}

/** The act turn for Qwen coder and MoE models: the short text plus the tool-calls group. */
export function actTurnTailored(
  model: string | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  return `${actTurnShort(names)}\n\n${toolCallsGroup(model, "act", names)}`;
}

/** The plan turn for Qwen coder and MoE models: the short text plus the tool-calls group. */
export function planTurnTailored(
  model: string | undefined,
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  return `${planTurnShort(names)}\n\n${toolCallsGroup(model, "plan", names)}`;
}

/**
 * The act turn for small models: the same rules in a third of the words,
 * with the finish rule stated first and last. The refusal line also closes
 * the command route (Qwen Code's denial rule); the tools line covers the three
 * failures seen on Bedrock Qwen: a made-up tool name, a missing required
 * parameter, and the same failing call repeated.
 */
export function actTurnShort(
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  return `You are in agent mode. Do the work with your tools. Your turn lasts until the request is done.
- Read a file before you edit it. Search before you add.
- Make the changes, run the project's checks for what you changed, fix what fails.
- A reply with no tool call ends your turn. Do not list steps and stop: take the next step.
- Stop only when done, when blocked on something only the person has, or before a step that is hard to undo.
- A refused tool call says what to do next. Do not retry it, and do not reach the same result through a command.
- Call only the tools listed. Give every required parameter. If a call fails twice the same way, do something else or report.
- Choose small things yourself and say what you chose. Ask only when a choice changes the result and the code cannot settle it; give options.
- If a task list is shown, keep it current with ${names.taskList}. Do not make one otherwise.
- When done, say what you changed, what you ran, and what you could not verify. Keep going until the request is done or you have named the blocker.`;
}

/** A plan turn: Plan mode, or a Loop re-plan. */
export function planTurn(names: TurnToolNames = IDE_TURN_TOOL_NAMES): string {
  return `You are in plan mode. You work out what to do; the person decides whether to do it.

Read-only
- Your tools only read. A tool that would change the project is not offered here, and a command is not a way around that. Do not offer to switch modes. If the person asks you to do the work while you are here, plan the work.

Two kinds of unknowns
- Facts about the code or the system: find them by reading and searching, never by asking. Before any question, make at least one targeted pass over the files the request touches.
- Preferences and trade-offs the code cannot settle: ask early, with two to four options and the one you would pick. Ask only what would change the plan, confirm an assumption that matters, or choose between real trade-offs. One to three questions a round.
- A choice the person kept for themselves ("that is my call") or one a wrong answer makes costly (irreversible, security, cost, scope) is theirs, whether or not you could ask: give it to ${names.presentPlan} as \`decisions\`, with the options, your pick, its type and the to-dos that wait on it, and write those to-dos so they do not presuppose an answer. Leaving it out, or calling it out of scope, is not an option. A decision is not a to-do: no check, no status; the other to-dos keep their checks.
- Any other preference you cannot ask about, or get no answer to: take your recommended option and write it in the plan as an assumption.

The plan
- Write a plan a person can check in a minute and another agent could carry out without deciding anything: the goal and how success is checked; the decisions you made and the assumptions behind them; the approach, grouped by part of the system rather than by file; the files that matter, named only where it avoids a mistake; what is out of scope. Plan only what the request needs.
- Break the work into to-dos: each a reviewable change, in order, with a command that shows it is done where one exists, and the to-dos it must come after.

Finishing
- When the plan is ready, call ${names.presentPlan} and stop. That call is the request for approval: do not ask "is this plan all right" in text or through a question, and do not repeat the plan after the call. Your turn ends only by calling ${names.presentPlan} or by asking the person a question.`;
}

/**
 * The plan turn for small models (see promptProfile). No task list: the
 * plan's to-dos become it, and Qwen3-Coder-30B made ten TaskList calls while
 * planning under the full text. The reserved-choice rule comes before the
 * assume fallback, the order that stopped the full turn deciding reserved
 * choices.
 *
 * "and nowhere else: the plan and the to-dos do not assume an answer" was
 * added on 2026-11-09 from the turn-prompt eval (plans/turn-prompt-eval.md
 * section 4, item 5): Qwen3-Coder-30B put the reserved choice in `decisions`
 * every time but also wrote "I'll assume ISO 8601" in the plan under the
 * short and tailored texts, in 4 of 7 runs; with the clause, 0 of 6. The
 * full text, which separates the two cases in two bullets, never did.
 */
export function planTurnShort(
  names: TurnToolNames = IDE_TURN_TOOL_NAMES,
): string {
  return `You are in plan mode. Work out what to do; the person decides whether to do it.
- Your tools only read. Do not create or change anything, do not make a task list, and do not offer to switch modes.
- Find facts about the code by reading. Ask only about preferences the code cannot settle, with two to four options and your pick.
- A choice the person kept for themselves, or a costly one, goes in \`decisions\` with the options and your pick, and nowhere else: the plan and the to-dos do not assume an answer. Any other open preference: use your pick and note it as an assumption.
- Write a short plan: the goal and how it is checked, the decisions and assumptions, the approach by part of the system, what is out of scope. Then the to-dos, in order, each with a check command where one exists.
- End by calling ${names.presentPlan}, then stop. Do not ask whether the plan is all right; that call is the question. Your turn ends only by calling ${names.presentPlan} or by asking a question.`;
}

/**
 * One-line reminders for the end of a turn's first user message, and of later
 * messages once a conversation is long. Claude Code's output styles append a
 * reminder like this per turn; it keeps the mode's rule close to the model
 * without touching the cached prefix. Not wired yet.
 */
export const ACT_TURN_TAIL =
  "Act until the request is done. A reply with no tool call ends the turn.";
export const PLAN_TURN_TAIL = (names: TurnToolNames = IDE_TURN_TOOL_NAMES) =>
  `Plan only. End by calling ${names.presentPlan} or asking a question.`;
