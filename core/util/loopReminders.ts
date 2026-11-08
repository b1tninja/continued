import type {
  LoopReminder,
  LoopReminderFile,
  LoopReminderWhen,
  LoopState,
  TaskPlan,
} from "../index.js";

/**
 * Loop mode's reminders (remind_me): what a run learned, for one later run.
 * Each item starts in a fresh context, and finish_item's notes can only be
 * written when an item ends, so a reminder is saved at once and survives a
 * stopped or crashed run. Each is delivered once, in the opening prompt of
 * the run it is for, which leaves the prompt cache alone.
 *
 * These functions are pure. The harness reads the files: it stamps a
 * reminder's files when it is saved and again when it is delivered, and a
 * file that changed in between marks the reminder as written before the
 * change. Design: plans/loop-mode.md.
 */

export const LOOP_REMINDER_LIMITS = {
  maxLength: 2000,
  maxPerLoop: 20,
  maxPerItem: 5,
  maxFiles: 10,
  maxPathLength: 500,
} as const;

export const LOOP_REMINDER_WHEN: readonly LoopReminderWhen[] = [
  "item",
  "next_items",
  "retry",
  "replan",
];

/** The run a reminder can be delivered to. */
export type LoopReminderTarget =
  { kind: "item"; itemId: string } | { kind: "replan" };

/** A reminder as a prompt carries it. */
export interface LoopDeliveredReminder {
  reminder: LoopReminder;
  /** Its files that changed since it was saved */
  staleFiles: string[];
}

/** The stamp of a file that could not be read. */
const ABSENT_FILE_STAMP = "absent";

/**
 * A short stamp of a file's content, to compare later (FNV-1a and the
 * length; it detects a change and protects nothing). Undefined means the
 * file could not be read.
 */
export function reminderFileStamp(content: string | undefined): string {
  if (content === undefined) return ABSENT_FILE_STAMP;
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

/** The `files` argument of remind_me as paths; anything else is left out. */
export function reminderFilePaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const paths = files
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim())
    .filter((f) => f && f.length <= LOOP_REMINDER_LIMITS.maxPathLength);
  return [...new Set(paths)].slice(0, LOOP_REMINDER_LIMITS.maxFiles);
}

export type SaveReminderResult =
  | { ok: true; loop: LoopState; reminder: LoopReminder; duplicate: boolean }
  | { ok: false; error: string };

function itemIdOf(item: unknown): string | undefined {
  if (typeof item === "number") return String(item);
  if (typeof item !== "string") return undefined;
  return item.trim() || undefined;
}

/** Why a reminder for a given item cannot be delivered, if it cannot. */
function targetItemError(
  loop: LoopState,
  plan: TaskPlan | undefined,
  fromItemId: string,
  itemId: string | undefined,
): string | undefined {
  if (!itemId) {
    return 'Not saved: when "item" needs `item`, the number of the item in the plan.';
  }
  if (itemId === fromItemId) {
    return 'Not saved: this is the item you are running. Use when "retry" for a later run of it.';
  }
  if (plan && !plan.items.some((t) => t.id === itemId)) {
    return `Not saved: the plan has no item ${itemId}.`;
  }
  if (loop.items.find((i) => i.id === itemId)?.status === "done") {
    return `Not saved: item ${itemId} is already done, so it will not run. Use when "next_items" or "replan".`;
  }
  return undefined;
}

/** Saves a reminder from the running item, or says why it was refused. */
export function saveReminder(
  loop: LoopState,
  plan: TaskPlan | undefined,
  input: {
    fromItemId: string;
    note: unknown;
    when: unknown;
    item?: unknown;
    files?: LoopReminderFile[];
  },
  now: Date,
): SaveReminderResult {
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!note) return { ok: false, error: "Not saved: the note is empty." };
  const { maxLength, maxPerLoop, maxPerItem } = LOOP_REMINDER_LIMITS;
  if (note.length > maxLength) {
    return {
      ok: false,
      error: `Not saved: the note is ${note.length} characters, over the limit of ${maxLength}. Shorten it and save it again.`,
    };
  }
  const when = LOOP_REMINDER_WHEN.find((w) => w === input.when);
  if (!when) {
    return {
      ok: false,
      error: `Not saved: when must be one of ${LOOP_REMINDER_WHEN.join(", ")}.`,
    };
  }
  const itemId = when === "item" ? itemIdOf(input.item) : undefined;
  if (when === "item") {
    const error = targetItemError(loop, plan, input.fromItemId, itemId);
    if (error) return { ok: false, error };
  }

  const reminders = loop.reminders ?? [];
  const same = reminders.find(
    (r) =>
      !r.deliveredAt &&
      r.fromItemId === input.fromItemId &&
      r.note === note &&
      r.when === when &&
      r.itemId === itemId,
  );
  if (same) return { ok: true, loop, reminder: same, duplicate: true };

  if (reminders.length >= maxPerLoop) {
    return {
      ok: false,
      error: `Not saved: this loop already holds ${maxPerLoop} reminders, the most it keeps. Put what matters most in your report's notes instead.`,
    };
  }
  if (
    reminders.filter((r) => r.fromItemId === input.fromItemId).length >=
    maxPerItem
  ) {
    return {
      ok: false,
      error: `Not saved: this item has saved ${maxPerItem} reminders, the most one item may. Put what matters most in your report's notes instead.`,
    };
  }

  const reminder: LoopReminder = {
    id: `r${reminders.length + 1}`,
    note,
    when,
    fromItemId: input.fromItemId,
    savedAt: now.toISOString(),
    ...(itemId ? { itemId } : {}),
    ...(input.files?.length ? { files: input.files } : {}),
  };
  return {
    ok: true,
    loop: { ...loop, reminders: [...reminders, reminder] },
    reminder,
    duplicate: false,
  };
}

function isDue(reminder: LoopReminder, target: LoopReminderTarget): boolean {
  if (reminder.deliveredAt) return false;
  if (target.kind === "replan") return reminder.when === "replan";
  switch (reminder.when) {
    case "item":
      return reminder.itemId === target.itemId;
    case "next_items":
      return reminder.fromItemId !== target.itemId;
    case "retry":
      return reminder.fromItemId === target.itemId;
    default:
      return false;
  }
}

/** The files of the reminders due for this run, for the harness to stamp. */
export function reminderPathsDue(
  loop: LoopState,
  target: LoopReminderTarget,
): string[] {
  const paths = (loop.reminders ?? [])
    .filter((r) => isDue(r, target))
    .flatMap((r) => (r.files ?? []).map((f) => f.path));
  return [...new Set(paths)];
}

/**
 * The reminders for this run, marked delivered, so each reaches one run.
 * `stamps` has the current stamp of each path of reminderPathsDue.
 */
export function takeReminders(
  loop: LoopState,
  target: LoopReminderTarget,
  stamps: Record<string, string>,
  now: Date,
): { loop: LoopState; reminders: LoopDeliveredReminder[] } {
  const due = (loop.reminders ?? []).filter((r) => isDue(r, target));
  if (due.length === 0) return { loop, reminders: [] };
  const ids = new Set(due.map((r) => r.id));
  const deliveredAt = now.toISOString();
  return {
    loop: {
      ...loop,
      reminders: loop.reminders?.map((r) =>
        ids.has(r.id) ? { ...r, deliveredAt } : r,
      ),
    },
    reminders: due.map((reminder) => ({
      reminder,
      staleFiles: (reminder.files ?? [])
        .filter((f) => (stamps[f.path] ?? ABSENT_FILE_STAMP) !== f.stamp)
        .map((f) => f.path),
    })),
  };
}

/** Text of the tool result for remind_me. */
export function reminderSavedResult(
  reminder: LoopReminder,
  duplicate: boolean,
): string {
  if (duplicate) return `Already saved as ${reminder.id}.`;
  const target =
    reminder.when === "item"
      ? `item ${reminder.itemId}`
      : reminder.when === "next_items"
        ? "the next item that runs"
        : reminder.when === "retry"
          ? "a later run of this item"
          : "the next re-plan";
  return `Saved as ${reminder.id}, for ${target}.`;
}
