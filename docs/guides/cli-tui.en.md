[中文](cli-tui.md) | **English**

# CLI and TUI guide

This guide describes upstream `main` at `1f6cc627a1754b32c32a5c396a9e58c8dd727deb`. Options, permissions, and service lifetimes can differ on other branches or releases; consult that version's `areal --help` and documentation. For Web and other client features, see the [client guide](clients.en.md).

## 1. Install and configure

Install the complete distribution or run `make setup` and `make build` in the source repository. See the [installation guide](installation.en.md) for packages and platform requirements. The source build produces `target/debug/areal`. The examples assume the complete distribution's `areal` is on PATH; in the repository, substitute `target/debug/areal`.

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

For an unauthenticated local model, omit the key settings. Do not put the key value in command arguments or TOML. See [configuration](configuration.en.md) for model, Responses, and provider settings. Keys saved by the GUI do not automatically enter a Core started independently from the terminal.

Local upstream defaults to YOLO permissions, allowing writes outside the workspace and tool network access. To require tool approvals, set `export ASK_PERMISSIONS=1` before starting the service or use the [permissions configuration](configuration.en.md#permissions). A task without an interactive response channel cannot wait for a human approval; use the interactive TUI when human participation is needed.

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

Common options include `--model`, `--effort`, `--max-turns`, `--permission-mode`, `--tools`, and `--no-session-name`. `--permission-mode` cannot expand server or Runtime authorization. See the [CLI contract](../api/claude-cli.en.md) for input formats, bidirectional stream-json, tool filters, and limitations; run `areal exec --help` for options.

On this upstream revision, local `exec` owns a separate Core/Runtime and waits for cleanup on exit; it does not shut down an external endpoint. Without a bidirectional response channel, noninteractive user questions are unavailable and tools requiring human approval are denied. The model can continue other work or report a blocker.

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

Write the array to a file and run `areal --input-file /absolute/path/to/input.json`. By default `--prompt`, `--goal`, and `--input-file` use an owned local service that is cleaned up on exit; `--local-mode shared` uses the shared service. See the [Core API](../api/core.en.md) for media fields.

## 5. Connect and recover

```sh
# Replace the address and path with the service's authentication file.
areal --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json
areal exec --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json 'Inspect the workspace'
# Manage the local shared service with its original workspace and configuration.
areal service list --json
areal service status --workspace /absolute/path/to/project --json
areal service restart --workspace /absolute/path/to/project --json
```

`--endpoint` (TUI alias `--remote`) connects to an existing service and cannot be combined with local deployment arguments. Credentials and permissions for a remote Core come from its startup environment. The authentication file uses the Core `security/auth.json` format; do not commit or expose it.

After a disconnect, reconnect and inspect the server snapshot before acting; do not automatically resend an unconfirmed submission. If a tool result is UNKNOWN after restart, inspect the actual files and processes and record the inspection as described in the [Core API](../api/core.en.md); this does not replay the tool. See the [local service contract](../api/local-service.en.md) for shared services, old data migration, and stop behavior.
