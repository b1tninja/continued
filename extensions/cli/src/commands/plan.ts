import type { Command } from "commander";

import { configureConsoleForHeadless } from "../init.js";
import {
  activatePlanBuild,
  deactivatePlanBuild,
  planBuildPrompt,
} from "../plans/planBuild.js";
import {
  listPlans,
  planStatusOf,
  resolvePlan,
  type PlanSummary,
} from "../plans/planStore.js";
import { addCommonOptions } from "../shared-options.js";
import { gracefulExit } from "../util/exit.js";
import { logger } from "../util/logger.js";

import { chat, type ChatOptions } from "./chat.js";

/**
 * `continuous plan list` and `continuous plan build <name|path>`: the plan
 * files Plan mode writes to `.continuous/plans` (plans/task-planning.md).
 */

export interface PlanIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const stdio: PlanIo = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

export function formatPlanRows(plans: PlanSummary[]): string[] {
  return plans.map(
    (p) =>
      `${p.status.padEnd(11)} ${`${p.done}/${p.total}`.padEnd(6)} ${formatTime(p.modifiedMs)}  ${p.path}  ${p.title}`,
  );
}

export function planListCommand(
  options: { json?: boolean },
  cwd = process.cwd(),
  io: PlanIo = stdio,
): number {
  const plans = listPlans(cwd);
  if (options.json) {
    io.out(
      JSON.stringify(
        plans.map(({ file: _file, ...rest }) => ({
          ...rest,
          modified: new Date(rest.modifiedMs).toISOString(),
        })),
      ),
    );
    return 0;
  }
  if (!plans.length) {
    io.out("No plans in .continuous/plans. Plan mode writes them.");
    return 0;
  }
  io.out("STATUS      DONE   MODIFIED          PATH  TITLE");
  for (const row of formatPlanRows(plans)) io.out(row);
  return 0;
}

/**
 * Checks a plan can be built and returns the prompt for the run, or the
 * reason it cannot be. A plan with a decision still waiting is a draft: a run
 * nobody can answer would guess, so it needs `force`.
 */
export function preparePlanBuild(
  name: string,
  options: { force?: boolean },
  cwd = process.cwd(),
): { ok: true; file: string; prompt: string } | { ok: false; error: string } {
  const found = resolvePlan(name, cwd);
  if (!found.ok) return found;
  const summary = listPlans(cwd).find((p) => p.file === found.file);
  const status =
    summary?.status ??
    planStatusOf({ title: "", body: "", items: [], decisions: [] });
  if (status === "done") {
    return { ok: false, error: `${name} is done: every to-do is completed.` };
  }
  if (status === "draft" && !options.force) {
    return {
      ok: false,
      error: `${name} is a draft (no to-dos, or a decision still waits for an answer). Finish it in Plan mode or the file, or pass --force.`,
    };
  }
  const prompt = planBuildPrompt(cwd, found.file);
  return { ok: true, file: found.file, prompt };
}

export interface PlanBuildOptions extends ChatOptions {
  force?: boolean;
  print?: boolean;
}

export async function planBuildCommand(
  name: string,
  options: PlanBuildOptions,
  cwd = process.cwd(),
  io: PlanIo = stdio,
): Promise<number> {
  const prepared = preparePlanBuild(name, options, cwd);
  if (!prepared.ok) {
    io.err(prepared.error);
    return 2;
  }
  const headless =
    Boolean(options.print) || !process.stdin.isTTY || !process.stdout.isTTY;
  configureConsoleForHeadless(headless);
  logger.configureHeadlessMode(headless);
  activatePlanBuild(prepared.file, cwd);
  try {
    const { print: _print, force: _force, ...rest } = options;
    await chat(prepared.prompt, { ...rest, headless });
  } finally {
    deactivatePlanBuild();
  }
  return 0;
}

/** Adds `continuous plan` with `list` and `build` to the program. */
export function registerPlanCommand(program: Command): void {
  const plan = program
    .command("plan")
    .description(
      "List and build the plan files Plan mode writes to .continuous/plans",
    );
  plan
    .command("list")
    .description(
      "List the workspace's plans: status, to-dos done/total, modified time, path",
    )
    .option("--json", "Machine-readable output")
    .action(async (options) => {
      await gracefulExit(planListCommand(options));
    });
  addCommonOptions(
    plan
      .command("build <name>")
      .description(
        "Run the agent on a plan (a name or a path inside .continuous/plans), from its first unchecked to-do; a to-do's check: is run by the harness",
      )
      .option("-p, --print", "Headless: run to the end without a TUI")
      .option("--force", "Build a draft plan with open decisions"),
  ).action(async (name: string, options) => {
    const code = await planBuildCommand(name, options);
    await gracefulExit(code);
  });
}
