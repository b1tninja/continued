# Server metadata fixtures

Bodies of Ollama `POST /api/show` and llama.cpp `GET /props`, used by
`serverHintFixtures.vitest.ts`, `ollamaShowHint.vitest.ts` and
`openaiCompatTest.vitest.ts`. No test calls a server or a model.

## Provenance

- `ollama-show/` files without a prefix (`qwen3.6-27b`, `glm-ocr`,
  `qwen3-embedding-8b`) are bodies recorded from a local Ollama.
- Files named `synthetic-*` were built, not recorded. The envelope is the
  documented response (keys `modelfile`, `parameters`, `template`, `details`,
  `model_info`, `capabilities`) plus the `parser`, `renderer` and
  `template_source` keys that the recorded `qwen3.6-27b` body shows for a model
  served through a renderer and parser. Parser names are the ones registered in
  `ParserForName`; family and capability values are plausible, not measured.
- `llamacpp-props/synthetic-*` use the documented `/props` envelope
  (`default_generation_settings`, `total_slots`, `model_path`, `chat_template`,
  `chat_template_caps`, `modalities`, `build_info`). `chat_template` holds only
  the tool-call lines of the published template of the named family, not the
  whole Jinja file, so the dialect sniff has something to read.

## Sources (read 2026-11-11)

- Ollama API, show model information:
  https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md
- Ollama parser names (`ParserForName`):
  https://raw.githubusercontent.com/ollama/ollama/main/model/parsers/parsers.go
- llama.cpp server, `GET /props`:
  https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md

Gaps: Ollama has no Kimi parser, so no Kimi `/api/show` fixture exists; the
`/props` Kimi, DeepSeek and Llama 3.1 templates are excerpts, not downloads.
