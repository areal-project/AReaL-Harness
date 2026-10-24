[中文](README.md) | **English**

# Development

Read the [architecture](../design/architecture.en.md), [repository instructions](../../AGENTS.md) and [agent improvement goals and method](agent-improvement.en.md) first. Run commands from the repository root.

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

On macOS, `make build/release` also builds standalone Bash from SHA-256-pinned sources and patches, caching it under `target/runtime-shell` and copying it to `target/<profile>/shells`. The first build requires network access, a C compiler and Python 3.11+ with tar data-filter support. `cargo build` alone does not produce these complete Runtime assets. Tasks never download a shell or replace system programs. This separate component retains GPL-3.0-or-later licensing and complete corresponding source; the project Rust code remains Apache-2.0. See [release requirements](releasing.en.md).

`python3 scripts/tool-capacity-smoke.py --report /tmp/tool-capacity.json` submits 16 file operations to a real native Runtime after two background processes occupy all slots, and checks subscription-adapter construction/closure in restricted Node. Run `make build` and `make gui-install` first. `node scripts/permission-presets-smoke.mjs` covers approval isolation with `AGENTS.md` present and concurrent `read_file`/`search_files` within one Turn. These are deterministic mechanism regressions, not evidence of overall Agent improvement.

## Checks

| Change | Command |
|---|---|
| Formatting | `make fmt` / `make fmt-check` |
| Static analysis | `make lint` |
| Rust / SDK / scripts | `make test` / `make sdk-test` / `make script-test` |
| Regular regression | `make verify` |
| Native integration | `make verify-harness`, including regular regression |
| Unified delegation integration | `make unified-execution-smoke`: real Runtime candidate composition, delivery receipts, parent ownership, cancellation, and recovery; included in `make harness-smoke` / `make verify-native`; Linux CI runs it in the supported container with Bubblewrap user namespaces, while `make verify` remains portable |
| Child permission integration | `make delegation-permissions-smoke`: real Runtime enforced read-only, early rejection when unavailable, explicit inherited reads, and parent/child read cooperation; scripted model, no capability score; included in `make harness-smoke` |
| CI native delta | `make verify-native`, native backend and Harness integration smoke only |
| Capacity | `make capacity`, run separately |
| Documentation only | `python3 scripts/check-docs.py`; also compare commands with implementation |

The unified delegation smoke defaults to `target/debug`; set `AREAL_UNIFIED_BIN_DIR` to the complete installed bundle’s `bin` directory and `AREAL_UNIFIED_EVIDENCE_DIR` to retain full Core/Runtime stderr. Independent workers always use the native sandbox. Linux requires working Bubblewrap user/mount/PID namespaces; workers do not inherit the parent launcher’s full-access mode.

To test from a fixed artifact path, build and deploy Core and Runtime from the same build, then set absolute paths: `scripts/smoke.mjs`, `scripts/trajectory-smoke.mjs`, `scripts/trajectory-semantics-smoke.mjs`, and `scripts/local-service-smoke.mjs` use `AREAL_TEST_BIN_DIR`; `scripts/tui-local-smoke.py` uses `AREAL_TEST_BIN` for the `areal` executable; GUI source tests use `AREAL_CORE_BIN`. Run the relevant scripts directly and keep artifacts unchanged during testing. These variables do not change packaged-app test entry points or grant endpoint-security execution approval.

`make integration-boundaries` checks that the product, release entry points and default Make dependency graph do not load optional platform adapters; `make script-test` includes it.

See [testing](testing.en.md) for coverage. Pass arguments with `make tui ARGS='--prompt hello'`. `make release` writes to `target/release`; `make docs` generates Rust API documentation.

For request-projection changes, also run `cargo test --locked -p areal-engine --test runtime_context_projection --test http_model` to check chronology, counters and guidance changes, guidance restoration after compaction, original user/tool content, provider reasoning and default protocol behavior. Validate this separately from capture coverage above: a stable prefix or fewer bytes cannot replace actual returned tokens, task acceptance and source-isolated comparisons.

`python3 scripts/tui-local-smoke.py` injects an invalid trajectory destination in an isolated real owned TUI/Runtime. It verifies that the warning does not hide request status while multi-turn, tool, cancellation, and recovery interactions continue; no export worker starts. This check is included in `make harness-smoke`. See [GUI validation](../../clients/gui/README.en.md#lifecycle) for polling, protocol projection, and actual interface checks.

The project uses [Apache-2.0](../../LICENSE). Cargo workspace and npm packages declare the same license. Both SDKs include LICENSE; `scripts/package.py` copies it into desktop bundles and records its checksum. Third-party materials retain their original licenses and copyright notices.

`make smoke` also verifies optional trajectory export: the Agent returns while the local receiver responds with 503, the independent worker drains the queue after Core exits, and disabling export stops the worker. It also covers re-enabling failed 401 records within the five-second automatic spawn throttle, the first explicit retry after killing the worker, and concurrent retries preserving one worker, serialized sends, and no duplicate acceptance. Run `node scripts/trajectory-smoke.mjs` separately; `AREAL_TRAJECTORY_FIXTURE_OUTPUT` saves real OTLP protobuf for receiver interoperability tests, containing only local fixture data. Set `AREAL_TRAJECTORY_SMOKE_OUTPUT` to save a JSON acceptance record with actual spawn timestamps, retry timing, and concurrency observations.

`pnpm --dir clients/gui run test:trajectory-native` checks the real desktop backend, Core, Runtime and uploader with isolated local model/receiver fixtures: enabling a Core started with capture disabled waits for active work to finish before safe restart; disabling retains failed payloads; re-enabling resumes them. These tests prove control and delivery invariants without measuring general Agent capability.

`node scripts/trajectory-semantics-smoke.mjs` uses a real owned Core/Runtime with local model and receiver fixtures, covering multi-round tools, child Agents, a model change between Turns in the same thread, failures, and streaming cancellation. `make smoke` includes this check. Actual HTTP model inputs and OTLP protobuf are saved to `out/trajectory-semantics/` by default; `AREAL_TRAJECTORY_SEMANTICS_OUTPUT` overrides the directory for receiver interoperability checks. The script uses isolated temporary home, state, and workspace directories without reading user configuration.

## Dependencies and style

Use Rust `--locked`; intentional upgrades update manifests and locks. Cordis also updates [pins.json](../../upstream/pins.json), following the [upgrade guide](cordis.en.md). Use `npm ci --ignore-scripts` and `uv sync --locked --only-group dev`, without transient global formatting tools. Frozen third-party tasks and oracles are excluded from bulk formatting.

Use rustfmt/Clippy for Rust, locked Prettier for TS/JS/CSS/HTML and Ruff for owned Python code. Follow `.editorconfig`. New comments explain constraints and reasons in Chinese; accurate existing English comments need no mechanical translation.

Organize documentation through the [index](../README.en.md) and update both languages together. Keep README to an introduction and navigation, APIs in `docs/api/`, and historical results in `docs/benchmarks/reports/`. Fix references when moving pages. Maintain draw.io sources together with SVG/existing PNG previews under the [diagram style guide](../design/STYLE_GUIDE.en.md).

See the [release workflow](releasing.en.md) for Homebrew/Linux artifacts, installation verification and draft publication.

## Desktop GUI

Before changing pages, components, layout, styling, motion or UI copy, read the [design-system workflow](../../clients/gui/design-system/README.md#开工顺序). GUI `verify` includes the incremental audit; see [audit baselines and limits](../../clients/gui/design-system/automation.md#增量设计检查) and report design choices and evidence under the [delivery criteria](../../clients/gui/design-system/governance.md#完成条件).

The GUI uses a separate pnpm 11.7.0 workspace. Run `make gui-install`, `make gui-build`, and `make gui-smoke`; see the [GUI guide](../../clients/gui/README.en.md) for launch, packaging and isolation.

PR CI targets a 10–15 minute end-to-end feedback window, including runner queueing. GUI smoke jobs reuse the exact SHA-bound debug build and run up to six scenarios concurrently. `make verify-native` builds before testing, then runs its existing launcher, Runtime, Harness, desktop API and Workgroup groups with four Make workers; common build and SDK prerequisites finish before their consumers start. This preserves the validation commands and avoids release packaging on the PR critical path. Hosted runner queues and cold caches can exceed the target; measure the actual workflow duration rather than treating a timeout as a performance result. Complete CLI/GUI packaging, installation/upgrade acceptance, signing, notarization, uploads and channel synchronization belong to the local release procedure.

`make setup-node` installs only locked Node development dependencies for native CI that does not run formatting checks; use `make setup` for full local development.

## Local shared Rust cache

Optionally use a pinned [mr-boxington](https://github.com/jdx/mr-boxington) version to reuse compiler outputs across worktrees. Keep the Rust version in `rust-toolchain.toml`. The project's `.mbx.toml` disables caching build-script execution results, preserving normal generation and verification of Git revisions, source hashes and other build identity. Plain Cargo and CI do not require mbx.

```sh
cargo install mbx --version 1.26.0 --locked
mbx settings set build_script_execution false
mbx settings set target.views false
mbx settings set gc.max_total_size 40GiB
mbx settings set gc.min_free_size 30GiB
mbx settings set display plain
mbx settings set savings plain
mbx setup
```

These settings belong to the local user configuration, not the project's `.mbx.toml`. Disabling build-script execution caching locally also covers older worktrees without the project configuration. Put the official Cargo shim directory printed by `mbx setup` first on `PATH`; terminals, Codex and Python/Node subprocesses must inherit it. Check `command -v cargo`, `mbx setup --status` and `mbx doctor`, then keep using existing commands such as `make build`, `make check` and `make test`. Installing mbx alone does not wrap existing Cargo calls. Do not point all worktrees at one shared `CARGO_TARGET_DIR`.

`target.views=false` keeps each worktree's real `target` directory in place, without automatic migration, collection of fixed Core/Runtime paths, or a separate check/clippy lane. The 40 GiB setting is a logical-size collection target for mbx-managed data and 30 GiB is its free-space collection threshold; neither is a hard quota. Ordinary targets, Electron applications and complete release bundles still use the retention rules below. Inspect usage with `mbx cache stats`, preview collection with `mbx gc --dry-run`, and inspect the current worktree's reuse with `mbx explain --last`.

Do not recursively run `mbx adopt` over long-running Core processes, fixed-path acceptance artifacts or release outputs. Managed-target leases do not protect binaries launched directly from target or children that survive the mbx process. Rust 1.94 supports shared compiler outputs, but not cross-checkout private incremental seeding requiring rustc 1.98 or target unit seeding requiring Cargo 1.100. Remove the shim's PATH activation to return to plain Cargo; this does not delete outputs or the shared cache.

### Temporary worktree cache collection

The shared cache does not bound ordinary `target` growth. Use the existing cleanup entry point's budget mode for temporary worktrees; the default is a preview:

```sh
make artifact-cleanup ARGS='--temporary-worktrees --cache-budget-gib 40 --min-free-gib 30 --report /private/tmp/worktree-cache-preview.json'
```

After reviewing the preview, add `--apply` and choose a separate report path for each run. This mode selects existing secondary worktrees registered with this repository's Git checkout. It always excludes the primary worktree and rejects `--root` and `--no-worktrees` overrides. It only collects `deps`, `incremental`, `build` and `.fingerprint` under identified Cargo profiles. Profile executables, shells, complete bundles, delivery directories, dependencies and symlinks remain. Missing worktree registrations are skipped, not removed.

The 40 GiB budget covers estimated allocated blocks across secondary worktree caches, separately from the mbx shared-cache budget. When over budget or below 30 GiB free, older caches are selected by profile-directory modification time; caches within budget remain to avoid clearing them on every run. Directory times are not exact LRU, and APFS shared blocks make estimates differ from recovered space. Each deletion holds Cargo locks and rechecks activity. Any open file in the same profile, or a build/debug process in that worktree, protects the entire group. A profile that cannot be measured is retained and reported without blocking other groups. Active caches and unrelated data can prevent meeting either threshold; the report records remaining pressure.

In Codex, a heartbeat attached to this chat can run the command every 30 minutes with `--apply` and separate reports. Stay quiet when nothing is deleted or normal activity prevents collection; notify only for actual collection, failure or unresolved disk pressure. The automation reuses this mode, without invoking full bundle cleanup or stopping builds or services. It does not migrate targets. Primary-worktree caches and complete GUI/Core bundles continue to use the on-demand cleanup below.

## Validation artifact retention

Run `make artifact-cleanup` to preview AReaL artifacts under `~/Documents/Codex` and this repository's registered worktrees. The default is read-only. GUI packaging evidence identifies rounds, with executable/Core completeness checks; matching app/ZIP copies belong to the same round. For standalone Core, the command retains the newest five complete, manifest-verified bundle versions, deduplicated by build identity and file hashes. Cargo profile directories are mutable build outputs and are never counted as historical rounds. Loose profile outputs are removed only when all three binaries match a known complete bundle and at least five verified bundle versions remain; unidentified outputs remain.

Rust `deps`, `incremental`, `build`, and `.fingerprint` directories are managed independently of retained versions. Merely using a repository as a working directory does not block cache cleanup. Build/debugger processes, open files inside a candidate, and held Cargo locks do block it. Active profile outputs protect companion binaries as a group. Packaged GUI/Core runtime files remain with retained versions; generated debugging information can be lost when deleting caches. Unidentified archives and small packaging evidence records remain. Custom `target/delivery-*` contents are handled only as identified packages, never as an entire disposable cache.

Use `python3 scripts/artifact-cleanup.py --root /path/to/artifacts --no-worktrees --json` for an isolated scan. `--root` is repeatable, and `--keep` changes the retention limit. `--report /path/outside/scanned/roots/preview.json` saves the complete plan. Sizes use allocated blocks and exclude overlapping paths; hard links, APFS clones and snapshots may reduce actual recovered space.

After reviewing the preview, use `--apply --report /path/outside/scanned/roots/result.json` for explicit deletion. Execution takes exclusive locks on the profile's Cargo lock files, rechecks activity, and records each deletion before and after it happens. Locks are preserved; a failed check skips the path. Failed activity inspection blocks deletion. The command does not stop processes or remove worktrees, source, configuration or history. A failure exits nonzero; the result file records completed and potentially interrupted deletions. Inspect the receipt and rerun the preview after partial failure. The command itself does not install recurring tasks.
