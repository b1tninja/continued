<!-- Sample: generated against the fake server in test/fakeOllama.mjs. Not a measurement of any model. -->

# Sample report (fake server)

24 records, 0 errors (errors are excluded from every rate). Rates are k/n with a Wilson 95% interval.

## Suite: dialect-probe

### fake-small:1b

By arm:

| arm              |   n |   valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| ---------------- | --: | --------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| native           |  12 | 4/12 = 33% [14%, 61%] |          0/2 = 0% [0%, 66%] |          2 |         0 |             0 |       0 |    10 |            20 |         5 |  20.0 |
| text / codeblock |  12 | 4/12 = 33% [14%, 61%] |          0/2 = 0% [0%, 66%] |          0 |         2 |             0 |       0 |    10 |            20 |         5 |  20.0 |

By case group:

| group                                |   n |    valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| ------------------------------------ | --: | ---------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| argument-escaping (native)           |   2 |     0/2 = 0% [0%, 66%] |                           - |          0 |         0 |             0 |       0 |     2 |            20 |         5 |  20.0 |
| argument-escaping (text / codeblock) |   2 |     0/2 = 0% [0%, 66%] |                           - |          0 |         0 |             0 |       0 |     2 |            20 |         5 |  20.0 |
| argument-types (native)              |   4 |     0/4 = 0% [0%, 49%] |                           - |          0 |         0 |             0 |       0 |     4 |            20 |         5 |  20.0 |
| argument-types (text / codeblock)    |   4 |     0/4 = 0% [0%, 49%] |                           - |          0 |         0 |             0 |       0 |     4 |            20 |         5 |  20.0 |
| no-tool (native)                     |   2 | 2/2 = 100% [34%, 100%] |          0/2 = 0% [0%, 66%] |          0 |         0 |             0 |       0 |     2 |            20 |         5 |  20.0 |
| no-tool (text / codeblock)           |   2 | 2/2 = 100% [34%, 100%] |          0/2 = 0% [0%, 66%] |          0 |         0 |             0 |       0 |     2 |            20 |         5 |  20.0 |
| parallel-calls (native)              |   2 |     0/2 = 0% [0%, 66%] |                           - |          0 |         0 |             0 |       0 |     2 |            20 |         5 |  20.0 |
| parallel-calls (text / codeblock)    |   2 |     0/2 = 0% [0%, 66%] |                           - |          0 |         0 |             0 |       0 |     2 |            20 |         5 |  20.0 |
| single-call (native)                 |   2 | 2/2 = 100% [34%, 100%] |                           - |          2 |         0 |             0 |       0 |     0 |            20 |         5 |  20.0 |
| single-call (text / codeblock)       |   2 | 2/2 = 100% [34%, 100%] |                           - |          0 |         2 |             0 |       0 |     0 |            20 |         5 |  20.0 |

### Text replies and the parsers

2 replies carried tool markup in the text. Recovered by at least one parser: 2/2 = 100% [34%, 100%].

| parser    | replies it recovered |
| --------- | -------------------: |
| codeblock |                    2 |
