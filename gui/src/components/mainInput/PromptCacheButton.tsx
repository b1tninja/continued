import { CircleStackIcon as CircleStackIconOutline } from "@heroicons/react/24/outline";
import { CircleStackIcon as CircleStackIconSolid } from "@heroicons/react/24/solid";
import { useCountdownNow } from "../../hooks/useCountdownNow";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { setPromptCacheSetting } from "../../redux/slices/uiSlice";
import {
  modelSupportsOneHourCache,
  modelSupportsPromptCacheControl,
  PROMPT_CACHE_SETTING_LABELS,
  promptCacheStatus,
  promptCacheTooltip,
  type PromptCacheSetting,
} from "../../util/promptCache";
import {
  COUNTDOWN_WARN_MS,
  formatCountdown,
  ringFraction,
} from "../../util/promptCacheCountdown";
import { ToolTip } from "../gui/Tooltip";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";
import HoverItem from "./InputToolbar/HoverItem";

const CHOICES: (PromptCacheSetting | "config")[] = [
  "auto",
  "5m",
  "1h",
  "off",
  "config",
];

const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A ring that drains as the cache entry ages; `fraction` 1 is full. Drawn at
 * the size of the other toolbar icons (12px).
 */
function CountdownRing({
  fraction,
  warn,
}: {
  fraction: number;
  warn: boolean;
}) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-3 w-3 flex-none -rotate-90 ${warn ? "text-warning" : "brightness-200"}`}
      data-testid="prompt-cache-ring"
      aria-hidden="true"
    >
      <circle
        cx="6"
        cy="6"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.5"
      />
      <circle
        cx="6"
        cy="6"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={`${RING_CIRCUMFERENCE * fraction} ${RING_CIRCUMFERENCE}`}
      />
    </svg>
  );
}

function tooltipText(
  status: ReturnType<typeof promptCacheStatus>,
  setting: PromptCacheSetting | undefined,
): string {
  return promptCacheTooltip(status, setting);
}

/**
 * Toolbar control for prompt caching, next to the reasoning light bulb. While
 * the cache is warm it shows a ring that drains toward expiry, with the time
 * left beside it when there is room. Otherwise it is the database icon, filled
 * when requests carry cache breakpoints and outlined when they do not. Shown
 * only for models whose provider honours it.
 */
export function PromptCacheButton() {
  const dispatch = useAppDispatch();
  const model = useAppSelector(selectSelectedChatModel);
  const setting = useAppSelector((s) =>
    model ? s.ui.promptCacheSettings?.[model.title] : undefined,
  );
  const sessionState = useAppSelector((s) => s.session.promptCache);
  const isStreaming = useAppSelector((s) => s.session.isStreaming);

  const state = sessionState ?? { escalated: false };
  // Asking at the moment of the last request always finds the entry alive (when
  // caching is on), which gives the expiry the countdown hook sleeps toward.
  const expiresAt =
    model && state.lastRequestAt !== undefined
      ? promptCacheStatus(model, setting, state, state.lastRequestAt).expiresAt
      : undefined;
  // While a response streams the entry is being read and refreshed, so a
  // countdown from the request's start would only mislead.
  const now = useCountdownNow(expiresAt, !isStreaming);

  if (!model || !modelSupportsPromptCacheControl(model)) return null;

  const status = promptCacheStatus(model, setting, state, now);
  const canOneHour = modelSupportsOneHourCache(model);
  const choices = CHOICES.filter((c) => canOneHour || c !== "1h");

  const showRing = status.on && status.warm;
  const msLeft = status.msLeft ?? 0;
  const fraction = isStreaming
    ? 1
    : ringFraction(msLeft, status.lifetimeMs ?? 0);
  const warn = !isStreaming && msLeft <= COUNTDOWN_WARN_MS;

  return (
    <Listbox
      value={setting ?? "config"}
      onChange={(choice: PromptCacheSetting | "config") =>
        dispatch(
          setPromptCacheSetting({
            modelTitle: model.title,
            setting: choice === "config" ? undefined : choice,
          }),
        )
      }
    >
      <div className="relative">
        <ToolTip place="top" content={tooltipText(status, setting)}>
          <ListboxButton
            data-testid="prompt-cache-button"
            aria-label="Prompt cache"
            className="m-0 flex-none border-none bg-transparent p-0 text-description hover:brightness-150"
          >
            <HoverItem as="span" className="flex items-center gap-1">
              {showRing ? (
                <>
                  <CountdownRing fraction={fraction} warn={warn} />
                  {!isStreaming && (
                    <span
                      data-testid="prompt-cache-countdown"
                      className={`hidden text-[10px] tabular-nums xs:inline ${warn ? "text-warning" : ""}`}
                    >
                      {formatCountdown(msLeft)}
                    </span>
                  )}
                </>
              ) : status.on ? (
                <CircleStackIconSolid className="h-3 w-3 opacity-60" />
              ) : (
                <CircleStackIconOutline className="h-3 w-3" />
              )}
            </HoverItem>
          </ListboxButton>
        </ToolTip>
        <ListboxOptions className="min-w-48 max-w-72">
          {choices.map((choice) => (
            <ListboxOption
              key={choice}
              value={choice}
              data-testid={`prompt-cache-option-${choice}`}
            >
              <div className="flex flex-col">
                <span>{PROMPT_CACHE_SETTING_LABELS[choice].label}</span>
                <span className="text-xs text-description-muted">
                  {PROMPT_CACHE_SETTING_LABELS[choice].detail}
                </span>
              </div>
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
