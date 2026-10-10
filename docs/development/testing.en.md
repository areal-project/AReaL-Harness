[中文](testing.md) | **English**

# Testing

Install dependencies using the [development guide](README.en.md). Regular tests use temporary directories, dynamic loopback ports and deterministic models without real model credentials.

| Entry point | Coverage |
|---|---|
| `make verify` | Cordis pin, formatting, static checks, Rust workspace, both SDKs, Python, documentation and TUI smoke |
| `make script-test` | Launcher, Web reasoning/wait/cancel projections, benchmark statistics/evidence and documentation links/language pairs |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | Concurrency primitives |
| `make verify-runtime` | Runtime unit tests and real file, process, permission and shutdown smoke |
| `make verify-harness` | verify followed by Runtime, complete Harness, desktop API and Workgroup smoke |
| `make verify-native` | macOS native backend tests and Harness integration smoke; common checks are covered by `make verify` |
| `make examples-desktop-api` | [Direct API, CLI, Skills and relocated packaged binaries](../examples/desktop-api.en.md) |
| `make workgroup-smoke` | Private Runtime writes, combined verification, command deadlines and failure settlement |

Snapshot format changes require `make verify-harness`: Harness and plugin smoke check the written version, and desktop relocation tests compare the release manifest, `areal/server/status.stateVersion`, and actual snapshot versions.

macOS native smoke tests require Seatbelt; Linux native smoke tests require `/usr/bin/bwrap` and user namespaces. Neither platform may substitute unsandboxed execution when the capability is missing. `outer-container-perf` remains validated in controlled containers. Default `cargo test` excludes explicitly ignored native Workgroup and capacity cases.

Linux host checks use `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`. Native backend tests require `/usr/bin/bwrap` and user namespaces; a separate CI job builds the Dockerfile's `runtime-tests` target and runs every backend test, including `outer-container-perf`, inside the controlled Bubblewrap container. Excluding the backend alone does not complete validation.

## GUI and desktop route gates

`cargo test --locked -p areal-app-server --lib desktop_registered_methods_have_dispatch_routes` sends non-object parameters for every registered desktop RPC through the real connection dispatcher and requires an invalid-parameters error rather than method-not-found. It includes `areal/thread/start`, handled separately by the connection. The check runs with `make test-protocol`, `make test` and CI without starting model requests or creating Threads.

[GUI CI](../../.github/workflows/gui.yml) runs on GUI, Core, Runtime, schema and related build configuration changes. It installs frozen dependencies, checks GUI types and public boundaries, builds Core/GUI, checks routes, and runs the existing `make gui-smoke`, `test:composer` and `test:queue`. The three smoke scripts run sequentially with isolated directories and deterministic local models. Logs, screenshots and source manifests are uploaded as CI artifacts; they do not establish real-provider or packaged-app acceptance.

Composer and queue smoke share navigation and narrow-window steps in `clients/gui/scripts/smoke-navigation.mjs`: hover the project before creating a conversation, return through a stable task ID, and collapse the sidebar before resizing and waiting for the editor. Failures retain a full-window `failure-window.png` and `failure-state.json` with the original error, viewport, selected project/Thread and visible text. Unavailable pages or screenshots are recorded as capture errors without replacing the original test failure.

## Python and scratch

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

Request-budget tests cover `MAX_MODEL_ROUNDS` classification when Chat Completions or Responses returns tools in the final round, with no tool execution or retries and the original budget audit preserved. Ordinary tool-call budget exhaustion and invalid indices must retain their own classifications. Desktop CLI acceptance also checks the corresponding `error_max_turns` result. Goal HTTP regressions verify that output-token caps and tool count/buffer budgets survive shared pools, while unknown usage from failed requests prevents retries and tool execution.

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

## CI and contracts

macOS and Linux host checks share one matrix definition. `fail-fast: false` ensures a failure on one platform does not cancel coverage on the other. macOS uses `make setup-node` for native smoke and SDK Node dependencies; Linux `make setup` continues to install all locked formatting tools. Native validation runs Runtime, Harness, desktop API and Workgroup smoke in one child Make invocation, sharing one workspace build. Docker copies only the required CLI/TUI/Web clients and excludes GUI from its build context. All existing checks and tests remain.

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

`cargo test --locked -p areal-app-server --test browser_auth` verifies automatic login from the trusted client through real HTTP/WebSocket endpoints, concurrent single-use exchange, Origin validation, instance isolation, inherited permissions, manual login and connection closure at session expiry. Unit tests in that crate use virtual time for code/session expiry and capacity limits. `node --test scripts/web-progress.test.mjs` checks fragment removal before exchange, connection after success, manual fallback on failure and ordinary reloads.

The PTY helper continuously drains terminal output while waiting for CLI commands, service shutdown and window exit, preventing terminal backpressure from blocking the TUI. `make script-test` includes a deterministic regression that writes more than the PTY capacity before exiting.

TUI and shared-service PTY checks share a terminal screen parser that preserves unchanged characters during incremental redraws and handles split UTF-8/control sequences. Model reload checks wait for the new model name in the header, then verify that the service generation has not changed; they do not depend on raw output bytes or transient status notifications.

`cargo test --locked -p areal-engine --test model_reload` verifies that active children and queued requests retain their model while new submissions follow the updated default; busy `ifIdle` drain must leave admission open. Local service smoke also covers invalid edits, queue recovery across restart, workspace selectors and idle restart after limits change.

## Task Mode regression coverage

`cargo test --locked -p areal-engine --test task_modes` covers independent work during asynchronous questions, Channel replies and same-Run resumption, wakeup when one question expires while another remains pending, headless questions/approvals, durable scheduling, asynchronous foreground Goal questions, workers surviving coordinator Turns with shared budgets, cancellation cleanup and reply deduplication across restart. app-server unit coverage validates Task requests/responses/notifications against generated schemas, Thread authorization filtering and independent subscriptions/unsubscriptions.

`node examples/desktop-api/run.mjs task-matrix` uses real binaries and Runtime to verify headless ordinary conversations/Goals reject questions and approvals while continuing permitted commands, create no implicit schedules, resume asynchronous foreground Goals after disconnection, trigger/control schedules, and account for independent worker file artifacts. `node --test scripts/web-progress.test.mjs` checks wait states, selected later-page tasks, rejection of stale revisions, Inbox drafts and idempotent reply retries after timeouts. See the [desktop examples](../examples/desktop-api.en.md#web-validation) for actual browser validation.

Unified CLI parsing and configuration process regressions live in `clients/cli`, covering default TUI, exec, legacy -p, argument conflicts and side-effect-free diagnostics. Launcher tests dispatch Core and TUI through one areal fixture. Desktop CLI checks exercise both exec and legacy arguments; relocated bundle checks require areal as the only bin entry and verify the internal Runtime paths.

## Live context continuity

After building, run `node scripts/context-live-smoke.mjs /absolute/model.toml` with an explicitly chosen real model configuration. This incurs model usage. The script creates isolated workspace/state directories, submits task revisions, compacts three times, restarts Core, finishes a Goal with real reads/writes and a command, and independently checks every output field and an unchanged accepted artifact. Its JSON report records cache usage without treating unknown usage as zero. Use a small test-only byte window (20,000), recent budget (4,096), and `context_target_tokens=16000` to exercise compaction; do not copy these stress settings into production. The script does not restart production sessions. An optional second argument selects a new report directory. Reports separate `functionalVerified`, valid model summaries and summary failures. Evidence fallback does not substitute for three valid model summaries; any summary failure makes the script exit nonzero. Set `AREAL_CONTEXT_LIVE_BIN_DIR` to a frozen binary directory to use the same candidate across the restart.

For slow tools, enable `areal::tool_timing=debug,areal::persistence=debug` in the logging filter. Tool stages distinguish intent persistence (including lock/clone), invocation, projection and final commit. Persistence distinguishes encoding, IO admission, file write and sync/rename. No arguments, file contents or credentials are added to these timing events. Single encoding retains the same durable-before-execution ordering and file/directory sync.

Search regressions run the Runtime file helper directly, covering search without host rg/Python, workspace ignore rules, globs, context, truncation and symlink rejection. Native and release smoke tests exercise the complete Core `search_files` path without requiring rg in the shell.

Desktop soak and GUI bundle validation accept the embedded-search layout without standalone tools/rg. Soak also verifies the platform-specific Runtime components and manifest file hashes.
