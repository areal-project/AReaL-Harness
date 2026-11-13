[中文](installation.md) | **English**

# Installation and upgrades

Use these commands after the packages are published to GitHub Releases. Before publication, build and validate candidate artifacts locally; unreleased versions and taps are not available installation sources.

## Platforms and contents

| Platform     | Distribution                                                                                             | Prerequisites                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| macOS arm64  | Complete GitHub Release bundle and Python installer; public Homebrew stable and beta formulas | macOS 15+, Xcode Command Line Tools; standalone install/upgrade requires Python 3.9+ on PATH                                   |
| Linux x86_64 | Complete GitHub Release bundle and Python installer; public Homebrew stable and beta formulas                  | Ubuntu 22.04 or newer compatible glibc 2.35+ system; standalone install/upgrade requires Python 3.9+ on PATH; musl unsupported |

Only these architectures are validated. No Windows, Intel macOS or Linux arm64 packages are provided. **npm and `cargo install` do not provide complete bundles yet**, so neither is an installation channel. Choose Homebrew or standalone installation, not both for the same PATH entry. Bundles contain `bin/areal`, `libexec/areal/{areal-runtime,areal-runtime-fs}`, LICENSE and a file SHA256 manifest; Linux bundles also include `areal-runtime-reaper` in the same directory. Do not copy only `areal`. Startup does not require Rust/Cargo. macOS still requires an executable `/usr/bin/python3` from Command Line Tools; configured Node/Python tools need their interpreters.

Before starting a new backend, the macOS GUI checks developer tools and system Python. If a dependency is missing, follow the installation guidance and click **Check again** after installation. The system interpreter remains a runtime prerequisite declared in the complete bundle's `manifest.json`.

macOS bundles are ad-hoc signed, without Developer ID signing or notarization. Linux defaults to YOLO/full-access under the current user's permissions. Restricted/read-only scopes require `/usr/bin/bwrap` and usable user namespaces. Install `bubblewrap` on Ubuntu; restricted operations fail if user namespaces are disabled or AppArmor denies them, without silently expanding permissions. See [Runtime deployment](runtime.en.md).

## Homebrew (macOS / Linux)

The public [tap](https://github.com/areal-project/homebrew-tap) provides stable `areal` and optional `areal-beta` for macOS arm64 and Linux x86_64, using complete public Release archives and their SHA256 checksums. A Beta release updates only `areal-beta`; the default `areal` formula continues to track stable releases.

Both platforms use the same commands. The keg-only `areal-beta` leaves the stable PATH entry intact:

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
# Optional Beta: invoke its absolute entry without forcing a link
brew install areal-project/tap/areal-beta
brew test areal-project/tap/areal-beta
"$(brew --prefix areal-project/tap/areal-beta)/bin/areal" --version
```

The Linux formula supports only x86_64 with host glibc ≥ 2.35 and system `/usr/bin/bwrap` (Ubuntu: `sudo apt-get install bubblewrap`). See the [official Linux guide](https://docs.brew.sh/Homebrew-on-Linux) for Homebrew's own prerequisites and support policy. Linux arm64 and musl support are not added. Complete bundles and the standalone installer retain the glibc 2.35 baseline; native Linuxbrew acceptance uses Ubuntu 24.04 / glibc 2.39. On older hosts, Homebrew may install its own glibc/GCC. This acceptance does not establish all older-system/custom-prefix combinations; use the standalone installer where needed.

Before upgrading, finish tasks and safely stop shared services (`areal service list`, then `areal service stop --workspace /absolute/workspace` for each workspace, retaining its original configuration arguments without cancellation flags):

```sh
brew update
brew upgrade --formula areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
# Beta upgrades only its own formula
brew upgrade --formula areal-project/tap/areal-beta
brew test areal-project/tap/areal-beta
"$(brew --prefix areal-project/tap/areal-beta)/bin/areal" --version
```

The new `areal upgrade --check` reads the same formula in the local tap without refreshing it; run `brew update` first for fresh definitions. `areal upgrade` requires all services to be Stopped before refreshing the tap, upgrading the actual formula recorded in its receipt and checking the installed entry version. It uses the Homebrew that owns the Cellar rather than guessing from PATH. Missing receipts, unknown sources and channel changes are rejected. Stable never enters beta automatically; beta never switches to stable automatically. Older CLIs retain their embedded hardcoded upgrade route: use the exact `brew upgrade --formula <actual-tap/formula>` command above for the first transition. Never overwrite Cellar with the Python installer. Homebrew may clean up old kegs, so this path still requires stopped services; the command does not stop or cancel tasks for you.

## Standalone installation (macOS / Linux)

Download the installer and checksums from the same Release and verify before execution. Pin the version to avoid silent upgrades:

```sh
version=0.1.8
base="https://github.com/areal-project/AReaL-Harness/releases/download/v${version}"
curl -fL "$base/install.py" -o install.py
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
python3 - <<'PY'
import hashlib
from pathlib import Path
lines = [line.split() for line in Path('SHA256SUMS').read_text().splitlines()]
expected = [digest for digest, name in lines if name == 'install.py']
assert len(expected) == 1 and hashlib.sha256(Path('install.py').read_bytes()).hexdigest() == expected[0]
PY
python3 install.py --version "$version"
export PATH="$HOME/.local/bin:$PATH"
command -v areal
areal --version
areal build-info
```

The default destination is `~/.local/lib/areal/<version>-macos-arm64` or `<version>-linux-x86_64`, with a symlink at `~/.local/bin/areal`. Use `--prefix /absolute/path` for another writable directory. The installer never invokes sudo or changes shell configuration. It refuses to replace an unmanaged `bin/areal` or an existing version directory.

For offline installation, download the platform archive and matching SHA256SUMS:

```sh
python3 install.py --version 0.1.8 --prefix "$HOME/.local" \
  --archive areal-harness-v0.1.8-x86_64-unknown-linux-gnu.tar.gz \
  --checksums SHA256SUMS
```

For macOS offline installation, use `areal-harness-v0.1.8-aarch64-apple-darwin.tar.gz` instead. `python3 install.py --version latest --check` queries the latest public Release without installing it; `--version latest` installs it when explicitly requested.

The installer verifies the archive and all bundle files before executing any bundled program, rejecting links, devices and traversal entries. SHA256 verifies consistency with the published manifest; it is not independent authentication of the release source.

## Upgrade commands

Back up configuration and history first (normally `~/.areal`, plus custom data directories). Installer-managed complete bundles can update their entry while backends keep running:

```sh
areal upgrade --check
areal upgrade
command -v areal
areal --version
areal build-info
```

`command -v areal` should select the intended installation entry. Check PATH when several prefixes coexist, and run `hash -r` if needed. `build-info` reports the source commit; the complete bundle's `manifest.json` records platform and per-file SHA-256. Retain it alongside the matching release's `SHA256SUMS`.

Entry installation and backend handoff are separate. The current source installer validates a complete new bundle and atomically switches the entry without stopping backends, changing configuration/history or deleting old versions. A service starting during download or switching can keep its resolved complete old bundle; other workspaces and GUI instances are not stopped. Concurrent installers for one prefix are refused. Published 0.1.6 embeds an older stop-before-upgrade check: installing a newer target does not retrofit its CLI. Use the target release's verified installer to update the entry without a forced cold migration.

A new client must clearly report an incompatible backend rather than implicitly stopping, downgrading or taking it over. Handoff uses an explicit update/restart after work becomes idle. Unknown acceptance is checked through the original request without repeating stop. Retaining an old package does not back up data formats; verify the active entry and backend versions separately.

Interrupted downloads, bad checksums, mismatched program versions, and failed entry switches preserve the old entry and configuration/history. Fix the cause and retry. If interruption follows a completed entry switch, the new version may already be active: inspect the entry and version before deleting any candidate directory. Forced termination can leave staging or an inactive version directory: retain old installations and user data. If a version directory already exists, inspect its integrity and the active entry before proceeding; do not overwrite it. To roll back the executable, stop services and repoint the entry symlink to the retained old version. If the new version has written data, restore the matching pre-upgrade backup; old versions are not guaranteed to read newer data formats.

## Configuration, upgrades and uninstalling

Configure the model in `~/.areal/config.toml` using the [configuration guide](configuration.en.md), then launch `areal` in a workspace. Remove retired `limits.turn_timeout_seconds` and `AREAL_HARNESS_TURN_TIMEOUT_SECONDS` settings. Run `areal config validate`. Old `~/.areal-harness` state is not migrated automatically.

`areal version` is equivalent to `areal --version`. `areal upgrade --check` queries the original channel without installing (for standalone installs, the latest stable CLI, or for a beta the higher of the newest beta and stable; the original formula for Homebrew). The interactive TUI runs the same check in the background at startup, at most once every 24 hours, and shows "run areal upgrade" on the second header line when a newer version exists; it never installs anything. Set `AREAL_NO_UPDATE_CHECK=1` to turn it off; source builds do not check. When the TUI connects to a background older than itself it also says so: once tasks are idle, run `areal host stop` and reopen so the newer version starts the background. `areal upgrade` uses the original installation channel. Source builds and unmanaged copies refuse self-upgrade.

- **Standalone installations** verify a complete new bundle before atomically switching the command entry symlink. Shared services do not need to stop. The upgrade command neither stops nor restarts backends and does not migrate running sessions. Old version directories remain unchanged for existing processes and their Runtime helpers; new commands use the new entry point. Do not manually delete version directories that running processes still use.
- **Homebrew installations** upgrade the formula and verify its installed version, reporting an error if the tap is not yet updated. This channel still requires all shared services to stop before `areal upgrade`, because the command does not control Homebrew cleanup of old version directories. Inspect `areal service list`, then run `areal service stop --workspace /absolute/workspace` for each workspace. Busy tasks prevent stopping by default. Complete or explicitly pause them first; do not force-cancel tasks just to upgrade.

Installing a new version does not switch an existing backend to it. TUI startup, reconnect, and `areal service ensure` do not switch binary versions implicitly. To update a backend, complete or pause its tasks, then run `areal service restart --workspace /absolute/workspace` from the new entry point or use the GUI's explicit backend update action. After activation, an old TUI's automatic reconnect cannot stop the new backend; reopen the TUI from the new entry point to continue. Never overwrite running binaries. Standalone installations retain old version directories so the entry symlink can be switched back after stopping services. Older versions may not understand newer state formats; back up `~/.areal` before upgrading.

The new CLI manages backend shutdown through durable stop receipts, supported by hosts from 0.1.5. Stop older hosts without that capability, including 0.1.4, explicitly with their original CLI before starting the new version. The new CLI does not probe compatibility with a legacy stop request.

Stop services before uninstalling. Use `brew uninstall areal` or remove the installer-managed standalone entry symlink and selected version directories. Neither installation method automatically deletes configuration or history in `~/.areal`.

Symlink entry points are resolved to the real version directory before locating `libexec/areal`, covering Homebrew Cellar and versioned Linux installations.

## Desktop GUI (macOS Apple Silicon)

Download the DMG from GitHub Releases, or use Homebrew:

```sh
brew install --cask areal-project/tap/areal-harness
# Optional beta (cannot be installed alongside the stable cask)
brew install --cask areal-project/tap/areal-harness@beta
```

The GUI bundles a background program of the same version and updates itself, so `brew upgrade` skips it by default. It receives formal releases only; turn on "Get beta versions" under Settings > General > Software updates > Advanced to receive betas, and the background updates with it. Turning it off never downgrades: the app stays on its version until a formal release catches up. Installs from `areal-harness@beta` also need this switch turned on to keep receiving betas.

## Installing from source

Run `make install` to build release and install the complete Runtime under `/usr/local`. Use `make install PREFIX="$HOME/.local"` for a user installation, or `DESTDIR=/tmp/package` for staging. Search uses ripgrep Rust libraries embedded in the file helper; no separate rg is needed. Shell tasks that invoke rg still require a host installation.
