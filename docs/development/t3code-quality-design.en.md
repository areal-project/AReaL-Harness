[中文](t3code-quality-design.md) | **English**

# Learning from T3 Code: testability, reliability, and development efficiency

## Session objective and implementation boundaries

The session objective is to **make critical user journeys produce trustworthy outcomes during normal operation, failures, and upgrades; give every code change faster evidence that can detect mistakes; and improve responsiveness and consistent interaction on that basis.** T3 is a design reference. AReaL failures, call paths, and user tasks determine the work.

The external study targets T3 `f41518f3`; the local source comparison targets `93a9e079b107a13b0c312920b917b5f61a8f720c`. Its commit counts, CI rates, durations, and release examples are not AReaL quality metrics. Independently unverified numbers do not become acceptance evidence for this repository.

Retain Clients → Core → Runtime ownership: Core owns admission, conversations, and execution settlement; Runtime owns effects and cleanup; Desktop/workbench owns transport, observation, and rebuildable projections; Renderer owns user intent and derived presentation; Design System constrains state communication, composition, and interaction continuity. Introduce a domain object, recovery protocol, or persistence mechanism only after demonstrating which concrete contract the existing owner cannot satisfy.

### Six outcome objectives

| Objective | User or developer outcome | Acceptance and existing entry points |
| --- | --- | --- |
| Q1. Trustworthy state and recovery | Accepted, executing, settled, and unknown remain distinct; stop, reconnect, and late events cannot cross task ownership or repeat effects | Admission/recovery contracts and Provider replay check authoritative identities, persisted results, and real effects, followed by GUI state and available actions. See `core/engine/src/desktop/submissions.rs`, `provider_replay.rs`, and Desktop projection tests |
| Q2. Trustworthy, repeatable verification | Correct implementations pass and relevant faults are explicitly rejected; failures retain evidence and clean up their own resources | Bind results to source/input/artifact identity; cover empty plans, cache hits, missing prerequisites, and cleanup failures; await actual persistence, drain, or exit milestones. Reuse `check-changed.py`, existing smokes, and artifact verification |
| Q3. Consistent product interaction and Design System | Users understand the current state and next action, retaining reading and interaction intent through streaming, disclosure, navigation, and recovery | Apply `CONV-OWNER-01`, `CONV-READ-01`, `CONV-DISCLOSURE-01`, `NAV-CONTEXT-01`, and `RECOVER-TRUTH-01` to state, actions, focus, semantic anchors, and manual disclosure, using production components and nearby contracts |
| Q4. Attributable performance gains | Representative workloads reduce actual waiting or main-thread cost while data stays fresh and caches remain bounded | Compare identical inputs/environments; distinguish derivation calls/processed bytes, CPU, interaction latency, transfer size, and heap/RSS. Detect disabled optimizations and verify history/owner/status invalidation |
| Q5. Faster, transparent development feedback | Common changes expose relevant failures early; unknown scope expands checks and missing evidence stays visible | Reuse CI scope and the manifest; record type/static/behavior/build durations and first-run failures; explain selection, skipping, and cache invalidation; retain fault detection before and after optimization |
| Q6. Usable builds, upgrades, and delivery | The same candidate application starts, reads supported old data, displays original conversations, and exits normally, with recovery actions for failures | Reuse `verification.py`, `history-copy-smoke.mjs`, `update-smoke.mjs`, and package checks. Bind source, source Electron, final package, signing, and notarization evidence separately |

Testability is an owner-interface property: important asynchronous work needs observable completion or failure. Verifiability is an evidence property: conclusions identify inputs, actual execution boundaries, and missing coverage. Test counts, rule counts, cache counts, and document length are not completion metrics.

### Select coverage through user journeys

Maintain five repeatable journeys: send and observe an outcome; reconcile after stop or disconnect; read and manually expand during streaming; switch conversations and return to drafts/reading position; open old data and recover from upgrade failure. Each iteration selects the affected journeys and critical failure states rather than every state combination.

Design System supplies their interaction contracts: shared primitives own appearance and accessibility semantics, business owners supply truthful state and valid actions, and pages compose them. Follow must/default rules and reuse tokens, components, and states. New exceptions need a concrete consumer, reason, and exit condition. Static checks, pure derivation/SSR, real browser interaction, source Electron, and final packages receive separate conclusions. Screenshots only establish captured states, not recovery, cancellation, or focus continuity.

### Execution order

| Priority | Bounded work | Closure condition |
| --- | --- | --- |
| P0: integration baseline | Establish reachability of main-worktree, Claude, and specialist branches; run affected contracts, types, and design checks | Current baseline, unintegrated work, failures, and evidence limits are reviewable. Admission work and C lint are integrated; parked schedules and other specialist fixes still require their own reachability checks |
| P0: trustworthy feedback | Empty-plan source/index drift and history failure cleanup are fixed; cleanup errors remain separate, and absent Desktop metadata prevents success | Independent failure evidence for both; empty results bind current inputs; cleanup completes only when owned instances exit, without counting timeout or forced kill as normal cleanup |
| P1: product continuity | Establish a real-input baseline for streaming reading, manual disclosure, and navigation on integrated Messages; check unknown and unsettled states | Semantic anchors, conversation identity, disclosure choices, focus, and valid actions match contracts; classify baseline failures before optimization instead of weakening assertions |
| P2: demonstrated hotspots | Measure message grouping, reading-checkpoint serialization, and reference/notification propagation through CoreBackend→SharedCoreBackend→Renderer; implement only demonstrably useful small slices | Attributable gains on the same workload plus passing invalidation, capacity, and interaction contracts; candidates without benefit evidence remain unmeasured rather than adding mechanisms |
| Impact-triggered: delivery and model interfaces | Package/dependency/migration changes run final-artifact journeys; prompt/tool/budget changes run byte baselines and proportionate behavioral evaluation | Evidence identifies the artifact or model configuration; publishing, signing credentials, paid models, and external operations retain their authorization boundaries |

Fix performance workloads by actual dimensions: projects/conversations, visible Turns/items, stream-event count and cadence, historical pages/content size, reading owners, theme/font/window, and device. Separate cold and warm paths; attach sample counts and failed attempts to latency percentiles. Measure distributions before setting stable budgets. Do not copy T3 byte limits or equate encoded JSON size with memory limits.

On the merged baseline, message grouping measures about 2–4% of Messages subtree rendering cost, so this iteration retains the measurement entry point without adding that cache. Checkpoints use per-entry encoding and exact accumulated lengths to eliminate repeated prefix encoding. `CoreBackend.snapshot()` recreates projects, state/threads, and derived fields, while `SharedCoreBackend.snapshot()` wraps projects again. Simulating stable references only in the latter does not prove production transfer savings; cross-layer caching still requires measurement of the real path.

### Iteration loop and stopping conditions

Start with a real defect, user journey, or measurement. State “broken invariant → owning module → cheapest correct interception boundary → counterexample that can fail.” Reuse sufficient tests and avoid duplicate mirror tests for constraints already represented by types.

Each iteration follows objective/baseline → parallel investigation → architecture decision → small implementation → independent verification → contract/document update → local commit. Discovery does not automatically expand scope. Delegate by owner, freeze writes before integration, and bind evidence to one source baseline. Review state semantics, cache/selection logic, and failure cleanup first; resolve basic errors before visual or more expensive native qualification.

Deliver what changed, why that layer owns it, normal/failure observations, before/after measurements, targeted counterexamples, actual artifact identity, and unexecuted checks. Stop when the slice meets its contract, relevant checks are complete, and the owned diff is reviewed. Missing live-provider, platform, package, or user acceptance remains an explicit qualification gap; it does not become a claim that the entire system is accepted.

## Architecture review and this iteration's P0

The external topology proposal is checked against source revision `39982f3d`. Adopt service capabilities before client entry points, explicit lifecycles, admission evidence for writes, bounded read projections, and executable constraints. These factual corrections determine implementation order; the proposal is not an approved migration plan.

| Proposed diagnosis | Current source and decision |
| --- | --- |
| Cross-project coordination all lives in Electron's window Main | `service-client.cjs` launches an independent Desktop service; `service-main.cjs` owns CoreBackend, schedule activation, and RemoteControl. Directory placement is not process ownership. Consolidate at existing service boundaries first |
| service-host is short-lived and closing a window always stops background work | Rust service-host already supervises each dataDir persistently. Main hides closed windows; explicit quit settles and stops the background. Independence from GUI is a new lifecycle product decision, not a consequence of detached/unref |
| Every Host index and journal can be rebuilt from Core | Only derived projections support that promise. Project registration, pairing authorization, client submission intent, and crash/replacement receipts are user, security, or control facts. Intent that never reached Core cannot be recovered from it |
| All task directories poll every three seconds and shared client packages are missing | OwnerTasks already uses watch→paged baseline→dirty drain, task centers refresh on directory revision, and remote-client exists. Three-second polling remains in historical scheduled-task receipt detail cards; it does not justify replacing every directory or connection |
| Restart recovery is uniformly UNKNOWN and operation names determine replay safety | Store distinguishes paused Goals, interrupted Turns, and unconfirmed tool UNKNOWN; TaskRuns also pause on restart. Names such as cleanup or title generation do not prove replay safety: establish idempotency keys, commit points, owner generations, and settlement evidence first |
| Impact analysis, history fixtures, input budgets, and lint are absent | G/H/I/C already have scoped implementations and counterexamples. Final packages, real-user upgrades, and full-host model input need separate qualification. Rule counts and commit statistics do not prove quality. Static rules belong in code; semantics, rationale, and manual interaction contracts retain their single documentation owner |

This iteration implements only **P0: truthful cleanup and results after history acceptance fails**. An earlier real corrupted-history failure and an owned-child reproduction show that close timeouts can leave a test process alive, hide cleanup errors behind the original failure, and still report successful shutdown. Closing targets only the Electron child held by this run. Desktop/Core require independent verification; absent metadata or cleanup errors cannot produce success. Preserve business and cleanup failures separately; forcibly ending a child does not count as normal successful shutdown.

A machine-level Host, SQLite, background work after full quit, generalized replay policy, and merging runtimes for different protocols remain design candidates. Define per-user/per-profile isolation and lifecycle requirements before deployment topology. Retry ownership belongs to a specific connection/environment, not indiscriminately to a physical machine.

The next performance candidate is historical scheduled-task receipt cards: several cards for one taskId may independently call `manage/task`, and unchanged task content can still publish the model. First measure real 0/1/10-card workloads, both projection paths, and state-update latency; then choose duplicate-read coalescing or unchanged-publication suppression. Equal revision does not automatically prove equal complete content. This iteration does not present source inspection as measured performance savings.

## Status and implementation boundaries

This design extends A/B/C in the admission-record, scheduled-task, and repository-lint specification. The minimum D–I slices now use existing tests, fixtures, and local-check entry points. J changes the owners of Renderer navigation derivations and reading state. Executed evidence and remaining native acceptance are reported separately.

T3 reference sources are pinned to `93a9e079b107a13b0c312920b917b5f61a8f720c`. AReaL retains Rust Core/Runtime, real HTTP adapters, Desktop projections, the test manifest, and fixed-artifact verification. Protocol replay substitutes only the external model. Renderer derivation caches do not settle writes or own authoritative session state.

| Package | Current implementation | Executed evidence and limits |
| --- | --- | --- |
| C. Repository lint plugin | Changed-file rules, shared observeResize, rule and browser counterexamples | Node 24.11.0: 80 GUI unit tests including 18 rule tests, real changed-file counterexamples, and Chrome resize probes pass; accessibility diagnostics are classified separately |
| D. Provider protocol replay | Versioned JSON, real HTTP bytes, outbound-field checks, gates and disconnects | 23 HTTP/replay/timeout tests across D/E pass; one real Runtime write-recovery test passes from the fixed slot |
| E. Controlled ordering | Request-arrival/release milestones and virtual-time ResponseDeadline coverage | The 23 tests above and one virtual-time test pass; real HTTP time boundaries remain |
| F. Projection consistency | Close on missing base, reconnect with a full baseline, stale-connection isolation and history release | Seven Desktop local-transport tests pass; mobile and Relay are outside this evidence |
| G. Change-scoped local checks | Reuse CI scope and manifest, explain selection, invalidate changed inputs | Thirteen temporary-Git contracts and five manifest tests pass; full execution depends on selected prerequisites |
| H. Representative history | Old-format paged history, settled child relationships and three terminal outcomes with profile assertions | Real Electron/Core acceptance passes; 40 Turns require one older page, source and open-copy hashes stay unchanged, and model requests remain zero |
| I. Model-input baseline | Component byte baselines for default Desktop without Runtime/plugins | One real Engine/HTTP test passes, including independent-instance comparison and input-growth/shrinkage cases |
| J. GUI derivation and reading caches | Immutable-input caches, non-mutating sidebar sort, 32-entry memory cap, and single-pass entry encoding | Chrome computation/freshness, message continuity, and seven reading-cache tests pass; the complete legacy conversation-flow scenario still has a locator failure |

D/F/H add protocol faults, observation-chain checks, and representative historical data. E/G/I develop time control, local checks, and context budgets. J uses actual computation and capacity evidence to select a small correction. These evidence boundaries remain distinct and do not establish overall Agent capability, cost savings, or perceived-latency gains.

## D. Replay protocols at the real Provider adapter boundary

**T3 evidence.** `packages/provider-testing/src/replayTranscript.ts` parses metadata-bearing NDJSON and materializes workspace placeholders. `replayGate.ts` provides `waitForReached/release`. `ProviderReplayHarness.ts` connects replay adapters to real orchestration and persistence services. Recovery tests also carry persisted state into later runtimes. See the [transcript reader](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/packages/provider-testing/src/replayTranscript.ts), [gates](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/packages/provider-testing/src/replayGate.ts), and [recovery tests](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts).

**Implementation.** [http_replay.rs](../../core/engine/tests/support/http_replay.rs) reads versioned JSON declaring ChatCompletions and synthetic provenance, checks necessary outbound JSON-pointer fields, and sends specified HTTP bytes. A response can pause after request arrival or advertise more Content-Length bytes than it sends to reproduce transport truncation. `request(index)` and `release(index)` control ordering; completion checks script consumption, and failure/Drop cleans up the owned server task.

[provider_replay.rs](../../core/engine/tests/provider_replay.rs) runs production HttpModel/decoder, Engine, and temporary storage to verify retained text before an error in one chunk, no released tool calls after transport loss following finish_reason, and no late answer replacing a persisted Interrupted state. Two original `http_model.rs` tests move into this entry point; scripts live in `tests/fixtures/provider-replay`.

The real Runtime case is selected explicitly with `test-support`. It completes a file-tool write, independently checks the persisted record, disconnects the next model request, and reopens Engine. A sentinel file and tool-result count detect replay of the completed write. It requires `AREAL_TEST_BIN_DIR` pointing to a verified fixed bundle from the same build and passes one native fixed-slot case. It covers reopening after normal shutdown of the old Engine; an in-flight process crash is outside this evidence. Complete and truncated scripts have distinct expectations. Replay success does not establish live-provider compatibility or package acceptance.

## E. Control ordering with milestones and policy with virtual time

**T3 evidence.** [DeterministicRuntime.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/orchestration-v2/testkit/DeterministicRuntime.ts) installs TestClock and seeded randomness; replay gates distinguish arrival from release. [ThreadSettlementService.test.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/orchestration-v2/ThreadSettlementService.test.ts) uses Deferred and TestClock to control races. Polling helpers also exist in T3, so this does not establish that every test is deterministic.

**Implementation.** The cancellation scenario waits for replay request arrival, waits for the Turn to settle as Interrupted, releases the late response, and checks saved state in a new Engine instance. It replaces the cancellation test's delayed-header timing window. Network EOF and persisted outcomes remain separate assertions.

`first_event_deadline_is_fixed_and_activity_starts_a_new_idle_window` in [watchdog.rs](../../core/engine/src/watchdog.rs) uses paused Tokio time to verify the fixed first-event deadline and the new idle window after Activity. `model_timeouts.rs` retains four real HTTP boundary tests. Virtual time controls policy timers, not a shared clock for sockets, Main, pages, and system I/O.

Run `cargo test --locked -p areal-engine --test http_model --test provider_replay --test model_timeouts` and `cargo test --locked -p areal-engine --lib first_event_deadline_is_fixed_and_activity_starts_a_new_idle_window`. The former passes 23 tests and the latter one; the feature-gated Runtime case is not included. Milestones and targeted-error assertions explain failures while retaining overall deadlines. A retry pass cannot hide a first-run failure.

## F. Complete snapshot, delta, and reconnect consistency acceptance

**T3 evidence.** [subscribeBeforeSnapshot.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/utils/subscribeBeforeSnapshot.ts) either reads the snapshot then subscribes inside a shared mutex, or subscribes first when no shared lock exists. Its [tests](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/utils/subscribeBeforeSnapshot.test.ts) insert changes into the read window. [shell-sync.test.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/packages/client-runtime/src/state/shell-sync.test.ts) covers stale asynchronous saves, authoritative resets, and enrichment conflicts. Borrow executable invariants, not ordering inferred from a function name.

**Implementation.** Retain the stream/sequence/delta-base contracts in [state-projection.cjs](../../clients/gui/packages/workbench/client/state-projection.cjs) and ServiceConnection's ownership guard. [desktop-projection-transport.test.mjs](../../clients/gui/scripts/desktop-projection-transport.test.mjs) adds real local WebSocket observations covering duplicate/old frames, closure on a missing base, a full authoritative baseline after reconnect, and late old-connection frames that cannot overwrite the new connection.

Existing backpressure coalescing, receipt ordering, and cross-client history acquire/release isolation remain in the same entry point. `node --test clients/gui/scripts/desktop-projection-transport.test.mjs` passes seven tests, comparing recovered public semantic state with service snapshots and checking that user writes are not automatically resent.

Sequence reset remains tied to a new stream/reader instead of adopting T3's lower-sequence reset behavior. This evidence covers Desktop transport and projection. Complete Core history, mobile, and Relay retain their own acceptance paths; production fixes expand only when tests demonstrate an actual contract defect.

## G. Change-scoped local checks sharing CI selection

**T3 evidence.** [check-changed.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/scripts/check-changed.ts) reuses CI's `decide/readWorkspace`, includes uncommitted/untracked paths, typechecks affected packages and dependents, runs adjacent tests, and lists work left to CI. Its passing cache also checks that inputs did not change during execution.

**Implementation.** [check-changed.py](../../scripts/check-changed.py) provides `make check-changed CI_BASE=<ref>`. `ARGS=--plan` prints the JSON plan without executing it. The entry resolves merge-base once, includes committed/staged/unstaged/untracked paths, deletions and both rename sides, and reports an input hash, commands, reasons, matching paths, and uncovered work. Staged and working-tree deltas are unioned even when their contents cancel. The input hash includes the cached diff, so index-only drift invalidates evidence. Commands explicitly validate `working-tree` contents; partially staged index contents affect selection/drift detection only.

`ciScopes` directly reuses [ci-scope.py](../../scripts/ci-scope.py). Local expansion for unknown code is separately reported as `conservativeFallback`, without claiming CI already recognizes it. GUI selection uses [test-manifest.mjs](../../clients/gui/scripts/test-manifest.mjs)'s stdin-JSON `--select-changed` interface, reusing area/platform/prerequisite selection while retaining shared unit tests. Shared Rust/schema changes conservatively select workspace checks and SDK consumers without a detailed Rust dependency graph.

Execution is sequential with no passing-run cache. Successful execution reports only `passed-selected-checks`; missing prerequisites produce `partial`, changed inputs `invalidated`, failures `failed`, and an empty change set `no-changes`; empty plans also recheck source and index identity before returning. The failure/incomplete statuses return nonzero. E2E, native desktop, live providers, and packages remain deferred. Thirteen temporary-Git contracts and five existing manifest tests pass. Removing the unknown-code GUI expansion in an isolated copy makes the selection contract fail as expected.

## H. Reuse representative history in development and acceptance

**T3 evidence.** [migrate-dev-db.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/scripts/migrate-dev-db.ts) reads an isolated snapshot from a read-only source, selects stopped Thread families, clears pending work/auth sessions, migrates, and prunes. Its [tests](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/scripts/migrate-dev-db.test.ts) cover source/destination isolation and old-data upgrades. The benefit is bringing realistic data shapes into development.

**Implementation.** [profiles.json](../../clients/gui/scripts/fixtures/history-compat/profiles.json) declares synthetic provenance, old storage versions, and semantic expectations for a settled child relationship, 40-Turn paged history, and completed/failed/interrupted outcomes. Samples retain their original version-14 format. [history-copy-smoke.mjs](../../clients/gui/scripts/history-copy-smoke.mjs) reuses private copies and source-hash checks, adding public history acquire/page results, order, relationships, terminal states, and visible Renderer text assertions.

The entry remains `pnpm --dir clients/gui test:history-compat`, requiring matching fixed Core artifacts and built GUI. `AREAL_CORE_BIN` selects the source-test artifact; package acceptance can explicitly select an executable. Read-only profiles retain idle/no-queue/no-managed-execution and zero-model-request constraints. Active recovery data remains owned by D/F. Development startup does not automatically copy user data.

Real Electron/Core acceptance passes: the 40-Turn sample loads one older page, child relationships, three terminal outcomes, and visible text match expectations. Source and open-copy hashes stay unchanged, model requests remain zero, and isolated services exit normally. Synthetic samples cannot cover every real user dataset; explicit local-copy and package acceptance remain separate.

Failure cleanup applies one 120-second deadline to quit preparation and closing. A timeout ends only the Electron child owned by this run, followed by independent Desktop PID and Core inventory checks. Metadata, close, and inventory errors remain separate from the original business failure. The 13 contracts in `pnpm --dir clients/gui test:history-cleanup` cover blocked closing, inventory failure, absent/invalid/unreadable metadata, and multiple failures. A real missing-parent counterexample is rejected as expected, with unchanged source and zero model requests. Closing times out and triggers owned-child cleanup; independent checks confirm backend exit, while the report remains failed and retains the timeout. This establishes bounded failure cleanup and truthful reporting, not normal shutdown for the corrupted-history case.

## I. Track static model-input size by component

**T3 evidence.** [AgentContextBudget.test.ts](https://github.com/pingdotgg/t3code/blob/93a9e079b107a13b0c312920b917b5f61a8f720c/apps/server/src/provider/AgentContextBudget.test.ts) measures UTF-8 bytes from production instruction builders and registered model-visible tool fields against a versioned baseline.

**Implementation.** [model_input_budget.rs](../../core/engine/tests/model_input_budget.rs) captures production solve requests through `Engine::create_configured`, default configuration, and a real HTTP adapter. The existing SolveOnlyHttpModel boundary isolates auxiliary naming. The initial profile is `desktop-default-no-runtime-or-plugins`; it does not claim host Runtime or third-party plugin coverage.

The fixed [model-input-budget.json](../../core/engine/tests/fixtures/model-input-budget.json) baseline records 13,259 UTF-8 bytes of system instructions, 563 bytes of Execution settings, and per-tool name/description/parameters measurements for 18 tools, with 12,686 bytes of model-visible function JSON. The instructions include 1,501 bytes of Git branch and authentication-boundary guidance; those two paragraphs do not change tool or fixed-environment sizes. Two independent Engine requests with different temporary paths, IDs, and user text measure identically. Dynamic history, Skills bodies, retrieval, and media are outside this fixed profile.

`cargo test --locked -p areal-engine --test model_input_budget` passes one test, including increases/decreases in tool descriptions and a system-instruction increase. Differences report components and tool names; baseline updates require manual review. The check does not delete instructions, truncate tools, or change production budgets. Bytes signal deterministic growth, not unverified tokens, cost, or success-rate conclusions. Agent behavior changes still follow the [improvement method](agent-improvement.en.md).

## J. GUI derived caches and Design System continuity

User actions cross Renderer intent, Desktop transport/projection, Core authoritative sessions, and Runtime effects. The improvement loop defines an observable goal, traces calls and ownership, verifies the mechanism with a repeatable scenario, implements the smallest correction, and checks again. Repeated calls are candidate evidence; computation counts, capacity, freshness, and interactions are verified separately. Fewer computations do not automatically establish lower perceived latency.

| Owner | Retained data | Update and release boundary |
| --- | --- | --- |
| Core / Runtime | History, admission records, execution facts | Existing persistence/lifecycle contracts; Renderer caching never settles writes |
| Desktop / workbench | Projections with stream, sequence, and base; bounded history pages | Existing reconnect, baseline validation, and view-release behavior |
| Renderer navigation | Sorted projects, conversation catalog, sidebar derivations | Recompute on complete immutable dependency-reference changes; release on unmount |
| Messages / readingViews | Owner-scoped layout and semantic anchors | Saving refreshes recency; evict oldest entries above the existing 32-entry boundary |
| Design System | Navigation, reading, return, and state-feedback constraints | Nearby component contracts own rules; acceptance uses production components |

`useSessionNavigation` previously created a sorted project array on every render, after which `App` rebuilt the full catalog; Sidebar sorting also mutated incoming summaries. Stabilize upstream project references before caching catalog/sidebar derivations, and avoid mutating inputs. Renames, unread/running state, project order, and new authoritative snapshots must refresh promptly. Do not retain business objects indefinitely by Thread ID or hide pending/UNKNOWN outcomes.

`readingViews` limited sessionStorage to 32 entries and 65,536 characters but did not evict its in-memory Map. An isolated reproduction visiting 1024 owners retained 1024 in memory and 32 in storage, while each save copied the whole Map. Trim at the existing save owner using the same 32-entry boundary, including when storage is unavailable. Keep semantic anchors, not DOM, message bodies, or Core history.

Saving JSON-encodes each entry once, accumulates the UTF-16 lengths of the envelope, commas, and entries, then joins the final value instead of repeatedly encoding each growing prefix. The format, 65,536-character budget, recency order, skip-oversized-and-continue policy, and synchronous sessionStorage semantics remain equivalent. The saved-value marker updates only after a successful write, so identical content can retry after storage failure.

Backend history already bounds views, pages, and bytes. Retaining full pages across conversations would change release/resource ownership and is not justified in this iteration. Message-item projection caching is deferred following the measurements below; reconsideration requires new evidence of actual cost.

Interaction families are I-NAV, I-READ, and I-RECOVER, plus I-RETURN for returning from child conversations. Reuse App, Sidebar, Messages, and existing tokens. Constraints belong to NAV-CONTEXT-01, READ-CONTINUITY-01, RECOVER-TRUTH-01, and RETURN-CONTEXT-01 in [interaction patterns](../../clients/gui/design-system/interactions.en.md), and R-MESSAGES-004/005 in the [Messages contract](../../clients/gui/renderer/src/Messages.md). This slice adds no design rules or visual roles.

Compare catalog computation counts for unrelated UI interactions in the same Renderer fixture before and after, and verify immediate name/unread/running/order updates from new snapshots. Check reading-cache recency eviction, unavailable storage, and semantic-anchor reload; theme, font, and layout changes retain existing reading logic. Record screenshots, raw counts, and unsuccessful checks separately. Static design, Renderer interaction, Electron/Core history, and package acceptance retain distinct evidence boundaries.


**Executed evidence.** `pnpm --dir clients/gui test:navigation-cache` measures the same unrelated UI actions in the real React App/Chrome with fixture PlatformServices. Before optimization, the increments are 13 catalog computations, 156 project visits, and 38,805 comparisons; all three increments are zero afterwards. Five freshness cases pass: rename, unread, running state, order, and new authoritative snapshots. Counts establish fewer derivations in that scenario, not end-to-end or perceived-latency gains.

Seven `readingViews.test.ts` tests pass, including exact character limits, Unicode escaping, and failed-storage retries. The Chrome theme-switch/reload check observes 1px semantic-anchor displacement. The legacy `conversation-flow` scenario times out at `.tool-summary-row .tool-failed`; production collapsed failure state is expressed by `ActivityRowStatus` with `data-tone="failed"`. That markup is a separate boundary from the `readingViews` capacity change. This effort does not change the legacy runner, and the complete conversation flow is not counted as passing. Native Electron/Core history, platform input, and packages retain their own acceptance boundaries.

### Message-reading baseline after integration

`pnpm --dir clients/gui test:message-derivation` uses production Messages, CoreTaskModel, and real Chrome input to check manual disclosure, a semantic paragraph anchor across 20 streaming deltas, terminal state, history-gap insertion/removal, and owner replacement with the same Thread/Turn IDs. Evidence is captured after fonts are ready and geometry remains stable for six frames, retaining the 1px anchor tolerance. Passing after fixture corrections does not establish that a product defect in the old baseline was fixed. Failures still attempt browser/Vite cleanup and report writing.

The workload has 100 terminal Turns plus one active Turn, each with six items including a production activity group containing two file reads and a command. Across three development React/Chrome baselines, 12 unrelated updates produce 1,313 grouping calls over 7,878 items: total grouping CPU is 13.7–15.5ms versus 434.5–707ms for the Messages subtree Profiler. Twenty output updates produce 2,222 calls over 13,332 items: 25.8–30.7ms versus 745.3–868.3ms. Grouping accounts for roughly 2–4%, while Long Tasks vary substantially. This iteration therefore adds no message-derivation cache and does not treat instrumented development samples as a production latency budget. `--baseline` additionally checks current recomputation counts; default mode constrains behavior and permits future reductions.

### Reading-checkpoint serialization savings

`pnpm --dir clients/gui test:reading-checkpoint` exercises production Messages/saveReadingViews in Chrome 156 at 1100×800, light theme/14px, with checkpoints for one and 32 valid owners, 96 wheel inputs, and 24 appended outputs. The 32-owner scroll phase triggers 193 saves both before and after: total JSON-encoded characters decrease from 24,459,855 to 1,390,469 (about 94.3%), and cumulative synchronous stringify samples decrease from 23.0ms to 4.2ms. During output updates, characters decrease from 3,041,640 to 172,920, with samples of 4.4ms and 0.3ms. Actual scroll/resize counts and CPU profiles are retained separately. These are instrumented single-run CPU samples, not evidence of end-to-end latency, memory, or perceived responsiveness.

Both owner counts pass synchronous storage and cold-reload semantic-anchor checks. Output appended below the reader leaves the checkpoint unchanged and writes storage zero times. Default mode rejects a return to repeated prefix encoding; `--baseline` permits measuring the old implementation. Reports bind source hashes and browser version, and cleanup failures or source drift invalidate success. A separate message-measurement failure caused by concurrent-build HMR remains recorded; verification on stable source passes. These two Chrome fixtures do not qualify Electron, live providers, or packages.

## Verification entry points and completion boundaries

See the [testing guide](testing.en.md) for commands. D/E/F/G/I and J have local mechanism evidence: 24 Core HTTP/replay/timeout/fixed-slot Runtime tests and one virtual-time test pass. Isolated lost-text and incorrect-first-event-deadline counterexamples both fail assertions, followed by restored-source verification. Matching Core/GUI builds, fixed-slot doctor, GUI types/design, and formatting checks pass. H passes its real Electron/Core synthetic-history journey; real-user upgrade data and packages retain separate acceptance. Report unexecuted, failed, and locally passing evidence separately; test counts do not replace coverage boundaries. Inject targeted counterexamples only in isolated environments or captured test requests, then restore the normal inputs.
