[中文](testing.md) | **English**

# Testing

Recorded smoke journeys request normal `app.quit()` before awaiting Playwright `close()`, allowing product shutdown and recording settlement to proceed together while still awaiting completion of `close()`. Playwright otherwise drains recording before requesting quit, consuming the same 20-second deadline serially. A controlled recording gate verifies this ordering; incomplete shutdown still fails at the original deadline. Draft confirmation, failure reporting and recording evidence remain required.

The Side Chat Escape fallback test waits for the outer task-resources popup to leave layout before checking that the main turn stops. Hiding its inner `Activity` precedes the closing animation of the `keepMounted` popup; that animation must continue protecting the main turn. The test explicitly slows this animation and records popup state for both main/Side start orders, without a fixed sleep or repeated Escape presses to hide the race.

Model-usage observer non-interference tests await the `drained` settlement signal while disk writes remain blocked, then inspect the in-memory ledger under the observer lock. Receiving HTTP EOF does not establish that the server's `finally` block has completed; longer sleeps or releasing the blocked disk first cannot substitute for that ordering.


The release smoke fixture handles auxiliary session titles separately from solve requests. Main-task exit may cancel an unfinished title request; BrokenPipe/ConnectionReset while replying to that title must not turn successful read/write acceptance into failure. Interrupted solve responses, tools on naming requests and other protocol errors still fail. `scripts/fixture_session_title.py` is a local fixture helper and does not change production retries, timeouts or model usage.

Install dependencies using the [development guide](README.en.md). Regular tests use temporary directories, dynamic loopback ports and deterministic models without real model credentials.

| Entry point | Coverage |
|---|---|
| `make verify` | Cordis pin, formatting, static checks, Rust workspace, both SDKs, Python, documentation, TUI and unified delegation smoke |
| `make script-test` | Launcher, Web reasoning/wait/cancel projections, benchmark statistics/evidence, adapter dependency boundaries and documentation links/language pairs |
| `make upgrade-smoke` | Real CLI and offline installer in isolated directories, covering standalone upgrades, old-bundle retention, Homebrew protection and checksum failure; synthetic service records do not establish real-task continuity |
| `make tui-upgrade-smoke ARGS='--old-bin-dir /absolute/old/bin --new-bin-dir /absolute/new/bin'` | Two immutable real bundles, old and new TUI PTYs, local model and Core/Runtime, verifying old reconnects cannot stop or downgrade the explicitly activated new backend |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | Concurrency primitives |
| `make verify-runtime` | Runtime unit tests and real file, process, permission and shutdown smoke |
| `make verify-harness` | verify followed by Runtime, complete Harness, desktop API and Workgroup smoke |
| `make verify-native` | macOS native backend tests and Harness integration smoke; common checks are covered by `make verify` |
| `make examples-desktop-api` | [Direct API, CLI, Skills and relocated packaged binaries](../examples/desktop-api.en.md) |
| `make workgroup-smoke` | Private Runtime writes, combined verification, command deadlines and failure settlement |
| `make git-auth-smoke` | Public shared-service to real Runtime Git identity, SSH-agent signing, HTTPS push and failed-authentication protection |
| `make unified-execution-smoke` | Unified model tools, parallel isolated candidates, composed delivery, ownership checks, cancellation and restart recovery |

Snapshot format changes require `make verify-harness`: Harness and plugin smoke check the written version, and desktop relocation tests compare the release manifest, `areal/server/status.stateVersion`, and actual snapshot versions.

Real PTY smoke tests reconstruct incremental output with a terminal-cell emulator. Wide characters also overwrite the adjacent cell so stale characters cannot produce false Unicode-editing failures. Script unit tests cover this redraw boundary. Session IDs come from the dedicated welcome-page row, not UUIDs inside workspace paths. Child-session navigation waits for the specific tree row and its selection marker before Enter; a creation-status banner does not establish that the asynchronous tree has refreshed.

`tui-upgrade-smoke` does not build or deploy artifacts. Prepare complete, immutable old and new binary directories, using an old version that cannot read the new state format. The script isolates home, workspace, state and model endpoint. It submits messages through real old and new TUIs, explicitly restarts the service to activate the new version, then resumes the still-open old TUI and triggers reconnect. Across multiple retry periods it checks the new Host/Core PIDs, generation, state format and a subsequent reply. Use `--evidence /absolute/output` to retain terminal screens, command logs, source and bundle identities, and cleanup results; evidence defaults to a temporary directory. This check does not run the installer or replace `upgrade-smoke`, package validation or real-provider acceptance.

macOS native smoke tests require Seatbelt; Linux native smoke tests require `/usr/bin/bwrap` and user namespaces. Neither platform may substitute unsandboxed execution when the capability is missing. `outer-container-perf` remains validated in controlled containers. Default `cargo test` excludes explicitly ignored native Workgroup and capacity cases.

Linux host checks use `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`. Native backend tests require `/usr/bin/bwrap` and user namespaces; a separate CI job builds the Dockerfile's `runtime-tests` target and runs every backend test, including `outer-container-perf`, inside the controlled Bubblewrap container. It also enables `areal-runtime/native-tests` and runs the daemon's `native_transport` target. That target starts the real daemon over private stdio with the complete Runtime bundle, so Linux resolves the reaper beside the daemon. Its native sandbox test keeps the ordinary-command/hook progress and foreign-writer exclusion assertions; the four portable transport tests remain in the default suite. `make verify-native` builds the bundle before explicitly running the same native target on macOS. The feature selects this test target only and changes no production behavior. Excluding native tests from the portable host lane alone does not complete validation.

Integration tests that embed Runtime inside the Cargo test process need the matching reaper beside that host in `target/<profile>/deps/`. The `runtime-tests` image installs and checks this artifact in a separate layer, retaining compiled-test layers. The offline CI contract executes the actual installation commands and verifies location, bytes, and executable permissions; compiler and package-manager boundary fixtures do not replace native Linux container acceptance.

Native Side acceptance also starts an MCP fixture at runtime through `CARGO_MANIFEST_DIR`. The image must copy that file to the corresponding source path. The offline contract extracts these paths from the test source and checks the image's COPY mappings; the Docker build also checks readability. Successful compilation does not establish delivery of runtime fixtures.

## Repeatable faults, local checks, and cache acceptance

Select relevant entry points from the repository root:

```sh
make check-changed CI_BASE=<actual-comparison-ref> ARGS=--plan
make check-changed CI_BASE=<actual-comparison-ref>
python3 -m unittest scripts.tests.test_check_changed
cargo test --locked -p areal-engine --test http_model --test provider_replay --test model_timeouts
cargo test --locked -p areal-engine --lib first_event_deadline_is_fixed_and_activity_starts_a_new_idle_window
cargo test --locked -p areal-engine --test model_input_budget
node --test clients/gui/scripts/desktop-projection-transport.test.mjs
pnpm --dir clients/gui test:navigation-cache
pnpm --dir clients/gui test:unit renderer/src/readingViews.test.ts
```

`scripts/ci-scope.py` owns the plan shared by local checks and CI. `check-changed` resolves merge-base once and unions staged, unstaged, and untracked paths, including both rename sides and changes cancelled by partial staging. The plan records commands, dependencies, capabilities, platforms, and manifest child-test sets, bound to base/source/head and input digests. Shared Rust, schema, lockfile, build, and CI changes broaden selection; unknown code selects conservatively. An unavailable comparison base cannot pass.

Focused checks run the plan’s `commit` phase plus previously unsuccessful checks and their dependencies; `ARGS=--phase=full` selects the complete plan. Commands read the `working-tree`, while the index affects selection and drift detection; this does not validate partially staged contents. Reports list unselected full checks as `pendingRequired` and other-platform checks as `remoteRequired`. `passed` covers only the selected checks. `blocked`, `invalidated`, and `failed` cannot count as passing.

Failure follow-ups automatically read `target/ci/{preflight,changed,failures}/*/report.json`. Only reports from HEAD’s ancestry after the comparison base (including HEAD) participate. For each check ID and platform, results from newer commits take precedence, ordered by completion time within a commit. Unsuccessful checks still required by the current plan are selected with their dependencies. Other branches and commits already included in the base are excluded; late passes from ancestor commits cannot clear failures on newer commits. Reports only guide selection: commands come from the current plan, and historical passes never count as current evidence. Download remote reports to `target/ci/failures/<attempt>/report.json`, or import one explicitly with `ARGS='--failure-report /path/to/report.json'`; explicit reports outside the branch are rejected. Other-platform checks remain required remotely; missing local capabilities block the selected check.

Read structured progress with `python3 scripts/ci-preflight.py --report target/ci/changed/<run-id>/report.json`. The adjacent `plan.json` must match the report identity. At initialization, command start, and check completion, the runner updates `progress` with counts and IDs for `passed`, `failed`, `blocked`, `pending`, `running`, `invalidated`, and `cancelled`. Unselected full checks and remote checks remain pending and are also listed as `pendingFull` and `remoteRequired`. Later independent passes cannot erase earlier failures. Top-level `status=passed` covers only selected local checks; `progress.status=pending` means the full plan still needs validation. The progress reader’s exit code indicates readability, not verification success.

Design documents are health-budget inputs: Markdown-only changes under `design/` or `clients/gui/design-system/` select the inexpensive `gui-health` check without triggering GUI builds or smoke. Ordinary `docs/` changes retain document-only selection.

Reports record the actual selection in `selectedRequired`. An interrupted local attempt carries selected local checks without results into the next focused check; never-selected `pendingRequired` and other-platform `remoteRequired` do not become a mandatory local full run. Legacy reports recover this set only from an adjacent identity-matching `plan.json`. History only guides reruns, never proves a new source/base/plan passed; `passed` still covers the current selection, while progress and remote requirements describe completeness. Missing or duplicate child-runner entries report a coverage error; failures within a complete set identify `failedScripts`. Identity mismatches still fail immediately.

The scheduled-task editor loads only after explicit editing; reading the list imports no editor and submits no task operation. Its dynamic chunk remains in the Remote offline asset closure. New chunks need bounded budgets without raising entry or aggregate limits. Pure-state tests verify loading, retries, and stale-generation invalidation; SSR checks establish only the absence of eager imports; first editing, loading failures, task changes, and stale responses after unmount still require interaction acceptance.

Human review of health baselines remains a code-review responsibility; the script cannot verify human authorization. The explicit transition recognizes only `activeDesignDocBytes` from 262924 to 269714 with unchanged owner and direction, for bilingual plugin-resource specifications and disclosure/copy rules, without extra headroom. It suppresses only the old-base transition diagnostic; actual overruns, other metrics, and source caps still fail. Once the base adopts the new value, this record no longer matches and may be removed. Later growth requires a fresh review, not a permanent `--allow-regression`.

`make ci-preflight` records tool versions, lockfiles, and input digests in `target/ci/preflight/<run-id>/metadata.json`, freezes the plan in `plan.json`, and writes each command, timestamps, elapsed time, exit code, and status to `report.json`. Formatting, manifest/gate contracts, capability probes, and production bundle budgets run early. Independent checks continue collecting failures; only consumers of failed dependencies become `blocked`. New output directories preserve every attempt; passing results are not cached.

Fault-injection acceptance: `python3 scripts/desktop-schemas.py --counterexample` uses real Rust schema generators to prove drift is rejected. `pnpm --dir clients/gui test:ci-budget-counterexample` builds an oversized production entry in isolated output and requires the actual budget check to reject it. `python3 -m unittest scripts.tests.test_ci_contracts scripts.tests.test_check_changed scripts.tests.test_git_hooks` verifies blocking for absent native capabilities, gate rejection of missing checks/child tests, and staged-rule isolation. Preserve first-attempt failures instead of relying on automatic retries for green results.

Core connections coalesce only simultaneous raw, parameterless `areal/plugin/list` and `areal/plugin/mcp/list` reads with matching timeout and response budgets. Calls with decoders or onResult callbacks remain independent. Completion, failure, and disconnect clear the flight; mutation start and settlement separate reads so post-write validation cannot join a pre-write snapshot. `core-read-recovery.test.mjs`, included in `test:regressions`, uses real WebSockets and response barriers to prove 32 concurrent reads send one frame, controls remain live, failures are not cached, and mutation/connection/budget boundaries are preserved. This does not cache catalog results, replay mutations, or relax Core control reservations.

Dedicated Relay transport contracts run in a separate CI job: build inputs with the GUI-supported Node version, then switch to the Relay-pinned runtime. This job runs alongside the macOS GUI path, and the final GUI gate still requires success; cancellation, failure, or unexpected skipping cannot pass the gate.

Provider replay fixtures in `core/engine/tests/fixtures/provider-replay` exercise real HTTP bytes, production decoder/Engine, and temporary storage for retained text before errors, disconnects after finish events, and late answers after cancellation. Notifications control request arrival/release instead of fixed sleeps. Pure timer policy uses paused Tokio time while real HTTP timeout tests preserve I/O coverage. Server write chunks do not guarantee operating-system network packet boundaries.

`make test` first prepares a matching Core/Runtime bundle through `make build` and passes `target/debug` as the default `AREAL_TEST_BIN_DIR` to workspace tests. Runtime write recovery is explicitly selected by `areal-engine/native-tests` and runs in `make verify-native` and the Linux `runtime-tests` container; the portable lane retains three HTTP replay cases. Direct execution requires a deployed and verified fixed bundle from the same build, selected explicitly:

```sh
AREAL_TEST_BIN_DIR=/absolute/verified/bin cargo test --locked -p areal-engine --features native-tests --test provider_replay persisted_runtime_write_survives_disconnect_and_reopen_without_replay
AREAL_CORE_BIN=/absolute/verified/bin/areal pnpm --dir clients/gui test:history-compat
```

This native test compiles under `native-tests` (which includes `test-support`) and uses existing test construction APIs; this change does not alter production behavior. Missing fixed paths must fail rather than count as a passing skip. The Runtime case independently checks persisted writes, tool results after reopen, and a sentinel file; network milestones do not establish persistence and recovery does not authorize replay. `history-compat` also needs built GUI artifacts. Its `profiles.json` declares old-format paging, settled child relationships, and three terminal outcomes. The runner checks public history pages, order, relationships, and Renderer text while preserving source hashes and zero model requests. See the [quality design](t3code-quality-design.en.md) for current acceptance status of these two native paths.

`model_input_budget` measures fixed instructions, environment text, and each tool's name/description/parameters from actual outbound solve requests under default Desktop configuration. The initial profile excludes Runtime/plugins; dynamic user content and random paths stay outside its fixed baseline. Changes report components and tool names and require manual baseline review without changing production inputs or limits.

`test:navigation-cache` uses the production React App, real Chrome, and fixture PlatformServices to count derivations for unrelated UI actions, check name/unread/running/order/new-snapshot freshness, and save source identity and screenshots. It does not start Core/Electron or establish package or perceived-latency acceptance. `readingViews` unit tests cover the 32-entry memory bound, recency eviction, unavailable storage, and semantic-anchor reload; real theme/layout continuity needs Renderer scenarios. The legacy `conversation-flow` scenario times out at `.tool-summary-row .tool-failed`; production collapsed failure state is expressed by `ActivityRowStatus` with `data-tone="failed"`. That markup is a separate boundary from the `readingViews` capacity change. This effort does not change the legacy runner, and the complete conversation flow is not counted as passing.

## Local verification artifacts and startup diagnostics

After Cargo succeeds, `make build` / `make release` writes `target/<profile>/verification-build.json`, binding the existing Core `inputHash`, build revision and SHA-256 of the complete Core/Runtime set. GUI builds extend the existing bundle analysis plugin with `renderer/dist/verification-build.json`, recording GUI inputs and output hashes; source changes during a build fail it.

From the repository root, deploy matching artifacts into a separate fixed slot, then diagnose startup:

```sh
python3 scripts/verification.py deploy --source-dir "$PWD/target/debug" --bin-dir "$PWD/.local/dev-bin/verification" --evidence "$PWD/.scratch/verification/deployment.json"
make gui-build
python3 scripts/verification.py doctor --core "$PWD/.local/dev-bin/verification/areal" --report "$PWD/.scratch/verification/startup-1.json"
```

Deployment reuses existing process/open-file inspection and rejects occupied slots, missing components and artifacts changed since the build. Verification helpers hold the slot's `.verification-lock` for the entire run; deployment uses the same lock. Locks do not expire automatically. After interruption, inspect `owner.json` and confirm its processes and services have stopped before removing a leftover lock. Existing local fixed-path deployment and doctor entry points delegate to these versioned implementations. Isolating test directories does not establish build identity. Direct `cargo build` does not create the batch receipt; use `make build`.

Before Electron starts, doctor checks Core's embedded input identity, all component hashes, Renderer inputs and output hashes. Reports include each of the three programs' path, SHA, probe command, exit code or signal, and macOS signature check. A failed probe does not discard remaining diagnostics and produces a nonzero exit. Use a new report filename for each attempt; existing reports cannot be overwritten. The file helper's no-request probe checks startup without performing a file operation. Neither exit zero nor a valid signature proves manual authorization. `authorization` defaults to `unknown`; after actual human observation, record each component separately with options such as `--authorization-observation areal=allowed`. SIGKILL is recorded as a signal without attributing it to endpoint protection. Reports do not replace real Runtime, provider or packaged-app acceptance.

Static browser acceptance uses the existing `verification.py` to create a private copy of a build matching the current GUI inputs:

```sh
python3 scripts/verification.py snapshot-renderer --source-dir "$PWD/clients/gui/renderer/dist" --output-dir "$PWD/.scratch/verification/renderer-1"
pnpm --dir clients/gui test:history-navigation-ui
```

The output directory must not already exist. The command checks the build receipt, source digest, and every output file before and after copying, publishing the snapshot receipt only after success. Rebuilding shared `renderer/dist` subsequently cannot change the copied artifacts. The receipt records the source revision, input digest, original build directory, and copied file hashes; it identifies this run's artifacts, not later source changes. Follow [concurrent changes and final acceptance](README.en.md#concurrent-changes-and-final-acceptance) for worktree selection and build sequencing.

The history-navigation runner calls this entry point automatically and serves only its private static copy. `AREAL_RENDERER_DIST` still requires a receipt matching the current sources. `renderer/test-fixtures/history-navigation.ts` implements the production `DesktopBridge` and participates in Renderer typechecking; removing `onPreviewEvent` or `onUpdate` fails before browser startup. The runner builds the fixture with the existing Vite toolchain and requires its input digest to match the Renderer, retaining the real desktop adapter and projection reader. Assertions cover mouse and keyboard history navigation, cold-project switching, preservation of UNKNOWN requests, and zero submissions. The boundary is Chrome + Renderer + a bridge fixture, excluding Electron/Core.

The task catalog smoke fixture lives in `clients/gui/renderer/test-fixtures/scheduled-workspace.tsx`, is typechecked with Renderer, and is loaded directly by the existing browser runner. It checks new intents routed through `onStartDraft`, project defaults, explicit reconciliation and observed receipts for legacy requests. Only the IPC boundary is replaced by the fixture.

## GUI test registry and platform qualification

`clients/gui/scripts/test-manifest.json` registers every `test:*` command in the root GUI `package.json`. `layer` distinguishes pure unit tests, contracts without a GUI, and browser/Electron end-to-end boundaries. `platforms`, `areas`, and `requires` declare runnable platforms, covered areas, and prerequisites. Entries limited to one platform require `platformReason`. A platform declaration is not acceptance evidence. Headless tests that need Core remain contract tests.

Run these commands from `clients/gui`. Use a frozen Core build and do not rebuild it during acceptance.

```bash
pnpm verify:tests
pnpm test:unit
node scripts/test-manifest.mjs --list --platform=linux --layer=contract --available=git,python3,gui-build
node scripts/run-portable-tests.mjs
AREAL_CORE_BIN=/absolute/fixed/areal node scripts/run-portable-tests.mjs --core-contracts
node scripts/test-manifest.mjs --ci-matrix --base=<commit>
node scripts/repeat-tests.mjs --profile=linux-feasibility --plan
AREAL_CORE_BIN=/absolute/fixed/areal xvfb-run -a node scripts/repeat-tests.mjs --profile=linux-feasibility
AREAL_CORE_BIN=/absolute/fixed/areal node scripts/repeat-tests.mjs --profile=macos-baseline
```

Run `make gui-build` first to prepare Desktop/UI/Renderer inputs. The portable runner executes the planned unit and contract set for its platform and lane. Missing capabilities produce blocked failures rather than removing required tests. Reports retain results, elapsed times, and commands owned by other lanes. Reports default to `target/ci/gui/portable/<run-id>/report.json` or `target/ci/gui/core-contracts/<run-id>/report.json`, preserving failed attempts and recording source/diff digests, the Core artifact hash, and CI run/attempt. Set `AREAL_PORTABLE_TEST_REPORT` to choose an explicit output file. Full Relay transport contracts also require their pinned Node 24.2.0 and `services/remote-relay` dependencies. CI runs them in a separate step. Real CA/HTTPS/WSS tests live in `remote-relay-system-ca.test.mjs` and run only through `test:remote-relay`; `test:remote-relay-contracts` retains generic contracts that do not start the Relay CLI.

`--core-contracts` requires a working `AREAL_CORE_BIN` and runs the registered contracts that depend on Core. The macOS build job runs this set after building the matching Core/Runtime bundle and archives the matching Core contract report; the Linux portable lane remains independent of Core. The required smoke matrix also runs `test:design` against the matching design build, including actual browser accessibility and keyboard checks. Active `design/**` changes trigger GUI checks.

`ciSmoke` binds the existing macOS smoke matrix. Area selection narrows only known local Renderer changes. Shared owners, test scripts, unmapped paths, and areas without matching smoke coverage retain the full matrix. Runs without a comparison base also use the full matrix. Linux units and contracts are not narrowed by area.

Create temporary directories with `makeTempDir(prefix)` from `scripts/support/temp.mjs`. It resolves `os.tmpdir()` through `realpath`, preserving macOS path-comparison semantics. `verify:tests` checks registered scripts and local imports through an AST and rejects actual `/private/tmp` and `/var/folders` path literals. Strings in audit rules and negative fixtures are not temporary directory creation.

The repeat driver retains first-attempt logs, isolated temporary directories, exit status, elapsed time, and source/Core identities before and after execution. It neither retries nor removes failures. Linux qualification reuses the five existing startup/recovery, send/stream, stop-Turn, desktop-settings, and quit-draft runners for ten attempts each. The macOS baseline runs every unattended registered E2E five times. `--scripts=test:composer,test:queue` narrows the run and marks its report scoped. `--repetitions=N` supports diagnosis; fewer than ten Linux attempts cannot qualify for required CI. Quit-draft still requires a complete frozen Core bundle under the repository's `.local/dev-bin/`.

A Linux required-CI candidate must complete at least ten first attempts per journey, have no environment blocks, pass at least 95%, and retain the same source identity. Ten attempts therefore require 10/10. A complete five-attempt macOS sample below 95% with real failures appears in `flakyCandidates`; environment blocks remain separate. Maintainers review causes and evidence before setting `flaky: true` or approving the required Linux set. Qualification reports do not automatically alter registrations or weaken existing gates.

Select `qualification=linux-feasibility` in a manual [GUI workflow](../../.github/workflows/gui.yml) run to execute the Linux plan on native Ubuntu with xvfb. `macos-baseline` expands the five-attempt baseline by script. Linux preflight requires a non-root user, DISPLAY, user namespaces, and Bubblewrap. Missing capabilities return blocked while preserving Electron/Runtime sandboxing. It does not use `--no-sandbox` or alter host security policy. Unexecuted or unreviewed qualification is not a Linux pass. Manual qualification jobs expose failures independently and do not replace the required GUI gate.

The portable Linux job's ten-minute timeout is a limit, not runtime evidence. `portable-interval.json` measures the interval from its first execution step through report creation, excluding runner provisioning and artifact upload. Check GitHub Actions job timestamps for complete job duration. Without a remote CI run, the under-ten-minute criterion remains unverified.

The public-source scan admits exact paths for the bundled product Skill and the UI package’s usage and review Skills. Their contents remain subject to private-path and credential checks. `test:regressions` verifies admission of public files, rejection of other Skills, and rejection of private content inside a public Skill.

## Git identity and authentication

`make git-auth-smoke` (also part of `make harness-smoke`) uses an isolated HOME, foreground SSH agent, deterministic local model and loopback HTTPS bare repository. It commits, signs and pushes through public `service ensure`, CoreClient, Core tools and the real Runtime. After loading a test key it deletes the disk private key; missing-agent signing must fail without changing HEAD, and an incorrect password must be rejected without changing the remote ref. A temporary CA is explicitly trusted without disabling TLS verification. The test also checks byte-for-byte configuration preservation, absence of test passwords in model/result/service logs, and service process exit.

Build the complete bundle and install the existing Node development dependencies before running `node scripts/git-auth-smoke.mjs` directly. `AREAL_TEST_BIN_DIR` selects the bin directory; `AREAL_GIT_AUTH_EVIDENCE_DIR` saves evidence. Git SSH signing, OpenSSH, OpenSSL and loopback listeners are required. The temporary root defaults to `/tmp` on macOS to avoid login-session paths exceeding Unix socket limits, and the system temporary directory on Linux. `AREAL_GIT_AUTH_TMPDIR` explicitly selects an authorized short directory with write access. Unavailable or overlong paths fail directly without retrying another location. This test does not read user credentials, operate existing desktop services, or replace real-provider, GUI-click or model branch-selection testing.

To verify authentication with a stored local Keychain item, first obtain explicit permission for a temporary test entry, then run `AREAL_GIT_AUTH_EVIDENCE_DIR=/authorized/evidence/path node scripts/git-auth-smoke.mjs --keychain`. This opt-in mode uses the login HOME and system `git-credential-osxkeychain`, but explicitly points global Git configuration at a synthetic file. It creates, reads, updates, and deletes only a synthetic credential for a random account and exact loopback port/path; it does not use existing credentials, automatically unlock a keychain, or change the default keychain or search list. It checks successful HTTPS push, failure protection for incorrect and missing credentials, cleanup, and unchanged Keychain settings. `SIGINT`/`SIGTERM` enter bounded cleanup. After forced termination or failed cleanup, `*-keychain-cleanup.json` in the evidence directory retains the exact helper/query without a password: confirm the original service has exited and reconcile that entry before further testing; never report unconfirmed cleanup as successful. This mode is not part of default CI, and a local pass does not verify the original reporter or a real remote.

For the Keychain boundary in a macOS login session, run `python3 scripts/git-keychain-smoke.py --bin-dir target/debug`, optionally with `--report` to save JSON. It only queries randomly generated nonexistent host/account pairs and does not enumerate, read or write user credentials. Full access must return no match successfully; explicit native profiles, fixed read-only inputs, denied network and narrowed write roots must retain rejection. `-50` is recorded as an observation, not a universal incorrect-password classification. A missing system helper or unavailable login session fails rather than being skipped or counted as passing. This check is separate from generic CI without a login session and does not establish that real Keychain entries are unlocked or remote authorization is valid.

## GUI and desktop route gates

Run conversation-directory regressions from the repository root with `cargo test --locked -p areal-app-server --lib catalog_tests`, `cargo test --locked -p areal-engine --lib catalog::tests`, `cargo test --locked -p areal-engine --test catalog_observation`, and `node --test clients/gui/scripts/catalog-refresh.test.cjs`. They cover legacy metadata and persistent-byte compatibility, filtering before page sizing, complete-reference comparisons, long filter gaps, cursor ordering and authorization, independent session-lock and registration progress, registration rollback, GUI refresh coalescing and connection replacement. Observation regressions also check unchanged model inputs, tool effects, usage and restart history. The GUI tests are included in `pnpm --dir clients/gui verify`.

Explicit local performance comparisons use `cargo test --locked --release -p areal-app-server --lib catalog_performance_comparison -- --ignored --nocapture` and `node clients/gui/scripts/catalog-refresh-benchmark.cjs`. Pass an older `history-observation.cjs` path to the latter to compare coordinators with the same fixture. Timings are not CI thresholds. See the [conversation-directory report](../benchmarks/reports/conversation-catalog.en.md) for source identity, raw samples, reproduction and measurement limits.

The same Rust module provides `catalog_filter_performance_comparison` for sparse filtering, also run explicitly with `--ignored --nocapture`. Set `AREAL_CATALOG_BENCH_CACHE=production` for real library serialization, file writes and rename while retaining activity writes. `AREAL_CATALOG_BENCH_THREADS` selects 1–20,000 rows. See [directory iteration validation](../benchmarks/reports/conversation-catalog-validation.en.md) for alternating comparisons and remaining costs.

Both directory backends run the same RPC regressions: set `AREAL_CATALOG_TEST_BACKEND=memory` and `sqlite` separately for `cargo test --locked -p areal-app-server --lib catalog_tests --jobs 3 -- --test-threads=4`. Only tests read this variable; production uses `[storage].session_catalog`. `cargo test --locked -p areal-engine --lib catalog:: --jobs 3 -- --test-threads=4` covers reuse, offline reconciliation, preserved corrupt-cache rebuild, external writer locks, stale-index fallback, queue overflow, read deadlines, safe paths and rollback after an unknown creation result. `catalog_observation` runs both backends, checking model inputs, actual file effects, usage and no tool replay after restart. Test configuration with `cargo test --locked -p areal-config --test session_catalog`.

The explicitly ignored `catalog_backend_performance_comparison` covers complete recovery with warm file caches, index build/reuse, full pagination, large metadata, real fact creation and snapshot-producing Turns with concurrent reads. Select both backends in the same release `--lib` executable, alternate at least five independent processes per backend, and retain active backend, index hits, fallbacks, written rows and peak RSS. Avoid concurrent builds and exclude fixture preparation from query timings. Index reuse is not a disk-cold startup. Built-binary `scripts/smoke.mjs` and `clients/gui/scripts/large-history-smoke.mjs` also accept `AREAL_CATALOG_TEST_BACKEND=sqlite`, write it into isolated configuration and check that the database was created. See the [SQLite comparison](../benchmarks/reports/conversation-catalog-sqlite.en.md) for results and boundaries.

The additional `catalog_cooperative_concurrency_performance_comparison` yields after each read in both backends to diagnose write-lock overlap in the closed-loop fixture. Run it explicitly with `--ignored --nocapture` in five alternating processes per backend. Retain the original non-cooperative results rather than equating a single-thread fixture gap with production regression.



`memory-lazy` and `sqlite-lazy` reuse the same directory regressions. `catalog_observation` covers all four modes, resumed execution after recovery and no repeated tool effects. `cargo test --locked -p areal-engine --lib store::lazy --jobs 3 -- --test-threads=4` covers first-load concurrency/cancellation, metadata and work overview, fact bytes, equal-length offline edits, membership changes, tightened limits, invalid/unknown-version caches and execution checks. Run complete Engine/config/app-server regressions with test-only `AREAL_TEST_SESSION_CATALOG=memory-lazy` and `sqlite-lazy`; this is enabled only by `test-support`, and production defaults do not read it. Explicit `Limits.session_catalog` wins so eager control instances stay eager.

GUI refresh regressions run with `test:regressions`, retain shared list/metadata response decoders, preserve the backend disconnect read barrier, and reject malformed responses without overwriting the last complete cache. Lifecycle checks distinguish ordinary shutdown from explicit drain, verify paused queues and intact history after restart, and record the cache revalidation boundary. All four modes also compare idle-drain decisions after clock rollback, including archived recovery and cache reuse, without materializing cold history.

Cache fault regressions also cover stale membership above a tightened limit with a legal fact count, five interrupted SQLite bootstrap stages, cancellation after fact validation while waiting for publication, duplicate identities, external cache writers, and symbolic/hard links. Rebuilds check unchanged fact bytes and cache reuse on the next open; foreign databases and unknown versions must preserve their original bytes.

`catalog_lazy_tests::lazy_catalog_process_comparison` is a separate ignored test. Build release app-server `--lib`, freeze one executable and create isolated fact copies for each of the four `AREAL_CATALOG_TEST_BACKEND` values. Configure `AREAL_LAZY_PERF_ROOT` (absolute directory), `AREAL_LAZY_PERF_COUNT`, `AREAL_LAZY_PERF_CASE=ordinary|archiveGap|cli|mixed` and `AREAL_LAZY_PERF_OPERATION=prepare|startup|directory|execution|preloaded-execution|all`; preparation also needs `AREAL_LAZY_PERF_BODY` and `AREAL_LAZY_PERF_METADATA`. Fixture preparation and measurement must use separate processes. `execution` includes the first cold-body restore; `preloaded-execution` reads the target history before the execution timer and records that separate cost as `preloadMs`. Both report admission (`startMs`) and post-admission completion (`waitMs`); preloaded results must not replace cold results. Optional `AREAL_LAZY_PERF_PERSISTENCE=1` collects existing persistence serialization, queue, write and synchronization timings in the isolated diagnostic process; retain its samples separately from measurements without tracing. Compare cache build, reuse and startup after a single-file change. Record fact volume, parsed facts, cache hits, stage RSS, process peak, first/repeated history reads, first resumed execution and all-open costs. Queries include RPC projection and JSON encoding, discard two warmups and retain ten samples (five full-directory traversals). Alternate at least five independent processes per mode without concurrent builds or functional tests; do not call this disk-cold startup. Retain unfavorable samples and exit status; see the [lazy loading comparison](../benchmarks/reports/conversation-catalog-lazy.en.md). Native smoke backend variables also accept both lazy values.

`cargo test --locked -p areal-app-server --lib desktop_registered_methods_have_dispatch_routes` sends non-object parameters for every registered desktop RPC through the real connection dispatcher and requires an invalid-parameters error rather than method-not-found. It includes `areal/thread/start`, handled separately by the connection. The check runs with `make test-protocol`, `make test` and CI without starting model requests or creating Threads.

[GUI CI](../../.github/workflows/gui.yml) runs locked dependency installation, GUI types, public boundaries, Core/GUI builds, desktop route checks, and the registered macOS smoke matrix for applicable changes. Linux static health and portable units/contracts use separate jobs. Tests use isolated directories and deterministic local models, retaining logs, screenshots, and source manifests. These checks do not establish real-provider or packaged-app acceptance.

Composer and queue smoke share navigation and narrow-window steps in `clients/gui/scripts/smoke-navigation.mjs`: hover the project before creating a conversation, return through a stable task ID, and collapse the sidebar before resizing and waiting for the editor. Failures retain a full-window `failure-window.png` and `failure-state.json` with the original error, viewport, selected project/Thread and visible text. Unavailable pages or screenshots are recorded as capture errors without replacing the original test failure.

Composer IME setup clears the editor with native select-all and Backspace, then requires the DOM, Lexical state, and stored draft to be empty. Playwright `fill("")` can select DOM content without synchronizing the editor's internal selection, so it is unsuitable for this setup. Candidate input, commit, and cancellation remain covered through native Chromium IME events.

Composer smoke closes a completed Side reading view with its tab's Delete key and waits for the main editor to become visible, covering full view in narrow windows and split view in wide windows. The narrow-window panel button switches views. Before applying configuration after a cold reopen, model-selection smoke reads the real `serviceStatus` and waits for tasks, operations, project startup, and configuration updates to settle, then submits once.

Slash keyboard acceptance waits for the Core catalog refresh triggered by this opening, then requires the intended option selected by ArrowDown and the editor's `aria-activedescendant` to agree before pressing Enter. The previous option's selected state cannot prove that keyboard navigation has completed.

Native tool smoke drains all HTTP fixture request threads before assertions. Solve requests require an equal number of completed audits. A single auxiliary naming attempt may be cancelled before HTTP arrival, in which case only an interrupted audit without an HTTP status is accepted. Missing audits for observed requests, duplicate naming, unobserved completion, and naming with tools fail acceptance.

Plugin connection regressions freeze an old catalog scan with one-shot barriers and require newly published generations to survive it. A paired test disables a plugin while its handshake is held, requiring disable to complete and preventing publication. Failed native workgroup cases retain their temporary directory and print the specific case, model usage, and authoritative tool receipts, separating budget errors from earlier failures.

In the model-selection smoke, only settings-operation settlement after applying model configuration uses a 180-second deadline, covering the existing 150-second apply IPC, subsequent configuration reads and UI settlement. Other page actions retain the default 15 seconds. The test submits apply once, waits for navigation to become available, then checks the actual Core model catalog and requests; it does not hide failures with fixed sleeps or replayed applications.

Independent CLI configuration reads, service stop and status queries in the desktop connection smoke use the product `executeCore` launch bridge. On macOS the system Python remains the actual parent of native Core; tests do not substitute direct Node launches for the product entry point. Disconnect recovery still checks the original Turn, subscriptions and request count without replaying submissions.

## Usage analytics history sync

`node --test scripts/analytics-history.test.cjs` uses the real `CoreClient` and a local WebSocket protocol fixture to verify that the dedicated read-only history connection's 4 MiB frame limit does not close the primary project connection. It also covers startup before the model connects, identity changes, history deduplication, partial caches, handshake/RPC timeouts, and cleanup with partial-history errors after primary closure. The analytics connection only initializes, negotiates capabilities, and calls `thread/read`, using the client's default request deadlines; each project has at most one sync in progress. Large-history failures remain partially synced and do not establish complete history coverage. This test does not replace real Core, native GUI, installed-package, or provider acceptance.

## Python and scratch

Failure state and screenshot capture each wait at most 10 seconds; derivation Electron cleanup waits at most 20 seconds. Timeouts enter the evidence without replacing the original failure. CI limits the derivation step to 10 minutes so failed diagnostics cannot block subsequent artifact upload. `make script-test` verifies diagnostic deadlines and propagation of original errors.

Continuous derivation video requires the FFmpeg build pinned by Playwright; installing Electron/npm packages alone is insufficient. GUI CI installs it with `pnpm --dir clients/gui --filter @areal/gui-desktop exec playwright-core install ffmpeg`. Run the same command locally before the first invocation of this smoke.

A full-view Side uses its own Composer. The main draft stays mounted but hidden so its floating actions cannot cover Side model selection or submission; split view still shows both Composers. Derivation smoke checks Side model selection and first-question submission through actual clicks and verifies retention of the main draft.

Linux reaping tests use `areal-runtime-reaper`, built by `cargo test -p areal-runtime-exec-native`. For a standalone `--lib` run, first run `cargo build --locked -p areal-runtime-exec-native --bin areal-runtime-reaper` with the same profile as the tests. macOS descendant tests keep ancestors alive through the tracking window before exit to verify cleanup of observed descendants; they do not establish a complete guarantee against rapid orphaning.

The macOS output-timeout regressions in `areal-local-service` wait for the real child to become ready before briefly advancing Tokio's clock to trigger expiry. Cases targeting post-handshake cleanup also confirm Rust has consumed the handshake; a PID file alone is insufficient. They then resume real time and verify that cancelling the waiter still reaps the real child and bridge, observing a stopped bridge within the implementation's existing two 5s cleanup budgets. These tests do not relax production timeouts or permissions or infer cleanup phases from fixed sleeps.

Independent macOS Python/scratch regression (local model, no provider credentials):

```sh
python3 scripts/native-python-smoke.py --bin-dir target/debug
```

`make harness-smoke` (called by `make verify-native` in macOS CI) includes this regression. It checks automatic scratch and a custom `--scratch` under both default YOLO and the explicit native sandbox: both expose `verify_command` and save verification receipts with exit codes 0 and 7 in a private per-thread directory. Shared resolver tests cover installed CLT without a `developer_dir` link and reject interpreters outside supported frameworks.

`make workgroup-smoke` also verifies that Worker commands receive a writable `TMPDIR` at `.scratch/agent-<threadId>` inside their private workspace, with Python bytecode writes disabled.

The Rust toolchain regression builds and runs a dependency-free Cargo program offline through the real Runtime with a minimal desktop PATH. It then checks Cargo fetching and offline cache reuse with a Git dependency from a local workspace repository. It covers ordinary scopes and a child scope with a read-only repository and writable scratch, and checks that reads outside the workspace are denied. It requires an installed Rust toolchain with a resolvable default and system linking tools. It downloads no toolchain or dependencies. Version probes do not establish compilation or linking support.

```sh
python3 scripts/native-rust-smoke.py --bin-dir target/debug
```

`make harness-smoke` includes this regression. Its Cargo home and local Git fixture are isolated, so it does not establish access to host Cargo caches, private dependencies, real models, or tools in an installed package.

## Recovery and research agents

`python3 scripts/navigation-read-scope-smoke.py --bin-dir target/debug` uses the real Runtime and a deterministic local HTTP model to read and search files while a background writer is still running. It checks navigation without writer-queue waits, restricted Scope reuse, termination of the original process, file-version conflicts, and out-of-bound path rejection. Use `--sandbox-profile full-access` to verify narrowing a full-access parent Scope, or `--evidence-dir` to retain the complete evidence. This runs with `make harness-smoke`, calls no external model, and does not establish end-to-end task performance.

On macOS, the creation-admission kill fixture uses the same trusted Python parent entry as the local service. It verifies that the worker actually receives SIGKILL and retains the crash-point, persisted-binding, recovery, and no-replay assertions; other Unix platforms launch the worker directly.

```sh
cargo test --locked -p areal-engine --test truncated_usage --test tool_call_stream --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

Native tools/agent smoke tests use a local fixed-response HTTP model, the standard launcher and temporary workspaces without external model services. They cover file CAS, search, verification receipts, images, no delegation, a single Worker, synchronous waits, budget failures, parent cancellation and default asynchronous dispatch. The asynchronous case requires parent progress before three Worker requests finish and checks parent/child sampling parameters. Stream tests cover same-frame/tail length usage, EOF/cancellation, no UNKNOWN replay, post-compaction handles and cross-Turn boundaries.

Local HTTP fixtures must add `127.0.0.1,localhost,::1` to both `NO_PROXY` and `no_proxy` for the test process, preserving existing entries so a proxy cannot alter truncated responses or introduce waits. Real HTTP tests check parameters, history and terminal events; an argument-only stream uses a handshake gate that releases the terminal event only after Activity is observed. Frozen-clock tests retain the 150 ms idle boundary and separately cover 40 ms activity, host stalls and 220 ms of actual silence. Silence retries only the incomplete response, with confirmed tools executed once. Fixtures that serve solve requests reject auxiliary purposes through `RequestPurpose`; separate tests cover session naming limits and lifecycle. Do not resolve test failures by raising production timeouts, SSE limits or budgets.


Request-budget tests cover `MAX_MODEL_ROUNDS` classification when Chat Completions or Responses returns tools in the final round, with no tool execution or retries and the original budget audit preserved. Ordinary tool-call budget exhaustion and invalid indices must retain their own classifications. Desktop CLI acceptance also checks the corresponding `error_max_turns` result. Goal HTTP regressions verify that output-token caps and tool count/buffer budgets survive shared pools, while unknown usage from failed requests prevents retries and tool execution.

The interactive-process smoke explicitly sets `stdinOpen:true` for non-PTY pipes, checks `stdinMode=pipe` and the running state before writing, then verifies output; PTY separately checks `stdinMode=pty`. Native tools smoke additionally checks default-closed stdin, write-then-EOF and EOF-only input instead of depending on the old implicit open pipe.

Linux requires Bubblewrap user/PID namespaces, seccomp, Python and Bash. The public Dockerfile builds the pinned bundled rg and provides the remaining toolchain; no host rg installation is required:

```sh
docker build -f tests/e2e/docker/Dockerfile \
  --build-arg INSTALL_CODEX=0 --build-arg INSTALL_CLAUDE_CODE=0 \
  -t areal-native-smoke .
for smoke in native-tools-smoke native-agents-smoke; do
  docker run --rm --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined --security-opt apparmor=unconfined \
    --mount "type=bind,source=$PWD,target=/repo,readonly" -w /repo \
    --entrypoint python3 areal-native-smoke \
    "scripts/$smoke.py" --bin-dir /usr/local/bin --sandbox-profile outer-container-perf
done
```

Outer-container relaxations apply only to the explicitly selected controlled profile; commands still run inside Bubblewrap. Docker's default AppArmor policy denies Bubblewrap namespace mounts, so this profile also explicitly relaxes AppArmor; it does not use privileged mode or add capabilities. Ubuntu 24.04+ additionally requires an administrator-provided AppArmor rule allowing `userns` for `/usr/bin/bwrap`; disabling Docker's AppArmor profile alone does not remove this host restriction. CI loads a rule matching only Bubblewrap on its ephemeral runner, then checks namespace and mount support before compilation. macOS `/usr/bin/python3` may access unauthorized Xcode-selector configuration; do not widen the sandbox automatically for smoke tests. TUI reconnect smoke waits for a `live` subscription before submitting: an open connection and visible cached history do not establish an authoritative restored snapshot.

## Capacity

| Command | Load |
|---|---|
| `make capacity-primitives` | Progress and cancellation of 20,000 asynchronous tasks |
| `make capacity-core` | 10,000 child agents with real persistence and controlled model permits |
| `make capacity-workgroup` | 32 real Runtimes, isolated writes and combined checks; requires macOS |

`make capacity` runs these sequentially; regular verification excludes them. Report hardware, build mode, storage and model fixtures. These figures do not measure real LLM throughput.

## Platform integration boundaries

`make integration-boundaries` requires a Git checkout and runs with `make script-test`. It prevents platform adapter dependencies from entering product sources, release/install entry points, workflows or recursive default Make targets. The generic Rust `id-arena` allocator is allowed. Platform integration and lifecycle acceptance belong to the consuming platform; native CLI, Runtime, Engine and tool tests cover the public contracts.

## CI and contracts

macOS and Linux host checks share one matrix definition. `fail-fast: false` ensures a failure on one platform does not cancel coverage on the other. macOS uses `make setup-node` for native smoke and SDK Node dependencies; Linux `make setup` continues to install all locked formatting tools. Native validation runs Runtime, Harness, desktop API and Workgroup smoke in one child Make invocation, sharing one workspace build. Docker copies only the required CLI/TUI/Web clients and excludes GUI from its build context. Native Runtime and Harness coverage is retained.

`harness-smoke.mjs` checks root/nested `AGENTS.md` and `AGENTS.override.md` replacement, empty-file fallback and ordering, unrelated-directory isolation, missing files, per-Turn refresh, the 32 KiB boundary, UTF-8 and symlink rejection through real Core/Runtime model requests.

[CI](../../.github/workflows/ci.yml) runs native Harness checks on macOS, portable regression and Docker sandbox/file-ownership checks on Linux, and separate Rust/npm advisory checks. Actions are pinned by commit, repository permissions are read-only, and failures retain logs. Consult the run for the relevant commit for actual results.

Pull requests, pushes to `main`, and manual dispatch run the full checks, avoiding duplicate push and PR runs for feature branches. Linux portable and container checks run in parallel, with formatting, SDK and script checks in parallel inside portable regression, followed by static analysis, Rust tests and TUI smoke. The existing `Linux checks and container Runtime` check remains as an aggregate gate that requires both the host matrix and the container job to succeed. macOS runs `make verify-native` for native backend and Harness integration coverage that Linux does not provide.

Host jobs cache Cargo dependency artifacts, npm downloads and uv packages; container tests also reuse the Runtime image build layers through BuildKit's GitHub Actions cache. Cache hits still execute tests. Rust caches are separated by platform, toolchain and dependency manifests. CI disables debug symbols and incremental compilation to reduce artifact size. Only the pinned `cargo-audit` binary is cached; every run still reads advisories and audits the lockfile.

Container behavior checks pass `--build-arg BUILD_PROFILE=ci`, selecting the Cargo `ci` profile inherited from `dev`: debug assertions remain enabled, with debug symbols and incremental compilation disabled. `runtime-tests` uses the same profile to reuse dependency artifacts. The Dockerfile still defaults to `release` with thin LTO; use that default for performance tests. The image label `io.areal.perf.build-profile` records the selected profile. CI images must not be used as release performance measurements.

`make schemas` updates the pinned Codex schema; `make desktop-schemas` updates desktop schemas. Update types, callers and contracts together. Local fixtures do not validate real models, GUIs, third-party daemons, signing/notarization or other platforms. See the [benchmark guide](../benchmarks/README.en.md) for performance runs.

## Network proxy regression

```sh
cargo test --locked -p areal-engine --test model_proxy
cargo test --locked -p areal-mcp --test proxy --test client
cargo test --locked -p areal-engine --lib plugin_host_inherits_proxies_without_other_credentials
```

Proxy fixtures use dynamic loopback ports and isolated subprocess environments. They cover streaming text/usage for Chat Completions and Responses, HTTP/HTTPS proxies, HTTPS CONNECT, SOCKS5 local/remote DNS, authentication, uppercase/lowercase variables and NO_PROXY bypass. Real MCP initialization, discovery and search calls traverse proxies. MCP HTTP library TLS tests explicitly trust the fixture certificate; public test keys in `tests/fixtures/proxy` are not deployment credentials and are never installed in the system trust store. Stdio MCP and plugin processes verify proxy inheritance while excluding unrelated credentials. Third-party search providers, arbitrary plugin HTTP libraries and deployment proxies require separate validation.

## Goal regression

`cargo test --locked -p areal-engine --test watchdog` checks ordinary network retries alongside Goal unknown-usage constraints, including transport failures, rate limits, service unavailability, interrupted streams, request/stream timeouts and summary failures. Goals avoid retry backoff, retain reservations and the previous checkpoint, and release model permits.

`cargo test --locked -p areal-engine --test goals` covers ordinary Turns without continuation, completion across two Turns, CAS/idempotency, budget exhaustion/editing, unknown reservations, pause/resume, queue priority, child attribution, capacity waiting, active deadlines and restart without replay. `cargo test --locked -p areal-engine goals::budget` covers concurrent reservations, nested Workgroup pools, model replacement and single-charge summary accounting. Configuration tests cover default execution limits, TOML overrides and policy ranges; Goal behavior tests use default Limits.

`node examples/desktop-api/run.mjs goal-mode` uses real Core/Runtime and an HTTP/SSE fixture with generated schema validation, file creation/verification across two Turns, isolated Workgroup accounting, observation permissions, retries, multi-client recovery and headless waiting across Turns. It runs under `make examples-desktop-api`; fixtures do not measure real-model task success.

## Shared local services

`make local-service-smoke` uses temporary directories, real Core/Runtime, two PTYs and an HTTP model fixture. It verifies concurrent ensure, workspace/symlink identity, configuration conflicts, authentication, Web discovery, window exit, busy/cancel stop, persistent history, launcher/host SIGKILL cleanup and reattachment. It is included in `make harness-smoke`. `make desktop-schemas` also exports `schemas/local-service-v1.json`.

During fault cleanup, the control socket or the local Core HTTP endpoint may close while a cleanup process still owns the instance lock. Fault-state polling only tolerates an explicit connection-refused transition and must still observe the expected `stopped` or `unavailable` state within the original deadline. Other errors fail immediately, and normal status queries remain strict. `AREAL_TEST_EVIDENCE` selects a JSON receipt path containing the phase and state polling observations; CI saves it to `target/ci/local-service.json` and uploads it alongside logs on failure.

`cargo test --locked -p areal-app-server --test browser_auth` verifies automatic login from the trusted client through real HTTP/WebSocket endpoints, concurrent single-use exchange, Origin validation, instance isolation, inherited permissions, manual login and connection closure at session expiry. Unit tests in that crate use virtual time for code/session expiry and capacity limits. `node --test scripts/web-progress.test.mjs` checks fragment removal before exchange, connection after success, manual fallback on failure and ordinary reloads.

The PTY helper continuously drains terminal output while waiting for CLI commands, service shutdown and window exit, preventing terminal backpressure from blocking the TUI. `make script-test` includes a deterministic regression that writes more than the PTY capacity before exiting.

TUI and shared-service PTY checks share a terminal screen parser that preserves unchanged characters during incremental redraws and handles split UTF-8/control sequences. Model reload checks wait for the new model name in the header, then verify that the service generation has not changed; they do not depend on raw output bytes or transient status notifications.

`cargo test --locked -p areal-engine --test model_reload` verifies that active children and queued requests retain their model while new submissions follow the updated default; busy `ifIdle` drain must leave admission open. Local service smoke also covers invalid edits, queue recovery across restart, workspace selectors and idle restart after limits change.

## Task Mode regression coverage

`cargo test --locked -p areal-app-server --lib calendar_` compares fixed UTC literals through the public Task dispatcher, a Core test clock and the real scheduler. It checks five durable Runs, independent Host/model observations, restart, DST, lateness boundaries and accepted plans. The clock exists only under test-support and is not a production RPC. `AREAL_TASK_CALENDAR_REGRESSION=1 pnpm --dir clients/gui run test:task-conversation` exercises the GUI configuration conversation, Core preview, lateness window and saved-state reopening. Its deterministic local model does not establish real-provider behavior.

`AREAL_COMPAT_OLD_BIN=/absolute/v4/areal AREAL_CORE_BIN=/absolute/current/areal node examples/desktop-api/calendar-storage.mjs` requires two qualified fixed artifacts. It creates real v4 state with the old binary, then uses the current Core production WebSocket routes to check migration, observe-only preview/context permission, original receipts and immutable references. It verifies that the old binary refuses v5 without changing Task files. The script prints an independent Evidence directory containing roots, receipts, hashes, logs and process-stop checks. It executes neither models nor GUI, and does not certify packaged upgrades.

`node examples/desktop-api/schedule-host.mjs` uses real Core/WS and persisted restart to verify offline catch-up, fresh Threads, restricted identities/subscriptions, same-Run recovery from preparation failure, stopping during preparation, and retired Host replies. `node clients/gui/scripts/schedule-desktop-smoke.mjs` uses isolated Electron/Core and a deterministic local model to verify conversational creation, time zones, fresh history, busy skips, separate pause/stop controls and ordinary approval UI, retaining screenshots and JSON. Set `AREAL_SCHEDULE_APPROVAL_EXPIRY=1` to wait the default 300-second deadline and verify Turn settlement plus fresh approval after explicit same-Run resume; an ordinary run does not claim that evidence. These checks do not replace real-provider or packaged acceptance.

`cargo test --locked -p areal-engine --test task_modes` covers independent work during asynchronous questions, Channel replies and same-Run resumption, wakeup when one question expires while another remains pending, headless questions/approvals, durable scheduling, asynchronous foreground Goal questions, workers surviving coordinator Turns with shared budgets, cancellation cleanup and reply deduplication across restart. app-server unit coverage validates Task requests/responses/notifications against generated schemas, Thread authorization filtering and independent subscriptions/unsubscriptions.

`node examples/desktop-api/run.mjs task-matrix` uses real binaries and Runtime to verify headless ordinary conversations/Goals reject questions and approvals while continuing permitted commands, create no implicit schedules, resume asynchronous foreground Goals after disconnection, trigger/control schedules, and account for independent worker file artifacts. `node --test scripts/web-progress.test.mjs` checks wait states, selected later-page tasks, rejection of stale revisions, Inbox drafts and idempotent reply retries after timeouts. See the [desktop examples](../examples/desktop-api.en.md#web-validation) for actual browser validation.

Unified CLI parsing and configuration process regressions live in `clients/cli`, covering default TUI, exec, legacy -p, argument conflicts and side-effect-free diagnostics. Launcher tests dispatch Core and TUI through one areal fixture. Desktop CLI checks exercise both exec and legacy arguments; relocated bundle checks require areal as the only bin entry and verify the internal Runtime paths.

## Live context continuity

After building, run `node scripts/context-live-smoke.mjs /absolute/model.toml` with an explicitly chosen real model configuration. This incurs model usage. The script creates isolated workspace/state directories, submits task revisions, compacts three times, restarts Core, finishes a Goal with real reads/writes and a command, and independently checks every output field and an unchanged accepted artifact. Its JSON report records cache usage without treating unknown usage as zero. Use a small test-only byte window (20,000), recent budget (4,096), and `context_target_tokens=16000` to exercise compaction; do not copy these stress settings into production. The script does not restart production sessions. An optional second argument selects a new report directory. Reports separate `functionalVerified`, valid model summaries and summary failures. Evidence fallback does not substitute for three valid model summaries; any summary failure makes the script exit nonzero. Set `AREAL_CONTEXT_LIVE_BIN_DIR` to a frozen binary directory to use the same candidate across the restart.

For slow tools, enable `areal::tool_timing=debug,areal::persistence=debug` in the logging filter. Tool stages distinguish intent persistence (including lock/clone), invocation, projection and final commit. Persistence distinguishes encoding, IO admission, file write and sync/rename. No arguments, file contents or credentials are added to these timing events. Single encoding retains the same durable-before-execution ordering and file/directory sync.

Search regressions run the Runtime file helper directly, covering search without host rg/Python, workspace ignore rules, globs, context, truncation and symlink rejection. Native and release smoke tests exercise the complete Core `search_files` path without requiring rg in the shell.

Desktop soak and GUI bundle validation accept the embedded-search layout without standalone tools/rg. Soak also verifies the platform-specific Runtime components and manifest file hashes.

## Remote GUI quit continuity

After building Core and the GUI, run `pnpm -C clients/gui test:remote-gui-quit`. `AREAL_CORE_BIN` selects a built Core; `AREAL_GUI_EXECUTABLE` selects a packaged Electron/Core, and `AREAL_CHROME_EXECUTABLE` selects local Chrome. This isolated native case uses a local deterministic model and the production GUI with its detached adapter. It pairs a PWA Operator through the desktop UI, quits the GUI normally while the original filesystem approval is pending, then allows once from the PWA. Assertions cover the same adapter PID/identity, Core generation from its isolated service registry, original Thread/Turn/interaction, one filesystem tool result, a durable Remote admission record, and two normal model stages. Reopening the GUI must not add provider calls. Public `stopService` with its normal confirmation dialog then checks persisted stop intent, descriptor removal, PID exit, Remote disconnection, and no automatic start on another GUI launch.

`node clients/gui/scripts/remote-gui-quit-e2e.mjs --self-test` checks only the deterministic model stages and rejection conditions. It loads no Electron, starts no network, and is not native acceptance. Native execution requires OS secure storage; failure of the production owner's `enableDirect` gate returns exit code 2 and `blocked`, without replacing safeStorage. The isolated scratch retains `report.json` and failure state. If its adapter remains alive, inspect and settle that isolated service before explicitly stopping it. Reports omit service credentials and do not claim an exact Core RPC dispatch count. Sleep, physical phones, Relay, public transport, and packaged installation acceptance remain separate.

## CI gates and cold starts

PR #111 integrates history recovery and scheduled-task ownership after the initial G0 snapshot. The following six existing source caps are explicitly revised to the measured integration at `9297968c`; metric directions, the 800-line cap for new files, and CI enforcement remain active. These exceptions accept module growth; they do not establish a structural improvement.

| Owner | Previous → current lines | Reason |
| --- | --- | --- |
| `app/src/core/backend.cjs` | 2270 → 2284 | Connect task catalog and scheduled-owner lifecycle |
| `app/src/core/history-observation.cjs` | 1072 → 1175 | Coordinate bounded-history reads, owner tasks and restoration |
| `app/src/core/lifecycle-operations.cjs` | 845 → 878 | Persist scheduling suppression and explicit resume |
| `renderer/src/Composer.tsx` | 1564 → 1580 | Locate a worker's original TaskRun through the owner task catalog |
| `renderer/src/Messages.tsx` | 1561 → 1718 | Preserve reading anchors while loading earlier history |
| `renderer/src/TaskCenter.tsx` | 2356 → 2380 | Observe task-directory revisions and shared owner activation |

Before pushing a GUI/Core integration branch, fetch the actual target ref, prepare locked dependencies, and run `make check-changed CI_BASE=upstream-readonly/main`. Full local validation remains available through `make ci-preflight CI_BASE=upstream-readonly/main`. The shared plan includes applicable Rust/SDK, schema, static checks, production builds and budgets, Portable/Core contracts, native checks, and Electron smoke paths. General GUI checks use Node 24.22.1; Relay contracts use Node 24.2.0, selectable locally through `AREAL_RELAY_NODE_BIN`. Full local validation runs all applicable checks for its platform; quick checks still list the remaining full-validation checks. Linux containers and other platforms remain required remotely and do not count as local passes.

Quick checks run one Portable production build and bundle budget. Independent Relay and macOS builds and the native helper remain in full validation. Quick checks include `mobile-types`; the full `mobile` group runs Relay installation and `mobile-browser`. The GUI process uses Node 24.22.1. Set `AREAL_RELAY_NODE_BIN` to Node 24.2.0 for the Relay subprocess; the runner passes it to the fixture as `AREAL_RELAY_NODE`. Mobile browser checks require the locked Playwright Chromium and WebKit. Chrome availability does not satisfy those requirements. A type failure does not prevent the independent browser scenario from collecting results.

`test:composer-files` is an independently required file-reference smoke. The ordinary `test:composer` retains input and IME coverage. The same-attempt `GUI gate` requires both mobile browser and file-reference results, rejecting omissions, incorrect platforms, and old attempts. Push hooks fix execution arguments so inherited `ARGS=--plan` cannot skip quick checks.

Use the project toolchain locally: `export PATH="$PWD/.venv/bin:$PWD/.local/tools/node/bin:$PATH"`. Git commit and push hooks automatically prefer these repository tools in this order, without requiring terminal activation. Keep Python in `.venv` and extract the official Node 24.22.1 distribution into `.local/tools/node` (executable: `.local/tools/node/bin/node`); both directories are Git-ignored. When repository tools are absent, hooks use the caller's PATH; capability probes still block unsupported versions explicitly. Capability probes require Python 3.11 or newer with `tomllib` and tar extraction filters; missing support blocks execution early. Cargo owns rebuilding within the mutable verify/native target directory. Artifact hash freezing applies to GUI bundles published across jobs, whose consumers still recheck every recorded file hash.

Local execution and CI run the same plan through `scripts/ci-preflight.py --groups <group>`; `--plan` only displays it. `make ci-gui-static CI_BASE=<ref>` runs the Portable commit phase, `make ci-gui-portable CI_BASE=<ref>` runs the full Portable group, and `make ci-core-contracts CI_BASE=<ref>` includes Core artifact dependencies. `make ci-gui-health` retains its lightweight health entry. An explicit `AREAL_CORE_BIN` must hash-match the freshly built Core; prepare macOS native execution through the fixed artifact procedure. CI accepts cross-job dependency reports only within the same run/attempt and rechecks artifact hashes. The final gate independently regenerates the plan and verifies exact check/child-test sets and source/plan/run/attempt identity; missing results and unexpected skips fail.

`gui-health.mjs --check --base=<ref>` identifies overruns already present in the base source while retaining failures against the reviewed `health-baseline.json`. Inherited classification provides attribution, not an automatic waiver; explicit exceptions and baseline changes retain their existing review requirements. Model-menu smokes open the stable `composer-model-trigger`, select the native radio in its provider tab, and verify the selected model and subsequent behavior.

The `Track red main` workflow tracks push results for `Verify` and `GUI checks` on main. Before mutating an issue, it checks the current main commit, the workflow's latest run/attempt, and its terminal state. Stale notifications and unfinished newer attempts do not change alerts. Current failures create or update the workflow issue; current successes close it. Repository protection rules own required-check settings. `python3 -m unittest scripts.tests.test_ci_contracts` uses offline responses at the GitHub CLI boundary to cover out-of-order completion, stale attempts, unfinished runs, and API read failures without modifying real issues.

Run `make hooks-install CI_BASE=upstream-readonly/main` to activate local hooks. Installation saves the actual remote target and preserves other hook configurations. The commit hook validates the staged manifest, generates `target/ci/staged-plan.json`, then checks formatting and workflows; displaying a plan is not execution evidence. The push hook requires the pushed SHA to equal HEAD, clean tracked files, and no nonignored untracked inputs, then fetches the target and runs affected quick checks plus unsuccessful checks and their dependencies. Use a separate clean worktree for concurrent work. `make workflow-lint` uses SHA-256-verified actionlint 1.7.12. Remote CI independently executes applicable checks. Real providers, devices, and signed packages retain separate acceptance.

`pnpm --dir clients/gui test:macos-dmg` separately exercises signed framework staging with real `codesign` and `hdiutil` on macOS. Run it where disk-image device access is permitted; a restricted agent sandbox may return `Device not configured`. Record that as an environment failure and rerun the same test in the permitted host environment. Do not skip assertions or report package acceptance. The macOS GUI job runs this check explicitly; portable `verify` does not create disk images.

GUI CI builds Core and the renderer once. After the build job completes, the ten native Core contracts and GUI smoke jobs consume the same artifact in parallel, each verifying its source SHA and executable components. The GUI gate waits for both groups; failures, cancellations and unexpected skips cannot pass. Core contract logs, reports and isolated temporary directories are archived separately. Historical compatibility, migration, Composer, model selection, queue, conversation derivation, and Side chat run through the manifest in separate isolated matrix jobs (up to six concurrently, `fail-fast: false`). The same-run artifact preserves executable modes in a tar archive and records the exact checkout SHA; smoke jobs reject a different checkout. Locked pnpm/Electron/FFmpeg downloads are cached. Build caches can now save after a successful build even if a later smoke fails. Reports and cross-job artifacts belong to one workflow attempt; rerun the complete workflow when necessary, because passing records or artifacts from an older attempt cannot satisfy the new gate. Missing artifacts, failed/canceled/unexpectedly skipped smoke jobs still fail the gate; no `continue-on-error` is used.

Restoration deduplication belongs to the project, Thread, and Core connection generation; a rebuilt adapter cannot reuse an old generation's completed or failed attempt. `thread-restoration-ui-smoke.mjs` reproduces this boundary in the built renderer with controlled Desktop projections while preserving unknown submissions without replay.

Confirmed send refusals belong to Composer and clear after later acceptance; global notices still retain genuinely unconfirmed or admitted outcomes.

Conversation derivation smoke uses `desktop-contract` command validation and read/mutation semantics with project/Thread ownership to verify observations during draft bring-back, rather than maintaining a separate read-only RPC whitelist. It retains all raw commands and the transport mutation flag, and still checks unchanged model-request counts, Turn counts, and workspace bytes.

Capacity/cancellation fixtures keep deliberately held SSE streams active with protocol comments and clear heartbeat timers on release or disconnect; silent streams remain appropriate for idle-timeout tests.

Model-retention checks compare the Core configuration revision and selected model, parameters, profile, options, and Skills instead of serializing the entire effective snapshot, which also contains derived metadata. Smoke cleanup bounds Electron close; a failed close terminates only the child returned by that fixture launch, keeps the test failed, and proceeds to generation-checked Core cleanup instead of leaving Node alive until the job timeout.

`make test` uses Cargo `--no-fail-fast` to collect failures across workspace test targets before returning a failing exit code; assertions and job timeouts remain enforced. Broad Core/protocol/storage integrations still require the applicable Rust behavior suites in full remote validation; `ci-preflight` can also run them locally in advance. The portable CI lane excludes `areal-runtime-exec-native`; the dedicated native/container lanes remain required.

`make script-test` needs no product binary. `make launcher-test` builds the workspace before the real Rust launcher regressions; a missing binary fails direct suite execution. `make verify` runs both. Run the inexpensive privacy and trajectory polling regressions with `pnpm --dir clients/gui test:regressions`; `make gui-install` prepares both Electron and FFmpeg.

The Verify aggregate requires host, container and dependency audit success. GUI gate and Release gate run for every PR. Release gate checks local packaging contracts; complete packaging and publication are local release operations. GUI jobs may be skipped only after a successful scope decision declares them inapplicable. Failures, cancellations and unexpected skips fail. Recommended required checks are these three stable aggregates; conditional matrix names should not be required. Maintainers must separately approve and apply branch protection settings; repository tools do not change them.

Audits independently scan Cargo, three npm lockfiles and the GUI pnpm lockfile. Vulnerability hits and scanner errors are distinct failures. RustSec revision and reports are retained for seven days; the live npm database has no immutable revision. A weekly lightweight audit installs cargo-audit without its tool cache, without daily full macOS/GUI runs. Tool versions and lockfile fingerprints omit credentials and environment variables.


## Codex plugins P0

Run `make build` and `make gui-build` from the repository root first. `node scripts/plugin-p0-smoke.mjs` uses real shared Core, CLI, authenticated RPC and deterministic local inference to verify original-package discovery/installation, source digest drift, contained shared resources, scope/revocation, deduplicated setup, lost-response receipt lookup and service restart. `pnpm --dir clients/gui test:plugins` uses isolated Electron/Core state for catalog→install→setup→open chat→disable/enable→uninstall. It injects setup response loss at the Main-to-renderer boundary and recovers through the real Core receipt without replay. Scripts print artifact directories and manifests with binary and modified source hashes.

Package and Engine integration: `cargo test --locked -p areal-plugins --test store -p areal-engine --test codex_plugins --test skills --test agents --test queue_transfer`. These cover filesystem/installation transactions and session/Turn authority and lifecycle respectively. They do not establish real-provider, signed-package, physical-input or cross-platform acceptance; see the [implementation plan](codex-plugins-plan.en.md) for later scope.

For installation/update changes, `make script-test` includes synthetic complete-bundle transactions, source-gate checks in an independent Git repository, and GUI updater controller regressions without Electron. These cover interrupted downloads, checksum/version failures, service preservation, failed entry commits, installer exclusion, unchanged user data, native-staging timeout, and no replay after unknown acceptance. Simulated transport errors do not validate real signed replacement. Local release qualification runs `scripts/install-smoke.py` with a real isolated shared service kept running. Use isolated package copies with `test:update` and synthetic `test:history-compat` for adjacent formal releases, replacement/reopen and data preservation as applicable; unit tests do not replace Gatekeeper, Finder launch or human permission acceptance.

Network regressions cover summary recovery in persistent and bounded modes, unchanged input after transient stream loss, the five-retry ceiling despite generic completion allowances, exactly-once confirmed mutations, and independent disable/environment precedence. Exhausted bounded recovery retains all observed usage and remains a failure.

## Repository lint rules

GUI repository rules live in `clients/gui/oxlint-plugin-areal` and load through lint.jsPlugins in vite.config.mts. `pnpm --dir clients/gui check` continues checking changed files only. Set `AREAL_CHECK_BASE=<base-sha>` for CI or branch validation. Explicit check:all includes legacy violations; do not blanket-suppress them.

To add a rule, use @oxlint/plugins defineRule under rules/, explain the problem and alternative in its diagnostic, register it in index.ts, and set severity/path scope in vite.config.mts. Add valid and invalid source cases to rules.test.ts, asserting the real oxlint subprocess exit status and rule name. Run `pnpm --dir clients/gui test:unit oxlint-plugin-areal/rules.test.ts`. Do not add an ESLint runtime. Suppressions require an inline `-- reason` or an immediately preceding standalone explanatory comment.

Use `@areal/ui/observe-resize` for size notifications and its cleanup function on effect unmount. That helper owns native construction; the incremental gate constrains added or changed call sites, while legacy callers have not been migrated in bulk. `pnpm --dir clients/gui test:resize-observer` compares native/shared React commit timing in isolated Chrome and checks disconnect. It does not establish that every layout jump is fixed.

The accessibility-specific scan collects only its four JSX-a11y rules and leaves repository-plugin diagnostics to the regular changed-file check. Run both checks separately so legacy repository-rule findings do not enter the accessibility baseline. Rule examples and changed-file enforcement must still pass.
