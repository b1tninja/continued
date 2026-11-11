# Local lab report

4 records, 0 errors (errors are excluded from every rate). Rates are k/n with a Wilson 95% interval.

## Suite: leaks

### qwen3.6:27b [think=on,np=1024]

By arm:

| arm                   |   n |    valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| --------------------- | --: | ---------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| whole t=0 tools=agent |   4 | 4/4 = 100% [51%, 100%] |                           - |          4 |         0 |             0 |       0 |     0 |            79 |      2055 |  77.5 |

By case group:

| group                                         |   n |    valid call (95% CI) | false calls (no-tool cases) | structured | text-call | format-broken | refused | prose | median tokens | median ms | tok/s |
| --------------------------------------------- | --: | ---------------------: | --------------------------: | ---------: | --------: | ------------: | ------: | ----: | ------------: | --------: | ----: |
| tools=agent t=0 whole (whole t=0 tools=agent) |   4 | 4/4 = 100% [51%, 100%] |                           - |          4 |         0 |             0 |       0 |     0 |            79 |      2055 |  77.5 |
