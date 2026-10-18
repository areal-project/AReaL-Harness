[中文](native-result-views.md) | **English**

# Bundled search and historical result retrieval experiment

Baseline `3c64f4f` and the frozen `native-v4` binaries in the evidence used the same `grok-4.7` configuration. All 18 final pairs across six ordinary probes completed and passed independent checks. Input tokens fell 16.2%, uncached input fell 2.5%, output tokens rose 9.2%, and latency did not improve. Separate large MCP result probes passed 3/3 on the candidate and 0/3 on baseline. This establishes retrieval functionality, not a cost comparison at equal correctness.

New result views remain `observe` by default; this experiment explicitly enabled `on`. Bundled rg and durable snapshots/retrieval are independent of that switch. [Sanitized evidence](native-result-views-evidence.json) retains all 146 attempts (including seven post-merge regressions); paired performance conclusions use the 36 `paired-v4` and six `snapshot-v4` attempts. Earlier failures and invalid fixtures are retained instead of selecting successful retries. Complete private model traces are not published, so aggregates are auditable but complete public reproduction materials are not provided. The [previous tool experiment](tool-optimization.en.md) used a different baseline; its gains cannot be added to these results.

## Conditions

The configured model route and sampling settings were preserved, without temperature or reasoning-effort overrides. Runs used macOS arm64 and debug builds; plans record Python/pytest versions and binary SHA-256 digests. Seed 163 shuffled adjacent pairs across two host slots. Each attempt had a private workspace, HOME and Store; limits were 180 seconds per Turn, 60 seconds stream idle and 80 tool calls. `--direct` cleared only child-process proxies. Some measurements overlapped local builds/checks, so latency is descriptive rather than an isolated performance measurement.

Four existing probes cover a small fix, long test output, multiline failure context and batch edits. `search-groups` places one active configuration in the middle of 65 matches; `repeat-log` places diagnostics between exact repeated lines. `snapshot` uses deployment-side stdio MCP to return about 50 KiB and 700 inventory rows, with the unique active value in the middle. The last probe uses a restricted sandbox with its fixture outside the task workspace; grading also requires exactly one source call and use of `read_tool_result`. Host-side assertions run after Agent exit, and original tests/configuration must remain unchanged.

All 36 final ordinary attempts completed, with complete input/cache/output usage. Optional reasoning counters were missing on some requests: totals are `null` with observed partial sums, never imputed zero. Input includes cached input; uncached input is their difference. No unknown prices are used to estimate charges. p95 uses nearest rank and equals the maximum for 18 observations, making it unstable.

## Final ordinary probes

| Metric | Baseline | Candidate | Change |
|---|---:|---:|---:|
| Completed and correct | 18/18 | 18/18 | No observed regression |
| Input tokens | 1,157,285 | 969,531 | -16.2% |
| Uncached input | 431,909 | 421,051 | -2.5% |
| Output tokens | 12,511 | 13,658 | +9.2% |
| Model requests | 112 | 110 | -1.8% |
| Tool calls | 131 | 127 | -3.1% |
| Elapsed p50 | 18.00 s | 19.76 s | +9.8% |
| Elapsed p95 | 37.94 s | 55.90 s | +47.3% |

Token counts below are sums of three attempts; elapsed time is the median. These are not causal ablations of individual transforms.

| Probe | Input: baseline → candidate | Uncached input: baseline → candidate | Elapsed p50: baseline → candidate |
|---|---:|---:|---:|
| pricing | 136,781 → 150,921 | 66,637 → 69,257 | 13.82 → 16.34 s |
| batch-edit | 190,784 → 167,456 | 62,656 → 75,680 | 27.67 → 29.89 s |
| failure-context | 184,667 → 187,484 | 55,899 → 74,972 | 19.74 → 20.05 s |
| output-tail | 269,280 → 206,899 | 92,768 → 77,875 | 29.59 → 34.53 s |
| search-groups | 235,995 → 138,457 | 84,571 → 65,881 | 14.47 → 12.06 s |
| repeat-log | 139,778 → 118,314 | 69,378 → 57,386 | 13.97 → 13.60 s |

Nine applied search views reduced 76,165 bytes to 20,274; six repeated-log views reduced 47,199 to 8,175, preserving every received match/text value. Byte reduction does not substitute for end-to-end usage: tool definitions, retrieval and model decisions can increase other workloads. The 21 final candidate attempts stored 412,332 logical snapshot bytes and spent about 567 ms of total elapsed preprocessing time. That is not CPU time or a tail-latency guarantee.

## Large results and iteration findings

Each final candidate MCP attempt called the source once, read seven pages and wrote the correct answer. Elapsed times were 33.20, 29.60 and 35.74 seconds; input tokens were 213,501, 213,689 and 213,839. Baseline failed at the old 16 KiB receive limit on its first MCP call. Retrieval enabled completion while adding real paging/context costs; this probe shows no token-saving result.

| Round | Attempts | Interpretation |
|---|---:|---|
| pilot | 7 | Five completed correctly; one correct artifact timed out; one provider stalled before tools |
| paired-v1 | 42 | Custom-command output requests exceeded parent Scope limits; snapshot fixtures were also host-readable, invalidating those answer grades |
| paired-v2 | 42 | All 36 ordinary attempts passed; six snapshot attempts were invalid because the runner disabled deployment MCP |
| snapshot-v3 | 6 | MCP worked, but normal TUI advertisements hid retrieval; candidate 0/3, prompting visibility fixes and advertisement assertions |
| snapshot-v4 | 6 | Final isolated MCP probe: baseline 0/3, candidate 3/3 |
| paired-v4 | 36 | Final ordinary probes: both 18/18 |
| merged-regression | 7 | Unified CLI after merging main `3bf7613`: one attempt for each probe, all completed and correct |

Fixes narrow custom-command limits to the parent Scope, accept up to 8 MiB of plain text/structured MCP data, increase plugin output to 96 KiB within existing frames, and advertise retrieval in ordinary and research sessions. Explicit allowlists that disable retrieval receive no unusable references. Deterministic coverage includes UTF-8/escaped paging, exact byte reconstruction, cross-Thread rejection, restart/GC/quotas/storage failure, fixed historical projections, unique middle evidence and actual MCP execution.

The seven post-merge regressions also retain binary/configuration/fixture fingerprints. They have no new baseline runs and establish no new paired performance result.

After the frozen model runs, script checks exposed an existing startup-cancellation race that removed the readiness directory before reaping children. The final change fixes the ordering and passes deterministic lifecycle tests; this shutdown fix is not included in the model measurements.

An MM480 selection of 24 cases was frozen from the original results (16 zero/failed and eight successful controls) and is included in the evidence. The planned 144 attempts were not run. Source for the original external media/nested-container runner was not recovered, and the current Grok route has not been validated inside that production sandbox. A Linux amd64 build does not validate that deployment chain. This report claims no MM480 score improvement, completed production adaptation or general speedup.

## Reproduction and replay

Build separate revisions using the [development guide](../../development/README.en.md). The measured legacy layout needs four server/TUI/Runtime binaries and `launch.py`, plus the candidate's complete `tools/` directory. After merging main, the runner also supports the unified CLI layout: `areal`, two Runtime binaries, `launch.py` and `tools/`. Installed bundles place Runtime and tools under `libexec/areal/`. Do not rebuild frozen directories during measurement. Set the credential environment variables required by your configuration, then run:

```sh
python3 tests/perf/native_tool_ab.py \
  --variant "baseline=$BASELINE_BIN" --variant "native=$NATIVE_BIN" \
  --view-mode native=on --model-config "$HOME/.areal-harness/config.toml" \
  --output target/perf/native-result-views --repeat 3 --seed 163 --jobs 2 --direct
```

Repeat `--case` to select probes; the default is seven probes and 42 attempts. The runner records plans, model/fixture fingerprints and per-attempt results. Bundled rg and MCP fixture digests were added to subsequent plans; earlier plans here did not include them, so the evidence stores separate supplemental fingerprints rather than retroactively claiming preregistration.

Inspect one Core Store and optionally run offline simulation:

```sh
python3 tests/perf/result_view_report.py path/to/core-data --output report.json
python3 tests/perf/result_view_report.py path/to/core-data --replay --output replay.json
```

Replay verifies Blob digests and calls the same Rust projection implementation without model requests. It covers preserved originals only, does not recreate previously truncated content or simulate Thread quotas, and may lack command classification for historical `read_process` calls without archived argv. Prefix fingerprints diagnose message/schema/instruction changes; they do not prove provider cache hits. See the [tool contract](../../guides/tools.en.md) for current behavior. Offline candidate savings are not measured billing savings.
