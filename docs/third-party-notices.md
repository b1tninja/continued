# Third-party notices and fixture licences

This page records what this repository contains that it did not write, under which terms, and the policy for data copied from other projects. It is checked by `scripts/ci/check-notice.mjs`.

## 1. This fork and Apache-2.0 section 4

- The work is a fork of [continuedev/continue](https://github.com/continuedev/continue) (Apache-2.0, verified through the GitHub licence API on 2026-11-10). `LICENSE` is the Apache-2.0 text and keeps the upstream appendix line `Copyright 2023 Continue Dev, Inc.`
- Section 4(a): recipients receive the licence (`LICENSE`).
- Section 4(b): files changed in this fork are changed by b1tninja. The history is the record (`git log --follow <file>`), and the README states that the original work is (c) 2023-2026 Continue Dev, Inc. and that changes are (c) 2026 b1tninja.
- Section 4(c): copyright, patent, trademark and attribution notices in source files are kept.
- Section 4(d): upstream has **no `NOTICE` file** (404 from the contents API on 2026-11-10), so there is no upstream notice text to reproduce. A `NOTICE` file added here carries only notices for code that is included; the open secret-scan pull request (#536) adds one for the gitleaks rules. A `NOTICE` does not change the licence.
- Section 6: the upstream name and marks are not licensed. The README says the fork is not endorsed by or affiliated with Continue Dev, Inc.
- `extensions/cli/package.json` and `core/package.json` say `"author": "b1tninja"`, as `extensions/vscode/package.json` does; the upstream copyright stays in `LICENSE`.

## 2. Code and data included from other projects

| Material                        | Where                                                                    | Licence                                                    | State                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@anthropic-ai/sandbox-runtime` | referenced by `extensions/cli/src/commands/sandbox.ts`, plans/isolation  | Apache-2.0 as reported in plans/isolation.md; verify first | Not vendored, no configuration patterns copied. If it becomes a dependency the lockfile lists it; see docs/supply-chain.md                 |
| gitleaks default rules          | `core/util/secretScan/rules.ts` (open PR "secret-scan-foundation", #536) | MIT, (c) 2019 Zachary Rice                                 | That PR adds the notice and licence text to `NOTICE`; this page does not duplicate it. The notice must be in the tree that ships the rules |
| detect-secrets patterns         | none                                                                     | Apache-2.0                                                 | Not ported as of 2026-11-10. Add an entry before any pattern is copied                                                                     |
| `playwright-core` 1.64.0        | `bench/screenshots`, installed on demand, not committed                  | Apache-2.0 (from its lockfile entry)                       | Dev-only, in no release artifact                                                                                                           |
| Chat template excerpts          | section 3                                                                | per model repository                                       | Excerpts only                                                                                                                              |

## 3. Chat template excerpts used as fixtures

Two places hold text derived from Hugging Face model repositories:

- `core/llm/toolDialects/corpus/fixtures/*.json`: 252 fixtures. 181 name a Hugging Face repository in `provenance.source` (31 repositories). The other 71 are synthesised from documentation, observed live, or derived from another fixture.
- `bench/research/test/fixtures/templates/*.jinja`: 62 reduced templates, and `bench/research/test/fixtures/dataset.json` (excerpts, sha256 and the licence field per repository).

### Policy

1. Excerpts only, **under 1,200 characters**, never a whole template. Prefer synthesising a small example in the shape of the template over copying it.
2. Every fixture has `provenance.source` with the source URL (hard check).
3. A fixture whose source is a Hugging Face repository should carry `provenance.license` with the licence id from the repository card (checked with `--strict` in CI).
4. A restrictive licence (Llama community licences, Gemma terms, `other`) is not a reason to drop a fixture, because the content is a few lines of protocol syntax and markers. It is a reason to keep the excerpt short, keep the attribution, and not reuse the fixtures outside this repository's tests. If a rights holder objects, the fixture is removed.
5. Fixtures are test data. They are not shipped in the extension or the CLI.

### Licence per source repository

Licence ids were read from the Hugging Face model API on 2026-11-10 (from `dataset.json` for the repositories it covers, by a direct API read for the rest). **Restrictive** marks terms beyond a permissive open-source licence; read the model card before widening use.

| Licence                                                                                 | Repositories                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT                                                                                     | deepseek-ai/DeepSeek-R1, DeepSeek-V3.1, DeepSeek-V3.2; zai-org/GLM-4.5, GLM-4.7; meituan-longcat/LongCat-Flash-Chat                                                                                                                                                                                                              |
| Apache-2.0                                                                              | google/gemma-4-31B-it; Qwen/Qwen3-30B-A3B, Qwen3-Coder-30B-A3B-Instruct; mistralai/Mistral-7B-Instruct-v0.3; unsloth/Devstral-Small-2507; ibm-granite/granite-3.3-8b-instruct, granite-4.0-h-small; openai/gpt-oss-120b; tencent/Hy3; allenai/Olmo-3-7B-Instruct; ByteDance-Seed/Seed-OSS-36B-Instruct; HuggingFaceTB/SmolLM3-3B |
| **Restrictive: Gemma terms** (`gemma`)                                                  | unsloth/gemma-3-27b-it (1 fixture)                                                                                                                                                                                                                                                                                               |
| **Restrictive: Llama community licences** (`llama3.3`, `other` with the llama4 licence) | unsloth/Llama-3.3-70B-Instruct (2), unsloth/Llama-4-Scout-17B-16E-Instruct (1)                                                                                                                                                                                                                                                   |
| **Restrictive: `other`**                                                                | moonshotai/Kimi-K2-Thinking, Kimi-K2-Instruct, Kimi-K3; MiniMaxAI/MiniMax-M2, MiniMax-M2.5 (`modified-mit`), MiniMax-M3; nvidia/NVIDIA-Nemotron-Nano-9B-v2; LiquidAI/LFM2-8B-A1B (LFM 1.0 licence); upstage/Solar-Open-100B (Upstage Solar licence)                                                                              |

Totals as the check prints them: 314 corpus fixtures, 0 missing `provenance.source`, 242 Hugging Face sourced, 242 with `provenance.license` (backfilled by `scripts/ci/backfill-fixture-licence.mjs`; `--strict` now passes).

One reduced template, `meituan-longcat__LongCat-Flash-Chat.jinja`, was 1,224 characters; a clause of the code-interpreter tool description was cut and it is now 1,193.
