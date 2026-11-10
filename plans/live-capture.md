# Live tool-call capture (I23)

A script that measures how a model answers a tool request under the agent's
real conditions, stores every raw reply as an observed corpus fixture, and
prints leak, structured and refused rates with Wilson 95 percent intervals.
Code: `core/llm/toolDialects/capture/`; entry point `core/scripts/capture-live.mjs`
(`npm run capture:live` in `core`).

## What it does differently from the first live run

- The tool list is the agent's own: `getBaseToolDefinitions()` plus the
  config-dependent definitions as a non-IDE, non-remote agent builds them
  (about 17 tools), not two toy tools. MCP tools are not included.
- Each prompt is sent streaming and non-streaming, for N passes (default 3), at
  the model's default temperature and at 0. Eight prompts cover read, run (twice),
  glob, ls, create, plan and fetch.
- Transports: Bedrock Converse and ConverseStream through the AWS SDK
  (`--profile`, `--region`), and any OpenAI-compatible base URL (Ollama, Strata,
  vLLM) over `/chat/completions`, with SSE streaming.

## Usage

Planning is the default. Without `--run` the script prints the cost plan (calls,
tool tokens, input and output tokens, dollars when prices are given) and exits
without calling any model.

```sh
cd core
# plan only
node scripts/capture-live.mjs --model bedrock:us.meta.llama3-3-70b-instruct-v1:0 \
  --profile torgate --price-in 0.72 --price-out 0.72
# run: one Bedrock model and one local model
node scripts/capture-live.mjs --run --out D:/temp/capture \
  --model bedrock:us.meta.llama3-3-70b-instruct-v1:0 --profile torgate \
  --model openai:qwen3-coder:30b --base-url http://127.0.0.1:11434/v1
```

Options: `--passes`, `--temps default,0`, `--streaming both|stream|whole`,
`--max-tokens`, `--max-calls` (a plan above it is refused, default 500),
`--api-key-env`, `--out`. `--model` takes `bedrock:<id>` or `openai:<id>` and
may repeat. The default `--out` is a new folder under the temp directory, never
the repository.

## Output

- `raw/<id>.json`: the full reply, request metadata and classification, for
  every call including errors.
- `fixtures/<id>.json`: an observed corpus fixture for every reply that has
  text, in the format of `core/llm/toolDialects/corpus` (it passes
  `validateFixture`). Streamed replies carry an `observed` stream with the real
  delta boundaries beside `whole`, `char` and `inside-multibyte-char`.
  Captures are written as unreviewed negatives (`policy: either`, `markers: []`);
  promote a leak to a positive fixture by hand once its calls are agreed.
- `report.txt`: per model, transport, streaming and temperature, the leak,
  structured and refused rates with Wilson intervals. Errors are excluded from
  every denominator and counted apart.

Classification uses `classifyToolReply`, not a hand regex: structured when the
server returned a call; leak when the text classifies as a markup dialect at or
above the advisory threshold (0.5, because a bare Llama JSON object scores 0.7);
refused when neither.

## Limits

- Not run live: no model was called while building it. The planner, fixture
  writer, SDK and HTTP reply parsers and interval maths are unit-tested with mocked
  clients (`capture.vitest.ts`).
- Prices are not read from the repository tables; pass them or read tokens only.
- Fixture `family` is `unreviewed` and `markers` empty until a person reviews.
- Interval note: 1 of 8 has a Wilson 95 percent interval of 2 to 47 percent
  (the review that proposed this wrote 0.3 to 53 percent; 2 of 8 is 7 to 59).
