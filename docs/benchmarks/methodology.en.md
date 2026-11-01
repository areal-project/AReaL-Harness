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

## Common usage observer

`tests/perf/runner/model_observer.py` captures metadata for every HTTP attempt without probabilistic request sampling or changing request bodies, cache keys, or retry policies. Provider `x-request-id`, response IDs, and unique local observation IDs support correlation. Credentials, prompts, and output bodies are not persisted.

The observer commits complete SSE events at blank-line boundaries and handles fragmented streams, LF/CRLF/CR, and multiline data. It distinguishes complete provider usage receipts, partial counters, and unknown usage. Only a complete parseable JSON value may recover metering from an EOF tail, marked `eof_receipt_recovered`; this does not assert complete SSE framing or delivery. Conflicting response identities or counters keep usage unknown instead of combining receipts. Complete receipts from failed or incomplete responses still count toward consumption; execution outcome, transport integrity, and usage completeness are separate. Missing cache counters remain unknown; `usage_field_coverage` reports coverage per field. Legacy records without receipt provenance retain their conservative interpretation.

With `usage_receipt_version=2`, `usage_requests` / `usage_coverage` count attempts with complete provider usage receipts and their fraction, independently of task success. `usage_unknown_by_reason` separates HTTP errors, downstream disconnections, transport failures, missing terminal receipts, parser problems, and requests still in flight at close. Better coverage does not establish better task success or lower cost.

Received usage immediately updates the in-memory checkpoint and submits metadata to the adjacent `*.lifecycle.jsonl`. A receipt already received before HTTP EOF remains in the closing snapshot and is counted once. A bounded background queue handles metadata writes; `metadata_persistence` exposes disk errors, dropped records, and writes pending at close. Disk recovery never blocks forwarding. This queue is not a transactional ledger and cannot guarantee lossless persistence across forced termination or power loss.

Cancellation closes upstream through the existing path. Only already received bytes are parsed: the observer never drains canceled generation, extends generation, retries, or calls other APIs to obtain usage. Missing provider receipts remain UNKNOWN. Providers with stored-response support may permit separately authorized offline reconciliation; this observer does not retrieve responses automatically or present token estimates as actual usage.

Mechanism regressions: `python3 -m unittest discover -s tests/perf/tests -p 'test_model_observer.py' -v` and `python3 -m unittest discover -s tests/perf/tests -p 'test_usage_capture.py' -v`. Local HTTP fixtures cover byte transparency, cancellation, concurrency, disk failure, and closing snapshots; they do not establish that usage missing during real upstream failures can be recovered.

## Real-model browser task pilot

`browser-real-task-pilot-v1` preregisters six tasks with one attempt each, all in `areal-synthetic-browser-pilot-v1`. Tasks cover local HTML reading and questions, one form submission, dynamic directory selection, iframe information, multi-page lookup, and interruption after the first confirmed side effect. The model receives ordinary goals, public addresses, and legitimate user inputs, then chooses browser tools. Independent site receipts, native WebContents DOM, and complete Core history establish outcomes.

Run these commands from the repository root. Plan mode neither launches Electron nor reads model credentials. Fixture mode uses a fixed model stub and labels results `deterministic-task-chain`, with `realModel.status` set to `not_run`.

```sh
pnpm --dir clients/gui test:browser-tasks
pnpm --dir clients/gui bench:browser-tasks:plan \
  --output "$PWD/.scratch/browser-task-plan"
pnpm --dir clients/gui bench:browser-tasks:fixture \
  --output "$PWD/.scratch/browser-task-fixture"
```

Before fixture or real execution, prepare GUI artifacts and a real Core binary. Set an absolute `AREAL_CORE_BIN` if needed. Repository rules route computer and browser UI operations to GPT-6.1 Terra. Each task gets fresh Electron user-data, Core home, user home, registry, workspace, and browser state. Execution uses public create/send and authoritative `thread/read`. Browsers start cold, with no preopened page, manual navigation, or manual claim. The model's first Core-approved describe creates and claims the blank page through the product flow. The fixed model also obtains its pageId from the actual describe receipt before navigating through the same tool path.

Obtain user authorization for these six real-model tasks and the specific credential source first. After authorization, the operator populates a temporary credential environment variable in the current shell and supplies its name. Replace the example full Responses endpoint below with the authorized service. The runner does not read desktop vaults, accounts, or saved credentials. Secrets stay in the parent HTTP gate and do not reach Electron/Core children.

```sh
pnpm --dir clients/gui bench:browser-tasks:real \
  --authorized --protocol responses --model gpt-6.1-terra \
  --upstream https://api.example.invalid/v1/responses \
  --credential-env AREAL_BROWSER_PILOT_API_KEY \
  --output "$PWD/.scratch/browser-task-real"
```

Missing authorization, explicit configuration, or the named environment variable leaves all six attempts `blocked`, with no fallback model. `--authorized` records authorization already obtained from the user. It does not grant authorization itself. One [Arena real-task pilot](reports/browser-real-arena-pilot.en.md) is available as a single-source, single-attempt observation, without a general capability or benefit claim.

Each task fixes Terra, medium reasoning, default service tier, and omitted temperature. Core limits are 20 model rounds, 64 tool calls, 4096 output tokens per request, and zero task reruns. Model transport uses `model.max_retries=0`; Core `network.retry_mode="bounded"` still permits up to five network recovery retries per eligible logical request. Every such request counts toward the HTTP cap. Terminal polling has a 180-second budget, excluding setup and cleanup. The outer controller requests child termination at 420 seconds and forces termination at 435 seconds. In real mode, a transparent HTTP gate caps all underlying requests at 24, including retries and auxiliary requests, and rejects requests outside the frozen model parameters or output limit. If the provider honors that limit, aggregate output is bounded by 98,304 tokens per task. This does not bound input tokens or establish a dollar cap.

Approval uses Ask. The executor reads authoritative pending Core interactions, then allows once or denies according to source and destination origins, task ownership, and the exact local file scope. Every decision is retained. Random local-document origins enter the scope only through a successful openDocument receipt for that task. The effective preset, human reviewer, tool scope, and round limit are checked and recorded before submission. Public create does not expose an automatic-naming disable field, so naming keeps its default behavior. Naming, prompt prediction, and other auxiliary model requests pass through the same HTTP gate and Core audit and remain part of consumption. Fixture replies to auxiliary requests do not advance browser task steps. The stop task pauses after the first site side-effect receipt, stops all approval submissions, and reads authoritative history until the original request settles. It checks for no new effects over three seconds. Stop is submitted once. Crossing the task deadline preserves timeout/unknown and observes the original request without resubmitting. Site effects and stop-request metadata remain separate, so missing settlement does not imply that no effect occurred. Its expected `interrupted` state has a separate safety outcome and is excluded from the five ordinary tasks' completion count.

`manifest.json` retains every planned attempt, actual status, source and artifact hashes, model parameters, budgets, cleanup, and grading. Per-task directories retain complete authoritative history, every tool call, site facts, native page facts, Core model audits, and HTTP request metadata. A timed-out, blocked, or unknown attempt does not count as task completion even if Core reports completed during cleanup settlement. Actual tier and usage come only from receipts observed by Core. Missing values remain `unknown`, and known partial usage is a lower bound. Cancellation closes upstream instead of continuing generation to recover statistics.

This pilot checks one source's real-task pipeline. Formal policy development comparisons still require at least 12 distinct tasks, three independent source groups, and five repetitions per task per arm. Six same-source tasks and fixed-model fixture results do not establish model rankings, policy benefits, or default promotion.

## Paired browser development comparison

See the [paired benchmark acceptance report](reports/browser-paired-readiness.en.md) for execution and connectivity status.

The [local-link navigation preregistration](browser-local-link-plan.json) fixes current inputs and gates; the [guide-ablation preregistration](browser-guide-ablation-plan.json) remains historical experiment input. Twelve ordinary tasks have three mother sources, with a separate stop task. Five independent repetitions per task and arm produce 130 attempts. Each arm has 60 ordinary attempts, targeting at least 57/60, and must pass all five stop trials. The 95% threshold is an observed development-set gate, not a population capability guarantee.

Sources are the five existing ordinary synthetic tasks; enter-text, choose-list, click-checkboxes and click-option from [pinned MiniWoB++](https://github.com/Farama-Foundation/miniwob-plusplus/tree/33c3b4ddef8c6eb67c57a29663d844b1eda7e614); and add, edit and Active-filter tasks derived from [official TodoMVC tests](https://github.com/tastejs/todomvc/blob/ff43b02e59dfa604386bb382034b2cd07c2bcd8a/cypress/e2e/spec.cy.js). Original assets, licenses and hashes remain under `clients/gui/scripts/fixtures/vendor/browser-task-sources/`. MiniWoB's original ten-second deadline is ported to 180 seconds; the model still operates START within its budget. TodoMVC uses the official in-memory React app, starting empty and creating state through ordinary controls. Persistence and official benchmark scores are not claimed.

Both arms use normal application controls and avoid grader/reset APIs. Approval uniformly denies arbitrary Playwright evaluation without changing product tools. MiniWoB saves the public goal and native controls after START and before the answer, then cross-checks raw reward=1, episode state and final controls. Missing initial evidence remains UNKNOWN. TodoMVC follows the official visible-DOM assertions. These client-side oracles have a weaker trust boundary than an independent server submission receipt.

The first experiment is a historical guide ablation. A removes only the current fixed product's checked/topic runtime guidance; B is the current product. Geometry, Core, Electron, renderer and browser bundles match, with one frozen harness. Actual loaded Main paths and guide digests are checked separately; changing cwd or binary alone does not isolate an arm. Core keeps its authorized fixed path and the same debug profile, checking all three component hashes per attempt without rebuild/deployment during execution. This establishes no absolute release-package latency.

Before creating an output directory or requesting the model, the paired runner reads `inputPlanPath` (resolved relative to the configuration file) and checks the raw file against `inputPlanSHA256`. Admission checks schema 2, experiment ID, explicit comparison kind, A/B arms, model parameters, the complete task/source catalog, attempt budgets, schedule seed, every scheduled row, and quality denominators. A mismatch fails immediately. `--plan`, fixture, real execution, and `--resume` share this admission. The validated path and digest enter the freeze. Old configurations with only a digest, no path, or no explicit comparison kind are rejected. Archived experiments and receipts remain intact; changing their frozen configuration cannot resume them. This check does not interpret natural-language `sourceChange`; existing provenance and independent diff review still verify actual artifacts.

Local configuration supplies `inputPlanPath`, `inputPlanSHA256`, `experimentId`, `comparisonKind`, schedule seed, the full Arena Responses endpoint's SHA256, and each arm's absolute `appRoot`, `launcherPath`, `coreBinary` and `electronExecutable`. The authorized executor supplies the full endpoint, whose digest must match before requests. Secrets enter neither configuration, children nor evidence. Commands are:

```sh
pnpm --dir clients/gui test:browser-tasks
pnpm --dir clients/gui bench:browser-tasks:plan \
  --paired-config /absolute/paired-config.json --output /absolute/experiment
pnpm --dir clients/gui bench:browser-tasks:real \
  --paired-config /absolute/paired-config.json --output /absolute/experiment \
  --resume --authorized --protocol responses --model gpt-6.1-terra \
  --upstream https://api.example.invalid/v1/responses \
  --credential-env AREAL_BROWSER_PILOT_API_KEY
pnpm --dir clients/gui bench:browser-tasks:summary /absolute/experiment/manifest.json
```

The plan enumerates all source/task/repeat/arm/sequence identities. Paired attempts are adjacent with randomized AB/BA order and matching instance seeds. Every attempt creates fresh Electron/Core/home/workspace/gate state. Output directories never overwrite attempts. Resume accepts only completed receipts with matching identity, artifact and result hashes. Started attempts without receipts remain UNKNOWN without replay; unproven cleanup blocks the next attempt. Original six-task pilot commands remain available.

Per-attempt limits are unchanged. The 130-attempt plan permits at most 3,120 client HTTP requests. Conditional on provider enforcement, the output bound is 12,779,520 tokens; this bounds neither input nor money. Input rules are committed first, with complete artifact and endpoint identities sealed in the local manifest before the first request. Code, tasks, oracles, budgets and schedule remain fixed during execution. All failures and unfavorable results remain available.

The preregistered primary efficiency metric is source-equal-weight penalized Solve cost. Successful ordinary attempts use fully reconciled actual Solve HTTP counts. Failure/UNKNOWN receives a predefined cost of 24, which is not an actual request count. Missing successful-attempt counts make the comparison INCONCLUSIVE. All actual requests and known consumption are reported separately; missing usage is not zero, caches are not double counted, and lower bounds cannot establish token savings. `timings.sendToTerminalMs` measures submission to terminal; setup, verification, stop observation and cleanup are separate.

Development retention requires candidate ordinary quality of at least 57/60, stop safety 5/5, no observed quality decrease overall/by source/by task, and a paired-quality 95% interval lower bound of at least −5 percentage points. Cost improvement must have a point estimate of at least 15% and an interval lower bound above zero. A 10,000-sample paired source-cluster bootstrap retains all within-source tasks/repeats, with leave-one-source-out sensitivity. Three source groups do not establish generalization.

Historical ablation measures existing guidance, not a 15% improvement over the current product. Later experiments test one evidence-backed candidate at a time. Mechanically correct guidance is not reverted merely for lacking efficiency gains. Final cumulative effects require a fresh same-batch comparison against the original current product; effects from separate rounds are not multiplied. Default efficiency promotion additionally requires frozen sources unused during tuning.

### One-attempt autonomous HTML acceptance

`--task generated-local-html` separately selects autonomous creation and opening, outside the 130-attempt paired schedule. The executor prepares only an absent workspace HTML path. The model creates the document from the public title, Results content and per-attempt reference requirements, then opens it in the current chat. Only `fs_create` and `browser_v1` are allowed, using Ask approval, isolated instances and the same per-attempt budget. The executor neither prewrites HTML nor supplies a tool-call sequence.

Success requires normal Core termination, successful receipts creating then opening the same file, disk content and digest, final native page content, and complete cleanup evidence. Real mode retains every request and missing usage. One pass establishes only this flow, contributes no paired quality samples, and establishes neither generalization nor efficiency gains. Deterministic mode checks only execution and grading.
