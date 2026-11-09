import { useMemo, useState } from "react";
import {
  fillToolboxCard,
  TOOLBOX_GROUPS,
  toolboxCardsIn,
  type ToolboxCard,
} from "core/util/toolboxCards";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { useMainEditor } from "../TipTapEditor";
import {
  insertToolboxText,
  sendToolboxText,
  toolboxFactsFromState,
} from "./toolboxActions";

/**
 * The toolbox drawer: problem-solving prompts grouped by what the person is
 * trying to do. Each card is inserted into the input for editing or sent as the
 * next message. Its text is shown filled in from the session before either,
 * so the person sees exactly what will be sent.
 *
 * Test ids: toolbox-toggle, toolbox-drawer, toolbox-group-<group>,
 * toolbox-card-<id> (with -method, -expand, -prompt, -insert, -send).
 */
export function Toolbox() {
  const dispatch = useAppDispatch();
  const { mainEditor } = useMainEditor();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>();

  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const history = useAppSelector((state) => state.session.history);
  const loop = useAppSelector((state) => state.session.loop);
  const taskPlan = useAppSelector((state) => state.session.taskPlan);
  const facts = useMemo(
    () => toolboxFactsFromState({ history, loop, taskPlan }),
    [history, loop, taskPlan],
  );

  const textFor = (card: ToolboxCard) => fillToolboxCard(card, facts);

  return (
    <div className="px-1 pb-1">
      <button
        type="button"
        data-testid="toolbox-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-list-item-hover rounded-sm border-none bg-transparent px-1 py-0.5 text-xs text-description"
      >
        {open ? "Hide toolbox" : "Toolbox"}
      </button>

      {open && (
        <div
          data-testid="toolbox-drawer"
          className="mt-1 max-h-72 space-y-3 overflow-y-auto rounded-default border border-command-border p-2"
        >
          {TOOLBOX_GROUPS.map((group) => (
            <section key={group.id} data-testid={`toolbox-group-${group.id}`}>
              <h3 className="m-0 text-xs font-medium">{group.label}</h3>
              <p className="m-0 mb-1 text-xs text-description">{group.use}</p>
              <ul className="m-0 list-none space-y-1 p-0">
                {toolboxCardsIn(group.id).map((card) => (
                  <li
                    key={card.id}
                    data-testid={`toolbox-card-${card.id}`}
                    className="rounded-sm border border-command-border p-1.5"
                  >
                    <div className="text-xs font-medium">{card.title}</div>
                    {card.method && (
                      <div
                        data-testid={`toolbox-card-${card.id}-method`}
                        className="text-[10px] text-description-muted"
                      >
                        {card.method}
                      </div>
                    )}
                    <div className="text-xs text-description">{card.when}</div>

                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        data-testid={`toolbox-card-${card.id}-expand`}
                        aria-expanded={expanded === card.id}
                        onClick={() =>
                          setExpanded((current) =>
                            current === card.id ? undefined : card.id,
                          )
                        }
                        className="border-none bg-transparent p-0 text-xs underline"
                      >
                        {expanded === card.id ? "Hide prompt" : "Show prompt"}
                      </button>
                      <button
                        type="button"
                        data-testid={`toolbox-card-${card.id}-insert`}
                        onClick={() =>
                          insertToolboxText(mainEditor, textFor(card))
                        }
                        className="rounded-sm border border-command-border bg-transparent px-1.5 py-0.5 text-xs"
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        data-testid={`toolbox-card-${card.id}-send`}
                        disabled={isStreaming}
                        title={
                          isStreaming
                            ? "Wait for the reply to finish, or insert the card and edit it"
                            : undefined
                        }
                        onClick={() => sendToolboxText(dispatch, textFor(card))}
                        className="rounded-sm border border-command-border bg-transparent px-1.5 py-0.5 text-xs disabled:opacity-40"
                      >
                        Send
                      </button>
                    </div>

                    {expanded === card.id && (
                      <p
                        data-testid={`toolbox-card-${card.id}-prompt`}
                        className="mt-1 mb-0 text-xs whitespace-pre-wrap"
                      >
                        {textFor(card)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
