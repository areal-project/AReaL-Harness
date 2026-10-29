[中文](conversation-catalog-sqlite.md) | **English**

# Session directory: memory and SQLite comparison

Following [directory iteration validation](conversation-catalog-validation.en.md), this iteration improves the memory directory and implements an explicitly selected SQLite backend. The comparison concerns directory queries in the current file-authoritative architecture, rather than a general database ranking or four-domain Agent evaluation.


This report covers eager recovery and SQLite immutable-key queries. See the [new comparison](conversation-catalog-lazy.en.md) for compact metadata, lazy history and SQLite metadata with memory queries.

## Measured decision

Keep the improved memory directory as default and retain SQLite as an explicit candidate. Sessions are already fully recovered into memory. The main fixes remove history copying, unnecessary scans and duplicate refreshes; routing equivalent queries through SQLite does not justify replacing the default. This is neither a general claim that SQLite is slower than files nor proof of global optimality.

| Case | Memory | SQLite |
|---|---:|---:|
| 100 sessions, first page | 0.119 ms | 0.137 ms |
| 20,000 sessions, first page | 0.123 ms | 0.150 ms |
| 20,000 sessions, last page | 0.124 ms | 0.139 ms |
| 20,000 sessions, complete pagination | 33.082 ms | 39.974 ms |
| 2,000 sessions, 16 KiB history each, complete pagination | 2.883 ms | 3.380 ms |
| 2,000 sessions, 4 KiB metadata each, complete pagination | 10.872 ms | 11.173 ms |
| 20,000 sessions, one authorized per 100 | 0.145 ms | 0.226 ms |
| 20,000 sessions, long authorization gap | 0.127 ms | 0.165 ms |
| 20,000 sessions, long dynamic archive gap | 3.429 ms | 8.879 ms |
| 20,000 sessions, no matching dynamic source | 3.314 ms | 8.168 ms |

Single-page differences are usually tens of microseconds, but accumulate across complete pagination and dynamic filtering. Primary SQLite cases with recorded index metrics remained active, with actual SQL hits in executed query cases and zero errors, overflows or fallbacks. Memory fallback was not counted as SQL performance.

Authorization pushdown benefits both backends and must not be credited to SQLite. The secondary table alternates the frozen historical R3 release program; unlike the primary comparison it uses a different executable, recorded separately.

| 20,000 sessions, first-page authorization | R3 reference | Current memory | Current SQLite |
|---|---:|---:|---:|
| All visible | 0.119 ms | 0.120 ms | 0.133 ms |
| One visible per 100 | 2.269 ms | 0.145 ms | 0.226 ms |
| First 100 and final session visible | 4.973 ms | 0.127 ms | 0.165 ms |
| Empty authorized set | 3.045 ms | <0.001 ms | <0.001 ms |

Sparse and gap cases improve about 15.6x and 39.2x by intersecting candidates before State locks. Empty authorization returns directly in both backends without querying SQLite. Dense paths do not universally improve: at 2,000 sessions, R3's 0.117 ms becomes 0.122 ms in memory, about 4.9% slower. This adverse result is retained.

## Recovery and resource costs

| 20,000 sessions, warm file cache | Memory | SQLite |
|---|---:|---:|
| Complete recovery, first-build condition | 1,058.205 ms | 1,151.603 ms |
| Complete recovery, reopen condition | 1,157.240 ms | 1,099.996 ms |
| Directory initialization only, first build | 1.120 ms | 15.460 ms |
| Directory initialization only, reopen | 1.075 ms | 4.810 ms |
| Median whole-process peak RSS in primary comparison | 892.766 MiB | 900.125 MiB |

Complete recovery is actually lower at the SQLite reuse median, with strongly overlapping process ranges. These results establish neither universally slower startup nor removal of the recovery bottleneck. Directory initialization itself costs more, while file recovery still dominates roughly one second of startup. SQLite adds about 7.36 MiB to measured whole-process peak RSS; this is neither isolated index memory nor production residency.

The bundled SQLite version is 3.54.1, from pinned `rusqlite=0.41.0`. The reused 20,000-key database is about 2.05 MiB. First-build WAL is about 2.09 MiB while the database is still 4 KiB. These values exclude SHM, rejected caches and fact files. Default memory starts no index threads, although the added dependency still has build and linking costs.

## Fact writes, snapshots and a scheduling counterexample

Median fact creation across 64 actual writes per process, then across processes, is 8.005 ms for memory and 7.994 ms for SQLite. The difference does not establish stable acceleration. After sixteen snapshot-producing Turns per process, SQLite `rowsWritten` remains 64, unchanged from creation. Neither reads nor ordinary snapshots rewrite index rows, and model request count remains sixteen.

The initial single-thread Tokio closed-loop fixture reports concurrent read medians of 0.540 ms versus 8.792 ms. This cannot be called a sixteenfold production regression: memory queries can repeatedly complete without suspending, while SQLite yields to its worker threads, changing overlap with the snapshot writer's State lock.

To test that mechanism, retain the original samples and add a test-only control: both backends call `yield_now()` after each completed read. Five alternating processes per backend use the same additional release executable. Production sources remain unchanged.

| Mixed fixture: sixteen Turns and eighty reads per process | Memory | SQLite |
|---|---:|---:|
| Original closed loop, Turn median | 17.056 ms | 17.996 ms |
| Original closed loop, read median | 0.540 ms | 8.792 ms |
| Cooperative scheduling, Turn median | 18.660 ms | 18.662 ms |
| Cooperative scheduling, read median | 8.418 ms | 8.703 ms |

The controlled medians converge, supporting State snapshot-lock waiting and request scheduling as the explanation. An adverse memory round remains: its read median is 13.921 ms versus SQLite's 8.764 ms in that round. These are neither production arrivals, external model latency nor stable p95 evidence. The original gap does not prove that SQLite generally slows tasks; the counterexample does not establish SQLite superiority. WAL does not remove waiting for fact synchronization while current State remains locked.

## Mechanisms and fairness

Memory now reuses the UUID map already produced by recovery instead of rebuilding it through registration. Authorized IDs intersect the directory before session locks are acquired. UUID queries traverse the authorized range; creation-order queries use intersection and bounded selection for small sets, or ordered scanning for larger sets. Remaining archive, source and relationship filters inspect current State rather than a stale copy.

SQLite receives exactly the same authorization conditions. `entries(id PRIMARY KEY,created_at)` and its covering `(created_at,id)` index store immutable keys only. The `version` row changes in the same transaction as mutations. Queries use bound parameters, composite-key continuation and `LIMIT`, without OFFSET; bound JSON supplies authorization intersection. Keys resolve to current sessions under the same directory generation. Names, archive state, permissions and legacy metadata use the same projection.

One writer batches bounded queued mutations; two reader threads own separate connections. Async RPCs neither execute SQLite directly nor hold the directory lock while awaiting it. Queue capacity is 128. Lagging generations and busy readers fall back to memory. Database failures, writer overflow or reads exceeding 250 ms disable SQLite for the instance. Control barriers each have a one-second deadline; these do not forcibly cancel stuck filesystem calls.

Startup fully recovers files and compares every database key before reuse, rebuilding inconsistent keys transactionally. Corrupt or incompatible regular cache files are preserved before rebuilding. Cache paths reject symbolic and multiple hard links. Both backends retain memory order indexes for fallback. SQLite adds connections, threads, page caches and files; it does not claim lower resident history memory.

## Fact writes and compatibility

JSON facts, snapshot version, synchronous persistence ordering, UNKNOWN and tool-effect rules remain unchanged. Registration and rollback only enqueue index changes; cache errors do not alter original commit outcomes. Names, archive changes and ordinary Turn snapshots do not update SQLite rows. `flush_catalog` drains the cache rather than establishing a new fact commit point.

Existing RPC names, parameters, metadata, UUID/creation ordering, authorization, cursor encoding and non-snapshot cross-page semantics are preserved. `memory` remains the default; configuration or an environment variable explicitly selects `sqlite`. See [configuration](../../guides/configuration.en.md#session-catalog-backends). Rust embedders can set `session_catalog` in `Limits`; `Limits::default()` selects memory. Rust callers constructing every field explicitly must supply the new field; JSON/RPC clients require no change.

This iteration changes no model prompts, input planning, tool definitions, execution budgets or production GUI interactions. Reduced directory work can reduce contention, but does not establish faster model solving, commands or user-file operations generally.

## Method

Apple M5 Pro, 24 GiB RAM, Rust 1.94.0. Both backends use the same frozen release app-server `--lib` executable, selected with a test-only variable. Five independent processes per backend alternate execution order. This task runs no builds or functional tests during measurements. Query timing includes the real Engine, RPC projection and JSON encoding, excluding fixture preparation. Each case has two warmups, then seven samples for first/last pages and ten for filters, or five for complete directory traversal. Tables use the median of per-process medians rather than treating within-process samples as independent machines.

Recovery follows fixture preparation, so it uses **warm file caches**. First construction and index reuse each contribute one startup sample per process, five per backend; neither is called disk-cold startup. Additional cases cover 4 KiB metadata, long archive gaps and no matching source. Write fixtures measure 64 actual fact creations, sixteen completed snapshot-producing Turns and eighty reads from four query tasks, checking index writes, actual SQL hits, fallbacks and model request counts. RSS is whole-process peak residency rather than isolated index memory.

The legacy `catalog_performance_comparison` retains five `all` samples without separate warmup as supplementary data. Complete-pagination tables consistently use the new backend entry and its warmups; results are not selected across entries. RSS also includes the identical system Python launch wrapper.

A frozen historical R3 executable runs five sparse-authorization comparisons as a secondary reference. The primary backend conclusion uses the same current executable. The [results JSON](conversation-catalog-sqlite-results.json) retains all samples, exit codes, source and executable SHA256 values, index state and unsuccessful attempts.

## Functional protection and acceptance limits

- Broad default-backend Engine, app-server and config regressions: 854 passed, zero failed and seventeen explicitly ignored, across 78 result groups including doc-tests. Engine index regressions exercise both backends. The current follow-up release executable additionally runs SQLite directory contracts: ten passed and four explicitly ignored performance entries.
- Legacy metadata/persistent bytes, complete references with mixed permissions/archive/relationships, page sizes 1/7/100, timestamp ties, old cursors, forks, rollback and independent lock progress pass. Four query tasks concurrent with 32 creations preserve published sessions without omissions or duplicates; SQL remains active and settles 32 rows.
- SQL-specific cases cover reuse/stale-key repair, preserved corrupt-cache rebuild, external writer locks, lag, queue overflow, read deadlines and safe paths. Cache errors are not returned as fact commit failures; shared disk and CPU contention remain possible.
- Repeated directory observation in both backends preserves model inputs and fact bytes. A real file tool effect runs once, with unchanged usage/restart history and no tool replay.
- Thirteen GUI refresh regressions pass. Fresh TUI/Core artifacts pass multi-turn persistence, PTY behavior, cancellation, child navigation, reconnect, forced-kill recovery and OTLP in both modes. Actual CoreBackend/desktop-connection large-history checks also pass separately: ordinary/archive pagination, Unicode item reassembly above 64 MiB, view release and reconnect. Each backend has 228 history responses at most 1 MiB, one solve and one title request, preserving history and receipts.
- Clippy for four affected crates with all-targets and `-D warnings`, relevant Rust formatting, JS format/syntax, and documentation/link checks pass. No production GUI pages or visual components changed. Full GUI verify, manual Renderer visuals, packaged installation and Linux native acceptance were not repeated; prior GUI results are not counted as current runs.

This supports no regression in covered paths, rather than absolute immunity for every capability. Additional memory, connections, threads, build dependencies and disk costs are recorded. No four-domain Agent comparison establishes faster inference or user-file tools generally.

The initial direct timer launch of the historical program aborted before test entry with no valid samples. The identical SHA runs through system Python, subsequently used for every version. An execution-environment switch lost temporary logs and an unfinished broad test run; its final exit is UNKNOWN and excluded from pass totals. The broad suite was rerun with workspace evidence. Known initial configuration, compilation and macOS NOFOLLOW adaptation failures are also retained in JSON rather than presenting repaired passes as first-attempt successes.

## What to borrow from Codex

The official API separates database listings, JSONL repair and loaded sessions. `useStateDbOnly` skips log repair, while some metadata writes target SQLite directly. These boundaries are useful; they do not imply that every SQLite value is disposable cache. [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server)

This implementation deliberately tests rebuildable immutable-key indexing in the current architecture, rather than reproducing Codex's complete storage model. Potential gains from nonresident history or avoiding complete recovery additionally require lazy loading, fact versions/incremental discovery, crash reconciliation, dynamic metadata consistency and recovery gates. Those unimplemented gains are not credited to this candidate.

WAL allows short read transactions alongside writing but still has one writer. It does not remove current-State locks or fact-file synchronization costs. `synchronous=NORMAL` applies to rebuildable cache rather than fact durability. [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite PRAGMA](https://www.sqlite.org/pragma.html#pragma_synchronous)

## Alternatives

Retaining complete memory indexes for fallback is a compatibility choice, not the most memory-efficient SQLite design. These results reject the need for another equivalent SQL key-index layer as the current default optimization. They do not compare a complete database architecture with nonresident history or establish that the best possible SQLite implementation is inferior.


| Direction | Conditions and costs in the current architecture |
|---|---|
| Memory directory with authorization pushdown | A narrow correction with no second dynamic-state copy; correctness is directly testable |
| Current SQLite index | Runnable, explicit candidate with fallback; persistent cache and threads, still complete fact recovery |
| Index archive, source and relationships | Could reduce long dynamic-filter scans; requires all mutation paths and generation validation to prevent omissions or stale results; memory indexes can do this too |
| Optional slim summary API | Relevant if transport, JSON or large metadata dominates; preserve the old API and validate Core/GUI capability negotiation and compatibility |
| Independent lightweight directory and lazy history | Relevant when startup or history memory dominates; SQLite is one possible implementation, requiring discovery, versions and unsettled-execution recovery |
| Snapshot write coalescing | Requires evidence that snapshots dominate and an explicit fact commit boundary; no asynchronous lost writes, reduced fsync or hidden retries for better timings |
| GUI activity-write coalescing | Needs separate unread/order/failure/crash checks; a directory index does not optimize these writes automatically |

No implementation is called globally optimal. Mechanism regressions protect correctness; formal Agent strategy claims still require source isolation and fixed four-domain distributions. Single-machine directory measurements, deterministic models and native smoke do not replace that evidence.

## Reproduction

```sh
cargo test --locked -p areal-engine -p areal-app-server -p areal-config --jobs 3 -- --test-threads=4
AREAL_CATALOG_TEST_BACKEND=sqlite cargo test --locked -p areal-app-server --lib catalog_tests --jobs 3 -- --test-threads=4
cargo test --locked --release -p areal-app-server --lib --no-run --jobs 3
AREAL_CATALOG_TEST_BACKEND=memory cargo test --locked --release -p areal-app-server --lib catalog_backend_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_TEST_BACKEND=sqlite cargo test --locked --release -p areal-app-server --lib catalog_backend_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_TEST_BACKEND=memory cargo test --locked --release -p areal-app-server --lib catalog_cooperative_concurrency_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_TEST_BACKEND=sqlite cargo test --locked --release -p areal-app-server --lib catalog_cooperative_concurrency_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_TEST_BACKEND=sqlite node scripts/smoke.mjs
AREAL_CATALOG_TEST_BACKEND=sqlite node clients/gui/scripts/large-history-smoke.mjs
```

Freeze artifacts before timing and invoke the same executable directly in alternating order, avoiding intervening builds or overwritten artifacts. Build Core/Runtime before native scripts; `AREAL_TEST_BIN_DIR` and `AREAL_CORE_BIN` can select a separate build location. Smoke uses temporary configuration and data without operating existing user services.
