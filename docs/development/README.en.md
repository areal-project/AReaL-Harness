[中文](README.md) | **English**

# Development

Read the [architecture](../design/architecture.en.md) and [repository instructions](../../AGENTS.md) first. Run commands from the repository root.

## Environment

| Dependency | Requirement |
|---|---|
| Rust | 1.94.0 pinned in `rust-toolchain.toml`, including rustfmt / Clippy |
| Python / uv | Python 3.11+ for development; uv installs locked tools. The macOS product requires a working `/usr/bin/python3` (Xcode Command Line Tools); Linux product startup needs no Python; standalone installation and upgrade scripts require Python 3.9+ on PATH |
| Node.js / npm | Node.js 22.19.0+ for both SDKs and formatting tools |
| Build tools | Git, Bash, GNU Make 3.81+, C/C++ compiler and CMake; Xcode Command Line Tools on macOS |
| File search | Runtime file helper embeds ripgrep search libraries; `make build/release` has no host rg dependency |
| Native execution | macOS `/usr/bin/sandbox-exec`; Linux `/usr/bin/bwrap` plus Runtime seccomp; fixed benchmarks use the [controlled Docker profile](../benchmarks/README.en.md) |

```sh
make setup
make build
make verify
```

`setup` installs locked Cargo, npm and uv dependencies. Model fixtures require no credentials. When using a proxy, append `127.0.0.1,localhost` to existing `NO_PROXY` entries and to `no_proxy` if set.

Use `target/debug/areal` consistently for development startup and service control to avoid mixing it with the installed version on PATH:

```sh
make build
./target/debug/areal service restart
./target/debug/areal
```

Binary-only changes automatically restart an idle shared service, so manual restarts are not needed after every build. For configuration conflicts, use the complete restart command in the diagnostic. Wait for background work to settle; add `--cancel` only when cancellation is intended. If switching versions frequently, use a separate external directory for development, such as `--data-dir /tmp/areal-dev-state`, on both startup and restart; it has separate history. See [local service compatibility](../api/local-service.en.md#identity-compatibility-and-history).

## Checks

| Change | Command |
|---|---|
| Formatting | `make fmt` / `make fmt-check` |
| Static analysis | `make lint` |
| Rust / SDK / scripts | `make test` / `make sdk-test` / `make script-test` |
| Regular regression | `make verify` |
| Native integration | `make verify-harness`, including regular regression |
| Unified delegation integration | `make unified-execution-smoke`: real Runtime candidate composition, delivery receipts, parent ownership, cancellation, and recovery; included in `make harness-smoke` / `make verify-native`; Linux CI runs it in the supported container with Bubblewrap user namespaces, while `make verify` remains portable |
| CI native delta | `make verify-native`, native backend and Harness integration smoke only |
| Optional EnvArena adapter | `make envarena-check` / `make envarena-smoke`; excluded from default checks |
| Capacity | `make capacity`, run separately |
| Documentation only | `python3 scripts/check-docs.py`; also compare commands with implementation |

The unified delegation smoke defaults to `target/debug`; set `AREAL_UNIFIED_BIN_DIR` to the complete installed bundle’s `bin` directory and `AREAL_UNIFIED_EVIDENCE_DIR` to retain full Core/Runtime stderr. Independent workers always use the native sandbox. Linux requires working Bubblewrap user/mount/PID namespaces; workers do not inherit the parent launcher’s full-access mode.

`make integration-boundaries` checks that the product, release entry points and default Make dependency graph do not load optional platform adapters; `make script-test` includes it. `make envarena-check` separately maintains formatting, static checks and unit tests for adapter Python sources.

See [testing](testing.en.md) for coverage. Pass arguments with `make tui ARGS='--prompt hello'`. `make release` writes to `target/release`; `make docs` generates Rust API documentation.

`python3 scripts/tui-local-smoke.py` injects an invalid trajectory destination in an isolated real owned TUI/Runtime. It verifies that the warning does not hide request status while multi-turn, tool, cancellation, and recovery interactions continue; no export worker starts. This check is included in `make harness-smoke`. See [GUI validation](../../clients/gui/README.en.md#lifecycle) for polling, protocol projection, and actual interface checks.

The project uses [Apache-2.0](../../LICENSE). Cargo workspace and npm packages declare the same license. Both SDKs include LICENSE; `scripts/package.py` copies it into desktop bundles and records its checksum. Third-party materials retain their original licenses and copyright notices.

`make smoke` also verifies optional trajectory export: the Agent returns while the local receiver responds with 503, the independent worker drains the queue after Core exits, and disabling export stops the worker. It also covers re-enabling failed 401 records within the five-second automatic spawn throttle, the first explicit retry after killing the worker, and concurrent retries preserving one worker, serialized sends, and no duplicate acceptance. Run `node scripts/trajectory-smoke.mjs` separately; `AREAL_TRAJECTORY_FIXTURE_OUTPUT` saves real OTLP protobuf for receiver interoperability tests, containing only local fixture data. Set `AREAL_TRAJECTORY_SMOKE_OUTPUT` to save a JSON acceptance record with actual spawn timestamps, retry timing, and concurrency observations.

`node scripts/trajectory-semantics-smoke.mjs` uses a real owned Core/Runtime with local model and receiver fixtures, covering multi-round tools, child Agents, a model change between Turns in the same thread, failures, and streaming cancellation. `make smoke` includes this check. Actual HTTP model inputs and OTLP protobuf are saved to `out/trajectory-semantics/` by default; `AREAL_TRAJECTORY_SEMANTICS_OUTPUT` overrides the directory for receiver interoperability checks. The script uses isolated temporary home, state, and workspace directories without reading user configuration.

## Dependencies and style

Use Rust `--locked`; intentional upgrades update manifests and locks. Cordis also updates [pins.json](../../upstream/pins.json), following the [upgrade guide](cordis.en.md). Use `npm ci --ignore-scripts` and `uv sync --locked --only-group dev`, without transient global formatting tools. Frozen third-party tasks and oracles are excluded from bulk formatting.

Use rustfmt/Clippy for Rust, locked Prettier for TS/JS/CSS/HTML and Ruff for owned Python code. Follow `.editorconfig`. New comments explain constraints and reasons in Chinese; accurate existing English comments need no mechanical translation.

Organize documentation through the [index](../README.en.md) and update both languages together. Keep README to an introduction and navigation, APIs in `docs/api/`, and historical results in `docs/benchmarks/reports/`. Fix references when moving pages. Maintain draw.io sources together with SVG/existing PNG previews under the [diagram style guide](../design/STYLE_GUIDE.en.md).

See the [release workflow](releasing.en.md) for Homebrew/Linux artifacts, installation verification and draft publication.

## Desktop GUI

The GUI uses a separate pnpm 11.7.0 workspace. Run `make gui-install`, `make gui-build`, and `make gui-smoke`; see the [GUI guide](../../clients/gui/README.en.md) for launch, packaging and isolation.

`make setup-node` installs only locked Node development dependencies for native CI that does not run formatting checks; use `make setup` for full local development.

### RSI Artifact: one query and human selection

`/rsi-goal QUERY` explicitly creates an RSI goal with `workflow: "rsiArtifact"`; ordinary `/goal` behavior is unchanged. Phase one uses three visible, fixed Harness templates: baseline, structured, and critic-and-revise. They share one frozen workspace input and run up to three candidates concurrently through native `isolatedWrite` boundaries. Deployments without isolation reject creation rather than falling back to shared writes.

Each candidate delivers one UTF-8 `artifact.md` of at most 1 MiB; source code can be included in fenced blocks. A candidate can modify only its declared artifact path. Nothing is automatically applied to the source project. Under the Core data directory, `rsi/<goalId>/<candidateId>/` stores `request.json`, `harness.md`, `metadata.json`, and the settled `result.json`. The native execution service retains isolated workspaces, artifacts, and Runtime cleanup receipts separately. Candidate projections include the harness, status, workspace/artifact paths, summary, run/task identity, timestamps, and errors.

Both new-chat and existing idle root-chat composers accept the command; the GUI feature menu also offers “RSI 产物对比”. Candidate cards show Harness/run details, paginated artifact previews, and winner selection. In the TUI, use `/rsi-refresh`, `/rsi-artifact candidate-1 [OFFSET]`, and `/rsi-select candidate-1`; the right panel displays state and summaries; `/tasks` expands the complete candidate and artifact view. `/goal-clear` clears the current goal after candidates settle.

After all candidates settle, any successful artifact leads to `awaitingSelection`; otherwise the phase becomes `failed`. One failure does not cancel other candidates. Selection persists a winner reference without applying its artifact. Selecting the current winner again leaves the revision unchanged; stale revisions conflict. Reopening the GUI restores Core projections. A Core restart only reconciles existing executions: incomplete candidates conservatively fail and are never redispatched. Completed candidates and the winner remain available. Ordinary Turns are blocked until selection; conversation can continue afterwards.

Feedback evaluations, explicit bounded branching, and version trees are now available; see [RSI feedback branches](../guides/rsi-evolution.en.md). There are no automatic quality scores, automatic winner, or cross-task improvement claims. Templates are not an online research agent. The executor checks write scope, artifact presence, and resource settlement, not quality. Explicit token/time budgets are accepted; `inferLimits: true` and `maxTurns` are unsupported.

Acceptance commands (build the workspace and GUI first):

```bash
cargo test -p areal-engine --test rsi_goals
node scripts/rsi-goal-smoke.mjs
cd clients/gui && corepack pnpm test:rsi
```

Both smoke tests use a scripted model with actual Core/Runtime execution. The GUI test drives real Electron input, artifact reads, selection, and restarts. Set `AREAL_RSI_EVIDENCE_DIR` for receipts and screenshots. These tests validate execution contracts, not supplier model artifact quality.
