[中文](perf-pro-five-report.md) | **English**

# Historical five-task Harness comparison

This is a descriptive report for frozen versions, not a ranking of current source. See [JSON for all 23 attempts](perf-pro-five-evidence.json). Original images are private and full model traces are not published here. The JSON supports aggregation checks, not complete public reproduction.

The JSON is a redacted publication copy. Ten fields containing model endpoints, the deployment identifier, private image repositories and addresses/request identifiers in error text use explicit placeholders. These cannot connect to services or pull images; the model's specific identity is not public. `publication.redacted_fields` lists paths and reasons, `original_document_sha256` identifies the original file, and `preserved_payload_sha256` verifies the complete payload outside those fields. Measurements, attempt order, failure classification, image digests and source hashes retain their original values. Neither hash is presented as the byte digest of the current public file.

Five tasks were selected from six candidates after all three agents produced correct answers, introducing post-hoc selection bias. Excluded tasks, failures and reruns remain in the 23-attempt totals. Five-task correctness cannot estimate success across the entire pro suite.

## All attempts

<!-- benchmark-summary:start -->
| Agent | Attempts | Correct | Normally completed and correct | Timeouts / failures | All-attempt time | CLI reported tokens (coverage) | Complete observer usage coverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| AReaL-Harness | 8 | 7 | 4 | 0 / 4 | 48.4 min | 6,984,832 (8/8 attempts) | 0/8 |
| Codex | 9 | 6 | 3 | 2 / 1 | 90.7 min | 6,893,190 (6/9 attempts) | 4/9 |
| Claude Code | 6 | 6 | 6 | 0 / 0 | 73.5 min | 5,492,893 (6/6 attempts) | 0/6 |

Median AReaL-Harness / baseline ratios for normal correct completions (paired task count in parentheses):

| Baseline | Agent wall time | CPU time | Peak container memory | Complete input + output tokens |
|---|---:|---:|---:|---:|
| Codex | 1.37× (2) | 0.64× (2) | 0.57× (2) | — (0) |
| Claude Code | 0.97× (3) | 0.69× (3) | 0.28× (3) | — (0) |
<!-- benchmark-summary:end -->

Normal correct completion coverage on the selected five tasks is AReaL-Harness 3/5, Codex 3/5 and Claude Code 5/5. Correctness and normal termination are separate; incomplete token coverage cannot establish billing comparisons.

## Matched task samples

For each agent, select its first normally completed, fully correct attempt. Otherwise show the first correct but interrupted attempt, marked †. Do not select the fastest. Partial interrupted data is not a complete-cost advantage. Attempt numbers refer to the evidence JSON.

<!-- benchmark-cases:start -->
| Task | Agent / attempt | End state | Model requests | Tools succeeded / failed / unfinished (success rate) | Cache ratio | Total tokens | Seconds |
|---|---|---|---:|---:|---:|---:|---:|
| Device observations | AReaL-Harness #22 | Completed | 28 | 25 / 4 / 0 (86.2%) | 92.99% | 278,223 | 207.6 |
| Device observations | Codex #23 | Completed | 11 | 10 / 0 / 0 (100.0%) | 95.70% | 153,409 | 94.1 |
| Device observations | Claude Code #1 | Completed | 9 | 10 / 0 / 0 (100.0%) | 82.22% | 97,768 | 79.8 |
| Deployment coverage query | AReaL-Harness #3 | Completed | 91 | 73 / 19 / 0 (79.3%) | 97.40% | 2,719,743 | 1,102.8 |
| Deployment coverage query | Codex #6 | Timeout† | 38 | 25 / 5 / 1 (80.6%) | 95.55%† | 956,774† | 1,200.4 |
| Deployment coverage query | Claude Code #11 | Completed | 30 | 32 / 1 / 0 (97.0%) | 95.75% | 688,875 | 1,133.5 |
| KV RPC validation | AReaL-Harness #20 | Completed | 57 | 50 / 6 / 0 (89.3%) | 94.67% | 2,239,721 | 396.6 |
| KV RPC validation | Codex #19 | Completed | 52 | 34 / 3 / 0 (91.9%) | 97.74% | 1,827,497 | 748.1 |
| KV RPC validation | Claude Code #21 | Completed | 30 | 30 / 0 / 0 (100.0%) | 97.55% | 1,159,196 | 690.7 |
| Support rollup migration | AReaL-Harness #17 | Failed† | 41 | 29 / 10 / 0 (74.4%) | 95.31%† | 648,575† | 267.0 |
| Support rollup migration | Codex #13 | Timeout† | 65 | 55 / 6 / 1 (88.7%) | 97.85%† | 2,178,831† | 1,800.6 |
| Support rollup migration | Claude Code #15 | Completed | 56 | 54 / 3 / 0 (94.7%) | 98.61% | 2,511,949 | 1,162.6 |
| Warehouse batch migration | AReaL-Harness #10 | Failed† | 43 | 37 / 7 / 0 (84.1%) | 95.50%† | 763,510† | 419.7 |
| Warehouse batch migration | Codex #12 | Completed | 65 | 53 / 5 / 0 (91.4%) | 97.73% | 3,125,585 | 764.6 |
| Warehouse batch migration | Claude Code #2 | Completed | 35 | 33 / 3 / 0 (91.7%) | 98.21% | 906,289 | 847.4 |

Input/output breakdown (cached tokens are already included in input):

| Task / Agent | Input tokens | Cached input | Uncached input | Output tokens | Usage source / archived request coverage |
|---|---:|---:|---:|---:|---|
| Device observations / AReaL-Harness | 230,895 | 214,720 | 16,175 | 47,328 | CLI; 27/28 |
| Device observations / Codex | 139,696 | 133,696 | 6,000 | 13,713 | CLI; 10/11 |
| Device observations / Claude Code | 85,162 | 70,016 | 15,146 | 12,606 | CLI; 9/9 |
| Deployment coverage query / AReaL-Harness | 2,645,362 | 2,576,512 | 68,850 | 74,381 | CLI; 90/91 |
| Deployment coverage query / Codex† | 914,787 | 874,048 | 40,739 | 41,987 | Observer; 38/38 |
| Deployment coverage query / Claude Code | 662,743 | 634,560 | 28,183 | 26,132 | CLI; 30/30 |
| KV RPC validation / AReaL-Harness | 2,174,129 | 2,058,176 | 115,953 | 65,592 | CLI; 56/57 |
| KV RPC validation / Codex | 1,770,199 | 1,730,176 | 40,023 | 57,298 | CLI; 52/52 |
| KV RPC validation / Claude Code | 1,113,065 | 1,085,760 | 27,305 | 46,131 | CLI; 30/30 |
| Support rollup migration / AReaL-Harness† | 607,330 | 578,816 | 28,514 | 41,245 | CLI; 41/41 |
| Support rollup migration / Codex† | 2,091,319 | 2,046,336 | 44,983 | 87,512 | Observer; 65/65 |
| Support rollup migration / Claude Code | 2,457,864 | 2,423,680 | 34,184 | 54,085 | CLI; 56/56 |
| Warehouse batch migration / AReaL-Harness† | 731,107 | 698,240 | 32,867 | 32,403 | CLI; 42/43 |
| Warehouse batch migration / Codex | 3,027,334 | 2,958,464 | 68,870 | 98,251 | CLI; 65/65 |
| Warehouse batch migration / Claude Code | 878,043 | 862,336 | 15,707 | 28,246 | CLI; 35/35 |
<!-- benchmark-cases:end -->

Cache ratio is cached input / total input, a provider prompt-cache proxy rather than server KV-block hit rate. Total tokens are input + output without adding cached input again. CLI totals and per-request observation are labelled separately; archived request count is not valid usage coverage. Missing values are not zero.

Wall time excludes build/smoke/grading. Pair only normal correct completions; incomplete usage is excluded from token ratios. Tool success measures returned status. Different tool granularities and request counts do not establish equivalent work.

## Verify

```sh
python3 tests/perf/summarize_evidence.py \
  docs/benchmarks/reports/perf-pro-five-evidence.json \
  --check-report docs/benchmarks/reports/perf-pro-five-report.md
```

The command verifies the canonical Chinese generated tables; this page translates the same data. Aggregation regression is part of `make script-test`. See the [run guide](../README.en.md) and [methodology](../methodology.en.md) for new evaluations; keep historical figures separate.
