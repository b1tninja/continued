import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentListIcon,
  EyeIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  QuestionMarkCircleIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVEL_DESCRIPTIONS,
  POLICY_LEVELS,
  POLICY_PRESETS,
  policyLevelLabel,
  type PolicyArea,
  type PolicyLevel,
} from "core/tools/permissions/policy";
import { useId, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  REVIEWABLE_AREAS,
  selectAutoApproval,
  selectEffectiveLevels,
  selectYoloAreas,
} from "../../redux/selectors/selectAutoApproval";
import {
  applyPolicyPreset,
  changePolicyLevel,
} from "../../redux/thunks/policySettings";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";
import { CHIP, LEVEL_GLYPHS, LEVEL_TONES } from "./levelStyle";
import { PresetSelect } from "./PresetSelect";

const AREA_ICONS: Record<PolicyArea, typeof EyeIcon> = {
  context: EyeIcon,
  tools: WrenchScrewdriverIcon,
  edits: PencilSquareIcon,
  plan: ClipboardDocumentListIcon,
  questions: QuestionMarkCircleIcon,
};

const AREA_HINTS: Record<PolicyArea, string> = {
  context: "Reading files and searching: what the agent looks at",
  tools: "Commands, MCP tools and the web: what the agent runs",
  edits: "Changing files: what the agent keeps",
  plan: "Loop: what happens to a plan or re-plan",
  questions: "Loop: who answers the agent's questions",
};

/** Why Automatic cannot be chosen for an area, or undefined when it can. */
function automaticUnavailable(
  area: PolicyArea,
  status: ReturnType<typeof selectAutoApproval>,
): string | undefined {
  if (!REVIEWABLE_AREAS.includes(area)) {
    return "A reviewer for this area is not built yet.";
  }
  if (!status.offered) {
    return "Turn on experimental auto approval and choose a reviewer model.";
  }
  if (!status.available) return status.unavailableReason ?? "No reviewer.";
  return undefined;
}

interface AreaLevelSelectProps {
  area: PolicyArea;
  /** icon: the toolbar's compact button. row: a labelled button for Settings. */
  variant: "icon" | "row";
}

/** One area's dropdown. The same control in the toolbar and in Settings. */
export function AreaLevelSelect({ area, variant }: AreaLevelSelectProps) {
  const dispatch = useAppDispatch();
  const saved = useAppSelector((s) => s.ui.policyLevels[area]);
  const effective = useAppSelector((s) => selectEffectiveLevels(s)[area]);
  const status = useAppSelector(selectAutoApproval);
  const Icon = AREA_ICONS[area];
  const label = `${POLICY_AREA_LABELS[area]}: ${policyLevelLabel(area, saved)}`;
  // A saved Automatic that cannot run is in force as Cautious, so say so
  const shown: PolicyLevel = saved === "automatic" ? effective : saved;
  const LevelGlyph = LEVEL_GLYPHS[shown];
  const tone = LEVEL_TONES[shown];

  return (
    <Listbox
      value={shown}
      onChange={(level: PolicyLevel) =>
        void dispatch(changePolicyLevel({ area, level }))
      }
    >
      <div
        className="relative"
        title={`${label}. ${POLICY_LEVEL_DESCRIPTIONS[area][shown]}`}
      >
        <ListboxButton
          // The toolbar chip keeps the plain id; the Settings row is suffixed
          data-testid={
            variant === "row"
              ? `policy-select-${area}-row`
              : `policy-select-${area}`
          }
          data-roving={variant === "icon" ? "" : undefined}
          aria-label={label}
          className={`${CHIP} ${tone.chip}`}
        >
          {variant === "row" ? (
            <>
              <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <LevelGlyph className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{policyLevelLabel(area, shown)}</span>
              <ChevronDownIcon
                className="h-2 w-2 shrink-0"
                aria-hidden="true"
              />
            </>
          ) : (
            <>
              <span className="relative flex">
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <LevelGlyph
                  className="absolute -right-1.5 -bottom-1 h-2.5 w-2.5 rounded-full bg-background p-px"
                  aria-hidden="true"
                />
              </span>
              <span className="sr-only" data-testid={`policy-level-${area}`}>
                {policyLevelLabel(area, shown)}
              </span>
            </>
          )}
        </ListboxButton>
        <ListboxOptions className="max-w-72 min-w-48">
          <div className="px-2 py-1 text-2xs text-description">
            <div className="font-semibold">{POLICY_AREA_LABELS[area]}</div>
            <div className="whitespace-normal">
              {AREA_HINTS[area]}. Fewer decisions reach you as you go down.
            </div>
          </div>
          {POLICY_LEVELS.map((level) => {
            const unavailable =
              level === "automatic"
                ? automaticUnavailable(area, status)
                : undefined;
            return (
              <ListboxOption
                key={level}
                value={level}
                disabled={!!unavailable}
                data-testid={`policy-option-${area}-${level}`}
                className="items-start gap-1"
              >
                {(() => {
                  const OptionGlyph = LEVEL_GLYPHS[level];
                  return (
                    <OptionGlyph
                      className={`mt-0.5 h-3 w-3 shrink-0 ${LEVEL_TONES[level].icon}`}
                      aria-hidden="true"
                    />
                  );
                })()}
                <div
                  className="flex flex-col"
                  title={`${policyLevelLabel(area, level)}: ${
                    unavailable ?? POLICY_LEVEL_DESCRIPTIONS[area][level]
                  }`}
                >
                  <span>{policyLevelLabel(area, level)}</span>
                  <span className="text-2xs whitespace-normal text-description">
                    {unavailable
                      ? `Not available. ${unavailable}`
                      : POLICY_LEVEL_DESCRIPTIONS[area][level]}
                  </span>
                </div>
                <CheckIcon
                  className={`ml-auto h-3 w-3 shrink-0 ${shown === level ? "" : "opacity-0"}`}
                />
              </ListboxOption>
            );
          })}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

/**
 * The session policy: a preset picker and one dropdown for each of the five
 * areas. The five areas sit inline from the lg breakpoint; below it they fold
 * behind a chevron next to the preset picker, so the row above the input keeps
 * to one line in a narrow side panel. The fold is local state and is not saved.
 */
export function PolicyControls() {
  const [expanded, setExpanded] = useState(false);
  const areasId = useId();
  return (
    <div
      className="flex flex-row flex-wrap items-center gap-1"
      data-testid="policy-controls"
    >
      <PresetSelect />
      <button
        type="button"
        data-testid="policy-areas-toggle"
        data-roving=""
        aria-label={expanded ? "Hide policy areas" : "Show policy areas"}
        aria-expanded={expanded}
        aria-controls={areasId}
        title="Set each area on its own"
        onClick={() => setExpanded((open) => !open)}
        className="hover:bg-list-item-hover flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-full border-none bg-transparent p-0 text-description lg:hidden"
      >
        <ChevronDownIcon
          className={`h-2.5 w-2.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      <div
        id={areasId}
        className={`${expanded ? "flex" : "hidden"} flex-row items-center gap-1 lg:flex`}
      >
        {POLICY_AREAS.map((area) => (
          <AreaLevelSelect key={area} area={area} variant="icon" />
        ))}
      </div>
    </div>
  );
}

/**
 * Shown above the input for as long as any area is at YOLO. It has no close
 * button on purpose: the way to remove it is to leave YOLO.
 */
export function YoloBanner() {
  const dispatch = useAppDispatch();
  const areas = useAppSelector(selectYoloAreas);
  if (areas.length === 0) return null;
  const names = areas
    .map((a) => `${POLICY_AREA_LABELS[a]} (${policyLevelLabel(a, "yolo")})`)
    .join(", ");
  return (
    <div
      role="alert"
      data-testid="yolo-banner"
      className="flex items-center gap-2 bg-error/15 px-2 py-0.5 text-2xs text-error"
    >
      <ExclamationTriangleIcon className="h-3 w-3 shrink-0" />
      <span className="flex-1">
        {names}: nothing asks. Never rules, Ask rules, protected paths and the
        built-in rule check are ignored for these.
      </span>
      <button
        type="button"
        className="cursor-pointer border-none bg-transparent text-2xs text-error underline"
        onClick={() =>
          void dispatch(applyPolicyPreset(POLICY_PRESETS.careful.levels))
        }
      >
        Back to Careful
      </button>
    </div>
  );
}
