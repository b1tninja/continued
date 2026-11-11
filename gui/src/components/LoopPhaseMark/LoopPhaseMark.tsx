import { useRef } from "react";
import { useAppSelector } from "../../redux/hooks";
import {
  LOOP_PHASE_LABEL,
  selectLoopPhase,
  type LoopPhase,
} from "../../redux/selectors/selectLoopPhase";
import { LoopIcon, type LoopIconSide } from "../svg/LoopIcon";

const SIDE: Partial<Record<LoopPhase, LoopIconSide>> = {
  planning: "left",
  building: "right",
};

interface LoopPhaseMarkProps {
  className?: string;
  /** Show the phase beside the mark */
  label?: boolean;
  /** The primary placement (the loop panel) keeps the plain id; others suffix it. */
  testId?: string;
}

/**
 * Loop's mark: the Continuous infinity (LoopIcon) with its dot on the lobe of
 * the turn the loop is in, the left for planning and the right for building. At
 * rest the mark dims as a whole and the dot stays on the lobe it last used, so
 * a glance still says what the loop did last.
 */
export function LoopPhaseMark({
  className,
  label,
  testId = "loop-phase",
}: LoopPhaseMarkProps) {
  const phase = useAppSelector(selectLoopPhase);
  // A rest keeps the side of the turn before it
  const last = useRef<LoopIconSide | undefined>(undefined);
  if (SIDE[phase]) last.current = SIDE[phase];
  const resting = SIDE[phase] === undefined;
  const text = LOOP_PHASE_LABEL[phase];

  return (
    <span
      data-testid={testId}
      data-phase={phase}
      data-lit={last.current ?? "none"}
      title={`Loop: ${text.toLowerCase()}`}
      className="inline-flex items-center gap-1"
    >
      <span
        className="inline-flex motion-reduce:!transition-none"
        style={{
          opacity: resting ? 0.55 : 1,
          transition: "opacity 500ms ease",
        }}
      >
        <LoopIcon
          className={className ?? "h-3 w-[21px]"}
          dot={last.current}
          title={`Loop: ${text}`}
        />
      </span>
      {label && <span>{text}</span>}
    </span>
  );
}
