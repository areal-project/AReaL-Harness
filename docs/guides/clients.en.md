[中文](clients.md) | **English**

# CLI, TUI and local Web

Complete the [quickstart](quickstart.en.md) first. Clients share Core history; Runtime executes tools without requiring a Codex binary.

## Launch

```sh
make tui
make tui ARGS='--resume THREAD_ID'
make tui ARGS='--workspace /absolute/task --allow-write --prompt "Describe the task"'
# Connect using the authentication file in the existing Core data directory
make tui ARGS='--endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json'
```

Without an endpoint, TUI uses its embedded launcher to start Core/Runtime on a random loopback port and shuts them down on exit. An explicit endpoint (alias `--remote`) connects to an existing service and only disconnects on exit. Local deployment arguments cannot be combined with endpoint mode.

The default data directory is `~/.areal-harness/state`, with `launch-*.log` files inside it. Keep data and trusted binaries outside writable workspaces. A data directory has an exclusive lock; configure separate directories for multiple instances. The launcher uses system `/usr/bin/python3 -I -S` without importing workspace code.

`areal -p 'prompt' --output-format stream-json --verbose` provides noninteractive CLI operation; `areal serve` starts a persistent service. See the [CLI contract](../api/claude-cli.en.md) for arguments, authentication, resume and exit codes. Web is served at `/ui`; log in with the local token from `security/auth.json` in the service data directory.

TUI `--input-file /absolute/input.json` is mutually exclusive with `--prompt` and accepts a Core Input array up to 2 MiB, for example `[{"type":"text","text":"Inspect the image"},{"type":"localImage","path":"/absolute/image.png"}]`. Both local and explicit-endpoint modes support it; the trusted launcher forwards `--tui --input-file`. Media paths and fields remain subject to [Core API](../api/core.en.md) validation.

## TUI controls

| Control | Behavior |
|---|---|
| Enter | Start a Turn when idle; steer while running |
| `/`, Tab, Esc | Slash candidates, completion and dismissal |
| Ctrl-C / Ctrl-Q | Cancel the current task / exit |
| Ctrl-R | Reconnect and restore a snapshot without replay |
| F5, `/sessions`, `/new`, `/open ID` | Select, create or open sessions |
| F6, `/model` | Select a model or reset to default while idle |
| F2, `/theme` | Preview; Enter saves and Esc reverts |
| `/agents`, F3, `/topology` | Child-task tree and root topology |
| `/spawn prompt` | Manually spawn a child of the active Turn |
| `/tasks`, `/groups` | Plan and Workgroups |
| PageUp/PageDown/Home, End | Read history; End resumes following |

`--prompt` emits only the current Turn's text, writes Thread ID to stderr and exits nonzero on failure. It skips TUI preferences. See [appearance configuration](configuration.en.md#tui).

## History, recovery and observability

Core retains original history and tool intents/results; context compaction only changes future model input. Workspace-root `AGENTS.md` is read through Runtime (regular UTF-8 file, up to 32 KiB); nested instructions are not recursively loaded. Default delegation shares the workspace; use [Workgroups](workgroups.en.md) for isolated writes.

Restart marks unconfirmed tools/hooks UNKNOWN and blocks new Turns. Inspect actual files/processes, then record the inspection in Web or via `areal/tool/acknowledge`. History remains unknown. This neither replays operations nor approves permissions or restores old processes. Corrupt snapshots are not silently discarded.

```sh
export OTEL_SERVICE_NAME='areal-core'
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4318'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
make server
```

OTLP supports HTTP/protobuf only. It is disabled without an endpoint and can be disabled with `OTEL_SDK_DISABLED=true`. Default spans contain IDs, usage, status and timing rather than prompt bodies or credentials. Export failure does not change Turn outcomes.
