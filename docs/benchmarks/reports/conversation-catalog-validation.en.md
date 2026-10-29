[中文](conversation-catalog-validation.md) | **English**

# Conversation directory iteration, validation and alternatives

The [first iteration](conversation-catalog.en.md) removed complete-history cloning, repeated directory sorting and redundant GUI refreshes. This follow-up compares candidate scanning, includes real GUI cache IO and broadens functional regressions. Its conclusions concern directory and client synchronization mechanisms, not overall Agent capability or proof of zero regression.

## Three implementations

| Version | Candidate batch | Internal scan cursor | Assessment |
|---|---|---|---|
| R1: first iteration | Shrinks with remaining result capacity | Advances per candidate | A nearly full page degenerates into single-candidate index lookups across a long filter gap |
| R2: fixed batch | At most `limit + 1` handles | Advances per candidate | Removes that degeneration while preserving bounded memory and the API |
| R3: current candidate | Same as R2 | Advances once per batch | Further reduces temporary UUID cloning without caching dynamic state |

R3's scan cursor is used only when continuing after the current candidate batch. The public cursor still comes from the final returned row. The additional matching row only establishes continuation and remains available on the next page. Directory locks are released before session locks, with unchanged file authority and dynamic-state reads.

R3 is retained to remove demonstrated repeated lookup and allocation work while passing the same contracts. This does not establish that R3 wins every scenario. Some R2/R3 differences are small, and adverse results are retained.

## Performance comparison

The same local Apple M5 Pro, 24 GiB RAM and Rust 1.94.0 release environment is used. Each process records ten samples after two warmups per scenario. Each side runs in five independent processes, alternating execution order. Tables report the median of process medians; observations within one process are not treated as independent machines or tasks. See the [raw JSON](conversation-catalog-validation-results.json) for samples and source/executable identities.

Fixtures restore real-version files with the real Engine and measure actual RPC projection plus JSON encoding. Authorization cases include one visible row per 100 candidates, the first 100 plus the final row visible with a long gap between, and no visible rows. Fixture preparation and restoration are excluded from query timings.

| Scenario | R1 | R3 |
|---|---:|---:|
| 2,000 conversations, long authorization gap | 0.814 ms | 0.443 ms |
| 20,000 conversations, all visible, first page | 0.131 ms | 0.117 ms |
| 20,000 conversations, one visible per 100 | 3.551 ms | 2.992 ms |
| 20,000 conversations, long authorization gap | 10.938 ms | 6.777 ms |
| 20,000 conversations, none visible | 4.413 ms | 3.701 ms |

A second independent alternating block compares R2 with R3. For 2,000 conversations, sparse, long-gap and no-match medians improve by approximately 18%, 12% and 14%. However, the 20,000-conversation long-gap case increases from 7.168 ms with R2 to 7.478 ms with R3, approximately 4.3% slower. This result was retained. Dense large-directory queries are nearly identical; the cursor adjustment cannot be described as faster on every workload.

A preliminary single-process fixed-batch run measured approximately 4.8 ms for the long-gap case. Repeated comparisons showed greater variation, so final conclusions use the alternating measurements above. Long-term p95 under real writes, cross-machine distributions and production user latency were not measured. Microsecond differences are not treated as dependable product gains.

## GUI with production cache IO

The production `HistoryObservation`, `CoreLibrary` and `CoreBackend.save` run against temporary directories, performing real JSON serialization, temporary-file writes and rename. Core transport remains an asynchronous fixture; Backend snapshot projection, IPC delivery and Renderer work are excluded. Both sides use 2,000 rows, synchronous bursts of 20, and five samples. Each sample checks the final directory, latest completed Turn identity and unread state.

| Scenario | Original median | Current median | RPCs | All library writes |
|---|---:|---:|---|---|
| 20 complete refreshes | 81.13 ms | 2.56 ms | 400 → 20 | 20 → 1 |
| 20 Turn notifications for one conversation | 82.26 ms | 39.51 ms | 400 → 1 | 40 → 21 |

Summary-cache writes decrease from 20 to one in the Turn case, while all 20 activity updates remain persisted. This explains an approximately twofold improvement in the measured cache path; a 400-fold reduction in directory requests does not imply a 400-fold GUI speedup. Activity and unread persistence ordering are unchanged.

## Functional protection and limits

- Paginated output is compared field by field with the complete authorized reference: 257 mixed sources, archive states, parent relationships and tied creation times, main/all views, archive switches and page sizes 1, 7 and 100. Tests check complete legacy metadata, missing/duplicate rows and continuation cardinality.
- A long authorization gap checks continuation from the first 100 to the final visible row. Creating a second conversation while listing waits on an existing session lock checks that the directory does not retain the registration lock.
- An admitted task pauses inside a file-writing tool while directory queries repeat. Tests check unchanged model requests and authoritative records, one subsequent tool effect, original usage accounting, preserved restart history and no tool replay. This uses a deterministic local Model and dynamic-tool Host, rather than native Runtime or provider acceptance.
- Production GUI cache fixtures check directory completeness, completion identity and unread state. Existing connection, Worktree, configuration, history and authorization tests continue to protect their own contracts.

Complete Engine and app-server regressions passed in the development profile with three build jobs and four test threads: 777 passed and 16 explicitly ignored, across 71 target-result groups. Complete GUI verify passed 318 tests with three existing skips. Type checking, Clippy, formatting and documentation checks passed.

The default-concurrency Engine lib run had two MCP failures: Python initialization exceeded two seconds, and a directory-budget assertion differed. That attempt recorded 279 passes, two failures and four ignores. The unchanged MCP isolation group passed all four tests separately; the complete suite then passed with bounded harness concurrency. No product code, timeout or assertion was changed. This supports resource contention as an explanation without rewriting the failed attempt as a pass. The interrupted full-release LTO build, initial fixture compilation error and missing-log attempts are also retained in JSON. Performance comparisons always used frozen release executables.

Fresh real TUI/Core smoke passed multi-turn conversations, cancellation, child navigation, PTY behavior, SIGKILL recovery and OTLP delivery. Real CoreBackend large-history checks passed Unicode-item reconstruction above 64 MiB, ordinary and archived history pagination, reconnection and view release: all 228 history responses stayed within 1 MiB, solve requests remained at one, and authoritative history and receipts stayed unchanged.

A four-domain Agent capability evaluation, installer acceptance and human visual acceptance were not performed. Source changes do not alter prompts, model-input planning, tool definitions, permission rules, default budgets, persistent format or fsync ordering. Together with regressions, this supports no observed functional regression in covered paths, without an absolute claim about every normal capability.

## Whether to change architecture

The following is the historical R3 decision. A later iteration implements an explicit SQLite candidate; see the [memory and SQLite comparison](conversation-catalog-sqlite.en.md) for the current selection and equivalent-scope measurements.

Keep R3 and defer SQLite. The measured alternatives are three real in-memory query implementations. No equivalent end-to-end SQLite integration A/B was performed, so neither SQLite inferiority nor global optimality is claimed.

| Direction | Decision |
|---|---|
| Fixed candidate batches and batch cursor advancement | Retain; removes demonstrated repetition without changing API or storage contracts |
| Additional dynamic summary caching | Defer; introduces synchronization and invalidation for names, permissions, archive state and source classification |
| SQLite metadata index | Defer; startup, memory, full-text search or production tail-latency evidence does not yet justify migration |
| GUI activity-write coalescing | Identified remaining cost; requires separate unread, ordering, failure and crash-semantics verification |
| Snapshot batching or asynchronous durability | Defer; this iteration has no evidence that justifies changing commit or UNKNOWN semantics |

If real users still experience meaningful waits, measure Core cold startup and memory, sparse filtering and session-lock waits, and GUI library persistence and Renderer projection separately. Compare the relevant alternative only when its path is the dominant bottleneck. Engine still restores all Threads; adding SQLite without changing recovery does not automatically remove that work.

## Reproduction

```sh
cargo test --locked -p areal-engine -p areal-app-server --jobs 3 -- --test-threads=4
cargo test --locked --release -p areal-app-server --lib catalog_tests
cargo test --locked --release -p areal-engine --lib catalog::tests
cargo test --locked --release -p areal-engine --test catalog_observation
AREAL_CATALOG_PERF_PHASE=candidate cargo test --locked --release \
  -p areal-app-server --lib catalog_filter_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_BENCH_CACHE=production \
  node clients/gui/scripts/catalog-refresh-benchmark.cjs
```

Pass an older `history-observation.cjs` path to the GUI script to compare coordinators. Reconstruct R1/R2/R3 using identical fixtures, release settings and other implementations, changing only the candidate-batch and scan-cursor rules in the table. Freeze the executables before alternating comparisons. Full regressions preserve existing proxy exclusions and append `127.0.0.1,localhost,::1` to both `NO_PROXY` and `no_proxy`.
