# Lab compare: results vs results

**Verdict:** A is better: exact McNemar p = 0.0000 on 36 discordant pair(s).

Arms: A = results (qwen3-coder-family), B = results (qwen3-coder-chatml). Pairs are matched on suite, arm, case id and pass index; 48 paired.

| arm       | valid-call rate on the pairs (Wilson 95%) |
| --------- | ----------------------------------------- |
| A results | 36/48 = 75% [61%, 85%]                    |
| B results | 0/48 = 0% [0%, 7%]                        |

Difference B - A: -75 pts, paired bootstrap 95% interval [-85 pts, -62 pts].

|               | B valid | B invalid |
| ------------- | ------: | --------: |
| **A valid**   |       0 |        36 |
| **A invalid** |       0 |        12 |

McNemar exact (two-sided) on the discordant pairs 36 and 0: p = 0.0000.

## Cases that flipped (36)

- read.nagent.t0.whole [whole t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- run-timeout.nagent.t0.whole [whole t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- glob.nagent.t0.whole [whole t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- list.nagent.t0.whole [whole t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- create.nagent.t0.whole [whole t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- fetch.nagent.t0.whole [whole t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- read.nagent.t0.stream [stream t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- run-timeout.nagent.t0.stream [stream t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- glob.nagent.t0.stream [stream t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- list.nagent.t0.stream [stream t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- create.nagent.t0.stream [stream t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- fetch.nagent.t0.stream [stream t=0 tools=agent] pass 1: A valid (structured), B invalid (prose)
- read.nagent.t0.whole [whole t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- run-timeout.nagent.t0.whole [whole t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- glob.nagent.t0.whole [whole t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- list.nagent.t0.whole [whole t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- create.nagent.t0.whole [whole t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- fetch.nagent.t0.whole [whole t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- read.nagent.t0.stream [stream t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- run-timeout.nagent.t0.stream [stream t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- glob.nagent.t0.stream [stream t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- list.nagent.t0.stream [stream t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- create.nagent.t0.stream [stream t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- fetch.nagent.t0.stream [stream t=0 tools=agent] pass 2: A valid (structured), B invalid (prose)
- read.nagent.t0.whole [whole t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- run-timeout.nagent.t0.whole [whole t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- glob.nagent.t0.whole [whole t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- list.nagent.t0.whole [whole t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- create.nagent.t0.whole [whole t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- fetch.nagent.t0.whole [whole t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- read.nagent.t0.stream [stream t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- run-timeout.nagent.t0.stream [stream t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- glob.nagent.t0.stream [stream t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- list.nagent.t0.stream [stream t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- create.nagent.t0.stream [stream t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)
- fetch.nagent.t0.stream [stream t=0 tools=agent] pass 3: A valid (structured), B invalid (prose)

Both arms are measured on the same cases, so only discordant pairs say which is better. Token counts differ between engines: compare validity, not token or cache counters.
