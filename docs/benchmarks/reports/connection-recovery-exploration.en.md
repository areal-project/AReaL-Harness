[中文](connection-recovery-exploration.md) | **English**

# Bounded recovery exploration acceptance

2026-11-22. The recovery sample now exercises real actions, step evidence, data-only replay, historical counterexamples and budgeted failure reduction. Acceptance covers `fc49e941d` plus the frozen patch; full source, patch and runner digests are in the [structured record](connection-recovery-exploration.json). Concurrent UI commits entered the main worktree during execution and are outside this acceptance.

## Executed checks

| Check | Result |
|---|---|
| Seeds 1, 2 and 3, six real actions each | 3/3 passed, 18 actions covering successive submissions, idle reclamation, successive reconnects, editing and UNKNOWN |
| Fixed journey baseline in the frozen tree | All six business facts passed |
| Six-action exploration replay baseline in the frozen tree | Passed, including post-recovery submission, UNKNOWN and explicit stop |
| Restored premature loading failure | Detected by `loading-no-false-failure` |
| Restored stale hibernation owner guard | Fixed journey detected `idle-automatic-recovery`; exploration detected `exploration-recovery-progress / idle-reconnect` |
| Six reduction attempts | Reduced six actions to an actually reproduced `idle-reconnect → submit`; budget exhausted, `minimal=false` |
| Evidence and cleanup | Each run passed import and cleanup checks; isolated worktree removed |
| Targeted contract tests | Node 27/27, Python 21/21 + 44/44 |
| Documentation, journey manifest and reference checks | Passed |

Each submission checks a unique Core Turn and the visible completed card with that same Turn ID. UNKNOWN injection drops one accepted response for the original socket and commandId. Observation never restarts a stopped Core: the report references the last authoritative check with its step index, independently checks current Host state, visible history and absence of extra sends, and reads Core again after the next user submission.

## Earlier failures and limits

An earlier exploration received `scheduleHostUnavailable` on the first `session.create` even though Host/Core reported ready. Before executing actions, the final sample reuses the existing read-only `taskScheduleContext` probe to await the original owner's scheduling connection. **This does not fix the product's cold-start readiness window or prove immediate submission after visible readiness.** The original failure is retained; initial usability remains a separate acceptance obligation.

Another attempt failed to launch Electron inside the sandbox and remains blocked. After confirming the original runner had exited and its isolated registry contained no Host, that fixture was removed. Real acceptance then ran in an environment permitted to launch native applications. Earlier debugging records were not rewritten as passing.

This run establishes finite recovery sequences using a source Electron owner, production Web Renderer, real Rust Host/Core and deterministic local model. It does not establish installed-package, Host-process replacement, actual fifteen-minute timer, real-provider or physical-mobile acceptance. Detecting two known defects establishes neither an unknown-defect discovery rate nor reduced human time.

## Reuse

Commands and data contracts are in the [testing guide](../../development/testing.en.md); user obligations are in the [feature map](../../design/recovery-verification-map.en.md). Local evidence directories listed in the structured record contain plans, step JSON/screenshots, event order, receipts, first failures and cleanup. Those temporary artifacts are not committed. Use the source revision and patch digest together: replaying the reduced plan against the correct implementation should pass; the old guard mutation should produce the target failure.

The entry remains elective and changes no required CI checks. Another core journey can reuse the evidence and reduction entry points while defining its own user outcomes, fault boundaries and acceptance facts.
