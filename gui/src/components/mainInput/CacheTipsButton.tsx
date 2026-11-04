import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { dismissCacheTip } from "../../redux/slices/uiSlice";
import { cacheTipKey, cacheTips } from "../../util/cacheTips";
import { Popover, PopoverButton, PopoverPanel } from "../ui";
import HoverItem from "./InputToolbar/HoverItem";

/**
 * A small warning icon in the toolbar that appears only when there is advice
 * about the model or cache settings in use, for example that a regional Bedrock
 * endpoint costs 10% more than a global one. Clicking it lists the tips, each
 * with what to change and a way to dismiss it. Dismissals are remembered per
 * model, so a tip the user has decided to live with does not come back.
 */
export function CacheTipsButton() {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectSelectedChatModel);
  const setting = useAppSelector((s) =>
    model ? s.ui.promptCacheSettings?.[model.title] : undefined,
  );
  const dismissed = useAppSelector((s) => s.ui.dismissedCacheTips);
  const ledger = useAppSelector((s) => s.session.promptCache?.ledger);
  const failures = useAppSelector((s) => s.session.promptCache?.failures);

  const tips = useMemo(
    () =>
      cacheTips(model, setting, ledger, failures).filter(
        (t) => !dismissed?.[cacheTipKey(model?.title ?? "", t.id)],
      ),
    [model, setting, dismissed, ledger, failures],
  );

  if (!model || tips.length === 0) return null;
  const hasWarning = tips.some((t) => t.severity === "warning");

  return (
    <Popover className="relative">
      <PopoverButton
        data-testid="cache-tips-button"
        aria-label={`${tips.length} tip${tips.length === 1 ? "" : "s"} about this model`}
        title={tips[0].title}
        className="m-0 flex flex-none cursor-pointer items-center border-none bg-transparent p-0"
      >
        <HoverItem as="span" className="flex items-center">
          <ExclamationTriangleIcon
            className={`h-3 w-3 ${hasWarning ? "text-warning" : "text-description"}`}
          />
        </HoverItem>
      </PopoverButton>
      <PopoverPanel
        anchor="top start"
        data-testid="cache-tips-panel"
        className="z-[200000] max-w-80 rounded border border-solid border-border bg-vsc-input-background p-2 text-xs text-foreground shadow-md"
      >
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {tips.map((tip) => (
            <li key={tip.id} data-testid={`cache-tip-${tip.id}`}>
              <div className="font-semibold">{tip.title}</div>
              <div className="mt-0.5 text-description">{tip.body}</div>
              {tip.suggestion && (
                <code
                  data-testid={`cache-tip-${tip.id}-suggestion`}
                  className="mt-1 block select-all break-all rounded bg-transparent px-1 py-0.5 text-[11px]"
                >
                  {tip.suggestion}
                </code>
              )}
              <button
                type="button"
                data-testid={`cache-tip-${tip.id}-dismiss`}
                onClick={() =>
                  dispatch(
                    dismissCacheTip({ key: cacheTipKey(model.title, tip.id) }),
                  )
                }
                className="mt-1 cursor-pointer border-none bg-transparent p-0 text-xs text-description-muted hover:text-foreground"
              >
                Don't show again for this model
              </button>
            </li>
          ))}
        </ul>
      </PopoverPanel>
    </Popover>
  );
}
