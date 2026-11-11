/**
 * The Loop mark's colours. The stops are the gradient the CLI paints its loop
 * with (LOOP_GRADIENT in extensions/cli/src/asciiArt.ts, the `cn` art around the
 * prompt), plus the cyan of the dot that travels along it. The CLI cannot share
 * a module with the webview, so asciiArt.test.ts reads this file and fails if
 * the two drift apart. Change them together.
 */
export const LOOP_GRADIENT_STOPS = ["#6366F1", "#818CF8", "#A78BFA"] as const;

export const LOOP_DOT_COLOR = "#67E8F9";
