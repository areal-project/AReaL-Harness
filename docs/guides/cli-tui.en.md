[中文](cli-tui.md) | **English**

# CLI and TUI guide

This guide targets the public stable GitHub release [v0.1.8](https://github.com/areal-project/AReaL-Harness/releases/tag/v0.1.8), built from commit `6226e29aad7c35bd6d9dae3c17dfd67ee76d9da1`. For Web and other client features, see the [client guide](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/guides/clients.en.md).

The CLI runs scripted or single tasks. The TUI provides a fullscreen interactive terminal. Both use the same `areal` executable; no separate TUI download is required.

For a first session, install the bundle, configure a model, and open your workspace. Run `areal` for interaction or `areal exec 'your task'` for a single task. Release bundles require neither Rust nor Cargo.

## 1. Download, install, and upgrade

The public stable release used in this guide is `v0.1.8`, and the Homebrew stable formula uses its complete bundle. Supported platforms are macOS arm64 (macOS 15+ and Xcode Command Line Tools) and Linux x86_64 (compatible glibc 2.35+). Linux also requires `/usr/bin/bwrap` (install `bubblewrap` on Ubuntu); macOS needs an executable `/usr/bin/python3` at runtime. There are no Windows, Intel macOS, Linux arm64, or musl bundles.

macOS CLI/TUI bundles are ad-hoc signed, without Developer ID signing or Apple notarization. See [installation](installation.en.md) for installation details and system restrictions.

### Option 1: Install with Homebrew

Install [Homebrew](https://brew.sh/) first, then run:

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
```

Homebrew downloads and verifies the complete bundle and installs the CLI, TUI, and Runtime. Once the command is available, configure a model. Beta uses the separate `areal-project/tap/areal-beta` formula and does not automatically replace stable.

### Option 2: Download and install the standalone bundle

Without Homebrew, use the [v0.1.8 Release](https://github.com/areal-project/AReaL-Harness/releases/tag/v0.1.8). The installer requires Python 3.9+. These commands work on macOS arm64 and Linux x86_64; the installer selects the platform bundle:

```sh
(
set -eu
mkdir -p areal-download
cd areal-download
version=0.1.8
base="https://github.com/areal-project/AReaL-Harness/releases/download/v${version}"
curl -fL "$base/install.py" -o install.py
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
python3 - <<'CHECKSUM'
import hashlib
from pathlib import Path
entries = [line.split() for line in Path('SHA256SUMS').read_text().splitlines()]
expected = [digest for digest, name in entries if name == 'install.py']
if len(expected) != 1 or hashlib.sha256(Path('install.py').read_bytes()).hexdigest() != expected[0]:
    raise SystemExit('Installer checksum mismatch; do not run install.py')
CHECKSUM
# Run only after the checksum check succeeds.
python3 install.py --version "$version"
)
export PATH="$HOME/.local/bin:$PATH"
command -v areal
areal --version
areal build-info
```

The installer downloads and verifies the complete bundle. Its default entry point is `~/.local/bin/areal`. Add the PATH setting to your shell startup file for new terminals. SHA256 verifies consistency with the release manifest, not the identity of the publisher. Do not copy only `bin/areal` from the archive; retain its Runtime files.

Choose one installation channel. If another installation exists, check the active entry point with `command -v areal`. Standalone installations normally use `~/.local/bin`; Homebrew uses its own `bin` directory.

### Upgrade

First back up `~/.areal` and any custom data directories. After finishing tasks, inspect shared services with `areal service list` and stop each by workspace. Busy services refuse to stop by default; wait for tasks to finish or pause them first.

```sh
areal service list
areal service stop --workspace /absolute/path/to/project
brew update
brew upgrade --formula areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
```

Replace the example path with the actual workspace and stop each shared service. For a custom data directory, add `--data-dir /absolute/core-data`; alternatively, use `--instance INSTANCE_ID` to select a listed instance precisely, without combining it with `--workspace` or `--data-dir`. `service stop/status` do not accept startup options such as `--config`. Homebrew can remove old versions, so stop services before upgrading; the upgrade does not automatically stop tasks or services. `areal upgrade --check` checks the local tap; run `brew update` first to refresh it. See the [installation guide](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/guides/installation.en.md) for other channels and full platform requirements.

Standalone installations use their own upgrade command:

```sh
areal upgrade --check
areal upgrade
command -v areal
areal --version
areal build-info
```

A standalone upgrade switches only the command entry point and retains old version directories. Running services keep their existing version. After tasks finish, explicitly update a service with the new `areal service restart --workspace /absolute/path/to/project`. Homebrew still requires the stop-before-upgrade procedure above.

### Configure a model

Configure a model service that supports SSE and function tools. For example, a Chat Completions endpoint is the full request URL:

```sh
export AREAL_HARNESS_MODEL_ENDPOINT='https://model.example.com/v1/chat/completions'
export AREAL_HARNESS_MODEL='your-model-id'
export AREAL_HARNESS_MODEL_PROTOCOL='chat-completions'
export AREAL_HARNESS_API_KEY_ENV='AREAL_API_KEY'
# Enter the key; input is hidden.
read -r -s AREAL_API_KEY
export AREAL_API_KEY
areal config validate
```

For an unauthenticated local model, omit the key settings. Do not put the key value in command arguments or TOML. See [configuration](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/guides/configuration.en.md) for model, Responses, and provider settings. Keys saved by the GUI do not automatically enter a Core started independently from the terminal.

Local v0.1.8 startup defaults to YOLO permissions, allowing writes outside the workspace and tool network access. To require tool approvals, set `export ASK_PERMISSIONS=1` before starting the service or use the [permissions configuration](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/guides/configuration.en.md#permissions). A task without an interactive response channel cannot wait for a human approval; use the interactive TUI when human participation is needed.

### First task: A read-only project introduction

Enter your project directory and submit a read-only task:

```sh
cd /absolute/path/to/project
areal exec --permission-mode plan 'Read this project and describe its purpose, architecture, and main directories. Do not modify files.'
```

`--permission-mode plan` applies a read-only restriction. After this succeeds, use the interactive interface or submit editing tasks. Project documents and tool-read content are sent to the selected model service. Choose a provider authorized to receive this content.

With multiple configured models, select a provider ID and model ID explicitly:

```sh
areal exec --model 'PROVIDER_ID:MODEL_ID' --permission-mode plan 'Introduce this project'
```

Replace both IDs. The provider ID is its configuration identifier, not its display name. The model must belong to an enabled provider, and its credential must be available in Core. Use `/model` in the TUI to select a model interactively.

## 2. Interactive TUI

```sh
# Replace with your absolute workspace path.
areal --workspace /absolute/path/to/project
# Optionally submit an initial message after the interface is ready.
areal --workspace /absolute/path/to/project 'Describe this project'
```

Enter a task and press Enter. While it runs, enter another message and press Enter to add instructions.

| Action | Purpose |
| --- | --- |
| `Ctrl-C` | Pause an active Goal or interrupt the current Turn; exit when idle |
| `Ctrl-Q`, `/quit` | Exit the interface |
| `Ctrl-R` | Reconnect and restore the snapshot without replaying requests |
| `F5`, `/sessions` | Find and switch sessions |
| `/new`, `/open ID` | Create or open a session |
| `F6`, `/model` | Choose a session model while idle |
| `/skills`, `/skill NAME` | Select a Skill |
| `/permissions` | Inspect permissions and remembered approvals |
| `F4`, `/executions` | Inspect subtask progress, checks, and delivery |
| `F3`, `/topology` | Inspect the session tree |
| `Ctrl-O`, `/details` | Toggle compact and detailed history |
| `/restore-input` | Restore input retained after a failed or unconfirmed submission |
| `/help` | Show shortcuts |

Type `/` to see command suggestions, Tab to complete, and Esc to dismiss. In an approval dialog, use the arrow keys to select, Enter to confirm, and Esc to deny; deny is initially selected. Use `areal --mouse=false` to disable mouse capture and use the terminal's native selection and copy.

By default, the interactive TUI connects to a shared Core/Runtime reused for the workspace. Closing the interface leaves the shared service and background tasks running. To change a key in its startup environment, first wait for tasks to settle, then run `areal service restart` with the same workspace and deployment arguments. `Ctrl-R` does not inject a new environment into a running Core.

### Durable goals

Enter `/goal Complete the migration and run relevant tests` in the TUI to start a goal; `/goal` displays its status. Use `/goal-pause` to pause and `/goal-resume` after settlement to resume. `/goal-edit NEW OBJECTIVE` and `/goal-budget 200000` edit a stopped goal. `/goal-clear` clears a stopped goal after its resources settle. Goals can continue across Turns; an ordinary final response does not itself complete a goal.

## 3. Noninteractive CLI

Use `exec` in scripts rather than relying on the interactive default:

```sh
areal exec --workspace /absolute/path/to/project 'Describe the workspace'
printf '%s\n' 'Describe the workspace' | areal exec --workspace /absolute/path/to/project
areal exec --output-format json 'Describe the workspace'
areal exec --output-format stream-json --verbose 'Describe the workspace'
areal exec --resume SESSION_ID 'Continue the task'
```

`text` is the default output; `json` emits a final result and `stream-json` emits events. Logs go to stderr. Success exits with 0; failure exits nonzero. Resume with the returned session ID; a missing session or an unconfirmed result does not silently create a new session. `areal -p` is a compatible entry point with the same options as `exec`.

Common options include `--model`, `--effort`, `--max-turns`, `--permission-mode`, `--tools`, and `--no-session-name`. `--permission-mode` cannot expand server or Runtime authorization. See the [CLI contract](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/api/claude-cli.en.md) for input formats, bidirectional stream-json, tool filters, and limitations; run `areal exec --help` for options.

In v0.1.8, local `exec` owns a separate Core/Runtime and waits for cleanup on exit; it does not shut down an external endpoint. Without a bidirectional response channel, noninteractive user questions are unavailable and tools requiring human approval are denied. The model can continue other work or report a blocker.

## 4. Headless TUI and media

`--prompt` runs one task through the TUI protocol, which has different output from `exec`: the Turn text goes to stdout and the Thread ID to stderr. `--goal` waits across Turns for a terminal goal state; only completed succeeds.

```sh
areal --workspace /absolute/path/to/project --prompt 'Describe the workspace'
areal --workspace /absolute/path/to/project --goal 'Complete the migration and run tests' --goal-token-budget 200000
```

`--input-file` accepts a Core Input JSON array of at most 2 MiB and conflicts with `--prompt` and `--goal`. Image paths are resolved in the environment running the service.

```json
[{"type":"text","text":"Describe this image"},{"type":"localImage","path":"/absolute/path/to/image.png"}]
```

Write the array to a file and run `areal --input-file /absolute/path/to/input.json`. By default `--prompt`, `--goal`, and `--input-file` use an owned local service that is cleaned up on exit; `--local-mode shared` uses the shared service. See the [Core API](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/api/core.en.md) for media fields.

## 5. Connect and recover

```sh
# Replace the address and path with the service's authentication file.
areal --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json
areal exec --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json 'Inspect the workspace'
# Query by workspace; restart uses the original configuration and deployment options.
areal service list --json
areal service status --workspace /absolute/path/to/project --json
areal service restart --workspace /absolute/path/to/project --json
```

`--endpoint` (TUI alias `--remote`) connects to an existing service and cannot be combined with local deployment arguments. Credentials and permissions for a remote Core come from its startup environment. The authentication file uses the Core `security/auth.json` format; do not commit or expose it.

After a disconnect, reconnect and inspect the server snapshot before acting; do not automatically resend an unconfirmed submission. If a tool result is UNKNOWN after restart, inspect the actual files and processes and record the inspection as described in the [Core API](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/api/core.en.md); this does not replay the tool. See the [local service contract](https://github.com/areal-project/AReaL-Harness/blob/v0.1.8/docs/api/local-service.en.md) for shared services, old data migration, and stop behavior.

## 6. Common tasks and troubleshooting

### Common tasks

Run these commands from the project directory. Editing tasks use the current permission policy and can modify files.

```sh
# Review local changes without editing.
areal exec --permission-mode plan 'Review the current git diff for defects and missing tests. Do not modify files.'
# Diagnose interactively; inspect the plan and approval requests in the TUI.
areal 'Diagnose the failing tests, explain the cause, then fix and verify them'
# Save JSON output; runtime logs still go to stderr.
areal exec --output-format json --permission-mode plan 'Summarize the project entry points and main modules' > result.json
# Continue with a returned session ID.
areal exec --resume SESSION_ID 'Continue the previous analysis'
```

### Common errors

| Symptom | Check and action |
| --- | --- |
| `areal: command not found` | Check PATH with `command -v areal`. Add `~/.local/bin` for standalone installation, or follow Homebrew shell setup instructions. |
| Old version after upgrading | Check `command -v areal` and `areal --version`. Run `hash -r` in Bash/Zsh and check whether another installation shadows the new entry point. |
| `MODEL_NOT_CONFIGURED` | Check the default provider and model. Use `--model 'PROVIDER_ID:MODEL_ID'` to select an API model configured in the current Core. |
| `CREDENTIAL_UNAVAILABLE` | Set the variable named by `api_key_env` in the terminal that starts Core. Independent CLI startup does not automatically read GUI-encrypted credentials. Do not treat encrypted files as plaintext keys. |
| `401` / `403` | Check key validity, service URL, and access to the model. Never include keys in issue reports. |
| Failure after changing a terminal key | A new owned `areal exec` uses the new environment. Explicitly restart a shared service after tasks finish. `Ctrl-R` only reconnects; it does not update the service environment. |
| Tools wait for approval or are denied | Use the TUI for human approvals. A non-interactive CLI without an answer channel cannot approve tools. |
| Disconnection or unknown submission outcome | Reconnect and inspect the original session. Do not immediately resubmit a task that changes files. |

`areal config validate` checks configuration format and constraints, not model connectivity. Use the first read-only task to check a real model call. Preserve exit codes and stderr when reporting failures, and remove credentials. Run `areal --help`, `areal exec --help`, or `areal service --help` for more options.
