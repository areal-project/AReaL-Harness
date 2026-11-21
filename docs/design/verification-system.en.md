[中文](verification-system.md) | **English**

# Systematic verification: pstack research and an AReaL proposal

2026-11-21. This is research and a design proposal, not a passing execution report or a change to required CI checks. The goal is fewer regressions and less human judgment work. Execution entry points remain in the [testing guide](../development/testing.en.md).

## Primary sources

The author is Lauren Tan (Poteto), confirmed by the [official AI Engineer speaker page](https://ai.engineer/speakers/lauren-tan). Use `cursor/plugins/pstack` as upstream; `backnotprop/pstack` in the supplied material is an independent mirror.

| Source | Supported finding | Limit |
|---|---|---|
| [pstack Guide Pt. 1](https://x.com/poteto/status/2094457600259842065), September 1 Beijing time / August 31 UTC, 2026 | Verification skills are infrastructure; agents need a user-facing feature map and reusable application controls; measure a performance baseline before improvement | Self-reported throughput and multipliers are not controlled evidence of general benefits |
| [X update](https://x.com/poteto/status/2117437607940681849), November 3, 2026 | Abstract adversarial reviews can devolve into nitpicks; she favors empirical and formal verification | She reduced interrogate usage and might remove it later; this does not invalidate all review or establish removal |
| [All Code Is Slop (Except Mine)](https://ai.engineer/code/2026/talks/lauren-tan), November 11, 2026 | Review increasingly examines verification artifacts; running the app, CDP, feature maps and reusable drivers are foundations; model checking, Lean and UI property testing are additional approaches | The [official transcript](https://ai.engineer/api/code/reading-download/transcripts/lauren-tan.md) is machine-generated; the video was not watched in this investigation. Formal verification is explicitly experimental |

Original-stream timestamps: [01:11:13](https://www.youtube.com/watch?v=ZZ19zhYnDKY&t=4273s) for artifacts; [01:12:14](https://www.youtube.com/watch?v=ZZ19zhYnDKY&t=4334s) for formal verification; [01:13:01](https://www.youtube.com/watch?v=ZZ19zhYnDKY&t=4381s) for Bombadil/UI property testing. The precise 70% token figure initially quotes Cindy; it is not Lauren's own measurement.

The upstream snapshot inspected was [792440e8](https://github.com/cursor/plugins/tree/792440e8a560a4a3f63748cdee70491ecd412982/pstack):

- [create-verification-skill](https://github.com/cursor/plugins/blob/792440e8a560a4a3f63748cdee70491ecd412982/pstack/skills/create-verification-skill/SKILL.md): discover existing launch, drive, observation and isolation tools; exercise real user entry points and check visible outcomes alongside side effects. Run one mapped feature before delivery, preserving evidence after cleanup.
- [maintain-verification-skill](https://github.com/cursor/plugins/blob/792440e8a560a4a3f63748cdee70491ecd412982/pstack/skills/maintain-verification-skill/SKILL.md): reconcile source and live behavior with the feature map; distinguish documentation drift, harness gaps and product regressions.
- [create-formal-verification-skill](https://github.com/cursor/plugins/blob/792440e8a560a4a3f63748cdee70491ecd412982/pstack/skills/create-formal-verification-skill/SKILL.md): target consequential properties that tests rarely reach; map the model to code, state bounds and assumptions, and demonstrate failure on broken variants. Passing a model does not prove the entire implementation.
- [prove-it-works](https://github.com/cursor/plugins/blob/792440e8a560a4a3f63748cdee70491ecd412982/pstack/skills/principle-prove-it-works/SKILL.md): inspect the actual artifact and prefer repeatable comparisons.

## Current project capability

Reuse `ci-scope → ci-preflight → verification-evidence`; do not create a parallel CLI. The current [journey manifest](../../clients/gui/scripts/journey-manifest.json) contains four journeys. The new `connection-recovery` declares Web coverage only. Its fact contract flows through planning, execution and aggregation, so exit code zero alone cannot pass it. Older journeys have not all adopted that contract.

The new recovery runner and counterexample runner contain real Host/Core interaction, request-specific fault triggering, known broken variants, identity evidence and cleanup. This investigation inspected source without rerunning them. Source Web/socket coverage does not establish installed-package behavior, Host process replacement, the real fifteen-minute timer, real providers or physical mobile devices.

Identity, hashes and required fields establish provenance and completeness. The meaning of a `passed: true` still depends on sound assertions. A user feature map, bounded discovery and measured reductions in human effort remain gaps.

## Proposed design

### A feature map defines obligations

Extend existing feature documentation and manifests with user goals, supported entry points, prerequisites, authoritative outcomes, visible outcomes, applicable journeys and uncovered scope. Start with opening/recovering projects, sending/cancelling, history/restarts, model configuration, stopping/upgrading. Extend to Relay/mobile, tools/permissions and schedules. Avoid a second command catalog.

For “continue chatting after recovery,” prove automatic recovery, preserved draft and selection, no replay of the original unresolved request, and a subsequent new message settled in Core and visible in the UI. Socket connectivity or a disappearing spinner is insufficient.

### Fixed journeys and exploration share controls

Reuse fixture helpers. Extract shared opening, selection, typing, submission, disconnect and receipt operations when a second journey needs them; avoid copying large dedicated scripts. User actions use real entry points; isolated fault controls are recorded separately.

Fixed journeys guard known regressions. Generated exploration combines a finite set of actions under resource budgets: project switching, draft editing, disconnects, delayed baselines, idle reclamation, stopping, recovery and submission. Check invariants after transitions. Save the seed, complete event sequence, identities and initial state: a seed alone cannot replay asynchronous scheduling. Minimize failures and turn them into fixed regressions.

Agents may explore unscripted features using the map, but contracts and independent observations determine success, not the driving agent's own impression. Start with isolated data and deterministic local models; real providers and system permissions have separate entry points.

### Recovery needs safety and progress

| Property | Product meaning | Verification |
|---|---|---|
| No duplicate side effect | Lost responses query the original request rather than resend under a new ID | Drop a specific admitted response; check durable receipts and execution counts |
| No stale overwrite | Old Host/socket results cannot overwrite current selection or recovery state | Control late-response delivery; check owner/generation and UI |
| Respect explicit stop | Automatic reconnection cannot revive explicitly stopped execution | Trigger reads/reconnects after stopping; check no new execution generation |
| Recovery completes | Once dependencies recover and no explicit stop applies, the app becomes usable | Release the fault, await authoritative completion, submit a new message and check its outcome |

Progress claims require assumptions: dependencies recover, required events receive processing opportunities, and no new permanent failure occurs. A model can check progress under those assumptions. Runtime tests use a justified time budget and retain the last state on timeout, rather than retry forever.

Start with a small model of restoration ownership, connection generations and receipts. Abstract actions must match actual atomic boundaries; an operation spanning `await` is not automatically one atomic step. Replay model counterexamples against the real runner. Choose TLA+ or another tool based on the question and maintenance cost; a passing model still needs implementation checks.

### One report supports decisions

Extend existing evidence. Lead with whether the user goal was reached, followed by the first failed stage, assertion, original request/generation, shortest reproduction, authoritative and visible evidence, cleanup and unreached stages. Video and screenshots explain interaction, but alone do not prove persistence or absence of replay.

Distinguish product failures, environmental blocks, verifier failures and unexecuted obligations. Preserve first attempts when reruns pass. Performance acceptance uses a fixed workload and baseline and examines distributions.

### Accept the verification system itself

First stage: the correct implementation passes; two known broken variants fail at their intended business assertions; build failures do not count as detected regressions; recovery permits actual submission; failure evidence and cleanup are usable.

Second stage: generated exploration produces short replayable failures; a reviewer independent of implementation checks contracts and assertions; actual Host replacement and packaged-app journeys have separate evidence.

Third stage: freeze a consecutive sample of changes before selection, keeping unmapped changes. Compare interventions, reading/triage time, harness blocks, false alarms, escaped defects and execution cost. Missing historical evidence cannot demonstrate savings. `compare-journey-triage.py` currently omits unmapped changes and needs corrected sampling before measuring coverage gaps. Escaped defects require later discovery tracking; no alerts does not establish zero misses.

## Three policy choices

- **Do not ban every unwrap/expect.** User input, IO, networking and recoverable production errors should yield structured errors. Test assertions often reasonably use `expect`; internal invariant failures need an explicit policy. Substituting defaults or swallowing failures can hide defects. Apply policy by module and failure boundary rather than keyword count.
- **Do not require whole-app mutation for every rule.** Critical recovery properties, automated approval gates and new verifiers should demonstrate sensitivity to relevant defects. Static rules usually need positive/negative fixtures; an existing pre-fix failure may suffice. Formal properties need counterexample sensitivity, while expensive end-to-end mutations should not burden every small change.
- **Do not default to multiple model reviews.** Models can share blind spots; more opinions do not create evidence. Keep independent review for high-impact contracts, migrations and security boundaries, requiring reachable paths and consequences. Spend routine effort on executable evidence. People or independent reviewers still judge whether requirements and assertions are correct.

This proposal extends existing infrastructure. Changes to required CI checks or hooks retain the project's explicit authorization requirement.
