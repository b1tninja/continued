import { useId } from "react";
import { LOOP_DOT_COLOR, LOOP_GRADIENT_STOPS } from "./loopGradient";

/** The infinity, one closed stroke (brand-src/mark.svg). */
export const LOOP_PATH =
  "M256 256 C300 172 412 172 412 256 C412 340 300 340 256 256 C212 172 100 172 100 256 C100 340 212 340 256 256 Z";

/** Where the dot rests on each lobe, on the stroke and diagonally opposite. */
const DOT_AT = {
  left: { cx: 161.5, cy: 319 },
  right: { cx: 350.5, cy: 193 },
} as const;

const VIEW_BOX = "64 148 384 216";
const ASPECT = 384 / 216;

export type LoopIconSide = keyof typeof DOT_AT;

export interface LoopIconProps {
  /** Height in pixels; the width is about 1.8 times that. */
  size?: number;
  /** Tailwind sizing instead of `size` */
  className?: string;
  /**
   * Paint with the brand gradient and the cyan dot. Without it the icon is one
   * flat colour (currentColor, or `color`) and has no dot, so it follows the
   * editor's theme.
   */
  gradient?: boolean;
  color?: string;
  /** Which lobe the dot sits on. Right is the logo's. */
  dot?: LoopIconSide;
  title?: string;
  /** Test id of the svg (its dot adds "-dot"); a second mark on a page needs its own. */
  testId?: string;
}

/**
 * The Loop icon: the Continuous infinity. Every Loop mark in the app is this
 * component, so there is one drawing to change.
 */
export function LoopIcon({
  size = 16,
  className,
  gradient = true,
  color,
  dot = "right",
  title,
  testId = "loop-icon",
}: LoopIconProps) {
  // useId() contains colons, which are not safe in url(#...)
  const id = `loop-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const stroke = gradient ? `url(#${id})` : (color ?? "currentColor");
  // Small marks need a heavier line to stay open at the crossing
  const strokeWidth = size <= 16 ? 56 : size <= 24 ? 50 : 44;
  const last = LOOP_GRADIENT_STOPS.length - 1;
  return (
    <svg
      viewBox={VIEW_BOX}
      width={className ? undefined : Math.round(size * ASPECT)}
      height={className ? undefined : size}
      className={className}
      fill="none"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid={testId}
    >
      {gradient && (
        <defs>
          <linearGradient
            id={id}
            gradientUnits="userSpaceOnUse"
            x1="100"
            y1="0"
            x2="412"
            y2="0"
          >
            {LOOP_GRADIENT_STOPS.map((stop, i) => (
              <stop key={stop} offset={i / last} stopColor={stop} />
            ))}
          </linearGradient>
        </defs>
      )}
      <path
        d={LOOP_PATH}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {gradient && (
        <circle
          data-testid={`${testId}-dot`}
          data-side={dot}
          {...DOT_AT[dot]}
          r={strokeWidth * 0.6}
          fill={LOOP_DOT_COLOR}
        />
      )}
    </svg>
  );
}
