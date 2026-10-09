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
| CI native delta | `make verify-native`, native backend and Harness integration smoke only |
| Capacity | `make capacity`, run separately |
| Documentation only | `python3 scripts/check-docs.py`; also compare commands with implementation |

See [testing](testing.en.md) for coverage. Pass arguments with `make tui ARGS='--prompt hello'`. `make release` writes to `target/release`; `make docs` generates Rust API documentation.

The project uses [Apache-2.0](../../LICENSE). Cargo workspace and npm packages declare the same license. Both SDKs include LICENSE; `scripts/package.py` copies it into desktop bundles and records its checksum. Third-party materials retain their original licenses and copyright notices.

## Dependencies and style

Use Rust `--locked`; intentional upgrades update manifests and locks. Cordis also updates [pins.json](../../upstream/pins.json), following the [upgrade guide](cordis.en.md). Use `npm ci --ignore-scripts` and `uv sync --locked --only-group dev`, without transient global formatting tools. Frozen third-party tasks and oracles are excluded from bulk formatting.

Use rustfmt/Clippy for Rust, locked Prettier for TS/JS/CSS/HTML and Ruff for owned Python code. Follow `.editorconfig`. New comments explain constraints and reasons in Chinese; accurate existing English comments need no mechanical translation.

Organize documentation through the [index](../README.en.md) and update both languages together. Keep README to an introduction and navigation, APIs in `docs/api/`, and historical results in `docs/benchmarks/reports/`. Fix references when moving pages. Maintain draw.io sources together with SVG/existing PNG previews under the [diagram style guide](../design/STYLE_GUIDE.en.md).

See the [release workflow](releasing.en.md) for Homebrew/Linux artifacts, installation verification and draft publication.

## Desktop GUI

The GUI uses a separate pnpm 11.7.0 workspace. Run `make gui-install`, `make gui-build`, and `make gui-smoke`; see the [GUI guide](../../clients/gui/README.en.md) for launch, packaging and isolation.

`make setup-node` installs only locked Node development dependencies for native CI that does not run formatting checks; use `make setup` for full local development.
