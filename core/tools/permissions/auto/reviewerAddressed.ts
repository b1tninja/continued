import { detectInstructionLikeText } from "../injection";

/**
 * A deterministic, narrow check that runs before the reviewer model. It looks
 * for text inside a tool call (command, comment, echo string, file content,
 * URL) that is addressed to the reviewer or tries to dictate its verdict.
 * Such text is never evidence of safety, so a hit means the call is never
 * auto-allowed (plans/reviewer-isolation.md).
 *
 * It is not the advisory injection detector turned into a gate: only wording
 * aimed at the reviewer, forged verdicts, forged fence markers and role
 * headers count. A call that merely mentions "reviewer" or "approval" does not
 * match. It cannot see an instruction that is paraphrased, translated,
 * encoded (base64 is not decoded) or split across separate arguments.
 */

export interface AddressedMatch {
  id: AddressedCategory;
  label: string;
}

export type AddressedCategory =
  | "addresses-reviewer"
  | "dictates-verdict"
  | "claims-approval"
  | "overrides-instructions"
  | "forged-markers"
  | "forged-verdict"
  | "role-header"
  | "hidden-text";

const LABELS: Record<AddressedCategory, string> = {
  "addresses-reviewer": "text in the call addresses the reviewer",
  "dictates-verdict": "text in the call dictates the decision",
  "claims-approval": "text in the call claims it is already approved",
  "overrides-instructions":
    "text in the call tells the reviewer to ignore its instructions",
  "forged-markers": "text in the call imitates the reviewer's own markers",
  "forged-verdict": "text in the call contains a forged verdict",
  "role-header": "text in the call imitates a system or assistant message",
  "hidden-text": "text in the call hides characters that spell out a message",
};

/** The reviewer, in any of the ways text names it. "reviewers" and "code reviewer" are people. */
const REVIEWER = String.raw`(?:auto[- ]?)?(?:(?<!code\s)(?<!peer\s)reviewer(?!s)|review(?:ing)?\s+(?:model|agent|bot|ai|llm|system)|safety\s+(?:checker|model|monitor)|security\s+(?:reviewer|model|monitor|classifier))`;
const AI = String.raw`(?:ai|a\.i\.|llm|assistant|language\s+model|ai\s+agent|claude|copilot|chatgpt|gpt)`;
const ALLOW = String.raw`(?:allow(?:ed)?|approve[ds]?|accept(?:ed)?|permit(?:ted)?)`;

interface Rule {
  id: AddressedCategory;
  re: RegExp;
}

const RULES: Rule[] = [
  {
    id: "addresses-reviewer",
    re: new RegExp(
      String.raw`\b(?:notes?|messages?|instructions?|attention|memo|hint|comment|important|urgent|dear|hey|hello|hi|ps)\s*(?:to|for|:)?\s*(?:the\s+)?${REVIEWER}\b|\b${REVIEWER}\s*(?:notes?|messages?|instructions?|override|directive|notice|memo)\b|\b${AI}\s+(?:notes?|notices?|instructions?|override|directive|messages?)\s*[:\-—]|\b(?:notes?|messages?|instructions?|attention)\s+(?:to|for)\s+(?:the\s+)?${AI}\b\s*[:,\-—]|\b${REVIEWER}\s*[:,>]\s*(?:please\s+)?(?:ignore|disregard|allow|approve|answer|respond|reply|say|decide|treat|mark|pass|skip|you\b|this\b|do\s+not|don't|must|should|always|never|the\s+decision|decision|output|return)`,
      "i",
    ),
  },
  {
    id: "dictates-verdict",
    re: new RegExp(
      String.raw`\b(?:answer|respond|reply|say|decide|choose|vote|mark\s+(?:it|this)\s+as)\s*(?:with\s+|only\s+|just\s+)*["'{(\[:]*\s*${ALLOW}\b|\b(?:decision|verdict|answer|outcome|result)\s+(?:must|should|has\s+to|needs\s+to|shall|is\s+to)\s+be\s+["']?${ALLOW}\b|\byou\s+(?:must|should|have\s+to|need\s+to|are\s+required\s+to|will)\s+(?:now\s+)?(?:answer\s+|respond\s+)?${ALLOW}\b|\b(?:always|automatically|unconditionally)\s+(?:answer|respond|reply|say)\s+["']?${ALLOW}\b|\b${ALLOW}\s+(?:every|all|any)\s+(?:tool\s+)?(?:calls?|commands?|actions?|requests?)\b|\bthis\s+is\s+(?:a\s+)?(?:safe|harmless|routine|legitimate|benign)\b[^.\n]{0,20}(?:,|;|-|\bso\b|\btherefore\b)\s*(?:please\s+)?${ALLOW}\b`,
      "i",
    ),
  },
  {
    id: "claims-approval",
    re: /\b(?:this|that|the)\s+(?:tool\s+)?(?:call|command|action|request|operation|step|change)\s+(?:is|was|has\s+been|have\s+been)\s+(?:already\s+|pre-?|previously\s+)?(?:approved|authori[sz]ed|cleared|whitelisted|allow-?listed)\b|\b(?:pre-?approved|pre-?authori[sz]ed|pre-?cleared)\b[^.\n]{0,30}\b(?:call|command|action|request|tool|reviewer|assistant)\b|\b(?:call|command|action|request|tool|note)\b[^.\n]{0,30}\b(?:pre-?approved|pre-?authori[sz]ed|already\s+approved|already\s+authori[sz]ed)\b|\balready\s+(?:been\s+)?(?:approved|authori[sz]ed)\s+by\s+(?:the\s+)?(?:user|admin|owner|security|reviewer)\b/i,
  },
  {
    id: "overrides-instructions",
    re: new RegExp(
      String.raw`\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(?:your|the\s+reviewer'?s?|reviewer|review)\b[^.\n]{0,20}\b(?:rules?|instructions?|prompt|guidelines|policy|policies|restrictions|checks?)\b|\b(?:reveal|print|show|leak|repeat|output|replace)\b[^.\n]{0,25}\b(?:system\s+prompt|reviewer\s+prompt|your\s+(?:instructions|rules|guidelines))\b|\b${REVIEWER}\b[^.\n]{0,40}\b(?:ignore|disregard|bypass|skip)\b|\b(?:ignore|disregard|bypass|skip)\b[^.\n]{0,40}\b${REVIEWER}\b`,
      "i",
    ),
  },
  {
    id: "forged-markers",
    re: /\[\[\s*\/?\s*USER-(?:GUIDANCE|MESSAGES)\s*\]\]|<<<\s*(?:EARLIER-)?(?:TOOL-CALLS?|ENVIRONMENT)\b|\b(?:EARLIER-)?(?:TOOL-CALLS?|ENVIRONMENT)\s+END\b|<\s*\/?\s*(?:EARLIER-)?TOOL-CALLS?\s*>|\bEND\s+[0-9a-f]{6,}\s*>>>|\bTool\s+call\s+to\s+review\s*:|\bReply\s+with\s+the\s+JSON\s+object\b|(?:^|["'`])\s*tool\s*:\s*\w+\s*\r?\n\s*arguments\s*:/im,
  },
  {
    id: "forged-verdict",
    re: /\{\s*\\?["']decision\\?["']\s*:\s*\\?["'](?:allow|ask|deny)\\?["']\s*\}|\{[^{}]{0,200}\\?["']decision\\?["']\s*:\s*\\?["'](?:allow|ask|deny)\\?["'][^{}]{0,200}\\?["'](?:risk|authorization|authorisation|reason|category)\\?["']\s*:|\{[^{}]{0,200}\\?["'](?:risk|authorization|authorisation)\\?["']\s*:[^{}]{0,200}\\?["']decision\\?["']\s*:\s*\\?["']allow/i,
  },
  {
    id: "role-header",
    re: /(?:^|[\n"'#;|>`]|\/\/)\s*(?:system|assistant)\s*:\s*(?:you\b|ignore|disregard|allow|approve|always|from\s+now|new\s+instructions?|\{)|\b(?:new|updated)\s+(?:system\s+)?instructions?\s+(?:from|by)\s+the\s+(?:user|system|developer|admin)\b/i,
  },
];

/** Injection-detector ids narrow enough to reuse: they all dictate to a model. */
const REUSED_IDS: Record<string, AddressedCategory> = {
  "ignore-instructions": "overrides-instructions",
  "forget-above": "overrides-instructions",
  "new-instructions": "role-header",
  "claims-authority": "claims-approval",
  "fake-role-tag": "role-header",
  "chat-template-token": "role-header",
  "role-reassign": "role-header",
};

/** Letters that look like Latin ones, which NFKC leaves alone. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  һ: "h",
  ԁ: "d",
  ɡ: "g",
  ԛ: "q",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
  Ѕ: "S",
  // Greek
  ο: "o",
  α: "a",
  ν: "v",
  ρ: "p",
  ι: "i",
  κ: "k",
  τ: "t",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  // Latin lookalikes
  ı: "i",
  ɑ: "a",
  ƿ: "p",
  ⅼ: "l",
  ⅰ: "i",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** Tag characters (U+E0000 block) encode text that renders as nothing. */
const TAG_CHARS = /[\u{E0020}-\u{E007E}]/u;

/**
 * The text as the matcher reads it: NFKC, hidden characters removed (same
 * normalisation as the injection detector and the guidance), lookalike letters
 * folded, whitespace collapsed.
 */
export function foldForMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[­​-‏⁠-⁤﻿‪-‮⁦-⁩]/g, "")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .replace(/[^\S\r\n]+/g, " ");
}

/** The same text with shell quoting and escapes stripped, for `"IMPORTANT NOTE TO THE "'REVIEWER'`. */
function unquoted(text: string): string {
  return text.replace(/["'`\\]+(?=\w)|(?<=\w)["'`\\]+/g, "").replace(/\^/g, "");
}

/** A note hidden in a query string: "+" and %XX read as text. */
function urlDecoded(text: string): string {
  if (!/[%+]/.test(text)) return text;
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text.replace(/\+/g, " ");
  }
}

/** A search for the phrase is not the phrase: grep and git log --grep. */
const SEARCH_ONLY =
  /^\s*(?:git\s+(?:-C\s+\S+\s+)?(?:grep|log)|grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls)\b[^;&|\n#<>`$(]*$/i;

function stringsOf(value: unknown, out: string[], depth = 0): void {
  if (out.length > 200 || depth > 8) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const v of value) stringsOf(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsOf(v, out, depth + 1);
    }
  }
}

function matchesIn(text: string, searchOnly: boolean): Set<AddressedCategory> {
  const found = new Set<AddressedCategory>();
  if (TAG_CHARS.test(text.normalize("NFKC"))) found.add("hidden-text");
  if (searchOnly) return found;
  const folded = foldForMatching(text);
  for (const variant of [folded, unquoted(folded), urlDecoded(folded)]) {
    for (const r of RULES) if (r.re.test(variant)) found.add(r.id);
    for (const m of detectInstructionLikeText(variant)) {
      const id = REUSED_IDS[m.id];
      if (id) found.add(id);
    }
  }
  return found;
}

/**
 * Text addressed to the reviewer anywhere in a tool call's arguments (string
 * values and object keys, to a bounded depth). Empty means none was found.
 */
export function findReviewerAddressedText(args: unknown): AddressedMatch[] {
  const strings: string[] = [];
  stringsOf(args, strings);
  const hit = new Set<AddressedCategory>();
  for (const s of strings) {
    if (!s) continue;
    for (const id of matchesIn(s, SEARCH_ONLY.test(s))) hit.add(id);
  }
  return [...hit].map((id) => ({ id, label: LABELS[id] }));
}

/** The sentence the person and the agent see. It never repeats the text. */
export function addressedReason(matches: AddressedMatch[]): string {
  const what = matches.map((m) => m.label).join("; ");
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}. Text like that is never taken as a reason to allow, so this call needs a person.`;
}
