[中文](long-horizon75-execution-focus.md) | **English**

# executionFocus on a fixed 75-task development set

With `executionFocus` explicitly enabled, all 75 candidate authors completed and passed native-execution and usage audits. Across 70 valid original-baseline pairs, candidate/baseline median ratios were **0.901 for wall time** and **0.798 for total tokens**. Matched token totals were 36,918,769 / 46,667,225, a **20.9% reduction**. This supports retaining an explicit efficiency candidate; increased single-object token use and browser startup failures still limit default promotion.

This is a first-repeat development observation requested by the task owner, prioritizing time and tokens with quality and anomalies as guardrails. It is neither a five-repeat formal statistical comparison nor unseen-source confirmation. Model randomness, judge noise and gateway load across time remain limitations. Runs were not repeated until scores improved, and product defaults were not changed.

## Versions, tasks and comparison boundaries

| Item | Frozen setting |
|---|---|
| Tasks | 10 SWE Pro HARD, 5 custom repository tasks, 20 3D modeling, 10 game modeling, 10 single-object modeling and 20 historical BlenderWorld tasks |
| Model | Arena-provided `gpt-6-astra`, `reasoning_effort=medium`; no local-account model quota used |
| AReaL | Core `1f6cc627a1754b32c32a5c396a9e58c8dd727deb`; candidate enables only `executionFocus`, with the programmatic-tool candidate disabled |
| Codex | Native CLI `0.166.0` through the common protocol integration and task environment; not all Codex product modes |
| Root budget | 512 requests, 16,777,216 tokens; per-request context 131,072 and output limit 32,000; zero automatic retries |
| Environment | Modeling and custom tasks on Arena Linux; SWE on local Docker amd64 with matched images and resource limits, still using Arena model resources |
| SWE correction | Both AReaL arms use Runtime `4b5f9acdf351650c4002232e3e34cc7a3f9e26c7`; the first five reuse completed corrected proxy pairs, and the last five use a prospectively fixed common direct-transport three-arm cohort |

The original SWE read/search seccomp faults are not normal problem-solving overhead. Original authors, grades and costs remain recorded, but those authors do not enter corrected valid efficiency pairs. The final five tasks never fall back to a favorable earlier result, and wall time is not paired across proxy/direct routes. The Runtime correction is not an `executionFocus` effect.

The per-request output limit is a request parameter, not a claim of absolute gateway enforcement; cumulative budgets settle from actual receipts. Ratios compare the same task and model in comparable environments; below one means less. Absolute wall times are not pooled across execution environments, and quality scales are not pooled. Missing or invalid comparators receive neither zero cost nor an imputed ratio. Normal completion does not mean every tool succeeded or every quality requirement passed.

## Comparison with the original AReaL baseline

| Category | Valid pairs/fixed tasks | Median wall ratio | Median token ratio | Known-quality pairs | Candidate/baseline quality means |
|---|---:|---:|---:|---:|---:|
| SWE | 10/10 | 0.920 | 0.718 | 9 | 0.889/0.889 |
| Custom long tasks | 5/5 | 0.814 | 0.676 | 5 | 1.000/1.000 |
| 3D modeling | 18/20 | 0.720 | 0.835 | 18 | 72.22/69.72 |
| Game modeling | 10/10 | 0.801 | 0.823 | 10 | 75.00/75.00 |
| Single-object modeling | 10/10 | 0.950 | 1.177 | 9 | 72.78/70.56 |
| BlenderWorld | 17/20 | 0.950 | 0.698 | 16 | 0.7442/0.7548 |

Of 70 pairs, 48 were faster and 51 used fewer tokens. Geometric mean ratios were **0.912 for time** and **0.822 for tokens**. Medians, geometric means and matched token totals agree in direction, without establishing benefits for every task or model. Of 75 candidates, 74 grades are known and one original grader failed. The previously pending original BlenderWorld grade returned 0.3893; that task has no native-valid comparator, so paired statistics are unchanged. Execution qualification, duration, tokens and request counts remain unchanged across all 225 selected author records, with no additional author or grader calls. Five original-baseline authors failed execution qualification and have no comparable efficiency ratio.

The nine known SWE baseline quality pairs agreed task by task; one remaining baseline grade was affected by dependency-header compilation failure. A valid BlenderWorld candidate's grader failed on an extra render file. These UNKNOWN grades are not zeros, and authors are not rerun to obtain preferred grades.

## Remaining differences from Codex

| Category | Valid pairs | Candidate/Codex median wall ratio | Candidate/Codex median token ratio |
|---|---:|---:|---:|
| SWE | 10 | 1.294 | 1.616 |
| Custom long tasks | 5 | 1.137 | 1.200 |
| 3D modeling | 19 | 0.723 | 0.834 |
| Game modeling | 10 | 0.912 | 1.057 |
| Single-object modeling | 10 | 1.081 | 1.194 |
| BlenderWorld | 19 | 0.702 | 0.448 |

Across 73 valid pairs, median time/token ratios were 0.935/0.897. This modeling-heavy distribution cannot erase the remaining code-task gap or establish overall superiority to Codex. Category quality means, missing observations and per-pair values are in the [machine-readable evidence](long-horizon75-execution-focus-evidence.json). No same-model CC results were measured; public CC mechanisms were design references only.

## Mechanism evidence and counterexamples

On corrected SWE tasks, original AReaL/Codex median request-count and tokens-per-request ratios were 1.938 and 0.994. Extra round trips were more prominent than per-request size. With the policy, the candidate/Codex request ratio remained 1.409. For each pair, `total-token ratio = request-count ratio × tokens-per-request ratio`; separately computed medians cannot be multiplied this way.

Across ten SWE pairs, explicit waits of at most one second fell from 152 to 8, process-tool calls from 191 to 128, and still-running responses from 83 to 28; both arms had 35 failed tool items. Existing wait defaults were already longer. This supports reducing unnecessary short polling without overriding model-specified waits. The policy also guides independent reads and delegation contracts; the combined effect cannot be attributed solely to a wait instruction.

An offline tool-count audit covered all 75 candidate and 70 valid original-baseline archives. The reader follows Core's history-chain merge order, verifies segment SHA hashes and deduplicates identical inherited calls; missing, corrupt or conflicting evidence fails the audit. Eight reader controls passed. None of these 145 archives referenced history segments, so the counts remain unchanged, with no newly discovered seccomp faults. This audit reran neither authors nor graders and does not remove the recorded Chrome anomalies.

Codex's five custom-task traces contained 63 model requests and 58 exec programs; 15 model round trips performed multiple recorded actions, establishing actual use of composed operations. Programmatic tools still need net-effect measurement: this project's cache candidate, early programmatic candidate and browser hybrid candidate did not improve both primary metrics and stopped expanding. Availability in Codex or CC alone does not justify enabling a mechanism by default.

Seven of ten single-object tasks used more tokens, with a median ratio of 1.177; failed tool items increased from 10 to 29. Game-modeling failed-tool totals were both 19, but tasks explicitly reporting Chrome launch failures increased from two to five; single-object exposure increased from five to six. Failed tool items are not unique infrastructure incidents, and successful recovery does not erase anomaly differences. Full end-to-end consumption is retained instead of removing these tasks to improve ratios.

## Costs, recomputation and usage scope

This Astra comparison retains 150 original baseline authors, 75 original candidates, 16 proxy-path corrections and 15 direct-transport corrections: **256 author attempts**. Known tokens total at least **167,955,500**, with **11 requests** missing final usage. Unknown consumption must not be zero-filled. The 20.9% figure is a difference across 70 valid paired authors, not net savings for the entire research process. Other cache, programmatic and temporary-directory candidates, plus build, control and judge costs, remain separately accounted and are not author savings.

The evidence JSON includes three-arm states, usage, quality and category statistics for 75 anonymized samples, allowing recomputation of available-pair medians, `exp(mean(log(ratio)))` and token totals. Task-identity digests connect to the operator archive. Complete requests, artifacts, failures and judge traces are not public with this repository, so this summary alone is not a complete independent rerun package.

Use the existing explicit setting described in the [configuration guide](../../guides/configuration.en.md):

```json
{"policy":{"executionFocus":true}}
```

The switch does not alter budgets, isolation, tool results, cancellation or validation requirements, and does not route by task ID, benchmark or known answers. The [Core policy implementation](../../../core/engine/src/agents.rs) and registry default are unchanged in inspected main revision `eeabc5002bd4c27701bad1f955a3e94709435b63`; static equality is not a new-version performance rerun.

This checkpoint stops additional Astra author repeats and retains the explicit candidate with these limitations. Candidate gains come only from Astra. Output limits and older-route stream truncations in the Qwen 3.8 27B original-baseline comparison are recorded separately; they do not validate the candidate across models, and early failures are not speedups. Default promotion and cross-model gains remain unsupported; general gates are in the [Agent improvement method](../../development/agent-improvement.en.md).
