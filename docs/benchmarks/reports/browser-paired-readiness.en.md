[中文](browser-paired-readiness.md) | **English**

# Paired browser benchmark acceptance status

Independent real HTML creation/opening passed, and the local-link navigation and native-closure fixes are committed. The expanded paired experiment stopped after attempt 25 because native page shutdown timed out. Its result is INCONCLUSIVE, with no new complete real-model score or efficiency gain. See the [methodology](../methodology.en.md), [historical guide-ablation input plan](../browser-guide-ablation-plan.json), and [structured status and accounting](browser-paired-readiness.json).

## Completed validation

All 73 task benchmark Node tests, 93 browser contracts, GUI type/static checks, documentation and commit formatting checks passed. The original current product passed 13 deterministic Core scenarios and three native negative examples. The navigation fix additionally passed eight native controls and three real-Core deterministic regressions covering Active filtering, information details and a one-submission form. The first two explicitly use Ref act.

Navigation fix `19834532` binds the exact local link href during preparation, rechecks it before dispatch, then reuses existing navigation intent handling. Ordinary buttons retain their behavior, changed destinations are rejected before input, and script navigation and takeover still revoke control. The native probe uses a synchronous in-process service and establishes only its native branch. Separate real-Core regressions cover tool termination. There is no post-fix real-model benefit comparison yet.

## Independent real HTML acceptance

The first attempt failed in transport: six forwarded requests received no HTTP response. Its evidence remains intact. After connectivity recovered, a separate one-attempt acceptance started from an absent file. The model created and opened it. Core write digest matched disk bytes; the subsequent openDocument receipt matched native title, Results, public nonce and a separately reviewed native image. Terminal state, exit, cleanup and source checks passed.

The second attempt forwarded eight requests, six for Solve. Six had usage; two auxiliary requests were cancelled. Known lower bounds are 33,987 input and 433 output tokens; 11,008 cached input tokens are already included in input. Complete usage and actual-tier coverage remain unknown. These bounds establish neither savings nor monetary cost. One pass establishes only this flow, adds no paired samples and does not establish autonomous-generation generalization.

## Interrupted comparison and next steps

Historical guide-ablation-01 retains 25 receipts and 105 planned rows. Observed ordinary outcomes passed 14/23, and stop outcomes passed 2/2. These are incomplete mixed-arm observations, not a current-product score. The batch observed 379 forwarded requests. Attempt 25 did not meet its task goal and hit the Electron cleanup deadline of 20 seconds, yielding nonzero child exit. Core stopped, no provider requests remained in flight, and source hashes matched. Later process absence does not rewrite the original unknown cleanup receipt. The old batch is not resumed or stitched to new samples.

No-model native controls reproduced unsettled destruction with an open SELECT. Native DOM blur closed the menu and enabled normal destruction on the fixed local page, without window focus events. Main-renderer focus did not fix the real replay. Keeping the view attached also failed, so reparenting is not necessary. The instrumented resource replay explicitly waited for native destruction and rejected after ten seconds; it does not establish that dispose skipped its wait.

Native closure repair `c19cd5d5` passes 39 focused boundary tests. The final revision passes unnavigated blank-page closure, same-ID replacement, open SELECT, pending resources and strict attempt-025 replay. The replay still fails its task, but Electron exits normally, Core stops, and source hashes match before and after. The pending-resource case destroys promptly but its isolated blur returns false; that case does not establish blur execution. Ordinary input, crashed-renderer, controlled asynchronous barriers and actual WebM recording regression passed on the parent candidate. The final revision only adds the no-committed-document guard before DOM inspection. Actual recording completes before shutdown. Prior failures remain archived, with the native wait of 10 seconds and test exit deadline of 20 seconds unchanged.

The [new input plan](../browser-local-link-plan.json) preregisters a complete 130-attempt comparison of current product versus a single local-link fix, sharing the closure repair. Actual D/E artifacts and freeze passed independent admission. Prior failures and consumption remain separate. Gates remain 57/60 ordinary tasks, 5/5 stop trials and at least 15% improvement in source-equal-weight penalized Solve cost.

Raw evidence remains under `.scratch/browser-hillclimb-v2/`. Package, cross-platform and unseen-source confirmation remain unverified.

## Delivery and requested stop

At the user's request, the new experiment stopped after attempt 14 settled. Attempt 15 was never admitted; 116 rows remain planned. All 14 receipts pass identity, hash, cleanup and source-stability checks. The raw manifest retains a stale running field because the runner exited at the deliberate next-directory barrier. A separate closeout binds the original manifest hash and records no active attempts or related processes. This intentional EEXIST is not a model failure and replaces no receipt.

| Settled observations | Control A: common closure repair | Candidate B: additional local-link repair |
| --- | --- | --- |
| Ordinary tasks | 3/6 passed | 5/6 passed |
| Stop safety | 1/1 passed | 1/1 passed |

Each arm still has a planned denominator of 60 ordinary and 5 stop tasks. In two Active pairs, A fails with control_changed UNKNOWN while B passes. Each arm also fails one selection task. These incomplete development observations do not establish an overall improvement. There are 222 forwarded HTTP requests, including 202 Solve requests. Usage is complete for two attempts and partial for twelve; no token or dollar savings are inferred. Neither the 95% completion nor 15% cost goal has been accepted.

The [four-project research and earlier local improvements](browser-automation-evaluation.en.md), three-source 13-scenario benchmark, independent real HTML creation/opening and validated navigation/closure repairs form this delivery. The historical experiment retains 25 started and 105 planned rows, separate from these 14 attempts.

Unnamed native SELECT observation refs/options and cancellation remain a separate follow-up. The isolated F prototype is unpromoted and uncommitted; its retained candidate has a failing navigation-cancellation counterexample. A later passing 47-test log includes a withdrawn guard and does not verify that candidate. No UI or real-model validation ran for it. Follow-up work should validate reproduced closure, navigation and cancellation mechanisms without a model, then run a small real-model pilot before deciding on a full comparison. This delivery stops further repairs and retesting.
