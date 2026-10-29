[中文](conversation-catalog-lazy.md) | **English**

# Session catalog: compact metadata and lazy history

## Selection

Recommend `sqlite-lazy`: **persist compact metadata in SQLite, query existing ordered memory indexes, and load a session's history on first demand**. Keep `memory` as the compatibility default; the new mode is explicit and preserves fact/recovery semantics. See [configuration](../../guides/configuration.en.md#session-catalog-backends).

The final four modes share one release executable. Reusable-cache startup for 20,000 sessions decreases 74.1% and initial Core RSS 64.0%; with 2,000 histories of 64 KiB each, reductions are 69.8% and 61.3%. Most gains come from loading separation, compact State and deferred bindings/event buffers. SQLite adds value for metadata allocation and incremental maintenance. Queries are not universally faster; first-load, build and all-open costs follow.

The complete matrix below belongs to the first frozen executable. Independent measurements after cache-recovery fixes appear in the [additional audit](#additional-fault-recovery-audit), including unfavorable first-execution samples; results from different executables remain separate.

| Mode | Startup recovery | Persistent directory | Runtime queries |
|---|---|---|---|
| memory | Eager facts | None | Memory |
| sqlite | Eager facts | SQLite immutable keys | SQLite with memory fallback |
| memory-lazy | Settled ordinary roots on demand | JSON metadata manifest | Memory |
| sqlite-lazy | The same lazy mechanism | SQLite metadata cache | Memory |

The memory-query choice is deliberate. A development variant queried SQLite keys as well: the 20,000-session unmatched-origin query took 8.152 ms versus 3.294 ms for memory queries with the JSON lazy cache. An already resident order index did not benefit from that round trip. Another development counterexample used 1,200 mixed sessions and 8 KiB metadata: JSON lazy startup RSS was 194.953 MiB, exceeding eager memory's 169.938 MiB; SQLite metadata used 159.516 MiB. Whole-manifest temporary allocations and allocator-retained pages made JSON more expensive. These observations motivated the final combination; all original results remain retained.

## Startup and memory

Core Engine open plus default-model recovery (ms), including validation and directory initialization. Excludes fixture preparation, process creation, Runtime, network and Electron. File caches are warm; this is not disk-cold startup.

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 100 | 32.6 | 35.3 | 27.6 | 29.2 |
| 20,000 | 1050.4 | 1123.7 | 288.4 | 271.6 |
| 2,000 × 64 KiB | 169.5 | 156.8 | 52.5 | 51.2 |
| 200 × 512 KiB | 64.5 | 71.3 | 29.6 | 32.5 |
| 2,000 × 4 KiB metadata | 150.0 | 141.4 | 97.8 | 84.5 |
| 1,500 mixed, 6 KiB metadata | 115.2 | 119.9 | 101.3 | 82.4 |

Initial Core RSS (MiB), before directory/history requests. It includes shared executable, registry, allocator and linked SQLite code, rather than isolated cache size or total GUI memory.

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 100 | 117.3 | 119.1 | 113.9 | 115.2 |
| 20,000 | 581.7 | 585.4 | 207.0 | 209.7 |
| 2,000 × 64 KiB | 327.5 | 329.3 | 127.1 | 126.9 |
| 200 × 512 KiB | 223.0 | 225.4 | 114.5 | 116.2 |
| 2,000 × 4 KiB metadata | 182.3 | 184.0 | 179.0 | 158.4 |
| 1,500 mixed, 6 KiB metadata | 185.5 | 187.3 | 197.8 | 162.6 |

Cache build and startup after one equal-length fact-name edit (ms):

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 20,000 / cache build | 2347.8 | 2447.1 | 2430.3 | 2893.3 |
| 20,000 / one changed fact | 1185.6 | 1169.0 | 297.9 | 274.6 |
| 64 KiB history / cache build | 175.0 | 425.9 | 457.5 | 243.3 |
| 4 KiB metadata / cache build | 157.1 | 151.9 | 198.0 | 324.2 |
| 4 KiB metadata / one changed fact | 136.3 | 149.4 | 116.6 | 89.7 |

First enablement or recovery-fingerprint changes still validate all facts and rebuild caches, sometimes slower than eager recovery. Reuse skips history parsing. Every mode enumerates files; lazy modes stat each fact, so startup remains O(N). JSON rewrites the complete manifest when anything changes; SQLite transactionally updates invalid rows and membership. Both currently read the full metadata directory. Unavailable caches recover facts directly; misses cannot be counted as ordinary warm-cache gains.

## Queries and first use

Query times (ms) include real Engine/Desktop projection and JSON encoding, with at most 100 results per page. Full traversal visits every session. Authorization intersects candidates before session locks; type, archive and origin filters precede page-size calculation.

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 20,000 / first 100 | 0.114 | 0.134 | 0.181 | 0.186 |
| 20,000 / full | 34.085 | 39.697 | 41.554 | 40.747 |
| 4 KiB metadata / first 100 | 0.453 | 0.468 | 0.676 | 0.680 |
| 4 KiB metadata / full | 11.617 | 11.826 | 15.206 | 15.252 |
| archive gap / first 100 visible | 0.778 | 1.062 | 0.701 | 0.748 |
| 20,000 / no origin match | 5.779 | 11.063 | 3.696 | 3.876 |

Lazy views reject nonmatching dormant entries using compact fields, then decode returned metadata. Loaded sessions inspect current state. Arbitrary Rust predicates still decode candidate projections. Cursors advance over raw candidates; there is no OFFSET, missing-row shortcut or new cross-page snapshot guarantee. Absolute values prevent exaggerating submillisecond differences into general execution gains.

First history reads (ms) include fact IO, validation/recovery, Thread output and JSON encoding. Ordinary and archived cases are retained. Loading is at the **session's current snapshot** granularity; that snapshot is parsed completely, while existing archive segments retain their original read interfaces. This is not lazy decoding of individual Items.

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 64 KiB history | 0.058 | 0.060 | 0.379 | 0.513 |
| 512 KiB history | 0.215 | 0.248 | 0.740 | 0.694 |
| archived, 16 KiB history | 0.253 | 0.289 | 0.394 | 0.410 |
| archived, 12 KiB + 6 KiB metadata | 0.255 | 0.242 | 0.477 | 0.445 |

First resumed execution of an unopened session (ms), in separate execution fixtures after directory observations and before any history reads. Includes recovery, input construction, deterministic model, snapshots and settlement. Every mode makes one model request and produces identical restored user/assistant history hashes. This is not external LLM or real-tool throughput.

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 100 | 17.468 | 17.102 | 18.209 | 18.363 |
| 64 KiB history | 19.377 | 18.200 | 19.337 | 21.863 |
| 512 KiB history | 23.239 | 21.874 | 24.219 | 28.547 |
| mixed | 28.531 | 29.343 | 27.364 | 29.279 |
| confirmation | 27.798 | 28.258 | 28.355 | 28.614 |

Loaded history is not automatically evicted. After reading all sessions and initializing ordinary subscription buffers, Core RSS is:

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 2,000 × 64 KiB | 329.3 | 332.0 | 322.4 | 324.8 |
| 200 × 512 KiB | 225.7 | 228.6 | 224.9 | 226.8 |
| confirmation | 190.4 | 192.4 | 246.7 | 211.0 |

Benefits can disappear; retained allocations can make lazy modes larger. Archived bodies retain their original nonresident semantics. The design suits many settled ordinary sessions with few recently active histories. Small directories, permanently open history, Goals, complex ownership or unsettled records offer limited gains. Larger first snapshots cost more. At most two lazy fact reads run concurrently; recovery holds its session lock without holding the global directory lock for IO. Existing fact-write locks and fsync costs remain.

## Compatibility and constraints

- Authoritative JSON, state version 15, atomic write/fsync order, UNKNOWN, cancellation, permissions, tool receipts and workspace file tools are unchanged. Caches are not commit points; ordinary Turns do not dual-write metadata. SQLite NORMAL applies only to rebuildable caches.
- Only settled `appServer`, `cli` and `exec` roots defer. Children, Fork/Side, Goals, unsettled tools/processes/queues/interactions and legacy default-model migration retain eager recovery. Not every history becomes nonresident.
- Startup checks device/inode/length, nanosecond mtime/ctime, mode, single-link regular-file identity, projection checksums, archive-head dependencies and implementation fingerprints. First use checks full SHA-256, eligibility and metadata. Dormant projections cannot overwrite facts. Concurrent first loads publish one complete state; cancellation cannot publish partial history.
- Offline membership/edits, corrupt caches and tightened history limits retain fact validation. Unknown cache versions are preserved. Wrong first-load projections fail before execution and identifiable caches are quarantined so restart revalidates facts. No tool replay or implicit execution retry is added.
- RPC parameters, fields, statuses, order, permissions and old cursors remain compatible. New Rust view helpers share filtering; existing predicate signatures remain. Exhaustive SessionCatalog matches must cover two added lazy variants. GUI refresh coalescing is reused.

## SQLite and future scope

SQLite addresses persistent metadata: row updates, transactions, versioned structures and avoiding giant manifest allocation fit measured needs. The metadata counterexample shows JSON is not always lighter. Streaming JSON could reduce manifest peak memory and has not been compared here; these results are not a lower bound on JSON implementations. Segmenting and incrementally maintaining a file manifest would require another storage/recovery mechanism. Existing simple sort queries continue using memory.

Future multidimensional filters, tags, cross-project search and text search can add typed columns, covering indexes or a separate FTS index. Current `metadata(id,body)` still stores JSON projections and implements none of those features. Dynamic indexes need post-fact commit notifications, generation/dirty-row coverage, rebuild and fallback rules to prevent stale omissions. Removing cold Cell handles, skipping enumeration or evicting idle history requires further directory/active-session separation and recovery design. A SQLite file does not supply these gains automatically. [Query planning](https://www.sqlite.org/queryplanner.html), [FTS5](https://www.sqlite.org/fts5.html)

Codex's official API separates loaded sessions, stored-history pagination, database directories and JSONL repair, and exposes SQLite-backed persistent metadata updates. This supports borrowing the layering; it does not establish that every database value is disposable or supply performance evidence for this repository. Here JSON remains authoritative and SQLite remains rebuildable. [OpenAI App Server](https://learn.chatgpt.com/docs/app-server)

For a few small sessions, necessarily resident history or deployments avoiding derived caches, `memory` remains reasonable. For the ordinary-history residency and catalog-growth problem studied here, recommend `sqlite-lazy`, without claiming global optimality. The compatibility default stays `memory`; synthetic storage results do not establish four-domain Agent improvements.

## Validation and reproduction

Each lazy mode completed the full Engine/config/app-server suite: **866 passed, zero failed, 19 explicitly ignored**. The final release executable passes four-mode directory RPC contracts. Additional coverage includes 12 cache/recovery boundary tests, four-mode actual dynamic file effects executed once and continued after recovery, 13 GUI refresh tests and 39 GUI history/reconnect tests. Directory observations preserve complete recorded requests, usage and fact bytes; continued execution checks restored history and original tool receipts.

Fresh Core/Runtime binaries pass TUI, multi-turn persistence, PTY, cancellation, child navigation, SIGKILL recovery and OTLP smoke in default and both lazy modes. Both lazy modes pass actual CoreBackend/Desktop ordinary/archived segments, serialized Unicode Items above 64 MiB, view release and reconnect; reads add no model work or change authoritative history/receipts. Full GUI visual, packaged-release, Linux-native and four-domain model evaluations were not rerun.

One early Workgroup test hit its five-second timeout; isolated and full reruns passed, without fully attributing the cause. A deliberately interrupted suite is not counted as passing. Compile/Clippy fixes, the mistaken CLI-root fixture assertion and every development comparison remain recorded. Final production code stayed frozen and was not tuned against confirmation outcomes.

Five independent processes per mode/case rotate order. Each process discards two query warmups and retains ten samples (five full traversals); tables take the median within each process and then across five processes. ps records stage RSS; time -l peaks remain raw. A peak containing all-open work is not startup residency. Builds and functional tests finish before measurement. This shared single host and five processes do not establish stable p95 or cross-platform behavior. Ranges, raw values, exits, input hashes and source/executable SHA-256 are in the [result JSON](conversation-catalog-lazy-results.json).

```sh
cargo test --locked --release -p areal-app-server --lib --no-run --jobs 3
python3 scripts/conversation-catalog-benchmark.py /absolute/release-test-executable --rounds 5 --all-open --execution
python3 scripts/conversation-catalog-benchmark.py /absolute/release-test-executable --phase confirmation --cases confirmation --rounds 5 --all-open --execution
AREAL_TEST_SESSION_CATALOG=sqlite-lazy cargo test --locked -p areal-engine -p areal-app-server -p areal-config --jobs 3 -- --test-threads=4
AREAL_CATALOG_TEST_BACKEND=sqlite-lazy node scripts/smoke.mjs
AREAL_CATALOG_TEST_BACKEND=sqlite-lazy node clients/gui/scripts/large-history-smoke.mjs
```

The driver currently validates macOS RSS and system-Python launch semantics and refuses existing output directories. Build native binaries first; `AREAL_TEST_BIN_DIR` and `AREAL_CORE_BIN` can select fixed artifacts. The [earlier report](conversation-catalog-sqlite.en.md) covers eager memory and SQL keys; do not mix its samples into the final comparison.

## Additional fault-recovery audit

New adverse cases first reproduced two recoverability defects: after legitimate fact deletion and a tightened thread limit, an oversized stale catalog repeatedly bypassed caching; empty or reserved-version-zero remnants from interrupted SQLite initialization also remained unavailable. Facts and no-replay semantics held, but startup optimization was lost. Recognized invalid caches are now preserved and rebuilt, and SQLite identity/schema/version initialize in one transaction. Foreign databases and unknown established versions retain original bytes.

Boundary coverage expands to **19 passing tests**, including five bootstrap stages, tightened limits, duplicate identities, external cache writers, symbolic/hard links, and cancellation after fact validation while waiting for publication. The selected mode completes a fresh full suite: **873 passed, zero failed, 19 explicitly ignored**. The earlier timeout test passes five consecutive isolated reruns. Default and both lazy native TUI/Core/Runtime smoke, selected-mode large/archived/serialized Unicode history and reconnect, GUI history/refresh, Clippy and documentation checks are rerun.

After fixes, four representative cases run five independent processes per mode with one frozen release executable. Preparation and measurement remain separate, without concurrent builds or functional tests. Cells below show **reusable-cache startup ms / initial Core RSS MiB**. Raw build, changed-fact, query, first-read/execution and all-open samples are in the [audit results](conversation-catalog-lazy-audit-results.json). The original large matrix belongs to its earlier frozen executable; samples are not combined across versions.

| Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 20,000 | 1085.2 / 582.6 | 1051.0 / 586.3 | 268.1 / 206.9 | 249.9 / 210.2 |
| 2,000 × 64 KiB | 156.4 / 327.1 | 169.6 / 329.1 | 51.8 / 127.0 | 51.3 / 126.7 |
| 4 KiB metadata | 146.0 / 182.1 | 140.6 / 183.9 | 91.9 / 178.7 | 88.2 / 158.2 |
| mixed | 140.6 / 185.7 | 128.2 / 187.3 | 116.0 / 198.0 | 90.8 / 162.9 |

Costs remain visible in the fixed executable; values below are medians of five independent processes per mode:

| Metric | memory | sqlite-lazy |
|---|---:|---:|
| 20,000: first build (ms) | 1739.3 | 2987.5 |
| 20,000: first 100 (ms) | 0.118 | 0.176 |
| 20,000: full directory (ms) | 32.750 | 40.270 |
| 64 KiB: first history (ms) | 0.052 | 0.324 |
| mixed: all-open RSS (MiB) | 191.1 | 197.7 |

The mixed large-metadata fixture shows slower first execution: the original `sqlite-lazy` median is 56.4 ms versus 31.7 ms for `memory`. Additional controls use the same production sources: synchronize cache/target facts and wait two seconds; then add only ignored-benchmark phase timers to compare cold and preloaded execution, followed by collection of existing persistence timing events. Each row is one separate cohort of five independent processes per mode, in ms. Preloaded rows exclude the separately recorded restore cost; traced results also remain separate.

| Execution control | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 原始执行 / Original cold | 31.7 | 31.8 | 37.7 | 56.4 |
| 同步后等待 / After fsync and quiescence | 44.5 | 28.6 | 42.3 | 59.9 |
| 分段计时：冷 / Phase timers: cold | 32.2 | 29.3 | 39.0 | 54.3 |
| 分段计时：已加载 / Phase timers: preloaded | 37.1 | 33.5 | 48.1 | 35.0 |
| 持久化追踪：冷 / Persistence trace: cold | 30.2 | 38.2 | 43.8 | 30.4 |

Preloading history itself takes about 0.33 ms in both lazy modes but does not consistently remove total-execution differences. Traced executions all make three fact commits and one model request with identical history inputs. Durable synchronization accounts for a median 90.4% of elapsed time (range 71.2%–95.5%); combined serialization and write-queue medians stay below 0.25 ms in every mode. Code inspection confirms normal `sqlite-lazy` Turns do not access the metadata database; runtime queries remain in memory. Diagnostics identify existing durable commits as the main cost in these samples, without fully attributing earlier untraced differences or proving zero first-execution regression. Original slower samples remain intact and are not replaced by later lower medians.

Selection prioritizes startup and initial residency for many dormant histories plus growing metadata; `sqlite-lazy` remains recommended within that scope. Initial build, full traversal, first reads and some execution samples are slower, and all-open memory can be higher. `memory` remains reasonable when first-execution latency matters more or all history stays active, and remains the current default. Unimplemented streaming JSON, a separate cold directory and history eviction may improve other metrics; these four implementations cannot establish a global optimum.
