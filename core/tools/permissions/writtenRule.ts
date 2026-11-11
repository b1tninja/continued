import type { DecisionKey } from "./ruleWords";

/**
 * The one written form of a rule, shared by the Permissions page, the CLI and
 * `continuous audit suggest`: `continuous permissions add always '<rule>'`.
 * No imports beyond the vocabulary file, so the webview can use it.
 */

const WORD_TO_DECISION: Record<string, DecisionKey> = {
  never: "deny",
  deny: "deny",
  ask: "ask",
  always: "allow",
  allow: "allow",
};

const DECISION_TO_WORD: Record<DecisionKey, string> = {
  deny: "never",
  ask: "ask",
  allow: "always",
};

/** Quote for a POSIX shell, the way the CLI's suggestions do. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The command that makes this rule, as the CLI accepts it. */
export function writtenRuleCommand(
  decision: DecisionKey,
  rule: string,
): string {
  return `continuous permissions add ${DECISION_TO_WORD[decision]} ${quote(rule.trim())}`;
}

export type WrittenRule =
  | { ok: true; decision?: DecisionKey; rule: string }
  | { ok: false; error: string };

/** Take off one pair of matching quotes, undoing the shell quoting of `quote`. */
function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return t;
}

const COMMAND =
  /^(?:continuous|cn|cont)\s+permissions\s+add\s+(\S+)\s+([\s\S]+)$/i;
// `ALWAYS  rule`, `Never: rule`, as `continuous audit suggest` lists them
const LABELLED = /^(never|deny|ask|always|allow)\s*:?\s+(\S[\s\S]*)$/i;

/**
 * Read text a person pastes: the command from `continuous audit suggest`, a
 * "NEVER  rule" line, or a bare rule. The text is only read, never run. Flags
 * and anything after the rule are not accepted: a rule is one line.
 */
export function parseWrittenRule(input: string): WrittenRule {
  const text = (input ?? "").trim();
  if (!text) return { ok: false, error: "Paste a rule or a command first." };
  if (/[\r\n]/.test(text)) {
    return {
      ok: false,
      error: "A rule is one line. Paste one command or one rule.",
    };
  }
  const cmd = COMMAND.exec(text);
  if (cmd) {
    const decision = WORD_TO_DECISION[cmd[1].toLowerCase()];
    if (!decision) {
      return {
        ok: false,
        error: `"${cmd[1].slice(0, 20)}" is not Never, Ask or Always.`,
      };
    }
    const rule = unquote(cmd[2]);
    if (/^--?[a-z]/i.test(rule) || /'\s+--?[a-z]/i.test(cmd[2])) {
      return {
        ok: false,
        error:
          "Paste the rule without options. The page asks for confirmation itself.",
      };
    }
    if (!rule) return { ok: false, error: "The command has no rule in it." };
    return { ok: true, decision, rule };
  }
  const labelled = LABELLED.exec(text);
  if (labelled) {
    return {
      ok: true,
      decision: WORD_TO_DECISION[labelled[1].toLowerCase()],
      rule: unquote(labelled[2]),
    };
  }
  return { ok: true, rule: unquote(text) };
}
