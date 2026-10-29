[中文](conversation-catalog-lazy.md) | **English**

# Session catalog: compact metadata and lazy history

See [integration verification and remeasurement](#integration-verification-and-remeasurement) for the latest-main cohort, reported separately from earlier executables.

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

## Integration verification and remeasurement

After integrating main with the Cloud lifecycle changes, freeze production code again. Full Engine/config/app-server suites pass in both default `memory` and recommended `sqlite-lazy`: **896 passed, zero failed, 20 explicitly ignored** per mode. The 20 cache/recovery boundaries include cold and reused caches, archives, clock rollback and drain. GUI history/catalog contracts (68), regressions (100) and Cloud contracts (19) pass; groups overlap and are not summed as independent tests. Real TUI/Core/Runtime smoke passes in all four modes. Default and recommended modes pass large-history, archive, over-64-MiB Unicode item, view-release and reconnect checks. Clippy, full GUI types, formatting, health gates and paired documentation checks pass.

Integration reproduced an idle-reaping compatibility bug: idle calculation takes the maximum activity across all Turns, but tail-only cold metadata could lose an earlier larger timestamp after clock rollback. Retain a private maximum, include it in the projection checksum and verify it against complete facts at first materialization. Archive timing follows existing recovery semantics; public tail timestamps and RPCs do not change. GUI reads keep current shared decoders and the disconnect read barrier. Extract catalog scheduling into `catalog-observation` behind existing entry points and satisfy the existing source-size cap without relaxing its baseline.

Retain environment failures and controls. Host proxy interception of loopback also stalled the fork test on unmodified main; preserving exclusions and adding loopback made it pass. Downloader contracts deliberately change uppercase proxy variables, which host lowercase proxy variables and `no_proxy` overrode; isolating host proxy settings only for that fixture process passes the original assertions. No production downloader change or assertion relaxation was committed. Missing dependencies and early type/format/source-cap failures remain recorded. The first GUI baseline attempt failed before measurement because the loader lacked pnpm application dependency paths; reusing the loaded production module paths fixes the benchmark harness, and the failed attempt is retained separately.

Use the same final release executable for four modes, four cases and five independent processes per cell, totaling 324 preparation/observation processes. Build and functional verification precede measurement; OS file cache is warm. Each cell is **reusable-cache startup ms / initial Core RSS MiB**; Runtime/Electron, process creation and fixture preparation are excluded. Do not pool these values with older executables above. The metadata case also has 1 KiB history/session; the mixed case has 12 KiB history and 6 KiB metadata/session, including children and archives. Raw samples, costs, source/executable identities and failures are in [integration results](conversation-catalog-integration-results.json).

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 20,000 | 1378.7 / 583.9 | 1322.5 / 586.8 | 300.9 / 215.2 | 278.5 / 211.5 |
| 2,000 × 64 KiB | 163.6 / 327.9 | 180.9 / 329.8 | 61.5 / 127.6 | 61.6 / 127.2 |
| 2,000 × 4 KiB metadata | 159.4 / 182.6 | 162.3 / 184.3 | 100.3 / 179.1 | 99.3 / 158.8 |
| 1,500 mixed / 6 KiB metadata | 129.5 / 186.3 | 137.5 / 187.8 | 115.2 / 198.4 | 106.0 / 163.4 |

At 20,000 sessions, recommended-mode reusable startup falls 79.8% and initial Core RSS falls 63.8% relative to eager memory. All four modes already contain the compact directory and paging changes; this table isolates loading policies, not SQLite alone. Fixtures use sequential UUIDs and fixed distributions; five processes do not establish a stable p95 or a production population result.

| 场景 / Scenario | memory | sqlite | memory-lazy | sqlite-lazy |
|---|---:|---:|---:|---:|
| 20,000 / first build (ms) | 1767.588 | 1995.810 | 2001.340 | 2461.234 |
| 4 KiB metadata / first build (ms) | 175.392 | 172.226 | 222.118 | 368.484 |
| 20,000 / one changed fact (ms) | 1136.277 | 1276.711 | 338.688 | 283.390 |
| 20,000 / first 100 (ms) | 0.120 | 0.143 | 0.180 | 0.175 |
| 20,000 / full directory (ms) | 34.475 | 43.722 | 41.909 | 40.640 |
| 20,000 / no origin match (ms) | 5.685 | 11.176 | 3.436 | 3.223 |
| 64 KiB / first history (ms) | 0.049 | 0.047 | 0.383 | 0.299 |
| 64 KiB / first execution (ms) | 18.601 | 18.479 | 18.029 | 20.925 |
| 64 KiB / all-open RSS (MiB) | 329.656 | 332.328 | 321.875 | 323.953 |
| 4 KiB metadata / full directory (ms) | 10.991 | 11.837 | 14.896 | 15.953 |
| mixed / first execution (ms) | 27.370 | 27.087 | 28.130 | 27.767 |
| mixed / all-open RSS (MiB) | 191.188 | 193.406 | 246.812 | 211.469 |

Retain first-build, query, first-body, first-execution and all-open costs. Every deterministic execution uses one model request and identical recovered user/assistant input hashes across modes. These new execution samples do not replace the [earlier slower first-execution cohort](#additional-fault-recovery-audit) or prove zero real-task regression. Loaded history is not evicted, so all-open memory gains can disappear.

Compare the production GUI coordinator, CoreLibrary and CoreBackend.save against the original directory implementation on current main. Each arm has five independent Node 24 processes with five samples per process, taking process medians; 2,000 rows, 100/page, bursts of 20. Core transport is a fixture; JSON writes and rename are real. IPC, Renderer and network are excluded. Final summaries, completion identity and unread state agree.

| GUI operation | Baseline ms | Current ms | RPCs | All library writes | Summary writes |
|---|---:|---:|---|---|---|
| 20 simultaneous full refreshes | 63.62 | 2.84 | 400 → 20 | 20 → 1 | 20 → 1 |
| 20 same-session Turn notices | 84.20 | 38.15 | 400 → 1 | 40 → 21 | 20 → 1 |

Plain Engine shutdown leaves unopened bodies cold: the regression's next open hits 2/2 cache rows with unchanged fact bytes. Explicit drain preserves queue-pausing/revision semantics by restoring and committing unarchived sessions; the next open hits 0/2 and parses two complete facts with intact history. This can approach eager memory and pay rebuilding cost again: **cache-reuse startup is not a guarantee for every restart**. This change neither postpones fsync nor coalesces authoritative commits.

Continue recommending `sqlite-lazy` for many settled histories and growing metadata, while default remains `memory`. SQL key lookup cannot substitute for loading separation. SQLite metadata adds row-level maintenance and future schema/index options while hot directory queries reuse ordered memory indexes. Small catalogs, fully active histories or first-execution-sensitive workloads can retain `memory`. Covered paths show compatibility, not global optimality or an absolute absence of availability issues; local release installers and four-domain model evaluations were not rerun.
