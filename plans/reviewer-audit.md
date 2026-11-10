# Reviewer cache and isolation (Track U) and the audit trail (P12): design and measurement protocol

Status: plan with first slices built, 2026-11-10. Built: U0b (`core/scripts/reviewerCacheProbe.mjs`, `evaluation/cacheProbe.ts`; refuses to run without `--run`, never run by its author, tested with a stubbed provider) and P12a/P12b as pure code (`core/tools/permissions/audit/`: record types, masking, an append-only JSONL writer; not wired into the permission path). Not built: the fork control arm (D), U0c (the measurement), the hash chain, the reader and `continuous audit`, the IDE list, the work-log adapter. Companion to `reviewer-isolation.md` and `command-analysis.md`; the roadmap rows are updated separately.

Research date: 2026-11-10. Code read at `origin/main` of b1tninja/continuous after a fresh fetch (the local checkout is stale). Nothing was edited and no model was called.

## 1. Corrections to the plan, found in the code

1. **The nonce is not in every fence from the first user line.** `buildReviewMessages` (`core/tools/permissions/auto/prompt.ts`) opens the user message with `[[USER-MESSAGES]]`, which is a trusted block with no nonce. The nonce first appears in the `EARLIER-TOOL-CALLS` fence, second. So the first block is a stable prefix as long as the last 10 user messages do not change; what breaks the prefix is the nonce in block two and the sliding 30-call window. Plan finding 2 and the U0 result point 3 overstate this.
2. **The cache minimum has moved under the plan.** Anthropic now lists 512 tokens for Fable 5.x, Mythos 5.x, Opus 5 and 5.5, Sonnet 5.5 and Haiku 5.5; 1,024 for Sonnet 5, Sonnet 4.6, 4.5 and Opus 4.8; 2,048 for Opus 4.7; 4,096 for Opus 4.6, 4.5 and Haiku 4.5 (platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-11-10). AWS's table agrees except Opus 4.7, which AWS lists at 4,096 on Bedrock (docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, read 2026-11-10). If the system prompt really is about 700 tokens, it clears the 512 minimum on the whole 5.x Claude family. The plan's "below every minimum except the smallest" is true of the 4.x family only.
3. **The 2,813-character figure looks low.** The template literal alone plus the rendered category list is longer. Count the real prompt with the provider's token counter before trusting "about 700".
4. **The harness cannot read cache fields.** `evaluation/adapters.ts` (`anthropicMessages`, `openAiCompatible`) return only the text. The existing `eval:reviewer` gives verdict agreement and not cache read share. U0 needs a small probe (row U0b).
5. **Reviews go through `llm.chat`**, so cache points come from the reviewer model's own entry (`cacheBehavior`, `promptCaching`), via `bedrockCachePartsForModel` on Bedrock. The review passes none itself. A reviewer entry that does not set caching is uncached; there is no per-request override.

## 2. Provider mechanics, as of 2026-11

| Family                          | Mechanism                                                                                                        | Facts that decide the reviewer design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API                   | `cache_control` on blocks, or one top-level `cache_control` that moves forward                                   | Order tools, system, messages. Up to 4 breakpoints. Reads look back at most 20 blocks. 5 min (1.25x write) or 1 h (2x write); read 0.1x, and 0.05x on Opus 5.5 and Sonnet 5.5. A breakpoint on a block that changes every request never hits. Usage fields `cache_read_input_tokens`, `cache_creation_input_tokens`. Below the minimum the request succeeds uncached, with no error.                                                                                                                                                                                             |
| Bedrock Claude                  | `cachePoint` in `system`, `messages`, `tools`; `ttl: "1h"` only where listed                                     | Same minimums as above except Opus 4.7. The minimum counts the whole prefix up to the checkpoint. A cache entry lives on the serving host, so cross-region profiles can write again instead of reading. Top-level `cache_control` through `additionalModelRequestFields` works on the newer models; the `ttl` field on a 5-minute-only model can raise `ValidationException`. Usage `cacheReadInputTokens`, `cacheWriteInputTokens`, `inputTokens` (uncached only).                                                                                                              |
| Bedrock Nova                    | `cachePoint` in `system` and `messages`, never `tools`                                                           | 1K minimum, 5 minutes only, at most 20K tokens cached. Implicit reuse exists but is not reported or billed as a read, so a zero in usage can hide a latency gain.                                                                                                                                                                                                                                                                                                                                                                                                                |
| OpenAI (direct and Bedrock GPT) | Automatic; GPT-5.6 and later add `prompt_cache_options` (`implicit` or `explicit`) and `prompt_cache_breakpoint` | 1,024 visible tokens. `prompt_cache_key` steers routing and, on 5.6+, separates accounting per workspace; about 15 requests per minute per key before overflow routing can miss. Retention `30m` (default) or `12h` on 5.6+; earlier models `in_memory` or `24h`. Read 0.1x (0.05x on GPT-6.1 Sol and Terra); write 1.25x or 2.5x on 5.6+. `cached_tokens` and `cache_write_tokens`. On OpenAI direct, cached tokens still count toward tokens-per-minute; on Bedrock they do not (developers.openai.com/api/docs/guides/prompt-caching and the AWS page, both read 2026-11-10). |
| Gemini                          | Implicit by default on 2.5 and newer; explicit caching only on some models                                       | Implicit minimum 2,048 on 2.5, 4,096 on the 3.x models and Gemini 4 Argon. Gemini 4 caches a previous request fully only if the new one adds at least 2,050 tokens (aistudio.google.com/docs/caching, read 2026-11-10; TTL and discount not stated on that page). A reviewer prefix of about 2 to 6 thousand tokens is borderline: expect little or no cache on Gemini 3.x. Do not use explicit caching.                                                                                                                                                                         |
| vLLM, SGLang (local)            | Automatic prefix caching, no request fields                                                                      | vLLM hashes each full KV block over its tokens and the prefix, so only full blocks are reused, and `cache_salt` folded into the first block limits reuse to requests sharing a salt (docs.vllm.ai/en/v0.14.1/design/prefix_caching/, via search 2026-11-10). SGLang uses a radix tree, so a prefix can match at any token boundary; an official salt equivalent was not found. For both, the only lever is order: stable first, volatile last.                                                                                                                                   |

Takeaway: the same structure serves every family: a byte-stable prefix, then a volatile tail. Only the markers differ, and some families (OpenAI before 5.6, Gemini, local) need none.

## 3. Reviewer request shape

**Principle.** `system` is static. The user message is a list of blocks ordered by how often each changes: session block, then history block, then the call. The call block is the only one that carries a fresh nonce.

```
system:  REVIEWER_SYSTEM_PROMPT (static; version-hashed)
user[0]: [[SESSION]] environment + guidance (changes only when settings change)   <- breakpoint 1
user[1]: [[USER-MESSAGES]] + EARLIER-TOOL-CALLS, fenced with a per-session nonce  <- breakpoint 2
user[2]: TOOL-CALL fenced with a per-call nonce + "Reply with the JSON object only."
```

This is D1's recommendation made concrete. The call fence is where attacker-controlled text lives, so it keeps the per-call nonce; the history is things the agent already did and the person already said, so a per-session nonce there costs little. Because the system prompt now precedes a session block that is also stable, breakpoint 1 clears the 1,024 minimum on more models than the system prompt alone.

**Step trimming is required for breakpoint 2 to hit.** With sliding windows of 10 messages and 30 calls, every call after the window fills shifts every line. Drop the oldest items in blocks (for example 10 calls at a time, as the main conversation does) so the history is append-only between steps. Between steps the history block grows at its end, which the 20-block lookback handles on Anthropic and Bedrock because breakpoint 1 is still a prior write.

**Per family.**

| Family                                    | Markers                                                                                                                                                   | Notes                                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API, Bedrock Claude, 5.x models | Breakpoints 1 and 2; system prompt cached too (it is before breakpoint 1). TTL 5 min when reviews are under 5 minutes apart in the session, 1 h otherwise | Reviews are sporadic, so the keep-warm rule decides TTL. Writing 1 h costs 2x the base price on a few thousand tokens, a fraction of a cent. Check the model's minimum first and skip markers under it, so the ledger does not claim a cache that is not there. |
| Bedrock Claude 4.x, Opus 4.7              | Same, only if the measured prefix clears the minimum (1,024, 4,096 on Bedrock Opus 4.7, Haiku 4.5)                                                        | A Haiku 4.5 reviewer will not cache a 3,000-token prefix. Say so in the settings help rather than send dead markers.                                                                                                                                            |
| Nova 2 Lite and others                    | `cachePoint` after system and after session block; 5 minutes; cap 20K                                                                                     | Never on `tools`. Implicit reuse may help latency without showing in usage.                                                                                                                                                                                     |
| OpenAI and Bedrock GPT-5.5 and earlier    | No markers. Stable order, `prompt_cache_key` = hash of session id                                                                                         | Cache is implicit from 1,024 tokens.                                                                                                                                                                                                                            |
| GPT-5.6 and later                         | `prompt_cache_options.mode = "explicit"` with a breakpoint after the session block (and optionally after history)                                         | Explicit mode avoids the automatic breakpoint landing on the changing last message and using a write slot. 30-minute default retention covers a review burst.                                                                                                   |
| Gemini                                    | Nothing. Stable order only                                                                                                                                | Treat caching as a bonus. Keep prefix honest; do not pad to reach 4,096.                                                                                                                                                                                        |
| vLLM, SGLang                              | Nothing. Stable order; optionally a `cache_salt` per session                                                                                              | Block-aligned on vLLM: first-block stability matters most.                                                                                                                                                                                                      |

**Do not add thinking or `effort` changes between reviews.** On Anthropic these are listed as invalidators for the system or tools level on some models; the reviewer's reasoning setting is per model entry and must not vary per call.

## 4. Reuse the main session's prefix, or stay isolated?

|                    | Isolated minimal prompt (today, reordered)                                                                                                                                                                                                                                                                                                               | Fork the main session's cached prefix, append the review ask                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Injection exposure | The reviewer never sees tool output or assistant prose. Anthropic's auto-mode classifier is built the same way: it sees only user messages and tool calls, "reasoning-blind by design", because the agent cannot argue it into a bad call and tool results are where injections enter (anthropic.com/engineering/claude-code-auto-mode, read 2026-11-10) | Full tool output in context. The attacker's text now sits in the judge's prompt                                                   |
| Persuasion bias    | None from the author's reasoning                                                                                                                                                                                                                                                                                                                         | A reviewer that has read the author's reasoning tends to agree with it (plan finding 6)                                           |
| Cost               | Few thousand tokens at input price, or read price once warm                                                                                                                                                                                                                                                                                              | The main prefix is often 50K to 200K tokens, already warm at 0.1x: cheaper per token but far more tokens, and a miss is expensive |
| Model              | Any small, fast model, which is the point of `modeModels.reviewer`                                                                                                                                                                                                                                                                                       | Must be the same model as main (caches are per model), so the review costs and runs at main's price and latency                   |
| Tools              | None                                                                                                                                                                                                                                                                                                                                                     | Must send the main's identical tool list for a hit, so the reviewer is shown, and could call, tools                               |
| Cache coupling     | Own prefix, own TTL                                                                                                                                                                                                                                                                                                                                      | Rides the main's TTL; changes there (mode, effort, tool set) silently break the review's hit                                      |

Recommendation: stay isolated. The cost argument for forking is weak (reviews are cents), and its security and bias costs are exactly what the feature is for. One exception worth measuring as a control arm only: the Codex reviewer gets "a compact transcript of user messages, surfaced assistant updates, relevant tool calls and outputs", with hidden reasoning excluded, and may run read-only checks (learn.chatgpt.com/docs/sandboxing/auto-review.md, read 2026-11-10). Anthropic reports that a tool-calls-only variant had the lowest false-negative rate but lost the user-intent anchor, which is why user messages stayed. Our digest (user messages plus calls) is the Anthropic shape. The same article describes a two-stage design (a fast single-token filter, then reasoning on the flagged few) whose second stage reuses the first stage's prompt as a near-complete cache hit; that is a reuse pattern open to us as a later row, not part of U0.

## 5. U0 live measurement protocol

**Keys.** In the shell this research ran in, `ANTHROPIC_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` are set; `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AWS_ACCESS_KEY_ID` and `AWS_PROFILE` are not. Values were not printed and no model was called, because this task was read-only. The owner runs the commands below.

**Goal.** Decide whether U1 (reorder, step trimming, per-session nonce, breakpoints) is worth building, using a reviewer's real cache read share and latency.

**Inputs.**

- A recorded session of at least 60 gated calls. Use a real CLI or IDE history rendered through `buildReviewHistory`. If none is available, replay the 207 B4 cases (`evaluation/cases.ts`) in order, repeated with a rotating history so windows fill and slide.
- Four arms over the same inputs:
  - **A, today**: per-call nonce, no markers (what a reviewer entry without caching sends).
  - **B, system marker only**: tests whether the system prompt alone clears the minimum.
  - **C, proposed**: section 3 order, per-session nonce in history, step trimming (blocks of 10), two breakpoints.
  - **D, fork control** (optional, one model): main-style prefix of 40K tokens plus the review ask, to price the alternative.
- Pacing: **dense** (2 s between reviews) and **sporadic** (6 minutes, to see 5 min expire against 1 h). Run 5-minute and 1-hour TTL on C. Repeat each cell 3 times; drop the first call of each run (cold write).

**Models.** Anthropic API: Haiku 5.5 and Sonnet 5.5 (512 minimum), Sonnet 4.6 (1,024) and Haiku 4.5 (4,096) to show the cliff. Bedrock Converse: the same Claude models and Nova 2 Lite. Add GPT-5.6 Luna and a Gemini 3.x Flash if keys exist, and a local vLLM if one is running. Gaps are a result, not a failure.

**Metrics per call.** Total input tokens; cache read, cache write and uncached; round-trip latency (non-streaming, wall clock, p50 and p95); the verdict triple (decision, category). Derive: cache read share = read / total input; dollars per review at the price table; verdict agreement with arm A.

**How to run.** Verdict agreement needs no new code:

```
cd core
npm run eval:reviewer -- --help
REVIEWER_EVAL_PROVIDER=anthropic REVIEWER_EVAL_MODEL=claude-haiku-5-5 \
  REVIEWER_EVAL_API_KEY="$ANTHROPIC_API_KEY" REVIEWER_EVAL_OUT=/tmp/eval-haiku55.md \
  npx vitest run tools/permissions/auto/evaluation/live.vitest.ts
```

(`--help` first: the wrapper's flags were not read; the env form is from the file header of `live.vitest.ts`.) Cache and latency use row **U0b**, built: `core/scripts/reviewerCacheProbe.mjs`. It replays a session of reviews (the evaluation's labelled calls, with a history that fills and then slides) through arms A, B and C, reads the provider's cache usage fields and prints a table (cache read share with each arm's first review left out, p50 and p95 latency, agreement with A, and how many reviews arm C or B answered more loosely than A). Without `--run` it prints the plan and sends nothing. Each arm adds a salt line to the system prompt so one arm never reads another's cache entries. Arm D (fork control), GPT-5.6 explicit breakpoints and Gemini are not built.

```
cd core
node scripts/reviewerCacheProbe.mjs --help
# dry run: shows the plan, whether the key variable is set, sends nothing
node scripts/reviewerCacheProbe.mjs --provider anthropic --model claude-haiku-5-5
# dense run, then a sporadic one (360 s apart) to see 5 minutes expire against 1 hour
node scripts/reviewerCacheProbe.mjs --provider anthropic --model claude-haiku-5-5 --run --out /tmp/probe-haiku55.csv
node scripts/reviewerCacheProbe.mjs --provider anthropic --model claude-haiku-5-5 --run --calls 30 --gap-sec 360 --ttl 1h --arms A,C
# Bedrock Converse (bearer token variable), Claude and Nova
node scripts/reviewerCacheProbe.mjs --provider bedrock --model us.anthropic.claude-haiku-5-5 --region us-east-1 --run
```

Bedrock model ids and the Anthropic model ids are examples; use the ids the account lists.

**Pass bar (proposed; the owner may move it).**

- Build U1 and U2 only if, on a 30-review dense run for a 5.x Claude reviewer, arm C shows cache read share of 60% or more of input tokens **and** p50 latency at least 20% below A, **and** verdicts match A on at least 99% of the 207 cases with no deny-to-allow flip.
- On the sporadic run, 1 h must read where 5 min missed (U2's own criterion).
- Stop at U0 if the reviewer's share of a bench run's cost is under 5% and its p50 latency under 1.5 s. Cost is the weak argument: at Haiku 5.5's $0.10 per MTok input, a 4,000-token review is about $0.0004, so 500 reviews cost about $0.20. Latency on a blocking call and the rate-limit relief on Bedrock (cache reads do not count toward its input-token quota) are the real prizes.
- Record the answer per model, including "under the minimum, nothing cached".

## 6. The audit record (P12)

**Form.** Append-only JSON lines. Two events per call, joined by `callId`, so nothing is ever rewritten: a `decision` event written before the tool runs (a crash after approval still leaves the decision), and an `outcome` event written after. Plus a `turn` event per model turn so S can see turns that made no call.

**Where.** `<globalDir>/audit/<yyyy-mm>/<sessionId>.jsonl`, next to but not inside the session log. Reason: V4 will rewrite the session format, and deleting a session in the UI should not silently delete its audit; P12 should not wait on V4. Row P12 lists V4 as a dependency only for the shared format convention (one JSON line per item, a crash loses the last line); the two files can be joined later by `sessionId`. Decision needed: retention (proposed: 90 days, then delete whole files; a size cap of 20 MB per file starts a new `.1` file in the same month).

**Fields.**

| Group            | Field                                                                                                                                                                                                    | Notes                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope         | `v`, `ev` (`decision`, `outcome`, `turn`), `ts` (UTC ISO), `session`, `turn`, `callId`, `seq` (per file)                                                                                                 | `seq` makes loss visible even without a chain                                                                                                             |
| Call             | `tool`, `argsMasked` (clipped to 2,000 chars), `argsHash`, `argsLen`, `displayValue`                                                                                                                     | `argsHash` is SHA-256 of the **masked** text. A hash of the raw text is a guessing oracle for a low-entropy secret                                        |
| Reading          | `shell`, `understood`, `verdict` (reads, writes, unsure), `effects[]`, `destinations[]` (host, kind), `lint[]`                                                                                           | From the command analysis result; today `ToolPolicyResult` exposes `displayValue` and a read-only reason, so P12 includes exposing the rest               |
| Decision         | `policy` (allow, ask, deny), `by` (`rules`, `reviewer`, `person`, `system`), `source` (`DecisionSource`), `rule` (the text as written), `area`, `level`, `mode`                                          | Matches `ToolDecision` and `AutoReviewReply` already in code. `person` is added when an ask is answered, as a second `decision` event with `answers: seq` |
| Reviewer         | `model`, `promptVersion` (hash of `REVIEWER_SYSTEM_PROMPT`), `category`, `risk`, `authorization`, `reason`, `cached` (verdict reused), `latencyMs`, `usage` (in, out, cacheRead, cacheWrite), `unusable` | The prompt itself is not stored. `usage` makes the audit the U0 production ledger for free                                                                |
| Outcome          | `ran` (bool), `exit`, `durMs`, `outBytes`, `errSig` (masked, normalised first error line, 200 chars), `changed[]`, `read[]`                                                                              | No output text unless the person turns on `audit.capture: output`. `errSig`, `changed` and `read` are what S's signals consume (section 8)                |
| Context          | `jail` (id or none), `loopItem`, `agentMode`, `modelMain`, `cliVersion`                                                                                                                                  |                                                                                                                                                           |
| Chain (optional) | `prev`, `h`                                                                                                                                                                                              | See below                                                                                                                                                 |

**Masking rules (applied before anything is written; the writer never sees the raw text).**

1. Reuse the existing detectors: `protectedPathHit(..., ["secret"])` paths are kept but their contents are never read; `secretCommands.ts` flags words such as key, token, password and credentials, and those words decide when an adjacent value is masked.
2. Mask values of `NAME=value` assignments and flags when the name matches the secret-word list (`--password`, `-p` after `mysql`, `API_KEY=`), `Authorization:` and `Cookie:` header values, URL userinfo (`user:pass@`), and query parameters named like a secret.
3. Mask by shape: `sk-`, `AKIA`, `ASIA`, `ghp_`, `github_pat_`, `xox[bp]-`, `AIza`, three-part base64url JWTs (`eyJ`), PEM blocks, and high-entropy tokens of 32 or more characters in an argument position that follows a secret word.
4. Replace with `«masked:<kind>»`, not blanks, so the list still shows what kind of thing was there. Never log a masking failure's input.
5. Heredocs and `-c` payloads are masked as text and then clipped; if clipping would cut a masked span, cut before it.
6. A corpus test (like `corpus/`): each pattern has leak cases that must not appear in the output file, and false-positive cases (a commit hash, a UUID) that must.

Masking is best effort, and the doc must say so. An unknown secret format passes through. The mitigation is the file's location and mode (`0600` on POSIX; user-only ACL on Windows) and that nothing is sent anywhere.

**Rotation and durability.** One file per session and month, `fsync` on `outcome` and on `deny` events, buffered otherwise; a crash loses at most the last line (the reader skips a torn final line). Delete by whole file past the retention age. No in-place compaction, which would break any chain.

**Hash chain (optional, setting `audit.chain: true`).** `h = SHA-256(prev || canonicalJSON(record without h))` with RFC 8785 JSON canonicalization, `prev` = previous record's `h` in this file; the first record of a rotated file carries the last `h` of the file before it, so a deleted file is detected. `continuous audit --verify` walks the chain and names the first broken `seq`. What it proves: edits, reorderings and middle deletions are detectable. What it does not: truncation of the tail, or a rewrite of the whole file by a process with the person's rights. Tail truncation needs an external anchor: the optional second copy of D7, or a periodic `{seq, h}` written to a path the person names. The design matches what the open hash-chained agent logs do (halo-record: hash-chained JSONL with RFC 8785, a Claude Code `PostToolUse` hook; hackernoon.com/what-did-your-ai-agent-actually-do-building-a-tamper-evident-audit-trail), whose claims were read from search snippets, not their code.

**Export schemas.** Native JSONL is the source. `--export ocsf` and an OpenTelemetry mapping are later rows. Search results confirmed that tools exist that export agent logs to OCSF and CEF for SIEM ingestion, but did not give the OTel GenAI attribute names or an OCSF class for a tool call; the OTel GenAI conventions moved to github.com/open-telemetry/semantic-conventions-genai, whose pages were not read. Treat the mapping as unverified until that repository is read.

## 7. IDE list and the CLI command

**Core.** An `AuditReader` with `list({session?, tool?, decision?, by?, host?, since?, until?, text?, limit, cursor})`, `get(callId)` (joins the decision, any answer, and the outcome) and `verify(file)`. It pages by byte offset (the session-index idea from V4), so a 20,000-line file does not load whole.

**IDE.** A list view under the same surface as the toolbox drawer: one row per call (time, tool, a short masked value, an icon for allow, ask, deny, who decided, the rule or reviewer reason, outcome). Filters: tool, decision, decided by, host, session, time. A detail pane shows the reading (effects, destinations, lint), the full decision chain (rule or reviewer fields), the outcome, and the masked arguments. Row actions: "Add a rule like this" (reusing `suggest.ts`) and "Copy as JSON". Messages over the existing core protocol: `audit/list`, `audit/get`, `audit/export`. Empty state says what is not recorded (output text, anything before this version).

**CLI.**

```
continuous audit [--session <id> | --last | --all]
                 [--decision allow|ask|deny] [--by rules|reviewer|person|system]
                 [--tool <name>] [--host <glob>] [--rule <text>] [--since 2h|<date>]
                 [--limit N] [--json] [--show <callId>]
continuous audit export [--format jsonl|csv] [--out <path>]
continuous audit verify [--session <id>]      # exit 1 on a broken chain or gap in seq
continuous audit prune [--older-than 90d]
```

The default output is one line per call, the same shape as the IDE row, with `--json` emitting the records. The exit code is 0 unless `verify` fails. The prior art for what to surface is thin: Codex keeps session transcripts under `~/.codex/sessions` and passes the reviewer's rationale to the agent on denial, and the page describes no audit log; Anthropic's post gives error rates but no user-facing record (both pages read 2026-11-10). A first-class decision log with the reviewer's reason is therefore a differentiator, not catch-up.

## 8. How Track S's work log derives from the audit

`workLog.ts` consumes `StuckStep[]` (calls with `tool`, `args`, `result`, `error`, `changed`, `read`, plus a step `text`), built today by `stuckHistory.ts` from a CLI or IDE history. The audit supplies the same fields without the history:

- **`auditToSteps(records)`**, a pure function next to `stuckHistory.ts`: group by `turn`; each `outcome` becomes a `StuckCall` with `args` from `argsMasked`, `error = exit !== 0 || !ran`, `result = errSig`, `changed` and `read` copied across. A `turn` event with `textChars` and no calls becomes a monologue step (`text` is a placeholder of that length, since the monologue signal needs length and not words).
- Two things the audit must carry for this to work: `errSig` (the repeat-error signal compares normalised error text; with no output stored, the signature has to be written at the time) and `changed` and `read` paths. If these are absent the signals degrade silently, so S0's corpus gets an audit-derived twin of each history and the test asserts the same signals fire.
- **Masked arguments are fine for the log, not for near-repeat signals on secrets**: two calls differing only in a masked secret would look identical. Accept this; it makes the signal more eager, not less.
- Direction: the audit is the source and the work log a view (command-analysis.md already says so). `buildWorkLog` stays unchanged and still takes steps; either adapter feeds it. S continues to work for hosts that do not write an audit (the history adapter stays).
- Stuck signals themselves are not stored in the audit. They are derived and would go stale when thresholds change (S1).

## 9. Build rows

| Row  | Scope                                                                                                                                                                | Depends on | Done when                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| U0b  | `reviewerCacheProbe.mjs` plus the arm C prompt builder in `evaluation/cacheProbe.ts` (test-only); prints a table and a CSV per call with cache and latency           | none       | Built: the owner can run arms A to C on Anthropic, Bedrock and OpenAI-compatible servers |
| U0c  | The measurement run; fill a table of figures in `reviewer-isolation.md`                                                                                              | U0b, keys  | Per model: prefix tokens, cache read share, p50 and p95, verdict agreement, pass or stop |
| U4   | (unchanged) tool-output isolation tests and an injection set aimed at the reviewer's prompt                                                                          | none       | Can proceed now; also needed before any reorder                                          |
| U1   | Reorder, per-session nonce, step trimming, breakpoints per section 3, minimum-size check                                                                             | U0c pass   | Section 5 pass bar met                                                                   |
| U2   | TTL choice and keep-warm                                                                                                                                             | U1         | 1 h reads where 5 min missed                                                             |
| P12a | Record types, masker, corpus tests (pure)                                                                                                                            | none       | Leak cases never appear in output; false positives preserved                             |
| P12b | Writer: per-session file, two-phase events, fsync rule, rotation, retention, `0600`                                                                                  | P12a       | A killed process leaves a readable file                                                  |
| P12c | Wire core: decision events from `autoReviewToolCall` and `decideToolCall`, reviewer usage and latency, the person's answer; expose `reading` from `ToolPolicyResult` | P12b, P10  | Every gated call in a bench run has a decision and outcome pair                          |
| P12d | `AuditReader` and `continuous audit` list, show, export, prune                                                                                                       | P12b       | Filters work on a recorded file                                                          |
| P12e | Chain and `verify` (setting off by default)                                                                                                                          | P12b       | A flipped byte is named by `seq`                                                         |
| P12f | IDE list and detail, protocol messages                                                                                                                               | P12c, P12d | Row opens, filters work, "add a rule like this" works                                    |
| S0b  | `auditToSteps` and the twin corpus                                                                                                                                   | P12c       | Same signals fire as on the history path                                                 |
| S4   | The IDE work-log view reads the audit                                                                                                                                | S0b, P12f  | (existing S4 criteria)                                                                   |
| P12g | OCSF and OpenTelemetry export                                                                                                                                        | P12d       | Mapping verified against the spec repositories first                                     |

P12a and P12b do not need V4: they write their own file. U4 and P12a start now; U1 waits for the measurement.

## 10. Risks

- **A reviewer cache that never hits** because the prefix is under the model's minimum or each step shifts a window: a silent failure, since sub-minimum requests do not error. The ledger line for the reviewer must show reads, not just markers sent.
- **A per-session nonce weakens the fence** if the history ever contains attacker text that learned the nonce. The history is only user messages and clipped call arguments, and the agent never sees the reviewer prompt; the call fence keeps its per-call nonce. Add an injection case that tries to forge the session fence (U4).
- **Masked arguments become the evidence.** A bug in masking becomes a bug in the record. The file is local, `0600`, never sent, and the doc states best effort.
- **Audit write failure.** Policy: a failed write never blocks the tool call, but surfaces once per session; in headless mode with `audit.required: true` a failed write refuses the call. Default off.
- **Hash chain gives false comfort** if described as tamper-proof. The docs say what it proves (section 6).
- **Logging the reviewer's reason** can reproduce attacker text (the reason is model-written about attacker-written arguments). Clip it and mask it like arguments.
- **Retention versus privacy**: 90 days of command history is sensitive. A `continuous audit prune` and a one-line setting are part of P12d, not later.

## 11. Unverified

- The real token size of the reviewer system prompt (2,813 characters is the plan's number, which looks low).
- The exact flags of `scripts/reviewer-eval.mjs`; only the env form in `live.vitest.ts` was read.
- That Bedrock Converse accepts a `cachePoint` between two `text` blocks in one user message for every listed Claude model (the AWS page shows it for a message with an image and text) and that its 1 h TTL applies to Sonnet 5.5 for this account.
- GPT-5.6 explicit-mode behaviour as documented by AWS; direct OpenAI docs describe the same fields, neither was exercised.
- Gemini TTL, discount and explicit caching on 3.x (the page did not say).
- vLLM details came from search snippets of the docs, not the page; SGLang has no confirmed salt.
- The Anthropic and Codex classifier pages were summarised by a fetch tool; the error-rate table is as reported, not re-derived. Third-party write-ups (Codex guides, halo-record, the Register) were not read beyond snippets.
- The OTel GenAI `execute_tool` attribute names and any OCSF class for a tool call.
- That `ToolPolicyResult` can expose `shell`, `effects` and `destinations` without a larger change than P12c assumes (only `displayValue` and a read-only reason were seen).
- That the CLI and IDE can emit an `outcome` event with `changed` and `read` paths and `errSig` from where tools run; only `stuckHistory.ts`'s derivation from history was seen, not a live hook.
- Whether the Anthropic `cache_control` top-level (automatic) form is wanted for the reviewer: it moves the breakpoint to the last block, which is the call block and changes every time. Use explicit markers instead.
