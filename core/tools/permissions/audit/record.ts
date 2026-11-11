import { isRecoveredCallId } from "@continuedev/openai-adapters";
import { clipMasked, hashMasked, maskForAudit, maskText } from "./mask";

/**
 * The audit record (plans/reviewer-audit.md, section 6): one JSON line per
 * event. A call writes a `decision` event before it runs and an `outcome` event
 * after, joined by `callId`, so no line is ever rewritten. A `turn` event marks
 * a model turn, so a turn with no calls is still visible to the work log.
 *
 * Everything here is data built from already-masked text. The builders mask;
 * nothing in a record is the raw call.
 */
export const AUDIT_VERSION = 1;

export const MAX_ARGS_CHARS = 2000;
export const MAX_REASON_CHARS = 300;
export const MAX_ERROR_SIGNATURE_CHARS = 200;

export type AuditPolicy = "allow" | "ask" | "deny";
/** Who decided; "person" is the answer to an earlier ask */
export type AuditBy = "rules" | "reviewer" | "person" | "system";

export interface AuditEnvelope {
  v: typeof AUDIT_VERSION;
  ev: "decision" | "outcome" | "turn" | "policy";
  /** UTC, ISO 8601 */
  ts: string;
  session: string;
  /** Position in the file, so a missing line shows even without a hash chain */
  seq: number;
  turn?: number;
}

export const AUDIT_AGENT_KINDS = ["main", "subagent", "loop-worker"] as const;
export const MAX_AGENT_FIELD_CHARS = 80;

/**
 * Which agent made a call (ROADMAP O and X): a name, an enum and ids, never a
 * prompt. Ids are the ones the agent map uses (`main-<session>`,
 * `sub-<toolCallId>`, `worker-<itemId>`), so a row joins to a node.
 */
export interface AuditAgent {
  id: string;
  kind: (typeof AUDIT_AGENT_KINDS)[number];
  /** The definition's name ("Explore") or "item 3"; clipped and masked */
  role?: string;
  /** The permission mode or loop, as a short word */
  mode?: string;
  /** The spawning agent's id; absent for the main agent */
  parentId?: string;
}

/** Copy the identity field by field: nothing else a caller attached survives. */
export function auditAgentOf(
  agent: AuditAgent | undefined,
): AuditAgent | undefined {
  if (!agent || typeof agent.id !== "string" || !agent.id) return undefined;
  const line = (v: unknown) =>
    typeof v === "string" && v
      ? clipMasked(maskText(v).text, MAX_AGENT_FIELD_CHARS)
      : undefined;
  return clean({
    id: line(agent.id) as string,
    kind: AUDIT_AGENT_KINDS.includes(agent.kind) ? agent.kind : "subagent",
    role: line(agent.role),
    mode: line(agent.mode),
    parentId: line(agent.parentId),
  });
}

/** What the command analysis found; every part is optional while it is wired up */
export interface AuditReading {
  shell?: string;
  understood?: boolean;
  verdict?: "reads" | "writes" | "unsure";
  effects?: string[];
  destinations?: { host: string; kind?: string }[];
  lint?: string[];
}

export interface AuditReviewer {
  model?: string;
  /** Hash of the reviewer's system prompt; the prompt itself is never stored */
  promptVersion?: string;
  category?: string;
  risk?: string;
  authorization?: string;
  /** The verdict was reused from an identical earlier review */
  cached?: boolean;
  latencyMs?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  unusable?: boolean;
}

export interface DecisionEvent extends AuditEnvelope {
  ev: "decision";
  callId: string;
  tool: string;
  argsMasked: string;
  /** SHA-256 of the masked, unclipped text */
  argsHash: string;
  argsLen: number;
  maskedKinds?: string[];
  displayValue?: string;
  reading?: AuditReading;
  policy: AuditPolicy;
  by: AuditBy;
  /** The `DecisionSource` that decided, when rules did */
  source?: string;
  /** The rule as written in config.yaml */
  rule?: string;
  area?: string;
  level?: string;
  mode?: string;
  /** Which agent made the call; absent in files written before it was added */
  agent?: AuditAgent;
  reason?: string;
  /** The `seq` of the ask this line answers */
  answers?: number;
  reviewer?: AuditReviewer;
  jail?: string;
  loopItem?: string;
  modelMain?: string;
  /**
   * The call was recovered from text the model wrote (tool-dialects), not sent
   * as a native tool call. It went through the same policy; a reviewer can
   * tell the two apart here.
   */
  recovered?: true;
}

export interface OutcomeEvent extends AuditEnvelope {
  ev: "outcome";
  callId: string;
  tool: string;
  ran: boolean;
  exit?: number;
  durMs?: number;
  outBytes?: number;
  /**
   * SHA-256 of the masked, trimmed output. The output is not stored; two runs
   * that printed the same thing have the same hash, which is all the stuck
   * signals ask of it.
   */
  outHash?: string;
  /** Normalised first error line, masked; what the stuck signals compare */
  errSig?: string;
  /** Files the call changed, with a hash of the content after (for edit-revert) */
  changed?: { path: string; hash: string }[];
  read?: string[];
  agent?: AuditAgent;
}

export interface TurnEvent extends AuditEnvelope {
  ev: "turn";
  /** Length of the assistant's text, not the text */
  textChars: number;
  calls: number;
}

/** Who changed a permission rule: the Permissions page, the CLI or the Always allow button. */
export type PolicyChangeSource =
  "permissions-page" | "cli" | "always-allow-button";

export type PolicyChangeOp = "add" | "update" | "remove" | "adopt" | "undo";

/**
 * A change to the person's own permission rules (plans/rule-editor.md, B22).
 * It records what changed and who asked, never the file: the rule is masked
 * like call arguments, and the before and after hashes (of the whole file's
 * text) let a reader see that two changes were or were not adjacent.
 */
export interface PolicyEvent extends AuditEnvelope {
  ev: "policy";
  source: PolicyChangeSource;
  op: PolicyChangeOp;
  /** The list the rule was in or went to: deny, ask or allow */
  decision: AuditPolicy;
  /** The rule, with arguments masked */
  rule: string;
  /** For an update, the list and text it became */
  newDecision?: AuditPolicy;
  newRule?: string;
  /** Adopt: where the rule came from (assistant, workspace) */
  from?: string;
  /** The change lets something run that did not before */
  loosens: boolean;
  /** How the change was confirmed, when it needed it */
  confirmed?: "typed" | "click";
  /** SHA-256 of the file's text before and after, or undefined when it did not exist */
  beforeHash?: string;
  afterHash?: string;
  maskedKinds?: string[];
}

export type AuditRecord =
  DecisionEvent | OutcomeEvent | TurnEvent | PolicyEvent;

/** A record as the builders produce it: the writer adds `v`, `ts` and `seq`. */
export type AuditDraft = DistributiveOmit<AuditRecord, "v" | "seq" | "ts"> & {
  ts?: string;
};
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

export interface DecisionInput {
  session: string;
  turn?: number;
  callId: string;
  tool: string;
  /** The raw command or arguments (JSON text for a structured call) */
  args: string;
  displayValue?: string;
  reading?: AuditReading;
  policy: AuditPolicy;
  by: AuditBy;
  source?: string;
  rule?: string;
  area?: string;
  level?: string;
  mode?: string;
  agent?: AuditAgent;
  reason?: string;
  answers?: number;
  reviewer?: AuditReviewer;
  jail?: string;
  loopItem?: string;
  modelMain?: string;
  /** Set for a recovered call; also derived from the call id */
  recovered?: boolean;
}

const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const maskLine = (s: string | undefined, max: number): string | undefined =>
  s === undefined ? undefined : clipMasked(maskText(s).text, max);

export function decisionDraft(input: DecisionInput): AuditDraft {
  const args = maskForAudit(input.args, MAX_ARGS_CHARS);
  const { args: _raw, recovered, ...rest } = input;
  return clean({
    ...rest,
    recovered: recovered || isRecoveredCallId(input.callId) ? true : undefined,
    ev: "decision" as const,
    argsMasked: args.masked,
    argsHash: args.hash,
    argsLen: args.length,
    ...(args.kinds.length ? { maskedKinds: args.kinds } : {}),
    displayValue: maskLine(input.displayValue, MAX_ARGS_CHARS),
    reason: maskLine(input.reason, MAX_REASON_CHARS),
    reviewer: input.reviewer ? clean({ ...input.reviewer }) : undefined,
    agent: auditAgentOf(input.agent),
  }) as AuditDraft;
}

export interface OutcomeInput {
  session: string;
  turn?: number;
  callId: string;
  tool: string;
  ran: boolean;
  exit?: number;
  durMs?: number;
  outBytes?: number;
  /** The call's output. It is hashed after masking and never stored. */
  output?: string;
  /** The first error line of the output. It is normalised and masked here. */
  error?: string;
  changed?: { path: string; hash: string }[];
  read?: string[];
  agent?: AuditAgent;
}

/** Digits, hex runs and paths-with-ids vary run to run; the signature should not. */
export function errorSignature(error: string): string {
  const first =
    error
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const normal = first
    .replace(/\b0x[0-9a-f]+\b/gi, "#")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ");
  return clipMasked(maskText(normal).text, MAX_ERROR_SIGNATURE_CHARS);
}

export function outcomeDraft(input: OutcomeInput): AuditDraft {
  const { error, output, ...rest } = input;
  return clean({
    ...rest,
    ev: "outcome" as const,
    outBytes:
      input.outBytes ??
      (output === undefined ? undefined : Buffer.byteLength(output, "utf8")),
    outHash:
      output === undefined
        ? undefined
        : hashMasked(maskText(output.trim()).text),
    errSig: error ? errorSignature(error) : undefined,
    agent: auditAgentOf(input.agent),
  }) as AuditDraft;
}

export function turnDraft(input: {
  session: string;
  turn?: number;
  textChars: number;
  calls: number;
}): AuditDraft {
  return clean({ ...input, ev: "turn" as const }) as AuditDraft;
}

export interface PolicyInput {
  session?: string;
  source: PolicyChangeSource;
  op: PolicyChangeOp;
  decision: AuditPolicy;
  rule: string;
  newDecision?: AuditPolicy;
  newRule?: string;
  from?: string;
  loosens: boolean;
  confirmed?: "typed" | "click";
  beforeHash?: string;
  afterHash?: string;
}

/** The session name policy changes are written under: one file a month, not one per window. */
export const POLICY_SESSION = "policy-changes";

export function policyDraft(input: PolicyInput): AuditDraft {
  const rule = maskText(input.rule);
  const newRule =
    input.newRule === undefined ? undefined : maskText(input.newRule);
  const kinds = [...new Set([...rule.kinds, ...(newRule?.kinds ?? [])])];
  const { session, ...rest } = input;
  return clean({
    ...rest,
    session: session ?? POLICY_SESSION,
    ev: "policy" as const,
    rule: clipMasked(rule.text, MAX_ARGS_CHARS),
    newRule: newRule ? clipMasked(newRule.text, MAX_ARGS_CHARS) : undefined,
    maskedKinds: kinds.length ? kinds : undefined,
  }) as AuditDraft;
}
