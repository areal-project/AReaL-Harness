[中文](testing.md) | **English**

# Testing

Install dependencies using the [development guide](README.en.md). Regular tests use temporary directories, dynamic loopback ports and deterministic models without real model credentials.

| Entry point | Coverage |
|---|---|
| `make verify` | Cordis pin, formatting, static checks, Rust workspace, both SDKs, Python, documentation and TUI smoke |
| `make script-test` | Launcher, benchmark statistics/evidence and documentation links/language pairs |
| `make test-core` / `make test-protocol` | Engine / app-server |
| `make test-concurrency` | Concurrency primitives |
| `make verify-runtime` | Runtime unit tests and real file, process, permission and shutdown smoke |
| `make verify-harness` | verify followed by Runtime, complete Harness, desktop API and Workgroup smoke |
| `make examples-desktop-api` | [Direct API, CLI, Skills and relocated packaged binaries](../examples/desktop-api.en.md) |
| `make workgroup-smoke` | Private Runtime writes, combined verification, command deadlines and failure settlement |

Native smoke tests require macOS Seatbelt; never substitute unsandboxed execution for a failure. Linux CI uses controlled containers. Default `cargo test` excludes explicitly ignored native Workgroup and capacity cases.

Linux host checks use `make verify CARGO_TEST_ARGS='--exclude areal-runtime-exec-native'`. Native backend tests require a container boundary; CI then builds the Dockerfile's `runtime-tests` target and runs every backend test inside the controlled Bubblewrap container. Excluding the backend alone does not complete validation.

## Recovery and research agents

```sh
cargo test --locked -p areal-engine --test truncated_usage --test http_model --test context --test tools --test async_agents --test recovery
python3 -m unittest discover -s scripts/tests
python3 scripts/native-tools-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
python3 scripts/native-agents-smoke.py --bin-dir target/debug --sandbox-profile outer-container-perf
```

Native tools/agent smoke tests use a local fixed-response HTTP model, the standard launcher and temporary workspaces without external model services. They cover file CAS, search, verification receipts, images, no delegation, a single Worker, synchronous waits, budget failures, parent cancellation and default asynchronous dispatch. The asynchronous case requires parent progress before three Worker requests finish and checks parent/child sampling parameters. Stream tests cover same-frame/tail length usage, EOF/cancellation, no UNKNOWN replay, post-compaction handles and cross-Turn boundaries.

Linux requires Bubblewrap user/PID namespaces, seccomp, Python, Bash and rg. The public Dockerfile provides the toolchain:

```sh
docker build -f tests/e2e/docker/Dockerfile \
  --build-arg INSTALL_CODEX=0 --build-arg INSTALL_CLAUDE_CODE=0 \
  -t areal-native-smoke .
for smoke in native-tools-smoke native-agents-smoke; do
  docker run --rm --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined \
    --mount "type=bind,source=$PWD,target=/repo,readonly" -w /repo \
    --entrypoint python3 areal-native-smoke \
    "scripts/$smoke.py" --bin-dir /usr/local/bin --sandbox-profile outer-container-perf
done
```

Outer-container relaxations apply only to the explicitly selected controlled profile; commands still run inside Bubblewrap. macOS `/usr/bin/python3` may access unauthorized Xcode-selector configuration; do not widen the sandbox automatically for smoke tests. TUI reconnect smoke waits for a `live` subscription before submitting: an open connection and visible cached history do not establish an authoritative restored snapshot.

## Capacity

| Command | Load |
|---|---|
| `make capacity-primitives` | Progress and cancellation of 20,000 asynchronous tasks |
| `make capacity-core` | 10,000 child agents with real persistence and controlled model permits |
| `make capacity-workgroup` | 32 real Runtimes, isolated writes and combined checks; requires macOS |

`make capacity` runs these sequentially; regular verification excludes them. Report hardware, build mode, storage and model fixtures. These figures do not measure real LLM throughput.

## CI and contracts

[CI](../../.github/workflows/ci.yml) runs native Harness checks on macOS, portable regression and Docker sandbox/file-ownership checks on Linux, and separate Rust/npm advisory checks. Actions are pinned by commit, repository permissions are read-only, and failures retain logs. Consult the run for the relevant commit for actual results.

`make schemas` updates the pinned Codex schema; `make desktop-schemas` updates desktop schemas. Update types, callers and contracts together. Local fixtures do not validate real models, GUIs, third-party daemons, signing/notarization or other platforms. See the [benchmark guide](../benchmarks/README.en.md) for performance runs.
