import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { LightBulbIcon as LightBulbIconOutline } from "@heroicons/react/24/outline";
import { LightBulbIcon as LightBulbIconSolid } from "@heroicons/react/24/solid";
import { modelSupportsReasoning } from "core/llm/autodetect";
import { useWarmCacheNote } from "../../../hooks/useWarmCacheNote";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { selectSelectedChatModel } from "../../../redux/slices/configSlice";
import { setHasReasoningEnabled } from "../../../redux/slices/sessionSlice";
import { setReasoningSetting } from "../../../redux/slices/uiSlice";
import { ToolTip } from "../../gui/Tooltip";
import { Popover, PopoverButton, PopoverPanel } from "../../ui";
import { CacheTipsButton, useCacheTips } from "../CacheTipsButton";
import { PromptCacheButton } from "../PromptCacheButton";
import { UsageIndicator } from "../UsageIndicator";
import { HoverButton } from "./HoverItem";

/** The reasoning switch: on or off for the selected model. */
function ReasoningRow() {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectSelectedChatModel);
  const enabled = useAppSelector((s) => s.session.hasReasoningEnabled);
  // Changing the thinking settings rebuilds the message cache (measured live
  // on Bedrock)
  const warmCacheNote = useWarmCacheNote();
  if (!modelSupportsReasoning(model)) return null;
  const Icon = enabled ? LightBulbIconSolid : LightBulbIconOutline;
  const label = enabled ? "Disable model reasoning" : "Enable model reasoning";
  return (
    <ToolTip
      place="top"
      content={label + (warmCacheNote ? ` ${warmCacheNote}` : "")}
    >
      <HoverButton
        aria-label={label}
        aria-pressed={enabled}
        data-testid="reasoning-toggle"
        className="w-full justify-start gap-2 px-2 text-xs text-foreground"
        onClick={() => {
          dispatch(setHasReasoningEnabled(!enabled));
          if (model?.title) {
            dispatch(
              setReasoningSetting({
                modelTitle: model.title,
                enabled: !enabled,
              }),
            );
          }
        }}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span>Reasoning: {enabled ? "on" : "off"}</span>
      </HoverButton>
    </ToolTip>
  );
}

/**
 * One "..." button for the secondary controls of the input: the reasoning
 * switch, the prompt cache, tips about the model, and the usage readout. A dot
 * shows when a tip needs attention. Every control keeps its own test id.
 */
export function OverflowMenu() {
  const { tips, hasWarning } = useCacheTips();
  const attention = tips.length > 0 && hasWarning;
  return (
    <Popover className="relative">
      <PopoverButton
        as={HoverButton}
        aria-label={
          attention ? "More options (needs attention)" : "More options"
        }
        title="Reasoning, prompt cache, tips and usage"
        data-testid="input-overflow-button"
      >
        <span className="relative flex">
          <EllipsisHorizontalIcon className="h-4 w-4" aria-hidden="true" />
          {attention && (
            <span
              data-testid="input-overflow-dot"
              className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-warning"
            />
          )}
        </span>
      </PopoverButton>
      <PopoverPanel
        anchor="top end"
        data-testid="input-overflow-panel"
        className="z-[200000] flex w-max max-w-[90vw] min-w-48 flex-col gap-0.5 rounded border border-solid border-border bg-vsc-input-background py-1 text-xs text-foreground shadow-md"
      >
        <ReasoningRow />
        <PromptCacheButton inMenu />
        <CacheTipsButton inMenu />
        <div className="px-2 py-1 empty:hidden">
          <UsageIndicator />
        </div>
      </PopoverPanel>
    </Popover>
  );
}
