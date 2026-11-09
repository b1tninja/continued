import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { TaskItem, TaskPlan, TaskStatus } from "core";
import {
  buildTaskPlan,
  formatTaskProgress,
  TASK_PLAN_LIMITS,
} from "core/util/taskPlan";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setTaskPlan } from "../../redux/slices/sessionSlice";
import { saveCurrentSession } from "../../redux/thunks/session";

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

/**
 * Applies an edit made by the person. Their edit wins at once: the list is
 * stored as they left it and marked as edited by the user, and the next
 * request tells the model so (see formatTaskPlanBlock).
 */
export function applyUserEdit(
  plan: TaskPlan | undefined,
  items: Array<Partial<TaskItem> & { text: string }>,
): TaskPlan | undefined | string {
  // Keep the single-in-progress rule: the item just set wins.
  const result = buildTaskPlan(items, {
    previous: plan,
    reset: true,
    updatedBy: "user",
  });
  if (!result.ok) {
    return result.error;
  }
  return result.plan.items.length ? result.plan : undefined;
}

/** True for an item that is finished: it is a record, not something to edit. */
function isDone(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}

/** Moves the item `id` to position `to` (clamped), or returns the list as it is. */
export function moveItem<T extends { id: string }>(
  items: T[],
  id: string,
  to: number,
): T[] {
  const from = items.findIndex((i) => i.id === id);
  if (from < 0) {
    return items;
  }
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (target === from) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** A button that needs a second click, so one stray click removes nothing. */
function ConfirmButton(props: {
  label: string;
  confirmLabel: string;
  testId: string;
  ariaLabel: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={armed ? `Confirm: ${props.ariaLabel}` : props.ariaLabel}
      onClick={() => {
        if (armed) {
          setArmed(false);
          props.onConfirm();
        } else {
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
      className={`shrink-0 cursor-pointer rounded border border-solid bg-transparent px-1 text-[10px] ${
        armed
          ? "border-error text-error"
          : "border-border text-description-muted hover:text-foreground"
      }`}
    >
      {armed ? props.confirmLabel : props.label}
    </button>
  );
}

function TaskRow(props: {
  item: TaskItem;
  index: number;
  count: number;
  onStatus: (status: TaskStatus) => void;
  onText: (text: string) => void;
  onDelete: () => void;
  onMove: (id: string, to: number) => void;
}) {
  const { item } = props;
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [dragOver, setDragOver] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const done = isDone(item.status);
  const active = item.status === "in_progress";

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = active;
    }
  }, [active]);

  const commit = () => {
    if (draft !== undefined && draft.trim() && draft.trim() !== item.text) {
      props.onText(draft.trim());
    }
    setDraft(undefined);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(undefined);
    }
  };
  const smallButton =
    "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-1 text-[10px] text-description-muted hover:text-foreground";

  return (
    <li
      data-testid={`task-item-${item.id}`}
      data-status={item.status}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const id = e.dataTransfer.getData("text/plain");
        if (id) {
          props.onMove(id, props.index);
        }
      }}
      className={`flex min-w-0 items-start gap-1.5 border-0 border-t-2 border-solid py-0.5 ${
        dragOver ? "border-t-link" : "border-t-transparent"
      }`}
    >
      <button
        type="button"
        draggable
        data-testid={`task-grab-${item.id}`}
        title="Drag to reorder (or use the up and down arrow keys)"
        aria-label={`Move ${item.text}, position ${props.index + 1} of ${props.count}`}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", item.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            props.onMove(item.id, props.index - 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            props.onMove(item.id, props.index + 1);
          }
        }}
        className="text-description-muted hover:text-foreground shrink-0 cursor-grab border-none bg-transparent p-0 text-xs leading-none active:cursor-grabbing"
      >
        ⋮⋮
      </button>
      <input
        ref={checkboxRef}
        type="checkbox"
        data-testid={`task-status-${item.id}`}
        checked={item.status === "completed"}
        aria-label={`${STATUS_LABEL[item.status]}: ${item.text}`}
        title={`${STATUS_LABEL[item.status]}. ${
          item.status === "completed"
            ? "Uncheck to reopen."
            : "Check to finish."
        }`}
        onChange={() =>
          props.onStatus(item.status === "completed" ? "pending" : "completed")
        }
        className="mt-0.5 shrink-0 cursor-pointer"
      />
      {draft !== undefined ? (
        <input
          data-testid={`task-input-${item.id}`}
          autoFocus
          value={draft}
          maxLength={TASK_PLAN_LIMITS.maxTextLength}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          aria-label="Edit task"
          className="border-border bg-input text-foreground min-w-0 flex-1 rounded border border-solid px-1 text-xs"
        />
      ) : (
        <span
          data-testid={`task-text-${item.id}`}
          className={`min-w-0 flex-1 break-words text-xs ${
            done
              ? "text-description-muted line-through"
              : active
                ? "text-foreground font-medium"
                : "text-description"
          }`}
        >
          {active && item.activeForm ? item.activeForm : item.text}
          {item.note &&
            (item.status === "blocked" || item.status === "cancelled") && (
              <span className="text-description-muted"> ({item.note})</span>
            )}
          {item.model && (
            <span
              data-testid={`task-model-${item.id}`}
              title="The model a loop runs this item with"
              className="text-description-muted"
            >
              {" "}
              · {item.model}
            </span>
          )}
        </span>
      )}
      {draft === undefined && item.status === "pending" && (
        <button
          type="button"
          data-testid={`task-start-${item.id}`}
          title="Mark this the item in progress"
          onClick={() => props.onStatus("in_progress")}
          className={smallButton}
        >
          Start
        </button>
      )}
      {draft === undefined && !done && (
        <button
          type="button"
          data-testid={`task-edit-${item.id}`}
          aria-label={`Edit ${item.text}`}
          onClick={() => setDraft(item.text)}
          className={smallButton}
        >
          Edit
        </button>
      )}
      <ConfirmButton
        testId={`task-delete-${item.id}`}
        label="Delete"
        confirmLabel="Sure?"
        ariaLabel={`Delete ${item.text}`}
        onConfirm={props.onDelete}
      />
    </li>
  );
}

/**
 * The agent's task list above the input: a one-line progress summary
 * ("3/8 Running migrations") that expands to the editable list. The list
 * belongs to the session and is saved with it.
 */
export function TaskListPanel() {
  const dispatch = useAppDispatch();
  const plan = useAppSelector((s) => s.session.taskPlan);
  const planFile = useAppSelector((s) => s.session.planFile);
  const ideMessenger = useContext(IdeMessengerContext);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  if (!plan?.items.length) {
    return null;
  }

  const update = (items: Array<Partial<TaskItem> & { text: string }>) => {
    const next = applyUserEdit(plan, items);
    if (typeof next === "string") {
      setError(next);
      return;
    }
    setError(undefined);
    dispatch(setTaskPlan(next));
    void dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );
  };

  const setStatus = (id: string, status: TaskStatus) => {
    update(
      plan.items.map((i) =>
        i.id === id
          ? { ...i, status }
          : status === "in_progress" && i.status === "in_progress"
            ? { ...i, status: "pending" as const }
            : i,
      ),
    );
  };

  const move = (id: string, to: number) => {
    const next = moveItem(plan.items, id, to);
    if (next !== plan.items) {
      update(next);
    }
  };

  const progress = formatTaskProgress(plan);
  const ListIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      data-testid="task-list-panel"
      className="border-border mx-1 mb-1 min-w-0 rounded border border-solid px-2 py-1 text-xs"
    >
      <div className="flex min-w-0 items-start gap-1">
        <button
          type="button"
          data-testid="task-list-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="text-description hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-start gap-1 border-none bg-transparent p-0 text-left text-xs"
        >
          <ListIcon className="mt-0.5 h-3 w-3 shrink-0" />
          <span
            data-testid="task-list-progress"
            className="min-w-0 break-words"
          >
            {progress}
          </span>
        </button>
        {planFile && (
          <button
            type="button"
            data-testid="task-list-plan-file"
            title={`Open the plan file (${planFile.split("/").pop()})`}
            onClick={() => void ideMessenger.ide.openFile(planFile)}
            className="text-link shrink-0 cursor-pointer border-none bg-transparent p-0 text-xs hover:underline"
          >
            Plan
          </button>
        )}
        {expanded && (
          <ConfirmButton
            testId="task-list-clear"
            label="Clear"
            confirmLabel="Remove all?"
            ariaLabel="Remove the task list"
            onConfirm={() => update([])}
          />
        )}
      </div>
      {expanded && (
        <>
          <ul className="m-0 mt-1 max-h-48 list-none overflow-y-auto p-0">
            {plan.items.map((item, index) => (
              <TaskRow
                key={item.id}
                item={item}
                index={index}
                count={plan.items.length}
                onMove={move}
                onStatus={(status) => setStatus(item.id, status)}
                onText={(text) =>
                  update(
                    plan.items.map((i) =>
                      i.id === item.id ? { ...i, text } : i,
                    ),
                  )
                }
                onDelete={() =>
                  update(plan.items.filter((i) => i.id !== item.id))
                }
              />
            ))}
          </ul>
          {plan.items.length < TASK_PLAN_LIMITS.maxItems && (
            <input
              data-testid="task-list-add"
              value={adding}
              maxLength={TASK_PLAN_LIMITS.maxTextLength}
              placeholder="Add a task"
              aria-label="Add a task"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && adding.trim()) {
                  e.preventDefault();
                  update([...plan.items, { text: adding.trim() }]);
                  setAdding("");
                }
              }}
              className="border-border text-foreground placeholder:text-description-muted mt-1 w-full min-w-0 rounded border border-solid bg-transparent px-1 text-xs"
            />
          )}
          {error && (
            <div role="alert" className="text-error mt-1 break-words">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
