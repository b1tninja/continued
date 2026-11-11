# Local lab report

0 records, 0 errors (errors are excluded from every rate). Rates are k/n with a Wilson 95% interval.

No usable records.

# Cache suite

Counters are the engine's own. `cached` is llama-server `timings.cache_n`; Ollama reports no cached count, so `evaluated` (prompt_eval_count) falling against the first request is its signal. `evaluated vs cold` is evaluated divided by the cold request's. Compare rows inside one table only.

## churn: qwen3.6:27b via ollama-chat

|   # | step        | prompt tokens | cached | evaluated | evaluated vs cold | prompt ms | ttft ms | output tokens | first changed char |
| --: | ----------- | ------------: | -----: | --------: | ----------------: | --------: | ------: | ------------: | -----------------: |
|   0 | request-001 |            31 |      - |        31 |              1.00 |       265 |    7706 |            16 |                  - |
|   1 | request-002 |            77 |      - |        77 |              2.48 |       223 |    1055 |            16 |                 82 |
|   2 | request-003 |           110 |      - |       110 |              3.55 |       262 |    1158 |            16 |                 33 |
|   3 | request-004 |           128 |      - |       128 |              4.13 |       202 |    1067 |            16 |                 79 |
|   4 | request-005 |            49 |      - |        49 |              1.58 |       171 |    1044 |            16 |                156 |

## extends: qwen3.6:27b via ollama-chat

|   # | step        | prompt tokens | cached | evaluated | evaluated vs cold | prompt ms | ttft ms | output tokens | first changed char |
| --: | ----------- | ------------: | -----: | --------: | ----------------: | --------: | ------: | ------------: | -----------------: |
|   0 | request-001 |            49 |      - |        49 |              1.00 |       171 |    1039 |            16 |                  - |
|   1 | request-002 |            95 |      - |        95 |              1.94 |       204 |    1032 |            16 |                152 |
|   2 | request-003 |           140 |      - |       140 |              2.86 |       216 |    1026 |            16 |                345 |
|   3 | request-004 |           168 |      - |       168 |              3.43 |       257 |    1174 |            16 |                539 |

## system-field: qwen3.6:27b via ollama-chat

|   # | step        | prompt tokens | cached | evaluated | evaluated vs cold | prompt ms | ttft ms | output tokens | first changed char |
| --: | ----------- | ------------: | -----: | --------: | ----------------: | --------: | ------: | ------------: | -----------------: |
|   0 | request-001 |            31 |      - |        31 |              1.00 |       182 |    1077 |            16 |                  - |
|   1 | request-002 |            44 |      - |        44 |              1.42 |       211 |    1055 |            16 |                 77 |
