import type { LoopState, TaskItem, TaskPlan } from "core/index.js";
import {
  answersToDeliver,
  loopItemPrompt,
  markDelivered,
  loopDecidesAlone,
  standingInstructions,
} from "core/util/loopMode.js";
import { reminderPathsDue, takeReminders } from "core/util/loopReminders.js";

import { stampFiles } from "./loopReminderFiles.js";
import { CLI_LOOP_TOOL_NAMES } from "./loopSession.js";

/**
 * What an item's run starts with, inline or as a worker of a wave: the
 * reminders due to it are taken, the person's answers for it are marked
 * delivered, and its prompt is built (core's loopItemPrompt). The caller
 * then starts the run (startItemRun or startParallelRun) and sends the
 * prompt. The request carries the plan block (loopPlanBlock), so the prompt
 * leaves the notes and standing instructions out.
 */
export function prepareItemRun(
  loop: LoopState,
  plan: TaskPlan,
  item: TaskItem,
  now: Date,
  options: {
    planFile?: string;
    /** The run is a worker in its own worktree (a parallel wave) */
    worker?: { worktree?: string; files?: string[] };
  } = {},
): { loop: LoopState; prompt: string } {
  const reminderTarget = { kind: "item", itemId: item.id } as const;
  const taken = takeReminders(
    loop,
    reminderTarget,
    stampFiles(reminderPathsDue(loop, reminderTarget)),
    now,
  );
  loop = taken.loop;
  const itemState = loop.items.find((i) => i.id === item.id);
  const answers = answersToDeliver(loop, item.id);
  const prompt = loopItemPrompt({
    item,
    planFile: options.planFile,
    answers,
    questions: loop.questions,
    redo: itemState?.status === "redo",
    again: itemState?.again,
    attempt: (itemState?.attempts ?? 0) + 1,
    notes: loop.notes,
    standing: standingInstructions(loop),
    freshContext: loop.freshContext !== false,
    // The request carries the plan block (loopPlanBlock)
    planBlock: true,
    unanswered: loop.questions.filter((q) =>
      itemState?.unanswered?.includes(q.id),
    ),
    toolNames: CLI_LOOP_TOOL_NAMES,
    lastCheck: itemState?.check,
    reminders: taken.reminders,
    returning: itemState?.setAside,
    decideAlone: loopDecidesAlone(loop),
    mergeFailed: itemState?.mergeFailed,
    worker: options.worker,
  });
  loop = markDelivered(
    loop,
    answers.map((a) => a.id),
  );
  return { loop, prompt };
}
