# Model research tool (slice 1)

A small, dev-only tool that reads the public Hugging Face metadata of a handful
of model repositories, classifies which tool-call form each chat template
writes, and checks the result against `core/util/toolDialectPresetTable.ts`.
It exists to catch drift in that hand-read table. It is not a measurement of any
model.

Plain Node ESM (`.mjs`), no dependencies, Node 22 or newer. It is not part of
any workspace and nothing in `core/`, `gui/`, `extensions/`, `binary/` or
`packages/` imports it, so no release artifact includes it (the VS Code
`.vscodeignore` is relative to `extensions/vscode`, the CLI publishes an
explicit `files` list, and the tsconfig `include` lists of core, binary, gui and
the extension do not reach `bench/`). It is not wired into any workflow.

## Commands

```sh
# read the repos in repos.json (or --repo owner/name ...) and print the dataset JSON
node bench/research/mrt.mjs fetch --out "$TMPDIR/hf.json"
node bench/research/mrt.mjs fetch --write          # save to bench/research/data/hf.json

# compare with the preset table; exit 0 clean, 1 disagreement, 2 could not check
node bench/research/mrt.mjs check --data "$TMPDIR/hf.json"
node bench/research/mrt.mjs check --strict         # undecided, gated and unmatched also exit 1

# markdown tables on stdout
node bench/research/mrt.mjs report

# tests: offline, from fixtures
cd bench/research && npm test
```

`check` reads the table as text (a small parser in `lib/table.mjs`); it does not
import core or run TypeScript. A table that does not parse is exit 2.
`undecided` is never counted as agreement.

## What it will never do

- write or patch the preset table or any other source file
- commit or stage anything, or write outside `data/` (only with `--write`) or `--out`
- read or send a credential. `HF_TOKEN` and similar variables are ignored, and
  the tool says so if one is set
- call a model or an inference endpoint
- download weights: only `README.md`, `config.json`, `generation_config.json`,
  `tokenizer_config.json` and `chat_template.*` are allowed, and only from
  `https://huggingface.co`; a redirect to another host is refused
- work around a gate. A gated repo is recorded as `gated` and its template is not
  read (the API does return it without a token; whether to use that is an owner
  question, so it needs `--read-gated-config`). A private or missing repo
  answers 401 and is recorded as `unavailable`

## Files

| Path               | What it is                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `mrt.mjs`          | The command line                                                                           |
| `repos.json`       | The repos fetched by default: one representative per preset row that has a public template |
| `lib/classify.mjs` | The classifier: literal-marker rules, explicit `undecided`                                 |
| `lib/http.mjs`     | Polite client: ETag cache, delay, budget, rate-limit stop                                  |
| `lib/hf.mjs`       | One repo to one dataset record                                                             |
| `lib/table.mjs`    | Text reader for the preset table                                                           |
| `lib/check.mjs`    | Comparison, classes and exit codes                                                         |
| `test/`            | `node --test`, fixtures are reduced templates, never whole files                           |
| `data/`            | Generated dataset. Not committed by the tool; listed in `.prettierignore`                  |

## The dataset

One JSON file, repos sorted by name, one record per repo: the commit `sha`, the
`license` and `gated` fields of the repo, where the template came from, its
`sha256` and length, whether it renders a `tools` list, the verdict, and an
excerpt of at most 1200 characters around the first marker. Never a whole
template: many sit under model licences and some repos are gated, so a copy in
this repository would be a redistribution question. Whole responses go only to
the cache directory (`$TMPDIR/continuous-model-research-cache`, or `--cache`),
outside the repository.

## The classifier, and how well it does

Each form is a set of literal substrings that must all be present (for example
`<function=` and `<parameter=` for `qwen-xml`). Exactly one form: decided. A
template that renders a tools list but matches no rule: `undecided`. Two forms:
`undecided`. No template at all: `undecided`. No tools in the template: `none`.
The generic `<tool_call>` JSON rule is dropped when a more specific rule also
matched, because Qwen-XML and GLM-XML are wrapped in the same tag.

The rules were written while reading 31 templates (the "dev" set in
`test/fixtures/labels.json`). That 31 of 31 is a fit, not a validation. The
first hold-out set is 21 templates from repos that were not used to write the
rules, whose truth label (the call form the vendor's template writes) I read by
hand before comparing it with the classifier. Measured once, before any rule
was touched:

| Outcome                                      | Count |
| -------------------------------------------- | ----: |
| Decided                                      |    15 |
| of which correct                             |    14 |
| of which wrong                               |     1 |
| Undecided                                    |     6 |
| of which truly a form with no rule (correct) |     6 |
| Known form wrongly left undecided            |     0 |

Precision of the decided verdicts was 14 of 15 (93%). The wrong one was
ByteDance Seed-OSS: its template writes
`<seed:tool_call><function=...><parameter=...>`, and the `qwen-xml` rule
accepted the inner markup without checking the wrapper. The six undecided were
IBM Granite 3.3 (`<|tool_call|>`), Liquid LFM2 (`<|tool_call_start|>[f(...)]`),
Phi-4-mini, OLMo 3 (`<function_calls>`), Meituan LongCat
(`<longcat_tool_call>`) and Upstage Solar Open (`<|tool_call:begin|>`).

### Second round: wrapper check, five classifier-only forms, a fresh hold-out

Changes (2026-11-10): the `qwen-xml` rule now also requires the plain
`<tool_call>` tag to open `<function=` (allowing jinja quoting and the escaped
newline between them), so Seed-OSS is its own verdict `seed-xml`. Five forms
from the first hold-out get a rule each, as classifier verdicts only:
`granite-tokens` (`<|tool_call|>`), `lfm-tokens` (`<|tool_call_start|>`),
`longcat-json` (`<longcat_tool_call>`), `solar-tokens` (`<|tool_call:begin|>`)
and `olmo-function-calls` (`<function_calls>`). None is a preset dialect and no
parser exists for any: `check` reports such a verdict against a row that
records `none` as `novel` (neither agree nor disagree, exit 1 under `--strict`),
and against any other row as a disagreement. Phi-4-mini stays undecided.

The first 21 are now a fit (20 of 20 decided are right, 1 undecided), because
five rules were written from them. The honest number is the fresh set: 20 repos
that were not read when the rules were written, labelled by hand from the full
templates before the classifier ran on them (`fresh` in `labels.json`):

| Outcome                                      | Count |
| -------------------------------------------- | ----: |
| Decided                                      |    16 |
| of which correct                             |    16 |
| of which wrong                               |     0 |
| Undecided                                    |     4 |
| of which truly a form with no rule (correct) |     2 |
| Known form wrongly left undecided            |     2 |

Precision of the decided verdicts is 16 of 16, but read it with its limits:
four of the 16 are `none` (templates with no tool support, the easy case); one
(Granite 3.2) is the form the Granite 3.3 rule was written from, so it is not
independent; the sample is small and the interval wide, so 100% is not a rate.
Recall is the weaker side: SmolLM3 (`"name"` written with escaped quotes) and
Falcon-H1 (single-quoted `'name'`) write the Hermes form, but the hermes-json
rule wants a literal `"name"`, so both stay undecided. Undecided and correctly
so: Google FunctionGemma (`<start_function_call>call:NAME{...}`) and Liquid
LFM2-1.2B-Tool, whose template renders the tool list but contains no call
writer. The numbers are pinned by `test/classify.test.mjs`.

Candidates not used: THUDM/GLM-4-32B-0414 (401). Four earlier candidates were
gated or unavailable (Cohere Command R7B and Command A, Google Gemma 3n,
Salesforce xLAM).

## What it cannot answer

- What a model emits. A template is what the model is trained to read and write
  in history, not a measurement. Leak rates, false calls, argument-encoding
  faults and prompt adherence need the live bench (`bench/`).
- Whether a hosted provider (Bedrock, an OpenRouter provider) parses the markup
  on the server.
- Anything about closed models (Claude, GPT, Gemini, Grok, Nova): those rows are
  listed as `no-public-template`, never inferred.
- Families without a Hub template: Mistral and Devstral repos use
  `mistral_common`, Kimi K3 and DeepSeek V3.2 and V4 ship Python encoders. They
  are `undecided: no-template`; the tool does not fetch the encoders.
- Server-parser names, sampling defaults and system-prompt advice: not in slice 1.

## Rate limits and politeness

The Hub API allows 500 requests per 5 minutes unauthenticated, and raw files
3000 per 5 minutes (read from the `RateLimit-Policy` header on 2026-11-10; the
header can change). The client sleeps 200 ms between requests, sends
`If-None-Match` with the stored ETag so unchanged repos cost a 304, stops on a
429 without retrying (it prints `Retry-After` and `RateLimit`), stops when the
`RateLimit` header says the window is used up, and refuses to send more than
`--budget` requests (default 100). The default repo list is about 30 repos and
sends one API request each, plus raw requests only when the API response has no
template. The user agent is
`continuous-model-research/<version> (+https://github.com/b1tninja/continuous)`
and carries no personal data.
