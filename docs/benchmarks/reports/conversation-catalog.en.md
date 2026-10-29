[中文](conversation-catalog.md) | **English**

# Conversation directory, pagination and GUI refresh comparison

The first iteration uses a lightweight in-memory directory, cursor range reads and coalesced GUI refreshes. SQLite is deferred. Fixed fixtures show better directory-query timings and request counts; these results do not establish improvements to models, tools, task success rates or overall Agent performance. See the [follow-up validation](conversation-catalog-validation.en.md) for sparse filtering, real cache IO and functional protection comparisons.

## Changes and compatibility

- Engine maintains UUID and `(createdAt,id)` indexes containing session handles and immutable sort keys. Metadata is projected directly from current state without first cloning turns, checkpoints or cold-history manifests. Existing names, configuration, permissions, archive state and other metadata fields remain available.
- `areal/conversation/list` reads candidates after the cursor instead of collecting and sorting the complete directory on every page. Authorization and business filters precede LIMIT; one additional match determines continuation. UUID ordering for legacy `thread/list` and `areal/agent/list`, and the conversation cursor encoding, remain compatible.
- GUI allows one active and one pending batch per project, connection and generation. Synchronous bursts share a batch; notifications arriving during a read join the next batch. Completed callers do not wait for later notifications to stop. Once the complete directory is loaded, lifecycle notifications read affected sessions through `thread/read(includeTurns:false)`. Initial loading, reconnection and explicit refresh still read the complete directory.
- Worktree binding decisions still receive a complete directory. Stale connections and generations cannot publish results. Only authoritative not-found removes a target row; permission and ordinary read errors preserve the existing projection.
- File authority, Store commits, fsync ordering, state version, UNKNOWN handling and model inputs are unchanged. No persistent index, migration, delayed snapshot write or implicit retry is added.

The directory is not an independent cache of dynamic session state. Inspected candidates still require session locks, and sparse filtering can inspect many candidates. The directory lock is released before waiting for session locks. Pagination does not promise a consistent snapshot across pages; concurrent creation and classification changes remain visible through current state.

## Method and provenance

The [raw JSON](conversation-catalog-results.json) retains samples, source and executable SHA-256 values, and validation attempts. The baseline query implementation is from `61ce8ecc296a648f41b353da1b304d902711c48a`. The workspace contained unrelated pending edits, so this is not described as a clean whole-repository commit comparison. Three baseline Engine/GUI query source files match that commit; app-server only adds the performance-test module registration. The release baseline test executable was frozen before production changes and reused for the comparison.

Environment: Apple M5 Pro, 24 GiB RAM, Darwin arm64, Rust 1.94.0 and Node 23.11.0. Both sides use release builds and page size 100. Fixtures write real-version Thread records and restore them with the real Engine. Timings cover actual `Connection::conversation_list` and JSON encoding, excluding fixture preparation, startup recovery, WebSocket transport, UI rendering, models and tools. No real model requests occur.

Single-page queries use two warmups and seven recorded samples; complete-directory reads use five samples. The table reports medians. Preliminary baseline samples are retained separately. Concurrent-write tail latency, cross-machine variation and confidence intervals were not measured; these are local mechanism results rather than production latency commitments.

| Scenario | Before median | After median |
|---|---:|---:|
| 100 conversations, first page | 0.1515 ms | 0.1332 ms |
| 100 conversations, complete directory | 0.1568 ms | 0.1417 ms |
| 2,000 conversations, 16 KiB history each, first page | 3.7788 ms | 0.1194 ms |
| Same fixture, last page | 3.9202 ms | 0.1382 ms |
| Same fixture, complete directory | 75.6039 ms | 3.1749 ms |
| 20,000 conversations without history, first page | 132.1060 ms | 0.1259 ms |
| Same fixture, last page | 128.9174 ms | 0.1350 ms |

The large single-page difference for 20,000 conversations comes from eliminating repeated directory collection, sorting and traversal. It cannot be extrapolated into a thousandfold improvement for complete tasks. Small directories show much smaller gains.

GUI comparisons run the production coordinator with `setImmediate` fixture transport and an in-memory cache: 2,000 rows, 100 per page, bursts of 20, five samples per side. Counts were identical across repetitions. Raw timings are retained without treating them as user-visible latency, since real network and disk IO are excluded.

| GUI scenario | Before directory RPCs / summary-cache writes | After directory RPCs / summary-cache writes |
|---|---:|---:|
| 20 simultaneous complete refreshes | 400 / 20 | 20 / 1 |
| Complete directory loaded, 20 Turn notifications for one session | 400 / 20 | 1 / 1 |

The new request in the latter case is a target metadata read. Activity markers, notification persistence and other library writes are outside these summary-cache counts and were not coalesced by this change.

## Validation and retained adverse results

- All app-server lib tests passed: 27 passed and one explicit performance test ignored. New coverage includes legacy metadata and persistent-byte compatibility, timestamp ties, filtering and authorization, cursor binding, unrelated session locks, archive and creation behavior, and real Fork registration.
- Eight focused GUI groups passed 120 tests. The final directory suite passed 13, including task-draft filtering. Complete `pnpm --dir clients/gui verify` passed, with groups of 6, 208 and 104 passing tests and three existing skips.
- An initial test incorrectly attempted to restore an ordinary root through the Side-only restore API: one failed, five passed, one ignored. The test was corrected to exercise existing archive and creation behavior without weakening the production contract. The failed attempt is retained in JSON.
- The initial Engine suite stalled in an HTTP audit test after 279 passes and four ignores: local proxy settings intercepted loopback traffic. That test passed independently with `NO_PROXY=127.0.0.1,localhost` after the owned process was terminated. The complete rerun with isolated proxy settings passed 280 Engine lib tests with four ignores, plus 22 tests across four integration targets.
- Rust formatting, Prettier for new GUI tests and the benchmark, documentation language pairs and links, and diff whitespace checks passed. Initial Clippy found that the new file placed its test module before production items; moving the module to the end passed `--all-targets -- -D warnings` without changing production logic.

These checks establish query correctness, compatibility and local performance, without promoting Agent strategies, budgets or capabilities. Native GUI human visual acceptance, installer acceptance and an overall Agent benchmark were not performed. No pages, styles or interaction controls changed.

## Reproduction

Run from the repository root:

```sh
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  cargo test --locked --release -p areal-engine --lib \
  --test conversation_references --test session_name \
  --test admission_guards --test recovery_contract
cargo test --locked --release -p areal-app-server --lib
pnpm --dir clients/gui verify
AREAL_CATALOG_PERF_PHASE=after cargo test --locked --release \
  -p areal-app-server --lib catalog_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_PERF_PHASE=after node clients/gui/scripts/catalog-refresh-benchmark.cjs
```

To reconstruct the old query path in a separate checkout, use the baseline commit, copy the current `core/app-server/src/catalog_tests.rs`, register `#[cfg(test)] mod catalog_tests;` in app-server `lib.rs`, and run only the performance test. Freeze that executable before switching implementations. Behavior tests verify the repair and are not expected to pass against the old implementation. The GUI benchmark accepts an older `history-observation.cjs` file path and resolves dependencies from the original production module location without overwriting the workspace.

## SQLite decision

Keep this repair first: it removes demonstrated repeated work without adding file/database dual writes, index reconstruction or invalidation management. This is the preferred step supported by current evidence, not proof of an optimal architecture for every workload.

Startup still restores every record, hot sessions still consume memory, sparse filters still inspect candidates, session locks can still delay reads, and GUI initialization still loads the complete directory. The additional index also adds O(N) keys and references; memory and startup benefits were not measured. Reconsider a rebuildable SQLite metadata index if realistic startup or memory becomes the main bottleneck, full-text search is required, or query p95 under concurrent writes repeatedly exceeds the product budget. SQLite alone does not optimize snapshot serialization, fsync or Runtime tool file operations; each requires separate evidence and durability design.
