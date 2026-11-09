import { useRef } from "react";
import { useAppSelector } from "../../redux/hooks";
import {
  LOOP_PHASE_LABEL,
  selectLoopPhase,
  type LoopPhase,
} from "../../redux/selectors/selectLoopPhase";
import { LOOP_COLORS } from "../mainInput/GradientBorder";

/** How far the mark is turned for each half: planning up, building flipped. */
const ANGLE: Partial<Record<LoopPhase, number>> = {
  planning: 0,
  building: 180,
};

interface LoopPhaseMarkProps {
  className?: string;
  /** Show the phase beside the mark */
  label?: boolean;
}

/**
 * A yin and yang for Loop: one half is planning (cyan), the other building
 * (indigo), and the disc turns over to show which turn the loop is in. It
 * stays where it was when the loop rests, dimmed, so a glance still says what
 * it last did.
 */
export function LoopPhaseMark({ className, label }: LoopPhaseMarkProps) {
  const phase = useAppSelector(selectLoopPhase);
  // A rest keeps the angle of the turn before it
  const angle = useRef(0);
  if (ANGLE[phase] !== undefined) angle.current = ANGLE[phase]!;
  const resting = ANGLE[phase] === undefined;
  const text = LOOP_PHASE_LABEL[phase];

  return (
    <span
      data-testid="loop-phase"
      data-phase={phase}
      title={`Loop: ${text.toLowerCase()}`}
      className="inline-flex items-center gap-1"
    >
      <svg
        viewBox="0 0 32 32"
        role="img"
        aria-label={`Loop: ${text}`}
        className={className ?? "h-3.5 w-3.5"}
        style={{ opacity: resting ? 0.55 : 1 }}
      >
        <g
          data-testid="loop-phase-disc"
          style={{
            transform: `rotate(${angle.current}deg)`,
            transformOrigin: "16px 16px",
            transition: "transform 700ms cubic-bezier(0.65, 0, 0.35, 1)",
          }}
          className="motion-reduce:!transition-none"
        >
          {/* planning half, with the building dot in its bulb */}
          <circle cx="16" cy="16" r="15" fill={LOOP_COLORS.cyan} />
          {/* building half */}
          <path
            d="M16 1 A15 15 0 0 1 16 31 A7.5 7.5 0 0 1 16 16 A7.5 7.5 0 0 0 16 1 Z"
            fill={LOOP_COLORS.indigo}
          />
          <circle cx="16" cy="8.5" r="2.6" fill={LOOP_COLORS.indigo} />
          <circle cx="16" cy="23.5" r="2.6" fill={LOOP_COLORS.ice} />
        </g>
      </svg>
      {label && <span>{text}</span>}
    </span>
  );
}
