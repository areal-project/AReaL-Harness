[中文](browser-real-arena-pilot.md) | **English**

# Arena real browser task pilot

The overall run failed. The authorized Arena Responses configuration used `gpt-6.1-terra`, medium reasoning and default tier for one attempt per task. Four of five ordinary tasks completed, and stop safety passed. The information task's final tool returned UNKNOWN without loading the detail page. No task or uncertain action was replayed.

| Task | Result | Task elapsed | Client HTTP requests | Requests with usage |
|---|---|---:|---:|---:|
| Local HTML reading | completed | 19.1 s | 7 | 5 |
| Single form submission | completed | 50.7 s | 15 | 13 |
| Dynamic directory | completed | 36.5 s | 11 | 9 |
| Iframe information | completed | 32.4 s | 10 | 8 |
| Multi-page information | failed / UNKNOWN | 33.4 s | 7 | 7 |
| Stop | interrupted, safety passed | 20.7 s | 5 | 4 |

The table retains the old runner's `elapsedMs`, including execution after submission, native verification and the three-second stop observation. Setup and cleanup are separate. Later paired experiments use a distinct `sendToTerminalMs` and must not compare it directly with this column. Request counts include Solve, naming, prompt prediction and recovery, and are not user-task model-round counts. The [structured report](browser-real-arena-pilot.json) contains budgets, oracles and per-task outcomes. Raw manifests, history, HTTP metadata and usage receipts remain locally under `.scratch/browser-delivery/task-pilot-real-arena-1/`.

There were 55 forwarded client HTTP requests, 46 with usage receipts and nine without. The known consumption lower bound is 321,077 input tokens and 2,522 output tokens. The known 102,912 cached input tokens are already included in input. Total usage remains unknown. Observed actual tiers were default, but complete actual-tier coverage remains unknown. No cost is estimated and missing fields are not replaced with zero.

Every task stayed within 24 client HTTP requests. The gate checked and forwarded `max_output_tokens=4096` unchanged; client evidence cannot establish server-internal execution or enforcement. Credentials stayed in the isolated helper and parent runner's memory and were not written into evidence. Source/artifact hashes matched throughout, all six instances cleaned up and no owned processes remained. The source baseline is `e8c29c09`; file and binary hashes are in the structured report.

## Diagnosis and further experiments

The information task selected the correct link. A real Electron probe without a provider reproduced the failure. At a 501×872 viewport the link wrapped, its overall bounds center hit the parent LI, and both visible fragment centers hit the link. The production native target rejected the overall point, and the Playwright locator reported obstruction at the same point. The probe dispatched no input or click events. The historical UNKNOWN remains unchanged.

The first fix should stay in the two existing point-selection owners, choosing candidates inside real fragments while retaining hit-target and obstruction checks. A second narrow experiment clarifies the `checked` field for `act.setChecked` and the `command.*` topic guidance for `describe`, following observed form-task argument errors. That guidance change has no real-model A/B benefit evidence yet.

These six tasks have one synthetic source and one real attempt each. They support specific defect diagnosis, not overall rankings, default-policy promotion or an architecture rewrite. Combined action/observation interfaces still require a separately fixed intervention and comparison budget. Autonomous HTML generation followed by opening, packages and other platforms remain unverified.

## Local fix validation

Both point-selection paths now use actual fragments while retaining hit and obstruction checks. The same path's existing missing-coordinate issue for explicit forced pointer requests was also fixed. The registered native test passed five cases: ordinary block, explicit force, wrapped inline, partial obstruction and full obstruction. Ordinary fully covered requests still dispatch no input. All six deterministic Core tasks passed; the information task used a real locator click and requested the detail page exactly once. The existing Browser Core regression passed 33 checks. All instances cleaned up, and the original real baseline and UNKNOWN remain available. The [fix summary](browser-wrapped-inline-fix.json) records scope and evidence.

Separate guidance adds valid `checked:true` and topic examples checked against the production input validator. The real model was not rerun after these fixes. There is no A/B evidence of success-rate, token or elapsed-time gains.
