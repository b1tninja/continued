import { vscForeground } from "..";
import { LOOP_DOT_COLOR, LOOP_GRADIENT_STOPS } from "./loopGradient";
import { LOOP_PATH } from "./LoopIcon";

interface ContinuedLogoProps {
  /** Height in pixels; the width follows (mark plus wordmark). */
  height?: number;
}

/**
 * The Continuous mark (brand-src/mark.svg: an endless loop in the brand
 * gradient with a dot travelling along it) with the "Continuous" wordmark in the editor's foreground colour.
 */
export default function ContinuedLogo({ height = 75 }: ContinuedLogoProps) {
  return (
    <svg
      height={height}
      viewBox="0 0 1700 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Continuous"
    >
      <defs>
        <linearGradient id="continuous-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#312E81" />
          <stop offset="1" stopColor="#1E1B4B" />
        </linearGradient>
        <linearGradient
          id="continuous-loop"
          gradientUnits="userSpaceOnUse"
          x1="100"
          y1="0"
          x2="412"
          y2="0"
        >
          {LOOP_GRADIENT_STOPS.map((stop, i) => (
            <stop
              key={stop}
              offset={i / (LOOP_GRADIENT_STOPS.length - 1)}
              stopColor={stop}
            />
          ))}
        </linearGradient>
      </defs>
      <rect
        x="24"
        y="24"
        width="464"
        height="464"
        rx="108"
        fill="url(#continuous-bg)"
      />
      <path
        d={LOOP_PATH}
        fill="none"
        stroke="url(#continuous-loop)"
        strokeWidth="44"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="350.5" cy="193" r="32" fill={LOOP_DOT_COLOR} />
      <text
        x="560"
        y="330"
        fill={vscForeground}
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontSize="210"
        fontWeight="600"
      >
        Continuous
      </text>
    </svg>
  );
}
