/**
 * Answers the system gives when nobody is available to: a loop whose
 * Questions area is permissive (Automatic, Permissive or IDGAF) never waits
 * for the person, so a question the agent asks is answered from what it
 * offered. One rule for the IDE extension, the CLI and `continuous serve`.
 */

/** Said to the agent when a question has no option to pick. */
export const NO_ONE_AVAILABLE =
  "No one is available to answer; use your best judgment and state the assumption";

const RECOMMENDED = /\s*\(\s*recommended\s*\)\s*/i;

export interface AutoAnswer {
  text: string;
  /** Which rule chose it: the labelled option, the first, or neither */
  basis: "recommended" | "first" | "none";
}

/**
 * The option labelled "(recommended)" when one is, otherwise the first, and
 * otherwise the best-judgment line. The label itself is not part of the
 * answer.
 */
export function autoAnswerFor(
  options: readonly string[] | undefined,
  pick?: string,
): AutoAnswer {
  const usable = (options ?? []).map((o) => o.trim()).filter(Boolean);
  const labelled = usable.find((o) => RECOMMENDED.test(o));
  const picked = pick?.trim() || undefined;
  const chosen = labelled ?? picked ?? usable[0];
  if (!chosen) return { text: NO_ONE_AVAILABLE, basis: "none" };
  const text = chosen.replace(RECOMMENDED, " ").trim() || chosen;
  return {
    text,
    basis: labelled || picked ? "recommended" : "first",
  };
}

/** The compact line for a closed question: "Auto-answered: <question> -> <answer>". */
export function autoAnsweredLine(question: string, answer: string): string {
  const clip = (t: string, n: number) =>
    t.length > n ? `${t.slice(0, n - 1)}…` : t;
  return `Auto-answered: ${clip(question.replace(/\s+/g, " "), 100)} -> ${clip(answer, 100)}`;
}
