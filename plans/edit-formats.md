# Edit formats per model family, and robust exact-string edits

Date: 2026-11-10. Scope: ROADMAP Track Q rows Q3 (edit format per family), Q4 (Claude's native text editor on Bedrock), Q6 (tool profile per family) and Q7 (tool-perturbation robustness), and `plans/tool-call-styles.md`. This note does not change any plan file. It records what the sources say, what we decided, and what was built first.

Evidence grades: **[P]** primary (vendor or paper text seen directly), **[S]** secondary (a summary, mirror or blog that reports the primary), **[W]** our inference. Every numeric claim from a search snippet is [S] unless stated. The "Unverified" list at the end is the list to re-check before any of it is quoted in a decision record.

## Decision summary

1. **Keep exact-string replacement as the one edit shape we offer by default.** It is what Anthropic's `str_replace`, Qwen Code's `edit`, Claude Code's `Edit` and Cursor-era agents converge on, and Diff-XYZ found search/replace beating udiff for most families (below).
2. **Make the exact-string path forgive the repeatable mistakes and name the one that was made.** This is the part we built (slice 1 below). It costs no new tool, no new prompt and no measurement, and it only ever applies an edit that has a single location.
3. **Do not add V4A patch, udiff or whole-file as default for any family yet.** They are Q3's arms. The one family where a non-search/replace format is a strong prior is OpenAI's GPT-class models and `apply_patch` (V4A). That belongs behind a tool-profile switch (Q6), default off, and only after Q3 measures a win on our bench.
4. **Q4 stays a spike.** The native Anthropic text editor is a tool type the model was trained on; whether Bedrock Converse accepts it is unconfirmed (our own plan says the AWS docs point to the Messages format). Our function-tool `Edit` has the same semantics (`old_str`/`new_str` against `old_string`/`new_string`), so the likely gain is small: argument-name familiarity, and the model's own training on the failure and retry loop. Measure before building a route.
5. **Weak models gain the most from harness changes, and the harness is where the gain is cheap.** The "harness problem" write-up reports the weakest models improving most from an edit-tool change alone ([S], below). That is the argument for putting effort into the matcher and error text before a per-family format.

## What the sources say

### Aider: formats, and which models need which

Aider's edit-format documentation lists `whole` (full file returned), `diff` (SEARCH/REPLACE blocks), `diff-fenced` (same, with the file path inside the fence), `udiff` (a simplified unified diff) and `editor-diff` / `editor-whole` (shorter prompts for the architect/editor split). It says Aider picks the best format for common models and that `--edit-format` overrides it. [P] [aider.chat/docs/more/edit-formats.html](https://aider.chat/docs/more/edit-formats.html), seen via search 2026-11-10.

Reported associations, all [S] from aggregators and blog posts (not re-checked against the leaderboard page): `udiff` was introduced for GPT-4 Turbo to curb "lazy coding" (eliding code behind placeholder comments); `diff-fenced` exists because Gemini models mishandled the plain fence; the polyglot leaderboard has a "format" column and a "percent using correct edit format" column, and the top entries as of the 2025-08-13 refresh are o3-pro (diff), Gemini 2.5 Pro Preview 06-05 (diff-fenced) and o3 high (diff). One aggregator puts GPT-5 high at 88.0 percent correct with 91.6 percent format compliance. Sources: [aiwiki.ai Aider Polyglot](https://aiwiki.ai/wiki/Aider_Polyglot), [capitalandcompute.net](https://capitalandcompute.net/ai-benchmarks/aider-polyglot/). These aggregators disagree on dates and some figures; read the leaderboard at aider.chat before quoting any number.

Takeaway [W]: the leaderboard's real information is the "correct edit format" column. A model that is strong at the task but loses 8 to 25 points to malformed edits is an argument for a forgiving applier, not for a different format.

### Diff-XYZ (JetBrains), and what it says about format per family

Our existing note already cites Diff-XYZ (arXiv 2510.12487, v2 revised 2025-11-17): on diff generation, search/replace beat udiff for Claude 4 Sonnet (0.94 against 0.82), GPT-4.1 (0.95 against 0.81), GPT-4o, Gemini 2.5 Flash and Qwen2.5-Coder-32B (0.68 against 0.23); GPT-4.1-nano preferred udiff (0.50 against 0.07). On apply, search/replace scored 0.92 against 0.84 for Qwen2.5-Coder-32B. [P via `plans/tool-call-styles.md`; paper URL: [arxiv.org/html/2510.12487v2](https://arxiv.org/html/2510.12487v2)]. A search summary of the same paper says search/replace "consistently performs best across all tasks for stronger models, while udiff and udiff-h remain competitive". [S]

Prior, not answer [W]: Diff-XYZ tested Qwen2.5-Coder, not Qwen3-Coder, and a single-file diff task, not a multi-turn repository edit. Q3 exists to run our own.

### Anthropic's text editor tool

The documented tool is `str_replace_based_edit_tool`, type `text_editor_20250728`, with commands `view`, `str_replace`, `create` and `insert`. [P] (quoted in `plans/tool-call-styles.md` from [platform.claude.com text-editor-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)). It is a "schema-less" tool: the schema is built into the model and cannot be changed by the developer, which is the evidence that Claude was trained on it. [S, community write-up in search results]. Error handling is the developer's: the reference handler pattern fails `str_replace` when the old string is absent or occurs more than once and returns that as a tool error so the model retries with more context. [S]. No official page found that specifies the error strings.

Claude Code's own `Edit` is exact-match only, with recovery by model retry rather than built-in fallbacks, per a third-party comparison ([lzwjava.github.io](https://lzwjava.github.io/code-edit-tools-compared-en), [S]). Its issue tracker shows the two failure classes that matter to us: "found 2 matches ... replace_all is false" and `replace_all` reporting success while skipping matches ([claudeissues.com/issue/3337](https://claudeissues.com/issue/3337-bug-error-found-2-matches-of-the-string-to-replace-but-replace-all-is-false), [claudeissues.com/issue/51986](https://claudeissues.com/issue/51986-bug-edit-tools-replace-all-silently-skips-matches-and-consumes-adjacent-newlines), [S]). The second is a reason our new matcher never recovers under `replace_all`.

### OpenAI `apply_patch` and V4A

`apply_patch` is an OpenAI-defined tool whose model output is a V4A patch: a `*** Begin Patch` envelope with `*** Update File`, `*** Add File`, `*** Delete File` sections and context-anchored hunks without line numbers. OpenAI's tool docs say the harness is responsible for interpreting and applying the patch, with reference implementations in the Agents SDKs ([developers.openai.com tools-apply-patch](https://developers.openai.com/api/docs/guides/tools-apply-patch), [P via search snippet]). A third-party write-up says Codex models are heavily trained on the format and that OpenAI's April 2025 GPT-4.1 prompting guide documented it with a note on "significant training effort" ([codex.danielvaughan.com](https://codex.danielvaughan.com/2026/03/31/codex-cli-apply-patch-v4a-diff-format/), [S]; the cookbook wording was not confirmed). Two practical claims, both [S] and unconfirmed: using the Codex model with any other edit tool loses accuracy, and a non-OpenAI-hosted GPT-4.1 deployment broke when `apply_patch` was assumed to be in the model's system behaviour ([Warp](https://www.warp.dev/blog/codex-models-in-warp-apply-patch-and-prompting-changes)).

Takeaway [W]: for Codex-class models the choice is not a preference; it is a training fact, so a profile with `apply_patch` is the one family-specific edit shape worth building, but only when we route Codex models (we do not today; see `plans/model-benchmark.md`).

### "Fast apply" models: Cursor, Morph, Relace

Cursor's instant-apply post describes a specialised apply model (a fine-tuned Llama-3-70B) run with speculative edits, a speculative-decoding variant that uses the original file as the draft, reaching about 1000 tokens per second ([cursor.com/blog/instant-apply](https://cursor.com/ja/blog/instant-apply), 2024, [P via search]). Morph sells the same idea as an API (`morph-v3-fast`, `morph-v3-large`), claiming 4,500 then 10,500 tokens per second and about 35 percent faster end-to-end task completion against search-and-replace ([morphllm.com/blog/morph-breaks-10k-barrier](https://www.morphllm.com/blog/morph-breaks-10k-barrier), vendor claim, [S]; the posts disagree on GPU and price). Relace's "instant apply" produced no source in our search; nothing recorded here.

Takeaway [W]: fast-apply is a different architecture: the main model writes a lazy "edit sketch" (`// ... existing code ...`) and a second model merges it. That is what the placeholder-elision failure in our corpus looks like to a plain exact-string tool. It is a product decision (a second model, a vendor dependency) and out of scope for Track Q's first slices. Worth recording as the reason our matcher rejects elision with a specific hint instead of guessing.

### Cline, Roo Code, OpenHands, others: failure handling

- Cline's `replace_in_file` takes SEARCH/REPLACE blocks; failure surfaces as "the SEARCH block did not match", the model retries, and a release note says it "prevents infinite retry loops when replace_in_file fails repeatedly" (3.54.0) ([developersdigest.tech/errors/cline](https://www.developersdigest.tech/errors/cline/diff-search-patterns-dont-match), [S]). Users report retry loops with weaker models ([r/CLine thread](https://redlib.ssps.io/r/CLine/comments/1l7u0bu/what_am_i_doing_wrong_loops_of_the_model_used), [S]). A fork of Cline's code shows a line-trimmed fallback match ([S]); no threshold was found for Cline or Roo in this pass.
- Other agent tools, found in search, use fuzzy fallbacks with explicit numeric bars: 70 percent Levenshtein similarity, above 80 percent "confidence", and 50 percent line similarity ([hermes-agent fuzzy_match.py](https://gitcode.com/brxiz/hermes-agent/blob/main/tools/fuzzy_match.py), [DesktopCommanderMCP edit_block](https://instagit.com/wonderwhy-er/DesktopCommanderMCP/edit_block-fuzzy-search-fallback/), [S]). Those bars are low enough to apply the wrong edit; ours is 0.92 mean and 0.75 per line, and only when unique.
- OpenHands' `str_replace_editor` and SWE-agent's `edit` were not re-read in this pass. SWE-agent's paper does record a design choice that applies directly: an edit that leaves the file syntactically invalid is reverted and the model is shown the attempted change and the original ([arxiv.org/pdf/2405.15793](https://arxiv.org/pdf/2405.15793), [P via search]). The paper's ablation of that linter guardrail was not isolated in the snippets, so no figure is cited.

### "The harness problem" (hashline)

A February 2026 write-up, "I Improved 15 LLMs at Coding in One Afternoon. Only the Harness Changed", compared three edit tools across 16 models: apply-patch (worst for nearly every model), exact replace, and "hashline" (lines tagged by content hash; the model refers to the tag instead of reproducing the text). It reports hashline matching or beating replace for most models, the weakest models gaining most, and about 20 percent fewer output tokens ([blog.can.ac/2026/02/12/the-harness-problem](https://blog.can.ac/2026/02/12/the-harness-problem), [S] via summaries; secondary numbers such as "6.7 to 68.3 percent for Grok Code Fast 1" were not verified and should not be quoted). Two uses for us: it ranks V4A last for non-OpenAI models (agreeing with decision 3), and it names a fourth shape, anchored-by-line-tag edits, that removes the exact-reproduction burden entirely. We do not build it now; the matcher below attacks the same burden from the receiving end.

## Which edit errors small open models make

No source in this pass measures per-error rates for Qwen, Llama or Nova on exact-string edits, so the list is assembled from the sources above and from our own runs, and marked [W]. Each entry maps to a strategy or hint in the matcher.

| Error                                                                                | Seen in                                                                                                        | Handling built                                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Indentation drifted: block copied at a shallower or deeper level, or tabs for spaces | Cline retry loops; Aider "diff" failures [S]                                                                   | Indentation-shifted match, new_string re-indented by the same delta                  |
| Trailing whitespace or collapsed spaces in a line                                    | common to all exact tools                                                                                      | Whitespace-normalised match, unique only                                             |
| CRLF file, model sends LF                                                            | Windows users of every tool [W]                                                                                | Line-ending-normalised match; new_string rewritten to the file's endings             |
| Interior line paraphrased while first and last lines are exact                       | "lazy" copying [W]                                                                                             | Unique anchored match on first and last line, interior mean similarity at least 0.8  |
| One-character typo in a long line                                                    | small models [W]                                                                                               | Fuzzy match, mean at least 0.92, no line under 0.75, unique                          |
| Elided code: `// ... existing code ...` inside old_string                            | fast-apply style prompts; udiff exists to stop this in output [S]                                              | Never matched; error names the line and says to write every line                     |
| Escaped quotes (`\"`) or literal `\n` left in the argument                           | JSON-in-JSON for models whose arguments arrive as text (Qwen XML, Python-syntax recovery in our own plans) [W] | Hints in the error; no silent unescaping, because a literal backslash can be correct |
| Line-number prefixes copied from a file view                                         | models trained on numbered views [W]                                                                           | Hint in the error                                                                    |
| Truncated old_string (cut mid-token)                                                 | output-limit hits, small models [W]                                                                            | Closest-region diagnosis, first diverging line shown                                 |
| Multiple matches                                                                     | every tool; explicit error in Claude Code                                                                      | Existing error kept; ambiguity after normalising is now an error naming the lines    |

Not handled and why: unescaping JSON on the model's behalf (changes meaning), case-insensitive recovery (the legacy path has one; see "Existing behaviour"), and cross-file mislocation (the error says no region is close and asks for a re-read).

## What we built (slice 1)

- `core/edit/searchAndReplace/recoverMatch.ts`: a pure function `recoverMatch(file, oldString, newString)`. It is called only when the existing matchers find nothing. Order: line endings, indentation shift, whitespace, anchored, fuzzy. A strategy that yields exactly one window applies; two or more is an `ambiguous` error naming the lines; none is a `notFound` error. It never applies under `replace_all`.
- The `notFound` diagnosis scores every window of the file against old_string (near-equal lines weighted up, an exact leading run bonused, since models usually get a prefix right then drift), then reports: the closest region's start line, the first old_string line that differs, the file's line there, up to three other similar lines, and hints for the shape errors above.
- `performReplace.executeFindAndReplace` calls it at the one place both core tools (`single_find_and_replace`, `multi_edit`) and the CLI `Edit` and `MultiEdit` already share, so the change reaches all of them. The error keeps its reason codes and its `Edit at index N: string not found in file: "..."` prefix, then appends the diagnosis. Exact matches take the existing path untouched.
- `editFailureCorpus.ts` (14 cases, **synthesised** from the failure modes above, not captured) and `recoverMatch.vitest.ts` (corpus table plus safety and wiring cases).

### Existing behaviour worth a decision

`findSearchMatch.ts` already ran trimmed, case-insensitive and whitespace-ignored (all whitespace removed) strategies ahead of ours, and the whitespace-ignored one can match across line breaks and indentation differences without re-indenting. We left them as they were to keep today's behaviour byte-identical. Two follow-ups: (a) drop the case-insensitive strategy, which can match the wrong identifier (a stricter change, so it needs its own row), and (b) have the whitespace-ignored strategy use the new re-indentation. Neither is done.

## What is not built

- Q3's bench arms (SEARCH/REPLACE block, whole-file) and a per-family result table.
- Q4's Messages-format Bedrock route.
- Q6's profile table, and any `apply_patch` or V4A support.
- Q7's tool-name perturbation groups.
- A success note for a recovered edit ("matched after shifting indentation"); `recoverMatch` returns it, the tools do not show it yet because `executeFindAndReplace` returns a string.
- Syntax-validity check after an edit (SWE-agent's guardrail); a candidate next slice, language by language.
- Captured failures replacing the synthesised corpus: the bench should log `old_string`, file and error for every `not found` and feed `editFailureCorpus.ts`.

## Next slices, in order

1. Capture real edit failures in `bench/` runs (old_string, file hash, family) and replace synthesised cases; count how many a recovered match would have saved. Without this the bars (0.92, 0.75, 0.8) are priors.
2. Q3 arms: exact-string (with the matcher) against SEARCH/REPLACE blocks on one seeded repo, for Qwen3-Coder and Nova first, since they are the models our logs show failing.
3. Report recovered-edit notes in tool results, so the model learns its mistake without a failed call.
4. Q6 profile with `apply_patch` for Codex-class models, default off.

## Unverified

- Aider leaderboard figures and the "udiff for GPT-4 Turbo, diff-fenced for Gemini" mapping: aggregators, not the leaderboard or Aider source.
- The GPT-4.1 cookbook wording on V4A training, and the Azure failure story.
- The harness-problem numbers beyond "weakest models gain most, patch worst, about 20 percent fewer tokens".
- Morph throughput, cost and the "35 percent faster" claim (vendor, inconsistent between posts); Cursor's figure is from 2024.
- Cline and Roo matching ladders and any thresholds.
- That Bedrock Converse rejects `text_editor_20250728`.
- Per-error rates for small open models: none measured by any source here.
- The 0.92, 0.75 and 0.8 similarity bars: chosen to be conservative, not tuned on data.
- OpenHands' `str_replace_editor` behaviour and SWE-agent's guardrail ablation figure: not read.
