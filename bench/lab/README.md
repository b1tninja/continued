# Local lab

A scripted test harness for finding out what a local model (Ollama) responds to: which tool-call format, which prompt style, native `tools` field or the family's own text dialect. It is built for a resource-limited machine: one model at a time, one request at a time, hard budgets, resumable, and it refuses models that are too big for the limits you set.

Plain Node ESM (Node 22.13 or newer, the repository's `.nvmrc` is fine), no npm dependencies. It is dev-only: nothing in `core/`, `gui/`, `extensions/`, `binary/` or `packages/` imports it and no workflow runs it. It is designed so the whole folder can move to its own repository (see "Moving this folder").

Everything here is a measurement of a **local build and quantisation** of a model. It tells you what that local model does, not what the hosted model does.

## Quick start on this machine

Facts read on 2026-11-10 (run `inventory` for current ones): Ollama 0.40.13 at `http://127.0.0.1:11434`, 125 GB RAM, RTX 5090 with about 32 GB VRAM (`nvidia-smi`; the OS reports 4 GB because the adapter figure is a 32-bit cap). Models live in `D:\ai\models\` (`OLLAMA_MODELS`), and **that drive has about 1.3 GB free**. The lab never pulls, copies or deletes a model and never writes there.

Installed models that can chat with tools are all large (17 to 23 GB). `glm-ocr`, `deepseek-ocr` and `qwen3-embedding` are refused as not chat models. The smallest capable one is `qwen3.6:27b` (17.4 GB), so the default limits (8 GB) refuse it and you raise them on purpose:

```sh
# 1. what is installed and what is safe (reads only, loads nothing)
node bench/lab/lab.mjs inventory

# 2. a dry plan: cases x models x passes and an estimated time (sends nothing)
node bench/lab/lab.mjs plan --suite dialect-probe --models qwen3.6:27b --max-vram 20 --max-ram 20

# 3. optional: measure real speed with ONE tiny request (loads the model, then unloads it)
node bench/lab/lab.mjs plan --suite dialect-probe --models qwen3.6:27b --max-vram 20 --max-ram 20 --warmup

# 4. a first small real run: 6 cases (3 probes, each native and text), at most 12 requests, 10 minutes
node bench/lab/lab.mjs run --run --suite dialect-probe --models qwen3.6:27b \
  --max-vram 20 --max-ram 20 --limit 6 --max-requests 12 --max-minutes 10

# 5. read it
node bench/lab/lab.mjs report
node bench/lab/lab.mjs suggest        # writes bench/lab/profiles/<model>.json
```

Expected time for step 4: loading a 17 GB model takes tens of seconds, then each probe is a reply of under 100 tokens, a few seconds each. The plan prints its own estimate (assumed 20 tokens a second until it has a measurement, from `--warmup` or from earlier results). Treat the figure as an estimate, not a promise; the first run on this machine will replace it with a measured one. Thinking is switched off (`think: false`) for models that report a thinking capability, because reasoning tokens would dominate the time.

**To interrupt:** press Ctrl-C once. The lab finishes the request in flight, writes its record, sends `keep_alive: 0` to unload the model and exits with code 130. Press Ctrl-C a second time to quit at once (the model then unloads by itself after its 2 minute keep-alive, or run `ollama stop <model>`). Rerun the same command to resume: completed cases are skipped.

## Safety

- **One model, one request at a time.** There is no concurrency option; `--concurrency` other than 1 is refused.
- **Size guards.** `--max-vram GB` (default 8) and `--max-ram GB` (default 16) refuse a model whose reported size (weights on disk, a floor for what it needs loaded) exceeds them. A model is also refused if it is larger than the VRAM `nvidia-smi` says is free right now, if it is an embedding or OCR model, or if another model is already loaded (`--ignore-loaded` overrides that one).
- **Budgets.** `--max-requests` (default 60), `--max-minutes` (default 30 wall clock for the run), `--model-minutes` (default 15 per model), `--request-timeout` seconds (default 120). Any of them ends the run cleanly after unloading.
- **Cooldown** `--cooldown` seconds (default 15) between models, interruptible.
- **Circuit breaker.** Three consecutive failed requests stop that model.
- **Unload.** Every model is unloaded with `keep_alive: 0` when its cases finish, on error, and on interrupt.
- **Dry by default.** `run` prints the plan and sends nothing unless you pass `--run`.
- **Network.** Only the `--base-url` you give, and it must be loopback (`127.0.0.1`, `localhost`, `::1`) unless you pass `--allow-remote`. No credentials are read or sent.
- **Writes.** Only to `bench/lab/results`, `bench/lab/profiles` and a `continuous-lab` folder under the OS temp directory. `lib/paths.mjs` refuses any other path, and the tests check that. The product is read only. `suggest` writes profiles to the lab's own folder and never touches `core/util/toolDialectPresetTable.ts`.
- **Models.** The lab never runs `ollama pull`, `rm` or `create`.

## Commands

| command                     | what it does                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory`                 | Machine facts (nvidia-smi VRAM, RAM, models directory and its free disk, what is loaded), then every installed model: size, quantisation, family, context, `tools` capability, the preset row it matches and that row's `promptStyle`, and whether it is safe under the limits. |
| `plan --suite S --models M` | Cases x models x passes, how many remain after earlier results, and estimated minutes. `--warmup` sends one tiny request per model to measure tokens a second.                                                                                                                  |
| `run --run`                 | Runs the plan. Appends one JSON line per finished case.                                                                                                                                                                                                                         |
| `report`                    | Markdown: per model and per arm and case group, valid-call rate with a Wilson 95% interval, outcome counts, false calls, median tokens, latency and tokens a second, plus which recovery parsers read the text replies. `--suite`, `--file`, `--out`.                           |
| `diff <before> <after>`     | Two result files, per arm: both rates, the change, whether the intervals are disjoint, and the cases that flipped. For before and after a prompt change.                                                                                                                        |
| `suggest`                   | Writes `profiles/<model>.json` (see below).                                                                                                                                                                                                                                     |
| `fixtures --suite S`        | Writes observed corpus fixtures from raw replies to `results/fixtures/` (see below). `--only-leaks`.                                                                                                                                                                            |
| `snapshot-tools`            | Regenerates the real agent tool list from the product's install (needs `core` dependencies installed) into `results/agent-tools.snapshot.json`; copy it to `fixtures/agent-tools.json` to adopt it.                                                                             |

`--models` takes names, `smallest-safe` or `all-safe`. `--passes N` repeats each case; use at least 3 to 5 for any claim, intervals are wide below that. `--limit N` takes the first N cases (stratified by class for the reviewer suite). `--num-ctx` sets the context (default 8192, 16384 for `leaks`).

## Suites

Suites are data files in `suites/`; pass a name or a path.

**`dialect-probe`** (the R3 experiment, locally). Six Tier 1 probes: a native call, parallel calls, an integer argument, quotes, newlines and unicode in a string, a nested object, and a prompt that needs no tool. Each is sent two ways:

- `native`: the `tools` field through `/api/chat`.
- `text`: no `tools` field; the system prompt teaches the family's trained-in dialect, taken from the model's preset row `promptStyle` (`qwen-xml`, `hermes-json`, `glm-xml`, `pythonic`, `llama-json`, `toolcall-json`) or the generic `codeblock` when the preset says `native` or there is none. `--styles all` or a list asks every style of the same model, which is how you find the style a model prefers.

Each reply is classified as `structured` (a tool call came back), `text-call` (a call written as text that the product's leak detector `classifyToolReply` or one of the recovery parsers can read), `format-broken` (tool markup that nothing can read, or arguments that are not a JSON object), `refused` or `prose`. Every recovery parser is run on every text reply and the report says which would have recovered it. A reply is _valid_ when the right tool was called with arguments that fit the schema and match what the probe asked for.

**`prompt-variants`**. Three tasks (read, run, no-tool) under seven system-prompt styles: terse, verbose, example-laden, XML-tagged, JSON-schema-first, announce-then-call, call-only. Scored by call validity, schema validity, false calls (a call when none was needed), tokens and latency. `--variants file.json` replaces the variants with your own (`[{id, system, delivery?}]`, with `{{TOOL_NAMES}}`, `{{TOOL_LIST}}`, `{{TOOLS_JSON}}` filled in); `--deliveries native,text` runs each variant with the tools field and with the dialect in the prompt.

**`reviewer`**. The Auto-mode reviewer evaluation with a local model as the reviewer. The labelled set is the product's B4 evaluation set (`core/tools/permissions/auto/evaluation/cases.ts`); the prompt is the product's `buildReviewMessages` and the verdict is read by the product's `parseReviewerReply`. When the B12 gate lands, point `--dataset` at its labelled set (an array of `{id, request, tool, args, expect, category?}`). A case is acceptable when a deny or ask case is not allowed, or an allow case is allowed; the report adds dangerous allows (the number that matters) and unusable replies. The rules engine is not applied, so every case reaches the model: stricter than Auto mode itself.

**`leaks`**. The R4/R6-style census. The agent's eight common prompts with 2, 14, 60 or all 21 real agent tools, at chosen temperatures, streaming and not. The default grid is small (2 and 14 tools, temperature 0, not streamed); `--full-grid` runs every combination, or pick with `--tool-counts 2,14,60,agent --temperatures 0,0.7 --streams false,true`. Streaming runs keep the chunk boundaries.

## Results and learning

Each suite appends to `results/<suite>.jsonl`, one record per case and pass, keyed `suite|model|caseId|pN`. A record holds the classification, the score, token counts and timings, and the **raw reply** (text, thinking, tool calls, stop reason, stream chunks). A torn last line from an interrupted write is ignored on the next run. Errors are recorded and never counted in a rate; `--retry-errors` reruns them.

`suggest` reads the results and writes `profiles/<model>.json`: the ranked arms (native, each text style, each prompt variant) with counts and Wilson intervals, the best text style, whether native beats text at this sample size (only when the intervals are disjoint), the leak dialects seen, the parsers that recovered text, and a `row` in the shape of a preset-table row (`nativeToolCalls`, `textDialect`, `promptStyle` with its evidence string, `observedLeak`, `recoverWith`, `unverified`). It says `unmeasured` and `not enough evidence` below `--min-n` (default 8) replies per arm. A person reads the profile and decides what, if anything, goes into `core/util/toolDialectPresetTable.ts`.

`fixtures --suite S` turns recorded replies into observed corpus fixtures in the format the product's live-capture harness writes (it calls the product's `buildFixture`, so the format cannot drift): unreviewed negatives with `policy: "either"`, to be promoted to positives by hand once the calls they should yield are agreed. Copy chosen files into `core/llm/toolDialects/corpus/fixtures/` in a product PR.

`samples/` holds a small committed example of each output. It was generated against the fake server in `test/fakeOllama.mjs`, so it measures nothing.

## Tests

```sh
cd bench/lab && npm test        # node --test "test/*.test.mjs"
```

They run offline against a fake Ollama (`test/fakeOllama.mjs`, `node:http`): streaming and non-streaming, native and text calls, timeouts, abort, resume, the budgets, the guards, report and interval maths, profiles, diffs, fixtures. Tests that need the product's parsers or reviewer skip themselves when the adapter cannot find a product checkout.

## Moving this folder to its own repository

The only module that knows about the product is `adapter.mjs` (a test fails if any other file imports outside the lab). It locates the checkout from `--product <dir>`, then `$LAB_PRODUCT_ROOT`, then two levels above the lab, and loads TypeScript through a small load hook (Node's own `module.stripTypeScriptTypes`, Node 22.13 or newer; if the product's `typescript` package has `transpileModule` it is used instead). It reads, and the lab uses:

- `core/util/toolDialectDetect.ts`: `classifyToolReply`, `dialectFromChatTemplate`, the thresholds.
- `core/util/toolDialectPresetTable.ts`: the preset table (what we expect each family to write; the lookup is mirrored in the adapter).
- `packages/openai-adapters/src/dialects/{qwenXml,hermesJson,glmXml,pythonic,llamaJson}.ts`: the recovery parsers.
- `core/llm/toolDialects/capture/fixture.ts`: `buildFixture`, the observed-fixture writer.
- `core/tools/permissions/auto/{prompt,parse}.ts` and `evaluation/cases.ts`: the reviewer prompt builder, verdict parser and B4 set.
- `core/llm/toolDialects/capture/tools.ts` (on demand, `snapshot-tools` only): the real agent tool list.

Every section degrades to `null` with a line in `product.missing`, so the lab still runs the parts that do not need the missing piece. To move it: copy `bench/lab` to the new repository's root, set `LAB_PRODUCT_ROOT` to a product checkout, and drop the `!bench/lab/lib/` and `bench/lab/results|profiles` lines from the product `.gitignore` (the new repository needs its own `results/` and `profiles/` ignores).

**What the product keeps:** the corpus (`core/llm/toolDialects/corpus/fixtures`) and its runner and pinning tests, the preset table and its drift test, the live-capture harness (`core/llm/toolDialects/capture`), the parsers, the leak detector, and the reviewer and its B4 or B12 gate. The lab is a consumer of those and a source of candidate fixtures and profiles; promotion into the product stays a reviewed product PR. Two things the lab copies on purpose so it does not depend on the product to run: the eight capture prompts in `suites/leaks.json` and the frozen agent tool list in `fixtures/agent-tools.json` (regenerate with `snapshot-tools`).

## Layout

```
adapter.mjs   the one module that touches the product
lab.mjs       the CLI
lib/          ollama client, guards, suites, classify, run, report, diff, suggest, fixtures, inventory, stats, paths, prompts
suites/       dialect-probe, prompt-variants, reviewer, leaks (data)
fixtures/     frozen agent tool list
samples/      small committed examples (from the fake server)
test/         offline tests and the fake Ollama
results/      gitignored: JSONL results and fixtures
profiles/     gitignored: learned profiles
```
