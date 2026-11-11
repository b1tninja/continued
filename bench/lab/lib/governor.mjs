// The cost and quota governor (MR9, first slice): every runner asks it before a
// request and tells it what the request cost. Pure bookkeeping: it makes no
// request, reads no GPU and touches no network, and the clock is injected.
//
// Three limits are required (spend in USD, request count, wall time) so there
// is no "unlimited" run. Dry run is the default: `admit` then records what
// would have been sent and answers `proceed: false`.

export class GovernorError extends Error {
  constructor(reasons) {
    super(`governor refused: ${reasons.join("; ")}`);
    this.name = "GovernorError";
    this.reasons = reasons;
  }
}

const limit = (name, v) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new RangeError(`${name} must be a finite number >= 0, got ${v}`);
  return v;
};

export class Governor {
  /**
   * @param {{maxSpendUsd:number, maxRequests:number, maxWallMs:number,
   *   dryRun?:boolean, now?:()=>number}} opts
   */
  constructor({
    maxSpendUsd,
    maxRequests,
    maxWallMs,
    dryRun = true,
    now = Date.now,
  } = {}) {
    this.maxSpendUsd = limit("maxSpendUsd", maxSpendUsd);
    this.maxRequests = limit("maxRequests", maxRequests);
    this.maxWallMs = limit("maxWallMs", maxWallMs);
    this.dryRun = dryRun !== false;
    this.now = now;
    this.started = now();
    this.requests = 0;
    this.spendUsd = 0;
    this.planned = 0;
    this.plannedUsd = 0;
  }

  /** Why the next request may not go out, or [] when it may. */
  reasons(estimateUsd = 0) {
    limit("estimateUsd", estimateUsd);
    const out = [];
    if (this.requests + 1 > this.maxRequests)
      out.push(`request limit of ${this.maxRequests} reached`);
    if (this.spendUsd + estimateUsd > this.maxSpendUsd)
      out.push(`spend limit of $${this.maxSpendUsd} would be exceeded`);
    if (this.now() - this.started >= this.maxWallMs)
      out.push(`wall-time limit of ${this.maxWallMs} ms reached`);
    return out;
  }

  /**
   * Ask to send one request. Throws GovernorError over a limit. Otherwise
   * returns {proceed}: false in a dry run (the request is only planned).
   */
  admit({ estimateUsd = 0 } = {}) {
    const why = this.reasons(estimateUsd);
    if (why.length) throw new GovernorError(why);
    if (this.dryRun) {
      this.planned += 1;
      this.plannedUsd += estimateUsd;
      return { proceed: false };
    }
    this.requests += 1;
    this.spendUsd += estimateUsd;
    return { proceed: true };
  }

  /** Replace the estimate of an admitted request by what it actually cost. */
  settle({ estimateUsd = 0, actualUsd = estimateUsd } = {}) {
    this.spendUsd +=
      limit("actualUsd", actualUsd) - limit("estimateUsd", estimateUsd);
  }

  /** Run `send` only when admitted; its result, or undefined in a dry run. */
  async guard(send, { estimateUsd = 0 } = {}) {
    const { proceed } = this.admit({ estimateUsd });
    if (!proceed) return undefined;
    const res = await send();
    if (typeof res?.costUsd === "number")
      this.settle({ estimateUsd, actualUsd: res.costUsd });
    return res;
  }

  snapshot() {
    return {
      dryRun: this.dryRun,
      requests: this.requests,
      spendUsd: this.spendUsd,
      wallMs: this.now() - this.started,
      planned: this.planned,
      plannedUsd: this.plannedUsd,
      limits: {
        maxSpendUsd: this.maxSpendUsd,
        maxRequests: this.maxRequests,
        maxWallMs: this.maxWallMs,
      },
    };
  }
}
