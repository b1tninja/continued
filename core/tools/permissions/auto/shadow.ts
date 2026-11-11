import type { ILLM } from "../../..";
import { costOf, type UserPrice } from "../../../util/costOf";
import { scrubDeep } from "../../../util/secretScan";
import { secretValuesFromEnv } from "../../../util/secretScan/envValues";
import { knownValueMatcher } from "../../../util/secretScan/knownValues";
import { maskText } from "../audit/mask";
import type { AuditAgent, AuditBy, AuditPolicy } from "../audit/record";
import type { ShadowSettings } from "../audit/shadowSettings";
import type { AuditTrail } from "../audit/trail";
import { assembleGuidance, type GuidanceInput } from "./guidance";
import { usageOf } from "./handler";
import {
  reviewerPromptVersion,
  type ReviewEnvironment,
  type ReviewHistory,
} from "./prompt";
import { reviewToolCall, type ReviewerReasoning } from "./review";
import { findReviewerAddressedText } from "./reviewerAddressed";

/**
 * Shadow mode (ROADMAP B16, plans/reviewer-audit.md): the reviewer is asked
 * about calls it was not asked about, and what it WOULD have decided is written
 * to the audit trail beside the real decision. Nothing here can change a
 * decision: `observe` returns nothing a caller could act on, is not awaited by
 * the tool path, never throws, and runs one review at a time.
 *
 * Off unless the person's own config turned it on with a dollar budget
 * (`readShadowSettings`). Calls the reviewer already decided are not repeated.
 */
export type ShadowReviewerClient = Pick<ILLM, "chat"> & {
  model?: string;
  providerName?: string;
};

export interface ShadowCall {
  session: string;
  callId: string;
  turn?: number;
  toolName: string;
  args: Record<string, unknown>;
  history: ReviewHistory;
  /** The decision that stood: the rules' verdict, or the person's answer */
  real: { policy: AuditPolicy; by: AuditBy };
  agent?: AuditAgent;
}

export interface ShadowDeps {
  trail: AuditTrail;
  settings: ShadowSettings | undefined;
  /** The reviewer model, when one is configured */
  reviewer: () => ShadowReviewerClient | null | undefined;
  environment: ReviewEnvironment;
  /** The person's own guidance, as the real reviewer is given it */
  guidance?: () => GuidanceInput | undefined;
  reasoning?: ReviewerReasoning;
  /** USD already spent in the retained trail, read once */
  spentSoFar: () => number;
  userPrices?: Record<string, UserPrice>;
  /** Secret values of this machine; defaults to the environment's */
  env?: Readonly<Record<string, string | undefined>>;
}

export type ShadowStatus =
  | "recorded"
  | "off"
  | "no-reviewer"
  | "skipped-reviewer-decided"
  | "skipped-addressed-text"
  | "skipped-guidance"
  | "busy"
  | "over-budget"
  | "unpriced"
  | "dropped";

/** Settled by the reviewer itself or by a state that is not a decision */
const NOT_SHADOWED: readonly AuditBy[] = ["reviewer", "system"];

/** Text sent to the shadow reviewer: the outbound secret profile, then the audit mask. */
export function scrubForShadow<T>(
  value: T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const known = knownValueMatcher(secretValuesFromEnv(env));
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return maskText(v).text;
    if (depth > 40 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(scrubDeep(value, "outbound", { known }), 0) as T;
}

export class ShadowReviewer {
  private spent: number | undefined;
  private inFlight = false;
  private stopped = false;

  constructor(private readonly deps: ShadowDeps) {}

  /**
   * Start a shadow review and return at once with the promise of its status.
   * Callers do not await it; tests do.
   */
  observe(call: ShadowCall): Promise<ShadowStatus> {
    return this.run(call).catch(() => "dropped" as const);
  }

  private async run(call: ShadowCall): Promise<ShadowStatus> {
    const { settings, trail } = this.deps;
    if (!settings || !trail.enabled || this.stopped) return "off";
    const reviewer = this.deps.reviewer();
    if (!reviewer) return "no-reviewer";
    if (NOT_SHADOWED.includes(call.real.by)) return "skipped-reviewer-decided";
    // Text addressed to the reviewer is an attack: not sent, not measured
    if (findReviewerAddressedText(call.args).length > 0) {
      return "skipped-addressed-text";
    }
    const assembled = assembleGuidance(this.deps.guidance?.());
    if (assembled.errors.length > 0) return "skipped-guidance";
    if (this.inFlight) return "busy";
    this.spent ??= this.deps.spentSoFar();
    if (this.spent >= settings.budgetUsd) return "over-budget";

    this.inFlight = true;
    try {
      return await this.review(call, settings, reviewer, assembled.guidance);
    } finally {
      this.inFlight = false;
    }
  }

  private async review(
    call: ShadowCall,
    settings: ShadowSettings,
    reviewer: ShadowReviewerClient,
    guidance: ReturnType<typeof assembleGuidance>["guidance"],
  ): Promise<ShadowStatus> {
    const { env } = this.deps;
    let usage: ReturnType<typeof usageOf>;
    const startedAt = Date.now();
    const measured: Pick<ILLM, "chat"> = {
      chat: async (...args: Parameters<ILLM["chat"]>) => {
        const reply = await reviewer.chat(...args);
        usage = usageOf((reply as { usage?: unknown } | undefined)?.usage);
        return reply;
      },
    };
    const result = await reviewToolCall(
      measured,
      {
        toolName: call.toolName,
        args: scrubForShadow(call.args, env),
        history: scrubForShadow(call.history, env),
        environment: this.deps.environment,
        guidance,
      },
      {
        timeoutMs: settings.timeoutMs,
        // Nobody is waiting: an unusable answer is dropped below, not refused
        headless: false,
        reasoning: this.deps.reasoning,
      },
    );
    // An error, a timeout or an unreadable reply is not what the reviewer
    // would have decided
    if (result.category === "reviewer-unavailable" || result.unusable) {
      return "dropped";
    }

    const cost = usage
      ? costOf(
          {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            cacheRead: usage.cacheRead ?? 0,
            cacheWrite: usage.cacheWrite ?? 0,
          },
          {
            provider: reviewer.providerName ?? "unknown",
            model: reviewer.model ?? "unknown",
          },
          {
            userPrice:
              this.deps.userPrices?.[
                `${reviewer.providerName}/${reviewer.model}`
              ],
          },
        ).amount
      : "unknown";
    this.spent = (this.spent ?? 0) + (cost === "unknown" ? 0 : cost);

    this.deps.trail.shadow({
      session: call.session,
      ...(call.turn === undefined ? {} : { turn: call.turn }),
      callId: call.callId,
      tool: call.toolName,
      real: call.real,
      shadow: {
        policy: result.decision,
        ...(result.category ? { category: result.category } : {}),
        reason: result.reason,
      },
      reviewer: {
        ...(reviewer.model ? { model: reviewer.model } : {}),
        promptVersion: reviewerPromptVersion(guidance),
        latencyMs: Date.now() - startedAt,
        ...(usage ? { usage } : {}),
      },
      ...(cost === "unknown" ? {} : { costUsd: cost }),
      ...(call.agent ? { agent: call.agent } : {}),
    });
    // A model with no price cannot be held to a budget: stop after this one
    if (cost === "unknown") {
      this.stopped = true;
      return "unpriced";
    }
    return "recorded";
  }
}
