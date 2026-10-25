[中文](testing.md) | **English**

# Testing


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
| `make unified-execution-smoke` | Unified model tools, parallel isolated candidates, composed delivery, ownership checks, cancellation and restart recovery |

Snapshot format changes require `make verify-harness`: Harness and plugin smoke check the written version, and desktop relocation tests compare the release manifest, `areal/server/status.stateVersion`, and actual snapshot versions.

Real PTY smoke tests reconstruct incremental output with a terminal-cell emulator. Wide characters also overwrite the adjacent cell so stale characters cannot produce false Unicode-editing failures. Script unit tests cover this redraw boundary.

`tui-upgrade-smoke` does not build or deploy artifacts. Prepare complete, immutable old and new binary directories, using an old version that cannot read the new state format. The script isolates home, workspace, state and model endpoint. It submits messages through real old and new TUIs, explicitly restarts the service to activate the new version, then resumes the still-open old TUI and triggers reconnect. Across multiple retry periods it checks the new Host/Core PIDs, generation, state format and a subsequent reply. Use `--evidence /absolute/output` to retain terminal screens, command logs, source and bundle identities, and cleanup results; evidence defaults to a temporary directory. This check does not run the installer or replace `upgrade-smoke`, package validation or real-provider acceptance.

macOS native smoke tests require Seatbelt; Linux native smoke tests require `/usr/bin/bwrap` and user namespaces. Neither platform may substitute unsandboxed execution when the capability is missing. `outer-container-perf` remains validated in controlled containers. Default `cargo test` excludes explicitly ignored native Workgroup and capacity cases.

Linux host checks use `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`. Native backend tests require `/usr/bin/bwrap` and user namespaces; a separate CI job builds the Dockerfile's `runtime-tests` target and runs every backend test, including `outer-container-perf`, inside the controlled Bubblewrap container. It also enables `areal-runtime/native-tests` and runs the daemon's `native_transport` target. That target starts the real daemon over private stdio with the complete Runtime bundle, so Linux resolves the reaper beside the daemon. Its native sandbox test keeps the ordinary-command/hook progress and foreign-writer exclusion assertions; the four portable transport tests remain in the default suite. `make verify-native` builds the bundle before explicitly running the same native target on macOS. The feature selects this test target only and changes no production behavior. Excluding native tests from the portable host lane alone does not complete validation.

## GUI and desktop route gates

`cargo test --locked -p areal-app-server --lib desktop_registered_methods_have_dispatch_routes` sends non-object parameters for every registered desktop RPC through the real connection dispatcher and requires an invalid-parameters error rather than method-not-found. It includes `areal/thread/start`, handled separately by the connection. The check runs with `make test-protocol`, `make test` and CI without starting model requests or creating Threads.

[GUI CI](../../.github/workflows/gui.yml) runs on GUI, Core, Runtime, schema and related build configuration changes. It installs frozen dependencies, checks GUI types and public boundaries, builds Core/GUI, checks routes, and runs the existing `make gui-smoke`, `test:composer` and `test:queue`. The three smoke scripts run sequentially with isolated directories and deterministic local models. Logs, screenshots and source manifests are uploaded as CI artifacts; they do not establish real-provider or packaged-app acceptance.

Composer and queue smoke share navigation and narrow-window steps in `clients/gui/scripts/smoke-navigation.mjs`: hover the project before creating a conversation, return through a stable task ID, and collapse the sidebar before resizing and waiting for the editor. Failures retain a full-window `failure-window.png` and `failure-state.json` with the original error, viewport, selected project/Thread and visible text. Unavailable pages or screenshots are recorded as capture errors without replacing the original test failure.

In the model-selection smoke, only settings-operation settlement after applying model configuration uses a 180-second deadline, covering the existing 150-second apply IPC, subsequent configuration reads and UI settlement. Other page actions retain the default 15 seconds. The test submits apply once, waits for navigation to become available, then checks the actual Core model catalog and requests; it does not hide failures with fixed sleeps or replayed applications.

Independent CLI configuration reads, service stop and status queries in the desktop connection smoke use the product `executeCore` launch bridge. On macOS the system Python remains the actual parent of native Core; tests do not substitute direct Node launches for the product entry point. Disconnect recovery still checks the original Turn, subscriptions and request count without replaying submissions.

## Usage analytics history sync

`node --test scripts/analytics-history.test.cjs` uses the real `CoreClient` and a local WebSocket protocol fixture to verify that the dedicated read-only history connection's 4 MiB frame limit does not close the primary project connection. It also covers startup before the model connects, identity changes, history deduplication, partial caches, handshake/RPC timeouts, and cleanup with partial-history errors after primary closure. The analytics connection only initializes, negotiates capabilities, and calls `thread/read`, using the client's default request deadlines; each project has at most one sync in progress. Large-history failures remain partially synced and do not establish complete history coverage. This test does not replace real Core, native GUI, installed-package, or provider acceptance.

## Python and scratch

Failure state and screenshot capture each wait at most 10 seconds; derivation Electron cleanup waits at most 20 seconds. Timeouts enter the evidence without replacing the original failure. CI limits the derivation step to 10 minutes so failed diagnostics cannot block subsequent artifact upload. `make script-test` verifies diagnostic deadlines and propagation of original errors.

Continuous derivation video requires the FFmpeg build pinned by Playwright; installing Electron/npm packages alone is insufficient. GUI CI installs it with `pnpm --dir clients/gui --filter @areal/gui-desktop exec playwright-core install ffmpeg`. Run the same command locally before the first invocation of this smoke.

A full-view Side uses its own Composer. The main draft stays mounted but hidden so its floating actions cannot cover Side model selection or submission; split view still shows both Composers. Derivation smoke checks Side model selection and first-question submission through actual clicks and verifies retention of the main draft.

Linux reaping tests use `areal-runtime-reaper`, built by `cargo test -p areal-runtime-exec-native`. For a standalone `--lib` run, first run `cargo build --locked -p areal-runtime-exec-native --bin areal-runtime-reaper` with the same profile as the tests. macOS descendant tests keep ancestors alive through the tracking window before exit to verify cleanup of observed descendants; they do not establish a complete guarantee against rapid orphaning.

Independent macOS Python/scratch regression (local model, no provider credentials):

```sh
python3 scripts/native-python-smoke.py --bin-dir target/debug
```

`make harness-smoke` (called by `make verify-native` in macOS CI) includes this regression. It checks automatic scratch and a custom `--scratch` under both default YOLO and the explicit native sandbox: both expose `verify_command` and save verification receipts with exit codes 0 and 7 in a private per-thread directory. Shared resolver tests cover installed CLT without a `developer_dir` link and reject interpreters outside supported frameworks.

`make workgroup-smoke` also verifies that Worker commands receive a writable `TMPDIR` at `.scratch/agent-<threadId>` inside their private workspace, with Python bytecode writes disabled.

## Recovery and research agents

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

`harness-smoke.mjs` checks root/nested `AGENTS.md` ordering, unrelated-directory isolation, missing files, per-Turn refresh, the 32 KiB boundary, UTF-8 and symlink rejection through real Core/Runtime model requests.

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

Before pushing a GUI/Core integration branch, run `make ci-preflight CI_BASE=upstream-readonly/main` after fetching the target remote and preparing locked dependencies with `make setup` and `make gui-install`. Set `CI_BASE` to the actual PR target; its merge base drives the same incremental design and copy audits as CI. This entry reuses formatting, Rust/Python static checks, documentation, GUI types/public checks, fast regressions, browser contracts and the live GUI dependency audit. It does not launch the product and does not replace Rust integration, Linux portability, Electron user paths or full lockfile auditing. Portable Node fixtures must use `node:os` temporary directories; WebSocket substitutes must complete the real `send(data, callback)` contract so backpressure cannot silently stall later messages.

`pnpm --dir clients/gui test:macos-dmg` separately exercises signed framework staging with real `codesign` and `hdiutil` on macOS. Run it where disk-image device access is permitted; a restricted agent sandbox may return `Device not configured`. Record that as an environment failure and rerun the same test in the permitted host environment. Do not skip assertions or report package acceptance. The macOS GUI job runs this check explicitly; portable `verify` does not create disk images.

GUI CI builds Core and the renderer once, then runs historical compatibility, migration, Composer, model selection, queue, and conversation derivation in separate isolated matrix jobs (up to three concurrently, `fail-fast: false`). The same-run artifact preserves executable modes in a tar archive and records the exact checkout SHA; smoke jobs reject a different checkout. Locked pnpm/Electron/FFmpeg downloads are cached. Build caches can now save after a successful build even if a later smoke fails. Retry only failed smoke jobs and their gate with `gh run rerun <run-id> --failed`; passing build and smoke jobs are reused. Missing artifacts, failed/canceled/unexpectedly skipped smoke jobs still fail the gate; no `continue-on-error` is used.

Restoration deduplication belongs to the project, Thread, and Core connection generation; a rebuilt adapter cannot reuse an old generation's completed or failed attempt. `thread-restoration-ui-smoke.mjs` reproduces this boundary in the built renderer with controlled Desktop projections while preserving unknown submissions without replay.

Confirmed send refusals belong to Composer and clear after later acceptance; global notices still retain genuinely unconfirmed or admitted outcomes.

Conversation derivation smoke uses `desktop-contract` command validation and read/mutation semantics with project/Thread ownership to verify observations during draft bring-back, rather than maintaining a separate read-only RPC whitelist. It retains all raw commands and the transport mutation flag, and still checks unchanged model-request counts, Turn counts, and workspace bytes.

Capacity/cancellation fixtures keep deliberately held SSE streams active with protocol comments and clear heartbeat timers on release or disconnect; silent streams remain appropriate for idle-timeout tests.

Model-retention checks compare the Core configuration revision and selected model, parameters, profile, options, and Skills instead of serializing the entire effective snapshot, which also contains derived metadata. Smoke cleanup bounds Electron close; a failed close terminates only the child returned by that fixture launch, keeps the test failed, and proceeds to generation-checked Core cleanup instead of leaving Node alive until the job timeout.

`make test` uses Cargo `--no-fail-fast` to collect failures across workspace test targets before returning a failing exit code; assertions and job timeouts remain enforced. For broad Core/protocol/storage integrations, complete the applicable Rust behavior suites as well as `ci-preflight` before pushing. The portable CI lane excludes `areal-runtime-exec-native`; the dedicated native/container lanes remain required.

`make script-test` needs no product binary. `make launcher-test` builds the workspace before the real Rust launcher regressions; a missing binary fails direct suite execution. `make verify` runs both. Run the inexpensive privacy and trajectory polling regressions with `pnpm --dir clients/gui test:regressions`; `make gui-install` prepares both Electron and FFmpeg.

The Verify aggregate requires host, container and dependency audit success. GUI gate and Release gate run for every PR. Release gate checks local packaging contracts; complete packaging and publication are local release operations. GUI jobs may be skipped only after a successful scope decision declares them inapplicable. Failures, cancellations and unexpected skips fail. Recommended required checks are these three stable aggregates; conditional matrix names should not be required. Maintainers must separately approve and apply branch protection settings; repository tools do not change them.

Audits independently scan Cargo, three npm lockfiles and the GUI pnpm lockfile. Vulnerability hits and scanner errors are distinct failures. RustSec revision and reports are retained for seven days; the live npm database has no immutable revision. A weekly lightweight audit installs cargo-audit without its tool cache, without daily full macOS/GUI runs. Tool versions and lockfile fingerprints omit credentials and environment variables.


## Codex plugins P0

Run `make build` and `make gui-build` from the repository root first. `node scripts/plugin-p0-smoke.mjs` uses real shared Core, CLI, authenticated RPC and deterministic local inference to verify original-package discovery/installation, source digest drift, contained shared resources, scope/revocation, deduplicated setup, lost-response receipt lookup and service restart. `pnpm --dir clients/gui test:plugins` uses isolated Electron/Core state for catalog→install→setup→open chat→disable/enable→uninstall. It injects setup response loss at the Main-to-renderer boundary and recovers through the real Core receipt without replay. Scripts print artifact directories and manifests with binary and modified source hashes.

Package and Engine integration: `cargo test --locked -p areal-plugins --test store -p areal-engine --test codex_plugins --test skills --test agents --test queue_transfer`. These cover filesystem/installation transactions and session/Turn authority and lifecycle respectively. They do not establish real-provider, signed-package, physical-input or cross-platform acceptance; see the [implementation plan](codex-plugins-plan.en.md) for later scope.

For installation/update changes, `make script-test` includes synthetic complete-bundle transactions, source-gate checks in an independent Git repository, and GUI updater controller regressions without Electron. These cover interrupted downloads, checksum/version failures, service preservation, failed entry commits, installer exclusion, unchanged user data, native-staging timeout, and no replay after unknown acceptance. Simulated transport errors do not validate real signed replacement. Local release qualification runs `scripts/install-smoke.py` with a real isolated shared service kept running. Use isolated package copies with `test:update` and synthetic `test:history-compat` for adjacent formal releases, replacement/reopen and data preservation as applicable; unit tests do not replace Gatekeeper, Finder launch or human permission acceptance.

Network regressions cover summary recovery in persistent and bounded modes, unchanged input after transient stream loss, the five-retry ceiling despite generic completion allowances, exactly-once confirmed mutations, and independent disable/environment precedence. Exhausted bounded recovery retains all observed usage and remains a failure.
