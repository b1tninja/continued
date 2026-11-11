# Local lab report

96 records, 0 errors (errors are excluded from every rate). Rates are k/n with a Wilson 95% interval.

## Suite: leaks

### qwen3-coder-family [openai-chat,think=default,np=1024]

By arm:

| arm                    |   n |    valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| ---------------------- | --: | ---------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| stream t=0 tools=agent |  24 | 18/24 = 75% [55%, 88%] |                           - |         24 |         0 |             0 |       0 |     0 |            49 |       239 | 245.6 |
| whole t=0 tools=agent  |  24 | 18/24 = 75% [55%, 88%] |                           - |         24 |         0 |             0 |       0 |     0 |            49 |       242 | 237.1 |

By case group:

| group                                           |   n |    valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| ----------------------------------------------- | --: | ---------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| tools=agent t=0 stream (stream t=0 tools=agent) |  24 | 18/24 = 75% [55%, 88%] |                           - |         24 |         0 |             0 |       0 |     0 |            49 |       239 | 245.6 |
| tools=agent t=0 whole (whole t=0 tools=agent)   |  24 | 18/24 = 75% [55%, 88%] |                           - |         24 |         0 |             0 |       0 |     0 |            49 |       242 | 237.1 |

### qwen3-coder-chatml [openai-chat,think=default,np=1024]

By arm:

| arm                    |   n | valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| ---------------------- | --: | ------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| stream t=0 tools=agent |  24 | 0/24 = 0% [0%, 14%] |                           - |          0 |         0 |             0 |       0 |    24 |            27 |        91 | 344.2 |
| whole t=0 tools=agent  |  24 | 0/24 = 0% [0%, 14%] |                           - |          0 |         0 |             0 |       0 |    24 |            26 |       101 | 330.0 |

By case group:

| group                                           |   n | valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| ----------------------------------------------- | --: | ------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| tools=agent t=0 stream (stream t=0 tools=agent) |  24 | 0/24 = 0% [0%, 14%] |                           - |          0 |         0 |             0 |       0 |    24 |            27 |        91 | 344.2 |
| tools=agent t=0 whole (whole t=0 tools=agent)   |  24 | 0/24 = 0% [0%, 14%] |                           - |          0 |         0 |             0 |       0 |    24 |            26 |       101 | 330.0 |
