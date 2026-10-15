[中文](methodology.md) | **English**

# Benchmark methodology

See the [run guide](README.en.md) and the [agent improvement method](../development/agent-improvement.en.md) for goals, generality and default-policy gates. Report real-task benefits, deterministic mechanism regression and concurrency-primitive capacity separately.

1. Freeze source, tasks, images, model, parameters, resource limits, repetitions and selection rules before running. Pair matching task/repetition samples and randomize interleaving.
2. Establish correctness through trusted final checks, not agent claims, exit code 0 or local compilation. Distinguish original tasks from derived subsets; record empty/skipped tests and grading faults.
3. Retain all planned attempts, including failures, interruptions, timeouts, reruns and excluded tasks. Correctness, normal completion and valid grading are separate states.
4. Report all-attempt time/known tokens, then ratios for matching tasks completed normally and correctly by both sides. Select the first qualifying sample, not the fastest. Show pair counts and omit unsupported comparisons.
5. Missing usage stays unknown; partial failed usage is a lower bound. Cached input is already part of input tokens and is not added twice. Label CLI totals and observer coverage separately.
6. Distinguish user Turns, model requests, tool calls and processes. Model-permit occupancy includes network/stream waits and does not measure GPU utilization. Tool success rate is not task correctness.
7. Logs may contain prompts, source and service details. Redact and review redistribution scope before publication. Retain provenance hashes without describing hashes alone as fully reproducible evidence.

Higher Worker limits do not guarantee gains. Compare single-agent and fixed-width baselines with identical input, grants and final checks, including verification/repair costs. Small samples, post-hoc selection, different versions and emulation support only bounded descriptive observations, not general rankings.

Separate development, confirmation and regression material by source group rather than random task IDs. Inspected tasks or cases used for repairs are no longer unseen confirmation. Same-source variants and renaming test robustness. Assign 25% each to software engineering, browsing, documents and data in long-term comparisons, reporting domain results and source coverage; missing domains cannot form an overall score.

Predefine the mechanism hypothesis, intervention, minimum improvement, regression limits, confirmation sample and stopping rules. Freeze prompts, tools, protocol bridges, adapters, automatic continuation, defaults and complete root budgets. Disclose task-family budgets or added policies and compare them separately; do not hide them in integration code. Combined changes establish combined effects only.

Promoting default behavior requires matching development comparisons and source-separated confirmation excluded from tuning. Retain negative results and stop promotion instead of scanning thresholds on the same cases until they pass. Correctness repairs may merge on invariants and necessary regressions, without claiming general score or cost improvements. Label unverified candidates and effects explicitly.

## Repetitions, coverage and evidence size

Formal policy comparisons independently run every task at least 5 times per Harness, with fresh state and the same per-attempt root budget. Freeze repeat IDs, scheduling seed, actual model parameters and every attempt. Pair task/repeat IDs and randomly interleave execution; do not leak previous answers, workspaces or recovery state into later attempts. Five repetitions expose randomness; they are neither five independent tasks nor a guarantee of statistical power. Report single-attempt success distributions, never best-of-five or pass@5 as single-attempt capability.

| Stage | Minimum preregistered plan | Supported conclusion |
|---|---|---|
| Pipeline smoke / contract regression | Explicit `--repeat 1` is acceptable; model fixtures or a few tasks check input, execution and grading | Only the inspected path or invariant |
| Policy development comparison | At least 12 distinct tasks from at least 3 independent source groups; at least 5 repetitions per task per arm, or 60 full attempts per arm | Diagnose scope and counterexamples in covered domains; no default promotion |
| Global default promotion / overall ranking confirmation | After freezing the candidate, at least 48 untuned tasks and 5 repetitions per task per arm, or 240 full attempts per arm; at least 3 independent Benchmark suites; at least 12 tasks and 2 independent source groups in each of software engineering, browser, documents and data; sources disjoint from development | Promotion only when preregistered quality, efficiency, regression and uncertainty gates all pass; counts alone prove no benefit |

These are workload floors, not sufficiency guarantees, and do not require real-model experiments for every deterministic fix. A scoped policy must declare its domain in advance and confirm within that domain on at least 12 source-separated tasks × 5 repetitions; it cannot promote globally. With limited resources or no independent sources, keep smaller batches exploratory and policies explicitly experimental rather than reducing confirmation requirements.

Count Benchmark suites, source groups, tasks and repetitions separately. Renamed, reparameterized or harder variants of one repository, application, data generator or parent task remain one source group. Suites sharing a parent source do not supply independent Benchmark coverage. Repeating a task cannot supply missing tasks, sources or domains. The existing Docker `lite` / `pro` suites do not automatically establish independent confirmation across all four domains.

Submit a plan before execution listing stage, Benchmark/version, source group, domain, task digest, exposure status, repetitions per arm, root budget, model identity, order seed, exclusions, primary metric, minimum meaningful effect and stopping rule. Estimate variance and required scale from pilot development data; add tasks and sources before confirmation if the plan cannot resolve the target effect. Do not stop confirmation upon favorable interim results. Only preregistered sequential designs or resource/safety stops can alter execution; retain planned-versus-observed gaps.

Report domain/source strata, success/failure/UNKNOWN/pending review for every planned attempt, per-task repetition distributions, and intervals for paired quality, time and token differences (95% by default). Resample paired source clusters while retaining their tasks and repetition structure; report method, seed and independent group count. Do not treat repeated tasks as independent samples. Too few sources, incomplete usage or wide intervals mean insufficient evidence. Ranking superiority requires the quality-effect interval to support the planned minimum gain; efficiency improvement also needs predefined quality noninferiority and domain regression limits. Best runs and success-only comparisons cannot establish overall superiority; successful-pair efficiency remains conditional.

`scripts/perf run`, `compare` and the interactive menu default to `--repeat 5`; explicit `--task` / `--case` still selects the subset. The tool executes selected tasks only: it does not supply missing cross-suite/source coverage, run source-separated confirmation or decide default promotion. Check these conditions separately in the plan and report. Minimum repetition counts and a fixed seed do not guarantee identical provider randomness.
