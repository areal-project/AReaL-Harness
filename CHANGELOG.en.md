[中文](CHANGELOG.md) | **English**

# Changelog

## GUI 0.1.18

### Fixed and changed

- Prioritize complete user prompts and Agent replies to reduce waiting and missing messages in tool-heavy histories. Preserve the reading position when loading older history.
- Keep compact tool summaries and automatically fetch details on expansion, removing repeated notices that large records need manual loading.
- Fix opening historical chats with automatic session naming disabled.
- Show reasoning efforts allowed by the model configuration while keeping Fast independently selectable.
- Show copy, branch and time together after a turn ends. Center pause, retry recovery, model change and compaction notices between separator lines. Align control tooltips, focus and motion feedback.

### Install and upgrade

macOS Apple Silicon users can update through the production in-app channel or download the signed, notarized DMG from the [release page](https://github.com/areal-project/AReaL-Harness/releases/tag/gui-v0.1.18) for manual installation. An isolated native update from 0.1.17 to 0.1.18 is verified. Back up configuration and history, and install once background work is idle. Before replacing the app manually, safely stop the backend and quit; confirm 0.1.18 in About after reopening. If older installation checks in 0.1.13/0.1.14 block the update, use the DMG once.

## GUI 0.1.17

### Fixed and changed

- Preserve the latest installation state after downloads, avoiding progress stuck at 0% and missing recovery actions while waiting for background work.
- The compact lower-left update entry opens a status popover with download progress, waiting, preparation, restart, error details, and recovery actions.
- Retry failed downloads. Unconfirmed installations ask users to reopen and check the version; cancelling background tasks still requires confirmation.

### Upgrade

macOS Apple Silicon users can upgrade through the production in-app channel or install the signed, notarized DMG manually. Check for 0.1.17 in About afterward. If an older version waits for the backend without a recovery action, let tasks finish, safely stop the backend, and retry the update.

## GUI 0.1.15

### Fixes

- Recognize crash reporters belonging to the current application session during update checks, while retaining blockers for other profiles, independent CLI processes, and unknown users of the installation.
- Complete safe shutdown and package-use checks before preparing Squirrel installation, so a rejected install does not arm replacement on normal exit.
- If native preparation fails after shutdown, explain that the backend has stopped and the installation result needs checking. Reopen the app to check its version rather than automatically retrying installation.

### Upgrade

The previous installation checks in 0.1.13 and 0.1.14 can block automatic upgrades. Use the DMG once to migrate to this version. Later formal releases use the product update channel.

## GUI 0.1.14

### Fixes

- Resume backend startup after a completed automatic update and confirmed exit of the previous backend, avoiding a loading failure on reopen.
- Preserve recovery safeguards for unknown and unfinished operations. An explicit backend stop still requires manual reconnection.

## GUI 0.1.13

### Changes

- Use model-specific context defaults for GPT subscriptions and API connections, including Claude, DeepSeek, Qwen, Kimi and GLM. Explicit user settings take precedence; clearing a setting restores its default.
- Show configured provider names in the model picker and correct Fast request encoding for OpenAI-authorized connections.
- Inspect execution timing and delegated activity, and use workspace file references and media previews in conversations.
- Restore saved API credentials and subscription model choices after reconnecting. Keep paused tool records visible while removing redundant pause headings.
- Show update-check errors and preserve the backend when native update validation times out; an unknown stop result prevents repeated installation.

### Installation and known limitations

This macOS Apple Silicon release is distributed as a Developer ID-signed, Apple-notarized DMG for manual installation. Back up configuration and history before upgrading; older apps may not read data saved by this version. Finish running tasks and safely stop their backend before quitting and replacing the application. After launching the replacement, verify 0.1.13 in About AReaL Harness. The existing automatic-update channel is managed separately.

In very narrow Side panels, model controls can extend beyond the panel. Widen the panel if this occurs.

## CLI / TUI 0.1.8

### Changes

- Advance the shared source version for CLI, TUI and their bundled Core and Runtime.
- Apply an explicit CLI `--model` before creating a session, so an unavailable default provider no longer causes a misleading “thread not found” error. Missing default providers report a model configuration error.

### Install and upgrade

[Download 0.1.8](https://github.com/areal-project/AReaL-Harness/releases/tag/v0.1.8), including the complete archive for your platform, installer and SHA256 checksums. Supports macOS Apple Silicon (macOS 15+) and Linux x86_64 (glibc 2.35+; restricted execution requires `/usr/bin/bwrap` and usable user namespaces). macOS CLI binaries retain ad-hoc signatures without Developer ID distribution signing or Apple notarization.

Both platforms can install through the public Homebrew tap:

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
areal
```

Expect `areal 0.1.8`; `areal` opens the TUI. Existing Homebrew users should finish tasks and safely stop the relevant services before running `brew update` and `brew upgrade --formula areal-project/tap/areal`. See the [installation guide](docs/guides/installation.en.md) for standalone installation and upgrades. Standalone entry updates retain complete old bundles and running tasks; explicitly hand over the backend once idle. This version writes history format 16. Back up configuration and history before upgrading; older Core versions may require restoring a compatible backup when rolling back.

## CLI / TUI 0.1.7

### Changes

- Standalone upgrades update the command entry while retaining complete old bundles and running backends; explicitly restart the backend once idle. Homebrew stable and beta track their own channels.
- Improve TUI session recovery after disconnection. CLI and single-input modes accept `--no-session-name` to disable automatic naming while retaining history and resume.
- Fix state preservation during network recovery and child-task handoffs, and improve reporting of command exit codes and file-tool results.

### macOS download and usage (Apple Silicon)

Requires macOS 15+, Xcode Command Line Tools and an executable `/usr/bin/python3`. Install the complete CLI/TUI and Runtime through the public Homebrew tap:

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
```

Expect `areal 0.1.7`. For an existing Homebrew installation, finish tasks, inspect `areal service list`, safely stop each workspace with `areal service stop --workspace /absolute/workspace`, then run `brew update` and `brew upgrade --formula areal-project/tap/areal`. macOS CLI binaries are ad-hoc signed, without Developer ID signing or Apple notarization.

The [complete macOS arm64 archive](https://github.com/areal-project/AReaL-Harness/releases/download/v0.1.7/areal-harness-v0.1.7-aarch64-apple-darwin.tar.gz) is also available for offline distribution; verify and install the complete bundle as described in the [installation guide](docs/guides/installation.en.md).

### Linux download and usage (x86_64)

Requires glibc 2.35+ (such as Ubuntu 22.04+) and Python 3.9+. Restricted or read-only execution also requires system Bubblewrap and usable user namespaces. Download and verify the installer from the same Release; it downloads and verifies the [complete Linux x86_64 archive](https://github.com/areal-project/AReaL-Harness/releases/download/v0.1.7/areal-harness-v0.1.7-x86_64-unknown-linux-gnu.tar.gz):

```sh
(
set -eu
download_dir=$(mktemp -d)
cd "$download_dir"
base=https://github.com/areal-project/AReaL-Harness/releases/download/v0.1.7
curl -fL "$base/install.py" -o install.py
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
python3 - <<'VERIFY'
import hashlib
from pathlib import Path
entries = [line.split() for line in Path('SHA256SUMS').read_text().splitlines()]
expected = [digest for digest, name in entries if name == 'install.py']
assert len(expected) == 1
assert hashlib.sha256(Path('install.py').read_bytes()).hexdigest() == expected[0]
VERIFY
python3 install.py --version 0.1.7 --prefix "$HOME/.local"
"$HOME/.local/bin/areal" --version
)
```

After success, run `export PATH="$HOME/.local/bin:$PATH"` and retain that PATH in new terminals. Use the same `--prefix` for an existing standalone installation. Use the verified installer above for the first transition from an older stable release; subsequent upgrades use `areal upgrade --check` and `areal upgrade`. Once idle, explicitly activate the new backend with `areal service restart --workspace /absolute/workspace` from the new entry, retaining the original configuration arguments.

### Configure and start (both platforms)

Configure the provider, model and authentication in `~/.areal/config.toml` using the [model configuration guide](docs/guides/configuration.en.md), then enter your project directory:

```sh
areal config validate
areal             # Open the interactive TUI
# Or run a single CLI task
areal exec "Summarize this project's structure"
```

Back up configuration and history before upgrading (normally `~/.areal`, plus custom data directories). This release writes state format 15; retaining an old executable is not a compatible data backup. Verify standalone entry and backend versions separately; Homebrew upgrades require safely stopped services. See the full [installation and upgrade guide](docs/guides/installation.en.md).

Installation, upgrade and verification commands: [CLI guide](docs/guides/installation.en.md) and [GUI guide](clients/gui/README.en.md#installation-and-updates).
