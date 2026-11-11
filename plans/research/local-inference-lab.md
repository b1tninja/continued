# Local inference stack and the lab: research and experiment plan (2026-11-11)

Status: DRAFT, research and planning only. No model was loaded, no server was started, no GPU was used and nothing was written to C: while writing this. **Nothing in the experiment plan (section 5) runs without the owner's approval.** Web sources were fetched on 2026-11-11 unless a row says otherwise; secondary sources (blogs, aggregators, Reddit snapshots) are marked as such and are never the basis of a recommendation on their own. Items older than six months (before 2026-05-11) are flagged "old".

Machine (from `bench/lab/README.md` and the 2026-11-11 evidence folder): one RTX 5090 (32 GB), 125 GB RAM, Ollama 0.40.13, llama.cpp b12206 at `M:\ai\llama.cpp\b12206`, GGUFs `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M` (18.6 GB) and `gpt-oss-20b-MXFP4` (12.1 GB) in `M:\ai\gguf`, Ollama models `qwen3.6:27b`, `deepseek-ocr`, `glm-ocr`, `qwen3-embedding:8b`, and an NVFP4 `Qwen3.8-Flash-Next` checkpoint under `M:\Strata-models` (about 96 GB of safetensors plus a 99 GB `prepared` folder, so it is not a 32 GB-resident model; see 2.4).

## 1. Findings in brief

1. The Qwen3.6 and Qwen3.8 families are now the default local coding-agent choice for 32 GB; the older Qwen3-Coder-30B-A3B and gpt-oss-20b we measured are a generation behind on vendor numbers (section 2).
2. Measured here (RTX 5090, b12206, short outputs): Qwen3-Coder-30B-A3B Q4_K_M decodes at about 240 tokens/s; `qwen3.6:27b` on Ollama at about 77 tokens/s with thinking on. These are the only measured figures in this document; every other speed is published by someone else.
3. The one strong measured contrast: with `--jinja` and the file's own template Qwen3-Coder returned a valid agent-tool call in 36/48 (75%, Wilson 61-85%); forced to `--chat-template chatml` it returned 0/48 (0-7%, all prose). The handler is the experiment variable, not the weights.
4. llama.cpp has real speculative decoding now: `--spec-type draft-mtp` (merged 2026-05-16, PR #22673, requires `--parallel 1`), draft model, EAGLE-3, DFlash, n-gram variants. The b12206 `--help` is the authority on which exist in our binary.
5. NVFP4 on llama.cpp is merged with a Blackwell-native CUDA path (PR #22196, 2026-04-28), so the 5090 is the right card for it; NVFP4 weights for the models we can fit are the thing to look for.
6. Details, tables, the experiment plan, storage and embedding sections follow in later commits of this draft.

## 2. Models that fit 32 GB (research notes so far)

| Model           | Shape                                                           | Vendor coding and agent numbers (vendor card)                                                         | Source                                      |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Qwen3.6-27B     | 27B hybrid (Gated DeltaNet plus gated attention), MTP, 262K ctx | SWE-bench Verified 77.2, Terminal-Bench 2.0 59.3, LiveCodeBench v6 83.9                               | https://huggingface.co/Qwen/Qwen3.6-27B     |
| Qwen3.6-35B-A3B | 35B MoE, 3B active, MTP, 262K ctx                               | SWE-bench Verified 73.4, SWE-bench Pro 49.5, Terminal-Bench 2.0 51.5, MCP-Atlas 62.8                  | https://huggingface.co/Qwen/Qwen3.6-35B-A3B |
| Qwen3.8-27B     | 27B hybrid, MTP trained, 262K ctx, Apache-2.0                   | SWE-bench Pro 61.7, Terminal-Bench 2.1 73.0, LiveCodeBench v6 90.3 (vendor, not independently repro.) | https://huggingface.co/Qwen/Qwen3.8-27B     |

Sampling the vendor recommends for Qwen3.6-35B-A3B (thinking, general): temperature 1.0, top_p 0.95, top_k 20, presence_penalty 1.5; for precise coding temperature 0.6, presence_penalty 0.0. The Ollama `qwen3.6:27b` tag inherits temperature 1 and presence_penalty 1.5 (ROADMAP RQ26), which is the vendor's general-task set, not its coding set; that makes RQ26 a cheap and well-motivated experiment.

Ollama library page for qwen3.6 (https://ollama.com/library/qwen3.6): tags `latest`/`35b` 23 GB, `27b` 18-19 GB, 256K context, capabilities vision, tools, thinking.

Serving flags from the vendor cards: vLLM `--enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3`; MTP via `--speculative-config '{"method":"qwen3_next_mtp","num_speculative_tokens":2}'`; SGLang `--tool-call-parser qwen3_coder` and `--speculative-algo NEXTN`.

## 2.4 The local NVFP4 Qwen3.8-Flash-Next

NVIDIA's card (https://huggingface.co/nvidia/Qwen3.8-Flash-Next-NVFP4, 2026-08-31): 125B total, 6B active, plus 51B n-gram embedding and 4B MTP; expert layers W4A4 NVFP4, attention and shared experts BF16; vLLM is the supported runtime, tested on B200 and B300. The local copy (96 GB of tensors) can only run on a 32 GB card with expert paging to the 125 GB of host RAM, which is what the owner's Strata launcher presumably does (inference from sizes, not verified).

## 3. Engine facts (research notes so far)

- llama.cpp `--cache-reuse` default 0, `--cache-ram` default 8192 MiB, `--ctx-checkpoints` 32, `-fa auto`, `--jinja` on, `-np` auto (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md, master, not b12206).
- Tool calling needs `--jinja`; an unrecognised template logs `Chat format: Generic` and "may consume more tokens and be less efficient"; `-ctk q4_0` "can substantially degrade tool calling" (https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md).
- MTP: PR #22673, https://github.com/ggml-org/llama.cpp/pull/22673: needs `--parallel 1`, prompt processing slower (one user 1315 vs 665 tok/s prefill, secondary), about 2.5 GiB extra VRAM, 1.85x decode on a 27B Q6_K two-GPU rig (user report).
- Ollama 0.40.16 (2026-11-09) is the latest release; 0.40.12 added DFlash draft decoding on MLX only; 0.40.15 added YaRN for Qwen3 and Qwen3.5 (https://github.com/ollama/ollama/releases).
