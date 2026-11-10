import { EVAL_CASES, EVAL_ENVIRONMENT } from "./cases";
import { parseReviewerReply } from "../parse";
import {
  buildReviewMessages,
  clip,
  fenced,
  MAX_ARGS_CHARS,
  MAX_TOOL_CALL_CHARS,
  MAX_TOOL_CALLS,
  MAX_USER_MESSAGE_CHARS,
  MAX_USER_MESSAGES,
  newNonce,
  REVIEWER_SYSTEM_PROMPT,
  show,
  trusted,
  type ReviewPromptInput,
} from "../prompt";

/**
 * The reviewer cache probe (plans/reviewer-audit.md, row U0b).
 *
 * It builds the reviewer's real request for three arms, sends the same
 * replayed session to a provider, and reads the provider's own cache usage
 * fields, so the cache read share and latency of each arm can be compared.
 * Nothing here runs on import or in CI: `runProbe` takes the fetch function,
 * so tests pass a stub, and the script that calls it refuses to start without
 * `--run`.
 *
 *  - A, today: `buildReviewMessages` as it ships, no cache markers.
 *  - B, system marker only: the same text with a marker after the system prompt.
 *  - C, proposed: system, then a session block, then the history block, then
 *    the call, with a marker after the session block and after the history
 *    block, a per-session nonce in the history, and step trimming so the
 *    history grows at its end between steps.
 */
export type ProbeArm = "A" | "B" | "C";
export type ProbeProvider = "anthropic" | "bedrock" | "openai";

/** One text block of the user message; `cache` puts a cache marker after it. */
export interface ProbeBlock {
  text: string;
  cache?: boolean;
}

export interface ProbeRequest {
  system: string;
  /** Marker after the system prompt */
  systemCache: boolean;
  blocks: ProbeBlock[];
}

/** Drop the oldest items in steps, so the start of the list moves rarely. */
export function trimInSteps<T>(items: T[], max: number, step: number): T[] {
  if (items.length <= max) return items;
  const start = Math.ceil((items.length - max) / step) * step;
  return items.slice(start);
}

function sessionLines(input: ReviewPromptInput): {
  env: string;
  guidance: string;
} {
  const { environment, settings } = input;
  const env = [
    environment.os && `Operating system: ${environment.os}`,
    environment.workspaceDirs?.length &&
      `Workspace folders: ${environment.workspaceDirs.join(", ")}`,
    environment.gitRemotes?.length &&
      `Git remotes (the repository's own): ${environment.gitRemotes.join(", ")}`,
    settings?.environment?.trustedDomains?.length &&
      `Trusted domains: ${settings.environment.trustedDomains.join(", ")}`,
    settings?.environment?.productionMarkers?.length &&
      `Production markers (names that mean production): ${settings.environment.productionMarkers.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const guidance = [
    settings?.guidance?.block?.length &&
      `Always deny or ask for:\n${settings.guidance.block.map((g) => `- ${g}`).join("\n")}`,
    settings?.guidance?.allow?.length &&
      `Fine to allow:\n${settings.guidance.allow.map((g) => `- ${g}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { env, guidance };
}

/**
 * Arm C's prompt. Same information and the same fences as
 * `buildReviewMessages`, in the order static, session, history, call.
 * `sessionNonce` fences the history; `callNonce` fences the call only.
 */
export function buildOrderedRequest(
  input: Omit<ReviewPromptInput, "nonce">,
  sessionNonce: string,
  callNonce: string,
  systemSalt = "",
): ProbeRequest {
  const full = { ...input, nonce: callNonce };
  const { env, guidance } = sessionLines(full);
  const users = trimInSteps(input.history.userMessages, MAX_USER_MESSAGES, 5)
    .map((m, i) => `${i + 1}. ${clip(m, MAX_USER_MESSAGE_CHARS)}`)
    .join("\n");
  const earlier = trimInSteps(input.history.toolCalls, MAX_TOOL_CALLS, 10)
    .map((c) => `${c.name} ${clip(show(c.args), MAX_TOOL_CALL_CHARS)}`)
    .join("\n");

  const session = [
    fenced("ENVIRONMENT", sessionNonce, env || "(unknown)"),
    ...(guidance ? [trusted("USER-GUIDANCE", guidance)] : []),
  ].join("\n\n");
  const history = [
    trusted("USER-MESSAGES", users || "(none)"),
    fenced("EARLIER-TOOL-CALLS", sessionNonce, earlier || "(none)"),
  ].join("\n\n");
  const call = [
    `Tool call to review:\n${fenced(
      "TOOL-CALL",
      callNonce,
      `tool: ${input.toolName}\narguments: ${clip(show(input.args), MAX_ARGS_CHARS)}`,
    )}`,
    "Reply with the JSON object only.",
  ].join("\n\n");

  return {
    system: REVIEWER_SYSTEM_PROMPT + systemSalt,
    systemCache: true,
    blocks: [
      { text: session, cache: true },
      { text: history, cache: true },
      { text: call },
    ],
  };
}

/** Arms A and B from the shipped builder. */
export function buildShippedRequest(
  input: Omit<ReviewPromptInput, "nonce">,
  nonce: string,
  markSystem: boolean,
  systemSalt = "",
): ProbeRequest {
  const [sys, user] = buildReviewMessages({ ...input, nonce });
  return {
    system: String(sys.content) + systemSalt,
    systemCache: markSystem,
    blocks: [{ text: String(user.content) }],
  };
}

// --- provider request bodies ---------------------------------------------

export interface ProbeTarget {
  provider: ProbeProvider;
  model: string;
  /** Override the host (a proxy, or a local server for provider "openai"). */
  baseUrl?: string;
  /** Bedrock region */
  region?: string;
  /** "1h" asks for the one-hour lifetime on Claude; absent means the default */
  ttl?: "1h";
  maxTokens?: number;
  promptCacheKey?: string;
}

export interface HttpCall {
  url: string;
  /** Header values may hold a credential: never print this object */
  headers: Record<string, string>;
  body: unknown;
}

const DEFAULT_MAX_TOKENS = 300;

/** Build the HTTP call for one request. `credential` goes only into a header. */
export function buildHttpCall(
  target: ProbeTarget,
  req: ProbeRequest,
  credential: string,
): HttpCall {
  const maxTokens = target.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (target.provider === "anthropic") {
    const cc = {
      type: "ephemeral",
      ...(target.ttl ? { ttl: target.ttl } : {}),
    };
    return {
      url: `${(target.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": credential,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: target.model,
        max_tokens: maxTokens,
        temperature: 0,
        system: [
          {
            type: "text",
            text: req.system,
            ...(req.systemCache ? { cache_control: cc } : {}),
          },
        ],
        messages: [
          {
            role: "user",
            content: req.blocks.map((b) => ({
              type: "text",
              text: b.text,
              ...(b.cache ? { cache_control: cc } : {}),
            })),
          },
        ],
      },
    };
  }
  if (target.provider === "bedrock") {
    const region = target.region ?? "us-east-1";
    const point = {
      cachePoint: {
        type: "default",
        ...(target.ttl ? { ttl: target.ttl } : {}),
      },
    };
    const base =
      target.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`;
    return {
      url: `${base.replace(/\/$/, "")}/model/${encodeURIComponent(target.model)}/converse`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: {
        system: [{ text: req.system }, ...(req.systemCache ? [point] : [])],
        messages: [
          {
            role: "user",
            content: req.blocks.flatMap((b) => [
              { text: b.text },
              ...(b.cache ? [point] : []),
            ]),
          },
        ],
        inferenceConfig: { maxTokens, temperature: 0 },
      },
    };
  }
  // OpenAI and compatible servers: caching is implicit, so no markers.
  return {
    url: `${(target.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: {
      model: target.model,
      temperature: 0,
      max_tokens: maxTokens,
      ...(target.promptCacheKey
        ? { prompt_cache_key: target.promptCacheKey }
        : {}),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.blocks.map((b) => b.text).join("\n\n") },
      ],
    },
  };
}

// --- reading the reply -----------------------------------------------------

export interface ProbeUsage {
  /** All input tokens: uncached plus read plus written */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** Read the text and the provider's cache fields from one response body. */
export function parseReply(
  provider: ProbeProvider,
  data: any,
): { text: string; usage: ProbeUsage } {
  if (provider === "anthropic") {
    const u = data?.usage ?? {};
    const read = num(u.cache_read_input_tokens);
    const write = num(u.cache_creation_input_tokens);
    const plain = num(u.input_tokens);
    return {
      text: (data?.content ?? [])
        .map((p: any) => (p?.type === "text" ? p.text : ""))
        .join(""),
      usage: {
        input: plain + read + write,
        cacheRead: read,
        cacheWrite: write,
        uncached: plain,
      },
    };
  }
  if (provider === "bedrock") {
    const u = data?.usage ?? {};
    const read = num(u.cacheReadInputTokens);
    const write = num(u.cacheWriteInputTokens);
    const plain = num(u.inputTokens);
    return {
      text: (data?.output?.message?.content ?? [])
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .join(""),
      usage: {
        input: plain + read + write,
        cacheRead: read,
        cacheWrite: write,
        uncached: plain,
      },
    };
  }
  const u = data?.usage ?? {};
  const details = u.prompt_tokens_details ?? u.input_tokens_details ?? {};
  const total = num(u.prompt_tokens ?? u.input_tokens);
  const read = num(details.cached_tokens);
  const write = num(details.cache_write_tokens);
  return {
    text: data?.choices?.[0]?.message?.content ?? "",
    usage: {
      input: total,
      cacheRead: read,
      cacheWrite: write,
      uncached: Math.max(0, total - read - write),
    },
  };
}

// --- the run -----------------------------------------------------------------

export interface ProbeRow {
  arm: ProbeArm;
  /** 1-based position in the replayed session */
  call: number;
  caseId: string;
  gapMs: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  usage: ProbeUsage;
  decision?: string;
  category?: string;
  /** Short error text with any credential removed */
  error?: string;
}

export interface ProbeOptions {
  target: ProbeTarget;
  credential: string;
  arms?: ProbeArm[];
  /** Number of reviews per arm (default 60) */
  calls?: number;
  /** Wait between reviews, for the dense and sporadic runs */
  gapMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Distinguishes this run's cache entries from any earlier run's */
  runId?: string;
  onRow?: (row: ProbeRow) => void;
}

/** Remove the credential (and anything long that looks like one) from text. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[credential]");
  }
  return out;
}

/**
 * The replayed session: review i sees the requests of the cases before it as
 * the person's messages and their calls as earlier calls, so the history
 * windows fill and then slide, like a long session.
 */
export function sessionInput(
  i: number,
  cases = EVAL_CASES,
): Omit<ReviewPromptInput, "nonce"> {
  const c = cases[i % cases.length];
  const before = Array.from({ length: i }, (_, k) => cases[k % cases.length]);
  const seen: string[] = [];
  for (const b of before)
    if (seen[seen.length - 1] !== b.request) seen.push(b.request);
  seen.push(c.request);
  return {
    toolName: c.tool,
    args: c.args,
    history: {
      userMessages: seen,
      toolCalls: before.map((b) => ({ name: b.tool, args: b.args })),
    },
    environment: {
      os: EVAL_ENVIRONMENT.os,
      workspaceDirs: [...EVAL_ENVIRONMENT.workspaceDirs],
      gitRemotes: [...EVAL_ENVIRONMENT.gitRemotes],
    },
    settings: { environment: EVAL_ENVIRONMENT.settings.environment },
  };
}

export function requestFor(
  arm: ProbeArm,
  input: Omit<ReviewPromptInput, "nonce">,
  sessionNonce: string,
  salt: string,
): ProbeRequest {
  if (arm === "C") {
    return buildOrderedRequest(input, sessionNonce, newNonce(), salt);
  }
  return buildShippedRequest(input, newNonce(), arm === "B", salt);
}

/** Send the replayed session once per arm and return one row per review. */
export async function runProbe(opts: ProbeOptions): Promise<ProbeRow[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const arms = opts.arms ?? ["A", "B", "C"];
  const calls = opts.calls ?? 60;
  const gap = opts.gapMs ?? 2000;
  const runId = opts.runId ?? newNonce();
  const rows: ProbeRow[] = [];

  for (const arm of arms) {
    // A different tail on the system prompt per run and arm keeps one arm from
    // reading another's cache entries and flattering it.
    const salt = `\n[probe ${runId} arm ${arm}]`;
    const sessionNonce = newNonce();
    for (let i = 0; i < calls; i++) {
      if (i > 0 && gap > 0) await sleep(gap);
      const input = sessionInput(i);
      const req = requestFor(arm, input, sessionNonce, salt);
      const call = buildHttpCall(
        arm === "C" && opts.target.provider === "openai"
          ? { ...opts.target, promptCacheKey: `probe-${runId}` }
          : opts.target,
        req,
        opts.credential,
      );
      const row: ProbeRow = {
        arm,
        call: i + 1,
        caseId: EVAL_CASES[i % EVAL_CASES.length].id,
        gapMs: i === 0 ? 0 : gap,
        ok: false,
        status: 0,
        latencyMs: 0,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, uncached: 0 },
      };
      const t0 = now();
      try {
        const res = await doFetch(call.url, {
          method: "POST",
          headers: call.headers,
          body: JSON.stringify(call.body),
        });
        row.latencyMs = now() - t0;
        row.status = res.status;
        if (!res.ok) {
          row.error = redact((await res.text()).slice(0, 200), [
            opts.credential,
          ]);
        } else {
          const parsed = parseReply(opts.target.provider, await res.json());
          row.usage = parsed.usage;
          const verdict = parseReviewerReply(parsed.text);
          row.ok = true;
          row.decision = verdict.decision;
          row.category = verdict.category;
        }
      } catch (e) {
        row.latencyMs = now() - t0;
        row.error = redact(e instanceof Error ? e.message : String(e), [
          opts.credential,
        ]);
      }
      rows.push(row);
      opts.onRow?.(row);
    }
  }
  return rows;
}

// --- reporting ---------------------------------------------------------------

export const CSV_HEADER =
  "arm,call,case,gap_ms,ok,status,latency_ms,input,cache_read,cache_write,uncached,decision,category,error";

export function toCsv(rows: ProbeRow[]): string {
  const esc = (s: string | undefined) =>
    s === undefined ? "" : `"${s.replace(/"/g, '""').replace(/\s+/g, " ")}"`;
  return [
    CSV_HEADER,
    ...rows.map((r) =>
      [
        r.arm,
        r.call,
        r.caseId,
        r.gapMs,
        r.ok ? 1 : 0,
        r.status,
        r.latencyMs,
        r.usage.input,
        r.usage.cacheRead,
        r.usage.cacheWrite,
        r.usage.uncached,
        r.decision ?? "",
        r.category ?? "",
        esc(r.error),
      ].join(","),
    ),
  ].join("\n");
}

export interface ArmSummary {
  arm: ProbeArm;
  reviews: number;
  failed: number;
  /** cache read tokens over all input tokens, first review of the arm excluded */
  readShare: number;
  p50Ms: number;
  p95Ms: number;
  /** same decision as arm A on the same review; undefined for A */
  agreementWithA?: number;
  /** reviews A answered "deny" or "ask" that this arm answered "allow" */
  loosened?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarizeProbe(rows: ProbeRow[]): ArmSummary[] {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const byA = new Map(
    rows.filter((r) => r.arm === "A" && r.ok).map((r) => [r.call, r.decision]),
  );
  return arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const good = mine.filter((r) => r.ok);
    const warm = good.filter((r) => r.call > 1);
    const input = warm.reduce((s, r) => s + r.usage.input, 0);
    const read = warm.reduce((s, r) => s + r.usage.cacheRead, 0);
    const lat = good.map((r) => r.latencyMs).sort((a, b) => a - b);
    const s: ArmSummary = {
      arm,
      reviews: mine.length,
      failed: mine.length - good.length,
      readShare: input > 0 ? read / input : 0,
      p50Ms: percentile(lat, 0.5),
      p95Ms: percentile(lat, 0.95),
    };
    if (arm !== "A") {
      const both = good.filter((r) => byA.has(r.call));
      s.agreementWithA = both.length
        ? both.filter((r) => r.decision === byA.get(r.call)).length /
          both.length
        : undefined;
      s.loosened = both.filter(
        (r) => r.decision === "allow" && byA.get(r.call) !== "allow",
      ).length;
    }
    return s;
  });
}

export function formatSummary(label: string, s: ArmSummary[]): string {
  const pct = (v: number | undefined) =>
    v === undefined ? "-" : `${(v * 100).toFixed(1)}%`;
  return [
    `Reviewer cache probe: ${label}`,
    "| arm | reviews | failed | cache read share | p50 ms | p95 ms | agrees with A | looser than A |",
    "|---|---|---|---|---|---|---|---|",
    ...s.map(
      (a) =>
        `| ${a.arm} | ${a.reviews} | ${a.failed} | ${pct(a.readShare)} | ${a.p50Ms} | ${a.p95Ms} | ${pct(a.agreementWithA)} | ${a.loosened ?? "-"} |`,
    ),
    "Read share leaves out each arm's first review (a cold write). A review the model answered differently from A is not an error; a review answered more loosely (allow where A did not) is the number to look at.",
  ].join("\n");
}
