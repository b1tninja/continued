/**
 * The toolbox: pre-canned problem-solving prompts a person picks from the
 * drawer in the chat input, then inserts, sends or keeps. Each card is a
 * method rewritten as a concrete move for a coding agent; the method's name
 * is shown to the person and kept out of the text sent to the model.
 *
 * Design: policy-areas-toolbox.md (the notes folder of the policy-areas
 * session). Not in this file: "Ask the reviewer" (needs the reviewer role),
 * "Ask on the side" (a tool-less side call), "For every item" and the
 * shuffle button; those come after this change.
 */

export type ToolboxGroupId =
  "understand" | "diagnose" | "decide" | "check" | "ask";

export interface ToolboxGroup {
  id: ToolboxGroupId;
  label: string;
  /** When a person reaches for this group. */
  use: string;
}

export const TOOLBOX_GROUPS: readonly ToolboxGroup[] = [
  {
    id: "understand",
    label: "Understand",
    use: "The problem is unclear, or the agent misread it.",
  },
  {
    id: "diagnose",
    label: "Diagnose",
    use: "Something fails and the cause is not known.",
  },
  {
    id: "decide",
    label: "Decide",
    use: "A choice between approaches, or the scope is drifting.",
  },
  {
    id: "check",
    label: "Check",
    use: "The agent says it is done.",
  },
  {
    id: "ask",
    label: "Ask the agent",
    use: "Questions to ask mid-run.",
  },
];

export interface ToolboxCard {
  id: string;
  group: ToolboxGroupId;
  title: string;
  /** The method the card is built on, for the person; empty when none. */
  method: string;
  /** One line on when to use it. */
  when: string;
  /** The text sent to the model. `{name}` placeholders are filled from facts. */
  prompt: string;
}

/** The facts the drawer can fill in from the session. */
export type ToolboxFacts = Partial<
  Record<
    | "request"
    | "item"
    | "lastCheck"
    | "lastError"
    | "changedFiles"
    | "assumptions",
    string
  >
>;

export const TOOLBOX_CARDS: readonly ToolboxCard[] = [
  // Understand
  {
    id: "restate-the-problem",
    group: "understand",
    title: "Restate the problem",
    method: "",
    when: "Before changing anything, when the request could mean two things.",
    prompt:
      "Before changing anything, restate the problem in two sentences: what happens, what should happen, and how you will know it is fixed. If the request could mean two things, say both and pick one. {request}",
  },
  {
    id: "users-view",
    group: "understand",
    title: "The user's view",
    method: "Design thinking",
    when: "The fix has to suit the person who hits the problem, not only the code.",
    prompt:
      "Describe the problem from the point of view of the person who hits it: what they were doing, what they saw, what they expected. Then name the smallest change that would make that moment right. Do not list implementation options yet.",
  },
  {
    id: "what-changed",
    group: "understand",
    title: "What changed",
    method: "Root cause analysis",
    when: "Something that worked no longer does.",
    prompt:
      "Something that worked no longer does. List what changed between then and now: commits, dependencies, config, environment, data. Check each against the failure before proposing a fix. {changedFiles}",
  },

  // Diagnose
  {
    id: "reproduce-first",
    group: "diagnose",
    title: "Reproduce first",
    method: "",
    when: "Before any fix, to be sure the failure is real and repeatable.",
    prompt:
      "Do not fix anything yet. Write the shortest command or test that reproduces the failure, run it, and paste the exact output. If you cannot reproduce it, say what you tried and stop. {lastCheck}",
  },
  {
    id: "why-chain",
    group: "diagnose",
    title: "Why chain",
    method: "5 Whys",
    when: "The failure has a cause behind it that is not yet tested.",
    prompt:
      "Start from this failure and ask why it happened. Answer with evidence from the code or the output, not a guess, then ask why again. Stop at the first cause you can test with one command, and run that command. Five steps at most. {lastError}",
  },
  {
    id: "cause-map",
    group: "diagnose",
    title: "Cause map",
    method: "Fishbone",
    when: "Several causes are plausible and none is ruled out yet.",
    prompt:
      "List the possible causes of this failure under these headings: our code, data, configuration, environment, timing, a dependency. One line each. Then cross out each one with the evidence that rules it out, and test the one that is left. {lastCheck}",
  },
  {
    id: "instrument-do-not-guess",
    group: "diagnose",
    title: "Instrument, do not guess",
    method: "",
    when: "The cause is hidden and reading the code does not show it.",
    prompt:
      "Write three to five hypotheses for why this fails, each one sentence. Add a small log line for each where it would be decided, labelled with the hypothesis. Run the reproduction, read the logs, and mark each hypothesis confirmed, rejected or inconclusive with the log line that shows it. Fix only a confirmed cause. Remove the logs after the fix is verified. {lastCheck}",
  },
  {
    id: "bisect",
    group: "diagnose",
    title: "Bisect",
    method: "",
    when: "It worked at some earlier point and the change is large.",
    prompt:
      "Find the last state that worked and the first that did not, by commit, by input, or by disabling half the change at a time. Report the boundary and what differs across it before you change anything.",
  },
  {
    id: "baseline-first",
    group: "diagnose",
    title: "Baseline first",
    method: "",
    when: "Before a change, so that any new failure can be pinned to it.",
    prompt:
      "Before you change anything, run the project's lint, build and tests once and record what already fails, so that any new failure is yours. {changedFiles}",
  },
  {
    id: "failing-test-first",
    group: "diagnose",
    title: "Failing test first",
    method: "",
    when: "A bug with a clear symptom that a test can capture.",
    prompt:
      "Write the smallest test that fails because of this bug and run it to see it fail. Then fix, and run it again. Report both outputs.",
  },
  {
    id: "diagnose-before-environment",
    group: "diagnose",
    title: "Diagnose before touching the environment",
    method: "",
    when: "An install, a version or a lock file is the suspect.",
    prompt:
      "Read the error output to the end and inspect the manifests and lock files before installing, removing or upgrading anything. Prefer a change to code or tests over a change to the environment, and say why if you must change the environment.",
  },
  {
    id: "cross-check",
    group: "diagnose",
    title: "Cross-check",
    method: "",
    when: "A result is surprising and acting on it would be costly.",
    prompt:
      "That result is surprising. Confirm it with a different tool or a different command before you act on it, and say whether the two agree.",
  },

  // Decide
  {
    id: "widen-then-narrow",
    group: "decide",
    title: "Widen then narrow",
    method: "Brainstorming",
    when: "There is more than one reasonable way and none is chosen.",
    prompt:
      "List five to eight ways to do this, one line each, without judging them. Then name the criterion that matters most here (least code, least risk, matches existing patterns, fastest to verify) and pick by it. Say which you rejected and why in one line each.",
  },
  {
    id: "trade-offs",
    group: "decide",
    title: "Trade-offs",
    method: "SWOT",
    when: "A design choice between the current approach and one alternative.",
    prompt:
      "For the current approach and for one alternative: what it does well, where it is weak, what it makes easier later, what could go wrong. Four short lines each. Then recommend one and say what would change your mind.",
  },
  {
    id: "argue-against-yourself",
    group: "decide",
    title: "Argue against yourself",
    method: "Six Thinking Hats (critical and risk)",
    when: "The approach looks right and has not been tested against its weak points.",
    prompt:
      "Make the strongest case that your current approach is wrong: what it misses, what breaks, who it affects. Then answer each point or change the approach. Do not defend; look for the hole.",
  },
  {
    id: "blast-radius",
    group: "decide",
    title: "Blast radius",
    method: "Systems thinking",
    when: "A change touches something other code reads or writes.",
    prompt:
      "Before this change, list everything that reads or writes what you are changing, in this repository and outside it. Name any loop where your change feeds back into its own inputs. Say what else must change with it, and what you will not touch. {changedFiles}",
  },

  // Check
  {
    id: "define-done",
    group: "check",
    title: "Define done first",
    method: "",
    when: "Before continuing, so that done means something specific.",
    prompt:
      "Before you continue, write what would convince a sceptical senior engineer that this works: the exact command or action and the output it must show. Then list what does not count as evidence here: compiling, the app starting, a related feature working. Work toward the first list.",
  },
  {
    id: "what-did-you-verify",
    group: "check",
    title: "What did you verify",
    method: "",
    when: "The agent says it is done.",
    prompt:
      "Say exactly what you ran, what it printed, and what it proves. Separate what you verified from what you believe. If a check did not run, say so instead of describing what it would show.",
  },
  {
    id: "small-loop",
    group: "check",
    title: "Small loop",
    method: "PDCA",
    when: "A change that is not yet known to work.",
    prompt:
      "Make the smallest change that could fix this. Run the check. Compare the output with before. Keep the change only if the check passed and nothing else broke; otherwise revert it and say what you learned. One change per loop. {lastCheck}",
  },

  // Ask the agent
  {
    id: "what-are-you-assuming",
    group: "ask",
    title: "What are you assuming",
    method: "",
    when: "Mid-run, to surface what has not been checked.",
    prompt: "What are you assuming that you have not checked? {assumptions}",
  },
  {
    id: "smallest-change",
    group: "ask",
    title: "The smallest change",
    method: "",
    when: "The request is large and a smaller version would do.",
    prompt: "What is the smallest change that would satisfy the request?",
  },
  {
    id: "what-would-you-not-do",
    group: "ask",
    title: "What would you not do",
    method: "",
    when: "To see the limits the agent is working within.",
    prompt: "What would you not do here, and why?",
  },
  {
    id: "where-stuck",
    group: "ask",
    title: "Where are you stuck",
    method: "",
    when: "The run has slowed down.",
    prompt:
      "Where exactly are you stuck, and what is the cheapest thing that would tell you more?",
  },
];

/**
 * A card's prompt with the session's facts filled in. A sentence whose fact is
 * missing is dropped with it, so the text sent never has an empty placeholder.
 */
export function fillToolboxCard(
  card: Pick<ToolboxCard, "prompt">,
  facts: ToolboxFacts = {},
): string {
  const sentences = card.prompt.split(/(?<=[.?!])\s+/);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const names = [...sentence.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const missing = names.some(
      (name) => !facts[name as keyof ToolboxFacts]?.trim(),
    );
    if (missing) continue;
    kept.push(
      sentence.replace(/\{(\w+)\}/g, (_, name: string) =>
        (facts[name as keyof ToolboxFacts] ?? "").trim(),
      ),
    );
  }
  return kept.join(" ").trim();
}

/** The cards of one group, in the order they are listed. */
export function toolboxCardsIn(group: ToolboxGroupId): ToolboxCard[] {
  return TOOLBOX_CARDS.filter((card) => card.group === group);
}
