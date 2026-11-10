# Prompt injection in tool results and MCP content

Status: research and first slices, 2026-11-10. Branch `injection-defense`. Nothing here is wired into a tool path.

## 1. Decision summary

No defense against prompt injection is complete. The 2025 and 2026 evidence says three things, and the plan follows from them.

1. Detectors and trained robustness lower the rate; they do not remove it. Static benchmarks overstate both (section 3).
2. The defenses that hold by construction do not depend on the model noticing the attack: they limit what an injected agent can do (capabilities, information-flow control, the Rule of Two, egress limits, approval for state changes).
3. For this fork the cheapest real gains are at the boundary, not in the model: tool approval that cannot be talked out of, protected paths, the reviewer that never sees tool output, and pinning of MCP definitions.

Recommended order:

| Step | What                                                                                                                                            | Cost                             | Status                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| P1   | Pattern detector as a tripwire, with a labelled corpus and hidden-character handling                                                            | small                            | built in this PR, not wired further                             |
| P2   | MCP tool-definition pinning, with a store interface and a description check                                                                     | small                            | built (`core/context/mcp/toolPinning.ts`), not wired            |
| P3   | Spotlighting of untrusted text (`fetch_url_content`, MCP results, file reads from outside the workspace)                                        | small                            | helper built (`core/tools/permissions/spotlight.ts`), not wired |
| P4   | Wire P2 into `MCPConnection` and the approval dialog: ask on `new` and on `changed`, block auto-approve of a `changed` server until answered    | medium                           | not started                                                     |
| P5   | Flag in the CLI path too (only the GUI thunk and the subagent runner call `flagToolOutput`)                                                     | small                            | not started                                                     |
| P6   | A "tainted session" rule: after untrusted content entered the context, state-changing and network-egress calls ask even when a rule allows them | medium, needs a product decision | not started                                                     |
| P7   | Measure with the model harness: an injection set in the benchmark (row U4 already asks for one aimed at the reviewer)                           | medium                           | not started                                                     |

Do not build: a second LLM that judges every tool output (cost, and it is itself injectable, section 2.3), or a stronger regex set tuned until the corpus is clean (section 5.1 shows why).

## 2. What exists in the fork

Read at `origin/main` 9442b4210 (the stale checkout was fetched; the ref update reported a lock error, the worktree was still created from the fetched object).

- `core/tools/permissions/injection.ts`: `detectInstructionLikeText` matches regular expressions against tool output; `flagToolOutput` puts a notice in front of a match. It never blocks. Callers: `gui/src/redux/thunks/callToolById.ts` and `gui/src/util/subagents/runSubagent.ts`. No caller in `extensions/cli/src`, so the CLI agent gets no notice at all (verified with a search for `flagToolOutput`).
- `core/tools/permissions/auto/history.ts`: the reviewer is shown the user's typed text and earlier tool calls (name and arguments), never the agent's prose or any tool output. That is the right shape: it removes the path from an injected page to the component that decides approvals. It does not remove the path through the arguments of a tool call the injected agent makes, which the reviewer does see. A poisoned argument is a smaller channel than a poisoned page, but not an empty one.
- `core/tools/implementations/fetchUrlContent.ts`: returns page text, truncated at 20000 characters, with no marking.
- `core/context/mcp/MCPConnection.ts`: `listTools` is called at connect, and `this.tools = tools` replaces whatever was there. No hash, no comparison with an earlier approval, so a server can change a description between sessions, or while connected if it sends a list-changed notification (not checked in this pass).
- The CVE record (section 6) is mostly about what the agent could do after being injected, not about the injection being invisible. The fork already carries the matching hardening (protected paths, command analysis, effect rules).

## 3. Evidence: what has been shown to work and what has not

Dates are the dates of the cited page or paper version. Numbers are the authors' own unless marked.

### 3.1 Marking untrusted text

Spotlighting (Hines et al., Microsoft, arXiv 2403.14720, March 2024, CAMLIS 2024): three variants. Delimiting, datamarking (a marker character in place of whitespace) and encoding (base64 and similar). On GPT-family models the authors report attack success falling from above 50% to below 2%; datamarking gave 3.1% on GPT-3.5-Turbo summarisation, encoding 0.0%. Caveats the authors give: encoding hurts weaker models, datamarking is unsuitable for code, the attack set was synthetic with simple payloads. Treat it as a cheap risk reducer against lazy attacks, not as a boundary. Source: https://arxiv.org/pdf/2403.14720 (fetched via search 2026-11-10).

### 3.2 Training the model

- Instruction hierarchy: OpenAI ranks system over developer over user over tool, and in March 2026 published the IH-Challenge training set (arXiv 2603.10521). Reported: GPT-5-Mini fine-tuned on it, instruction-hierarchy robustness 84.1% to 94.1% across 16 benchmarks, and 44% to 100% on an internal static prompt-injection evaluation. The 100% is on a static internal set, which section 3.4 says not to trust as a bound. Source: https://openai.com/index/instruction-hierarchy-challenge (via search summary, 2026-11-10).
- Anthropic (browser use, November 2025): reinforcement learning plus classifiers; Opus 4.5 at about 1% attack success against an internal Best-of-N attacker with 100 attempts, and Anthropic itself says 1% is still meaningful risk. Its later Claude in Chrome general-availability post reports 17.6% against stronger professional red-team attacks that reached the model (16.7% with the November safeguards). Sources: https://www.anthropic.com/research/prompt-injection-defenses and https://claude.com/blog/claude-in-chrome-generally-available. The gap between 1% and 17% is the clearest public example of attacker strength moving the number by an order of magnitude.
- Google (June 2025): layered defense for Gemini: content classifiers, adversarial training of the model, "security thought reinforcement" (reminders around the content), markdown and URL sanitisation, user confirmation for risky actions, user notifications. The post argues for defense in depth rather than any one layer. Source: https://blog.google/security/mitigating-prompt-injection-attacks/.

The pattern across all three vendors: several layers, a stated residual risk, and confirmation for consequential actions. None claims the model alone is sufficient.

### 3.3 Design-level defenses

- CaMeL (Debenedetti et al., Google DeepMind and ETH, arXiv 2503.18813, March 2025): a privileged model writes a program from the user's request only; a quarantined model parses untrusted data and cannot call tools; an interpreter tracks capabilities on values and checks policies before each tool call. On AgentDojo the paper reports 77% of tasks solved with provable security against 84% undefended (an earlier version said 67%; cite the version). The costs are real: a custom interpreter, policies written per tool, utility loss, and a design that fits tasks whose plan is known up front better than open-ended coding. It does not stop an attack that stays inside the allowed flows, for instance text that misleads the user.
- The dual-LLM pattern (Willison, April 2023) is the ancestor: the privileged model never sees untrusted text, the quarantined one sees it and has no tools. CaMeL is what makes it safe to pass values between the two.
- FIDES (Costa et al., Microsoft, arXiv 2505.23643, v2 September 2025): confidentiality and integrity labels on data, deterministic policy enforcement in the planner, and primitives that hide untrusted content from the model. Reported: with policy checks off, the extra hiding machinery did not cost task completion with reasoning models. Source: https://arxiv.org/pdf/2505.23643.
- Meta's Agents Rule of Two (31 October 2025): in one session an agent should have at most two of: untrusted input, access to sensitive systems or data, ability to change state or communicate outward. Meta frames it as a limit on damage until detection is reliable, and not as a finish line. Source: https://ai.meta.com/blog/practical-ai-agent-security/. A coding agent that reads the web, reads the user's files and runs commands holds all three by default; the fork's "ask before egress or state change after untrusted input" rule (P6) is the Rule of Two applied per session.

What holds by construction here: constraining the effects. What does not: asking the model to notice.

### 3.4 Benchmarks and why numbers mislead

- AgentDojo (Debenedetti et al., NeurIPS 2024, arXiv 2406.13352): dynamic tool-using tasks. Original paper: attacks succeed against the best agents in under 25% of cases; a secondary detector brought it to about 8%.
- InjecAgent (arXiv 2403.02691): single-turn simulated tool outputs; prompted GPT-4 about 24% attack success, 47% with an enhanced attack string (as summarised; the metric counts only parseable outputs, so it is not comparable to ASR over all outputs).
- Agent Security Bench, ICLR 2025: highest average attack success 84.3% across attack types, with the tested defenses having limited effect.
- Caveat 1, the benchmarks are weak: Bhagwatkar et al. (arXiv 2510.05244) report flawed success metrics, implementation bugs and weak attacks in AgentDojo and ASB. An audit of open-weight agents found low success rates that came from models that never produced a usable action.
- Caveat 2, adaptive attackers: "The Attacker Moves Second" (Nasr, Carlini, Tramer and others, arXiv 2510.09023, 10 October 2025) tested 12 published defenses with gradient, reinforcement-learning, search and human red-team attacks. Most defenses exceeded 90% attack success, against near-zero in their own papers; automated attacks reached 71% to 100% on all 12. Source: https://arxiv.org/abs/2510.09023.

Consequence for this repository: any figure we measure on a fixed injection set is a floor on the attacker's success, not a ceiling. The corpus in section 5.1 is exactly that kind of set, and it shows the effect on a small scale.

## 4. MCP-specific attacks and mitigations

- Tool poisoning (Invariant Labs, April 2025): instructions hidden in a tool's description or parameter descriptions, invisible in a UI that shows only a short summary, followed by the model. Demonstrated against Cursor with a fake WhatsApp and GitHub server.
- Rug pull: the server shows a harmless definition at approval and a poisoned one later. Needs only that clients re-fetch definitions without comparing.
- Tool shadowing and line jumping: one server's description changes how the model uses another server's tools, or acts at connect time because descriptions enter the context before any tool is called. Mitigation is separation: do not mix a sensitive server with an untrusted one in one session; show which server each tool belongs to.
- Toxic agent flow (Invariant Labs, May 2025, GitHub MCP): no poisoned tool at all. A public issue carried the injection; an agent with a token that could read private repositories then copied private data into a public pull request. Invariant called it an architectural issue, not a server bug. This is the Rule of Two case, and pinning does nothing against it.
- Mitigations seen in practice: hash and pin the full definition (name, description, schemas, annotations) at approval and re-ask on change; show full descriptions in the approval dialog; scan descriptions for instruction-like text; namespace tool names by server; scope tokens narrowly. Limits: pinning sees a changed description, not changed behaviour or changed output, and says nothing about a description that was malicious when first approved. Sandboxing the server does not address an attack that works through the model. Sources: https://invariantlabs.ai/blog/mcp-github-vulnerability and the vendor write-ups indexed in section 8 (secondary, not independently verified).

## 5. What this PR builds

All three pieces are pure, tested, and not wired.

### 5.1 Detector changes (`core/tools/permissions/injection.ts`)

Added: normalisation before matching (NFKC; removal of zero-width and bidirectional characters; Unicode tag characters decoded to the ASCII they encode, so "ASCII smuggling" is read); a `hidden-unicode` flag for tag characters and bidirectional overrides; patterns for chat-template tokens, "forget the above", role reassignment, claims of user authority, switching off tool approval (`autoApprove ... true`), credential-file reads, system-prompt disclosure, "AI agents reading this", fetch-a-URL-and-follow, and image links whose address carries a secret. Narrowed: "you should run the following command" (ordinary documentation), "never tell the user their password" (a logging rule), "Important: for the agent module" (a heading), and a bare `<system>` config element.

Corpus (`injectionCorpus.ts`): 80 samples, 37 injected and 43 benign, in three splits (dev 34, held 26, fresh 20), hand-written by me, shapes paraphrased from the literature. Results, counting a sample as hit when any pattern fires:

| Split                                                                       | Old detector (precision / recall) | New detector |
| --------------------------------------------------------------------------- | --------------------------------- | ------------ |
| dev (patterns written against it)                                           | 0.71 / 0.63                       | 0.94 / 1.00  |
| held (written first, but its misses were seen at baseline)                  | 0.78 / 0.64                       | 1.00 / 1.00  |
| fresh (10 injected, 10 benign, written last in other phrasing, scored once) | none / 0.00                       | none / 0.00  |
| all 80 samples                                                              | 0.74 / 0.46                       | 0.96 / 0.73  |

Read this honestly. Dev and held are tuned, so the near-perfect score there is a regression floor, not evidence. The fresh split is the useful one: both detectors catch none of ten reworded injections (an imperative phrased as a favour, a German instruction, a base64 payload, "Instructions to the model:", an appeal to being the repository owner). The improvement is real on the false-positive side (fewer ordinary documents flagged) and on character-level evasion, and it is nil on rephrasing. A regular expression set is a tripwire for copy-pasted payloads. It should stay a notice, never a gate, and nothing should depend on it for safety. One more false positive is known and left: a security document that quotes "ignore previous instructions" is flagged. The corpus is small (80 samples); the ratios have wide uncertainty.

### 5.2 Tool pinning (`core/context/mcp/toolPinning.ts`)

`hashToolDefinition` hashes the canonical JSON of name, title, description, input and output schema and annotations, with sorted keys and no string normalisation (so an added invisible character changes the hash). `checkToolPins(serverId, tools, store, hash)` returns `new` (nothing approved yet), `unchanged`, or `changed` with the lists `changed` (name, before, after), `added` and `removed`; it writes nothing. `approveToolPins` records the current list after the user said yes. `ToolPinStore` is a two-method interface with an in-memory implementation for tests. `suspiciousToolDefinitions` runs the detector over descriptions and every string in the schemas, as a hint for the dialog. The hash function is injected, so the file has no Node import. Limits: it detects a changed description, not a changed server; a server that lies on first contact is pinned lying.

### 5.3 Spotlighting (`core/tools/permissions/spotlight.ts`)

`createSpotlight()` makes a 128-bit per-session token from `crypto.getRandomValues` (no `Math.random` fallback; it throws). `wrap(text, {source, mode})` returns the text between `<<untrusted-TOKEN ...` and `untrusted-TOKEN>>` lines. Before wrapping it removes any readable form of the token from the text: exact, other case, split by zero-width characters, written as Unicode tag characters, or in fullwidth form (the text is normalised only when the token is found in its normalised view, so ordinary output is untouched). That covers the case that matters in an agent: wrapped output that the agent wrote to a file and reads back. The source label is sanitised. `mode: "datamark"` replaces whitespace with U+02C6, for prose only. `instruction` is a sentence for the system prompt. Limits: the token sits in the system prompt, so a model that is talked into repeating it hands it over (the redaction then still removes it from later wrapped text, but not from the model's own writing); the marking lowers the rate of lazy injections and does nothing against an adaptive one.

## 6. Concrete CVEs against coding agents

Verified only through search summaries and third-party databases on 2026-11-10; check each advisory before quoting.

- Cursor CVE-2025-54135 (CurXecute, fixed in 1.3) and CVE-2025-54136: injection rewrites `.cursor/mcp.json` and runs commands without approval. CVE-2025-59944: case-sensitivity bypass of the protected-file check (1.6.23 and earlier). CVE-2025-61590 and others: workspace settings routes to code execution (fixed 1.7).
- GitHub Copilot CVE-2025-53773: injected text in a repository or issue flips the agent into auto-approve ("YOLO") by editing settings. The corpus sample for `autoApprove ... true` has this shape.
- Claude Code CVE-2025-66032 (GHSA-xq4m-mc3c-vvg3, fixed 1.0.93): read-only command validation bypass through `$IFS` and short flags; requires untrusted content in context. Related: CVE-2025-54795 (echo parsing), CVE-2025-58764 (rg), CVE-2025-64755 (sed writes).

The common shape: the injection was the delivery; the damage came from an approval or protected-path check that could be bypassed or that the agent could edit. That supports putting effort into section 1's P4 to P6 and the existing command analysis, ahead of detection.

## 7. Open questions for the owner

1. After untrusted content entered the context, should calls that write outside the workspace, run network commands, or call an MCP tool of another server ask even when an allow rule matches (P6)? It costs approvals and is the one change that applies the Rule of Two.
2. Is a `changed` MCP server blocked, or only asked about? Recommend asked, with auto-approve held until answered.
3. Where should pins live: per user (settings), or per workspace? A workspace pin file in the repository would let a repository author approve their own server, so per user.
4. Is spotlighting worth the tokens and the system-prompt line for every fetch, or only for `fetch_url_content` and MCP results?

## 8. Unverified

- Figures taken from search summaries, not from the paper PDFs: CaMeL 77% against 84% (and the earlier 67%), Spotlighting percentages, InjecAgent 24% and 47%, ASB 84.3%, IH-Challenge 84.1% to 94.1% and 44% to 100%, the Attacker Moves Second 71% to 100%, Anthropic 1% and 17.6%.
- A claim, in one aggregator, of a 31.5% raw hijack rate for a later Anthropic model: not found in a primary source, not used.
- The phrase that OpenAI considers prompt injection never fully solvable: not found in the pages retrieved, not used.
- Willison's dual-LLM post (2023) and the Invariant tool-poisoning post (April 2025): cited from memory and secondary summaries; the GitHub MCP post was reached through search only.
- Tool shadowing and line jumping: described from vendor blogs (securew2, neuraltrust, mcpbundles, trackr); no primary disclosure was read.
- Cursor, Copilot and Claude Code advisory details: third-party mirrors (GitLab advisories, cvefeed, nsfocus, feedly); fix versions not checked against the vendors.
- Whether `MCPConnection` handles `tools/list_changed` and so lets a definition change mid-session: not read.
- That the CLI never flags output: concluded from a search for `flagToolOutput` in `extensions/cli/src`, which found nothing; another wrapper could exist.
- The corpus is mine; no external labelled set was used, and no model was called.
