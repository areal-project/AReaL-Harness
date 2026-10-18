[中文](methodology.md) | **English**

# Benchmark methodology

See the [run guide](README.en.md). Report real-task benefits, deterministic mechanism regression and concurrency-primitive capacity separately.

1. Freeze source, tasks, images, model, parameters, resource limits, repetitions and selection rules before running. Pair matching task/repetition samples and randomize interleaving.
2. Establish correctness through trusted final checks, not agent claims, exit code 0 or local compilation. Distinguish original tasks from derived subsets; record empty/skipped tests and grading faults.
3. Retain all planned attempts, including failures, interruptions, timeouts, reruns and excluded tasks. Correctness, normal completion and valid grading are separate states.
4. Report all-attempt time/known tokens, then ratios for matching tasks completed normally and correctly by both sides. Select the first qualifying sample, not the fastest. Show pair counts and omit unsupported comparisons.
5. Missing usage stays unknown; partial failed usage is a lower bound. Cached input is already part of input tokens and is not added twice. Label CLI totals and observer coverage separately.
6. Distinguish user Turns, model requests, tool calls and processes. Model-permit occupancy includes network/stream waits and does not measure GPU utilization. Tool success rate is not task correctness.
7. Logs may contain prompts, source and service details. Redact and review redistribution scope before publication. Retain provenance hashes without describing hashes alone as fully reproducible evidence.

Higher Worker limits do not guarantee gains. Compare single-agent and fixed-width baselines with identical input, grants and final checks, including verification/repair costs. Small samples, post-hoc selection, different versions and emulation support only bounded descriptive observations, not general rankings.
