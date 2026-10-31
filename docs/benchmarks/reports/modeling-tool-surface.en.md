[中文](modeling-tool-surface.md) | **English**

# Modeling tool-surface comparison

In a new artifact workspace, the default surface can split directory inspection, directory creation and individual file writes into more model rounds. The existing `--tools` selector can expose a smaller set so the model composes operations through commands. This comparison validates an explicit configuration, with no Runtime, default-tool, permission or external task-generator change.

## Fixed comparison

Both arms use the same ci build at `9aa2d028d2a8ef255e3699109baf963e976c4ee7` and frozen Runtime. The default arm excludes delegation; the command arm exposes `run_command,read_process,image_read,write_process,terminate_process,task_state,read_tool_result`. Ten paired fresh generations share the previously seen public agave source and neutral prompt. Launch order alternates, with two author workers. No failed roots were replaced or samples stopped for interim scores.

All author calls use Arena/HTNN `gpt-6-astra / medium`; joint reviews use `max`. No current-account evaluation quota was used. Each root has 900 seconds, 80 physical requests, 80 model rounds, 4,000,000 input tokens, 196,608 output tokens and a 131,072 context cap; per-request output is 8,192. Earlier 16,384-cap cohorts remain separate.

## Results and admission

All 20 roots completed, preserved public inputs, and passed independent actual-GLB export and canonical rendering. The paired geometric-mean command/default wall ratio is **0.800**, about **20.0% lower**, with paired bootstrap 95% interval [0.735, 0.870]. The command arm is faster in 9/10 pairs.

Completed model responses fall from 143 to 113; physical requests are 151 / 120, with 8 / 7 missing-usage attempts. Known input subtotals fall from 2,053,650 to 1,318,969 (35.8%). Unknown consumption retains conservative configured-cap reservations. Known subtotals and cached input do not establish total consumption or monetary savings.

Known uncached input instead rises from 167,442 to 240,057. The conservative input-ratio 95% interval has an upper bound of 1.278, failing the token-improvement gate. Admission rests on latency and quality, not a claim of lower billing.

Each pair receives one joint blind review of the actual reference and each artifact's source camera plus common front/right/top views. Label position is balanced 5/5. Four visual dimensions have equal weight. The mean command-minus-default quality difference is **-0.087**, with paired 95% interval [-0.300, +0.125], and no command-arm critical failure. This passes the pre-registered 0.5-point noninferiority margin and performance gate (geometric mean ≤0.90, interval upper bound <1). It does not prove identical quality.

| Pair | Command/default wall | Quality difference |
|---|---:|---:|
| 1 | 0.790 | -0.250 |
| 2 | 0.843 | +0.625 |
| 3 | 0.810 | +0.125 |
| 4 | 0.853 | -0.125 |
| 5 | 0.677 | -0.250 |
| 6 | 0.839 | +0.250 |
| 7 | 0.770 | -0.750 |
| 8 | 0.618 | -0.250 |
| 9 | 1.062 | -0.125 |
| 10 | 0.811 | -0.125 |

Reference-image calls are 10 / 10; artifact-image calls are 19 / 20. The command arm did not obtain its gain by inspecting fewer artifact images. Confirmed tool failures, 1 / 3, are retained; every root recovered and completed. The intervention changes both schema input and action choice, which were not randomized separately.

## References and rejected candidate

A separate fixed five-triplet comparison used AReaL process-image output off/on and Codex 0.166.0 Code Mode. Codex composed reads and multi-file creation, while still separating render/wait/image steps in full tasks. Although the optional process-image candidate saved one model boundary in a component test, only 1/5 full roots used it; its median paired wall ratio was 1.056. One root exhausted the proxy's UNKNOWN output reservation; this is neither native irrecoverability nor successful acceleration. That candidate is not merged.

The [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) was used only as a design reference, not a same-model CC benchmark. The isolated CC 2.1.314 download did not start successfully; no native run result is claimed.

## Scope and reproduction

Ten repetitions of one seen source are not ten independent tasks and do not establish gains for games, white models, software engineering or global defaults. The separate AReaL/Codex comparison has build, prompt and image-preprocessing differences; the ten-pair native contrast holds those conditions equal. Same-model reviewers can share bias.

Retain this only as an explicit option for fresh, exclusively owned workspaces generating artifacts through commands. See the [tool guide](../../guides/tools.en.md#choose-visible-tools-for-the-workspace) for usage and missing capabilities. Preserve CAS, history and other tools where the workflow requires them; defaults are unchanged.

[Machine-readable evidence](modeling-tool-surface-evidence.json) includes all twenty roots, pairs, gates and frozen evidence hashes. The geometric mean is `exp(mean(log(command_wall/default_wall)))`; paired bootstrap uses seed 20261031, 20,000 resamples and sorted indices 500 and 19,499. Quality uses paired means. Raw requests/responses, failures, review images and source are retained in a separate operator archive, not published with this summary; the repository alone does not provide every input needed for a complete rerun.
