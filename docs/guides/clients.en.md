[中文](clients.md) | **English**

# CLI, TUI and local Web

Complete the [quickstart](quickstart.en.md) first. Clients share Core history; Runtime executes tools without requiring a Codex binary.

## Launch

The product command is `areal`. Use `target/debug/areal` after a source build; add only the bundle's `bin` directory to PATH. Place subcommand options after the subcommand.

| Command | Behavior |
| --- | --- |
| `areal [PROMPT]` | Open the TUI; submit an optional initial message once the session is ready |
| `areal version` / `areal --version` | Show the product version without starting services |
| `areal upgrade [--check]` | Check or upgrade a complete installed bundle; see [installation](installation.en.md) |
| `areal exec [PROMPT]` | Run noninteractively with text, JSON or stream-json output |
| `areal serve` | Start foreground Core + Runtime with cleanup owned by the launcher |
| `areal app-server` | Start Core directly; Runtime connections require explicit deployment |
| `areal config show/validate` | Inspect redacted configuration or validate it without starting services |
| `areal trajectory status/retry/sync-config` | Inspect the trajectory queue, requeue failed records, or apply persistent export control; output JSON |
| `areal service` / `areal web` | Manage shared services or open Web |
| `areal workgroup run/inspect` | Run isolated workgroups or inspect their state |

Migration: replace `areal-tui …` with `areal …`, `areal-server …` with `areal app-server …`, its `config` command with `areal config …`, and `areal-workgroup …` with `areal workgroup …`. The old standalone executables are no longer built or distributed. `areal -p/--print …` retains the existing noninteractive protocol and is equivalent to `areal exec …`. Bare `areal` now opens the TUI; automation must select `exec` or `-p`. `--prompt`, `--goal` and `--input-file` retain the original TUI headless behavior and conflict with positional PROMPT.

```sh
target/debug/areal
target/debug/areal --resume THREAD_ID
target/debug/areal exec --workspace /absolute/task 'Describe the task'
# Connect using the authentication file in the existing Core data directory
target/debug/areal --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json
```

Without an endpoint, interactive TUI attaches to a shared Core/Runtime on a random loopback port. Multiple windows in the same workspace reuse it; closing a window leaves service and tasks running. `--prompt`, `--goal` and `--input-file` default to owned mode and clean up on exit. `--local-mode shared|owned` overrides this choice. Explicit endpoint (alias `--remote`) only connects and cannot be combined with local deployment arguments.

Shared mode defaults to a workspace-specific data directory under `~/.areal/instances/`; explicit data configuration keeps its precedence. To open old `~/.areal-harness/state` history, specify `--data-dir` or bind it after stopping the old Core. Model TOML changes reload automatically; other TOML changes restart after background work settles, while permission/deployment argument changes require explicit restart. Discovery, migration, logs and Desktop integration are specified in [local services](../api/local-service.en.md).

TUI model credentials come from the environment that starts Core. Export the key variable in your terminal, then select its name with the provider's TOML `api_key_env = "MY_MODEL_KEY"`, `AREAL_HARNESS_API_KEY_ENV=MY_MODEL_KEY`, or `--api-key-env MY_MODEL_KEY`. CLI takes precedence over the environment override, then TOML. Encrypted keys saved by the GUI do not automatically enter an independent TUI's environment. Sharing the model catalog does not share those keys. Missing or invalid credentials identify the environment variable; you can exit after session creation fails and correct the configuration.

Changing your terminal environment does not update a running Core. For an existing shared service, run `areal service restart` with the same configuration, workspace, and deployment arguments, then start the TUI. Wait for background work to settle rather than canceling it to update a key. `Ctrl-R` only reconnects and cannot inject a new key. With `--endpoint`, configure credentials in the remote Core's launch environment. Keep key values out of command arguments and TOML. See the [model configuration examples](configuration.en.md#shared-gui-and-cli-model-catalog).

```sh
target/debug/areal web --workspace /absolute/task
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
```

`areal exec 'prompt' --output-format stream-json --verbose` provides noninteractive CLI operation; `areal serve` starts a persistent service. See the [CLI contract](../api/claude-cli.en.md) for arguments, authentication, resume and exit codes. Web is served at `/ui`; `areal web` opens it and signs in automatically without copying a token. Direct visits without a valid session can use the local token from `security/auth.json` in the service data directory.

Local `areal exec` owns Core/Runtime through a supervised launcher. macOS uses the existing trusted-service launch adapter and requires a working `/usr/bin/python3`; Linux launches directly. Normal CLI shutdown waits for the actual launcher's cleanup receipt. Early startup exits report their status, and invalid readiness or authentication files trigger cleanup of the owned services before returning an error. An explicit `--endpoint` connection does not own the remote service lifecycle.

TUI `--input-file /absolute/input.json` is mutually exclusive with `--prompt` and accepts a Core Input array up to 2 MiB, for example `[{"type":"text","text":"Inspect the image"},{"type":"localImage","path":"/absolute/image.png"}]`. Both local and explicit-endpoint modes support it; the trusted launcher forwards `--tui --input-file`. Media paths and fields remain subject to [Core API](../api/core.en.md) validation.

## Web controls and appearance

Web uses a neutral workbench layout: a collapsible 240px sidebar, a task heading with view tabs, centered conversation content, and a rounded composer. Its light and dark appearance follows the AReaLGameAgent workbench. It follows the system by default; use “Settings → Appearance” at the bottom of the sidebar to override it. The preference is stored in the current browser. Narrow screens use a dismissible navigation drawer.

- Create, select, refresh, or paginate tasks from the sidebar. New tasks center the composer; once history exists, the composer stays at the bottom.
- `areal web` signs in automatically. One-time links last 60 seconds and sessions last one hour. After expiry or service restart, run the command again or enter a token in “Settings → Local connection”; errors appear in settings. With a valid session, reload to reconnect and restore the task snapshot.
- Enter sends; Shift + Enter inserts a newline. Confirming an input-method candidate does not send. While a task runs, send additional instructions or stop execution.
- Web input starting with `/` opens command suggestions and supports `/help`, `/new`, `/refresh`, `/goal`, `/skills` and `/skill NAME`. Use `Skills` below the composer or `/skills` to select a Skill for the current task.
- The Web sidebar's delete-session button archives through Core. Stop an active Goal and settle queues/resources first. Confirmation removes the session from the list; disk history and deduplication receipts remain, so this is not permanent erasure.
- Expand “Persistent goal” above the composer to inspect budget and progress, create or edit a goal, pause, resume, or clear it. The stop button pauses an active Goal; automatic continuation Turns retain their source label.
- “Task history” displays messages and expandable tool results; UNKNOWN tool results still require an inspection record. “Collaborative tasks and acceptance” retains plan submission, progress queries, cancellation, and revision controls.

The Web client owns appearance and navigation; task, permission, and execution state come from Core.

Web and TUI retain displayed user inputs, follow-up instructions, and Agent replies after context compaction. Completion, interruption, and failure merge the message suffix carried by the event; refreshing or reconnecting restores complete history from Core. See the [Core API](../api/core.en.md#transport-and-sessions) for merge rules.

TUI headers and Web show YOLO/ASK_PERMISSIONS and Core remains authoritative. TUI approvals show effective arguments; ↑/↓ selects deny/allow once/remember session/project, Enter submits, Esc denies and PgUp/PgDn scrolls arguments. Deny is selected initially. Web provides equivalent buttons. Forced approvals only offer single-use answers. `/permissions` displays mode, source and memory; `/permissions clear-session` or `clear-project` revokes remembered grants. See [configuration](configuration.en.md#permissions). `--prompt`/`--input-file` cannot answer interactive requests: they interrupt and return an error asking for interactive TUI/Web.

## TUI controls

| Control | Behavior |
| --- | --- |
| Enter | Start a Turn when idle; steer while running |
| ←/→, Option+←/→, Ctrl-A / Ctrl-E | In the editor, move by grapheme; Option+←/→ (Alt+b / Alt+f) jump to the previous word start / next word end using Codex word boundaries; Ctrl-A / Ctrl-E jump to the current line start / end |
| Ctrl-D / Delete, Backspace | Delete the grapheme at / before the cursor; empty input or the corresponding boundary is a no-op, without exiting |
| `/`, Tab, Esc | Slash candidates, completion and dismissal |
| Ctrl-C / Ctrl-Q | Ctrl-C pauses the current Goal or interrupts its active Turn, and exits the TUI when no task is active; Ctrl-Q exits the TUI from any view |
| Ctrl-R | Reconnect and restore a snapshot without replay |
| F5, `/sessions`, `/new`, `/open ID` | Select, create or open sessions |
| F6, `/model` | Select a model or reset to default while idle |
| `/skills`, `/skill NAME` | Choose or apply a Skill for the current session |
| F2, `/theme` | Preview; Enter saves and Esc reverts |
| `/agents`, `/executions`, F4 | Subtask progress, verification, and delivery |
| F3, `/topology` | Session history tree and root topology |
| `/spawn prompt` | Delegate a read-only analysis child of the active Turn through the unified entry point |
| `/tasks` | Current task plan |
| `/execution-cancel ID` | Stop a subtask and let Core settle usage and resources |
| `/groups`, `/group ID`, `/group-start FILE` | Advanced legacy Workgroup history and explicit plans |
| PageUp/PageDown/Home, End | Read history; End resumes following |
| Click a history summary | Expand the group, then an individual record; the wheel scrolls |
| ↑/↓, Enter/Space, ←/→ | With history focused: select, toggle, collapse/expand; Esc returns to input |
| Ctrl-O, `/details` | Toggle compact/detailed history, preserving local expansion choices |
| `/restore-input` | Restore input retained after a failed or unconfirmed submission |

`/quit` followed by Enter exits from the input or when entered as the complete filter in a picker. A `/` typed from navigation or history focuses the input. Ctrl-Q remains available in all dialogs. When disconnected, awaiting a restored snapshot, or awaiting submission confirmation, Ctrl-C asks you to inspect the status; Ctrl-Q still explicitly exits. Exiting a shared TUI leaves Core and its background tasks running.

`AREAL_TEST_BIN=/absolute/fixed-slot/areal python3 scripts/tui-recovery-smoke.py` uses isolated Core/Runtime, a real PTY, and a local model to verify environment credential recovery, cancellation, and exit. It retains terminal screens and a report. It makes no real provider calls and does not modify user configuration.

Subtask lists are paginated; TUI `/more` loads later records. Waiting or disconnecting does not replay child execution, and Core owns cancellation. Manual `/spawn` defaults to read-only analysis. Submit development requests through the ordinary prompt so the coordinator can declare modification and delivery intent.

`--prompt` emits only the current Turn's text, writes Thread ID to stderr and exits nonzero on failure. It skips TUI preferences. See [appearance configuration](configuration.en.md#tui).

`--prompt` and `--input-file` accept explicit `--no-session-name` to disable display-only automatic naming while preserving persistent history; `areal serve --tui` forwards the same option. The client checks Core support before creating or observing a session through the existing entry, changes only the naming option, and waits for configuration acceptance before submitting the task. Configuration conflicts fail without an automatic retry. Omitting the flag preserves the existing choice. It is unavailable in fullscreen TUI or with `--goal`; the matching `areal exec/-p` option is described in the [CLI contract](../api/claude-cli.en.md). This only avoids optional naming requests; task token or latency savings have not been measured.

## Reasoning and waiting state

Web displays Chat Completions / Responses reasoning in an expandable section, labeled as a reasoning summary when only summary text is available, separately from the answer. While waiting for body text it shows whether reasoning has arrived and how many seconds this page has observed the wait. After 30 seconds it offers a reminder to keep waiting, refresh, or stop. This is a UI reminder, not a model timeout or stop signal. Refresh preserves the observation timer for the same request; reopening the page starts timing from the new observation.

Refresh shows its pending state and replaces history with the latest Core snapshot. Stop shows a pending state after submitting cancellation and waits for Core to settle the task and tools. Controls are disabled while disconnected; the server task may continue. Refresh after reconnecting to confirm state without automatically resending the task.

TUI starts with compact history: consecutive tool calls, reasoning and commentary form one Activity summary. Arguments, successful output previews and reasoning require explicit expansion. Final answers stay visible; legacy messages without a phase remain visible. Click a group and then a record, or focus history with Tab and use the keys above. `--mouse=false` disables capture for native terminal selection.

Failure reasons persist beside the affected Turn, even after reconnect; empty Agent titles are omitted. Partial replies are marked incomplete. Goal blockage, pending interactions, automatic retries and unconfirmed usage have explicit notices. Failed submissions restore the original input only when the editor is empty; `/restore-input` explicitly replaces the current draft. A disconnected session awaits synchronization and never automatically resends submissions or tools. Noninteractive output retains its existing body-text behavior. See [TUI design](../design/tui.en.md) and [Core API](../api/core.en.md#reasoning-progress).

## History, recovery and observability

Core retains original history and tool intents/results; context compaction only changes future model input. At the start of each Turn, Core selects and reads project instruction files through Runtime in order from the workspace root to the resolved session cwd (including platform path aliases). Files must be regular UTF-8 files, with a combined content limit of 32 KiB and a directory-chain limit of 64 levels; reads reject symlink files and directories replaced by symlinks. Missing files are skipped; siblings and subtrees below cwd are not scanned. The resolved cwd must remain inside the Runtime workspace. In each directory, Core selects the first non-empty (after trimming whitespace) file in this order: `AGENTS.override.md`, then `AGENTS.md`. Only one file is loaded per directory; an override replaces its sibling file and retains ancestor guidance. Invalid candidates (non-regular files, invalid UTF-8 or size violations) fail the Turn instead of falling back; an unselected regular file is not read. This follows [OpenAI project instruction precedence](https://learn.chatgpt.com/docs/agent-configuration/agents-md); discovery remains workspace-scoped and does not read the Codex global directory or custom fallback filenames. Each file applies to its directory and descendants; closer rules take precedence, while user requests and deployment permissions override project rules. The model is instructed to read applicable rules before working in other directories; automatic loading does not follow temporary tool-command cwd changes. Instructions stay fixed within a Turn and are refreshed on the next Turn.

Ordinary tasks use one delegation entry point. Core chooses shared or isolated execution from the declared intent, dependencies, effective permissions, and runtime capabilities; users do not select a workspace mode. GUI Subtasks, TUI `/executions`, and Web Subtasks and Delivery read the same Core projection and distinguish execution, verification, and delivery. Producing a candidate, passing checks, and applying changes are separate states; conflicts or partial application do not mean delivery succeeded. Advanced controls retain [legacy Workgroups](workgroups.en.md) and historical tasks. GUI can preview candidate files and apply the complete change set; Core validates and executes delivery. Continue the original task to accept a candidate when it is no longer active. Per-file application is not offered.

Restart marks unconfirmed tools/hooks UNKNOWN and blocks new Turns. Inspect actual files/processes, then record the inspection in Web or via `areal/tool/acknowledge`. History remains unknown. This neither replays operations nor approves permissions or restores old processes. Corrupt snapshots are not silently discarded.

```sh
export OTEL_SERVICE_NAME='areal-core'
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4318'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
make server
```

OTLP supports HTTP/protobuf only. It is disabled without an endpoint and can be disabled with `OTEL_SDK_DISABLED=true`. Trajectories contain actual model inputs/outputs and tool arguments/results, together with IDs, usage, status and timing, without redaction. Export failure does not change Turn outcomes; see [reporting configuration](configuration.en.md#opentelemetry-trajectory-reporting).

<a id="goals"></a>

## Goal mode

No configuration change is needed. In TUI, `/goal Complete the module migration and pass its tests` creates and starts a Goal; `/goal` reads it. `/goal-pause` pauses; after Turn cleanup, `/goal-resume` resumes. `/goal-edit New objective` and `/goal-budget 200000` (or `none`) edit a stopped Goal while retaining usage. `/goal-clear` requires a stopped Goal with settled queues/resources. Web provides the same controls in its Goal panel.

Clients display status, token usage, active time, Turn count and stop reasons, and label automatic continuation Turns. Ordinary final text only ends its Turn. The model reports completion through `goal_update`; Core commits the final state after resource settlement. User input takes priority over automatic continuation and invalidates prior completion requests.

```sh
make tui ARGS='--goal "Complete the module migration and pass its tests" --goal-token-budget 200000'
target/debug/areal --endpoint ws://127.0.0.1:4500 --goal 'Inspect the code and prepare migration recommendations'
```

`--goal` conflicts with `--prompt`/`--input-file`. `--resume THREAD_ID` can create a new Goal in an existing idle Thread. Headless mode waits across Turns, exits successfully only for completed, and prints Goal JSON/reasons with a nonzero exit for other stopped states. Remote headless exit/disconnection does not cancel server execution; owned local launcher exit shuts down its Core; shared mode only disconnects. Use interactive `/open` and `/goal-resume` for stopped Goals. Ordinary `--prompt` and Claude CLI retain single-execution semantics.

Core restart restores active Goals as paused/serverRestarted; `thread/resume` does not restart them. Unknown model usage retains its reservation; explicit Goal resume acknowledges it without erasing consumption. Tool UNKNOWN still needs inspection and acknowledgement. Budget, active-time, Turn or history exhaustion stops execution without automatic retry. See [configuration](configuration.en.md#goals) and [Core API](../api/core.en.md#goals).

## Background tasks and Inbox

Core exposes a unified [Task Mode API](../api/tasks.en.md) for foreground, scheduled and background work. Models may ask asynchronously even inside foreground Goals; the Task Channel is separate from execution conversations. Find questions with inbox/list and answer with channel/reply. The Web Background and schedules tab provides creation, progress, channels, pause, resume and cancellation. The sidebar Inbox is independent of the selected execution conversation. A dedicated TUI Inbox panel remains to be integrated; API clients use channel/reply rather than interaction/respond for asynchronous answers.

Background tasks can use asynchronous questions or headless execution. Schedules bind to the selected conversation, accept a local date/time and an optional fixed repeat interval, and default to headless. Headless is an interaction policy; ordinary headless conversations and Goals do not automatically create schedules. Accepted controls still need execution to settle; replying while paused does not resume a task. Refreshing the Inbox retains current form drafts, while a full page reload can retrieve durable questions again.

TUI headless and Claude CLI without a bidirectional response channel use headless interaction policy. Explicit bidirectional stream-json retains host responses; dontAsk still forbids waiting. In headless mode, questions immediately return unavailable and tools requiring human approval are denied, allowing other work or a blocker report. To continue after closing a window, use a persistent shared or external Core service; an owned launcher still shuts down its service on exit.

The TUI captures the mouse by default for clicking and scrolling. Use `areal --mouse=false` for native terminal drag selection, then use the terminal copy shortcut. Ctrl-C continues to interrupt tasks.

## Unified remote app-server

GUI Cloud settings use the fixed `/openapi/v1/app-server/` service address and saving does not connect. Each new session UUID becomes its workspace; see the [GUI guide](../../clients/gui/README.en.md#cloud-backend-configuration). CLI/TUI `--endpoint` continues to accept the full native endpoint including workspace.

GUI, CLI, and TUI can connect to the same native AReaL WebSocket service. Arena provisions a workspace and UPFS; a remote machine or Docker host runs `areal serve` ahead of time. Only endpoint and credentials change. Without `--agent`, CLI/TUI select a single deployed Profile automatically. With zero or multiple Profiles they retain the server default configuration without guessing a candidate. Use `--agent id@revision` to pin a Profile. GUI Cloud requires at most one deployed Profile. Cold connections have a three-minute deadline.

```sh
# TUI; change only endpoint and credential file for a direct remote server
areal --endpoint ws://127.0.0.1:18088/openapi/v1/app-server/my-workspace/ --auth-file /private/arena-auth.json
# CLI uses the same protocol with optional streaming JSON
areal exec --endpoint ws://127.0.0.1:18457/ --auth-file /private/remote-auth.json --output-format stream-json --verbose 'Inspect the workspace'
```

Credentials use the native security/auth.json shape, with `principals[0].token`. Servers must offer compatible `areal.core.v1` capabilities; this is not a claim of complete OpenAI Codex extension support. The following `areal cloud` command remains the legacy batch HTTP compatibility entry, not native remote mode.

Remote CLI and GUI Cloud resume select `areal/thread/observe` when advertised. With older Core versions they read state through `thread/read` (GUI explicitly requests complete Turn history) and subscribe when submitting the next turn, without taking over an existing desktop tool host through `thread/resume`. The legacy read and subscription are not atomic; permission and network failures do not trigger fallback retries.

## Cloud

`areal cloud` connects to a generic HTTP backend and submits stateless Tasks without starting local Core, mounting the local project, using UPFS, or selecting or synchronizing a Harness. Persistent GUI Sessions are described in the [GUI guide](../../clients/gui/README.en.md#cloud-backend-configuration). The backend must accept `{ "prompt": "..." }` on `POST /harness-tasks` and choose runtime, model, and task environment through server-side defaults. The client does not guess a Harness or stream; backends without this default contract reject submission.


Cloud can use a configuration file without any local model configuration:

```toml
schema_version = 1
[cloud]
url = "https://backend.example/openapi/v1"
token_file = "cloud-token"
# Or token_env = "MY_CLOUD_TOKEN"; do not configure both.
```

Run `areal cloud --config ./config.toml exec 'Complete the task'`. Configuration discovery follows the shared order: `--config`, `AREAL_HARNESS_CONFIG`, `$AREAL_HARNESS_HOME/config.toml`, then `~/.areal/config.toml`. A relative `token_file` in the file is resolved against its directory; CLI/environment token paths are relative to the working directory. URL precedence is explicit argument, environment, then file. Credential precedence is `--token-file`, `AREAL_CLOUD_TOKEN_FILE`, `AREAL_CLOUD_TOKEN`, then the file credential reference; without a reference, `AREAL_CLOUD_TOKEN` is used. Plaintext token fields are not accepted in configuration files.

```sh
export AREAL_CLOUD_URL=https://backend.example/openapi/v1
export AREAL_CLOUD_TOKEN_FILE=/absolute/path/to/private-token
areal cloud exec 'Complete the task and produce artifacts'
areal cloud exec --no-wait 'Run the task in the background'
areal cloud status JOB_ID
areal cloud result TASK_ID
areal cloud artifact TASK_ID artifact.json --output ./artifact.json
```

Run `node scripts/cloud-task-smoke.mjs` locally to exercise the current CLI build against an isolated HTTP protocol fixture. It checks waiting, background acceptance, status/results, artifact downloads, failed outcomes, and no replay after an unknown submission. It does not validate a real Arena deployment, sandbox, or model.

The token file contains only the raw token and must have Unix permissions `0600` or stricter. `AREAL_CLOUD_TOKEN` is also supported; there is no token argument that would expose it in process arguments. `--url` and `--token-file` override environment variables. GUI credentials use separate system-encrypted storage and are not exported to the CLI.

Without a prompt argument, `exec` reads up to 1 MiB from stdin. It waits up to 900 seconds by default, adjustable through `--timeout-seconds`. JSON output first reports acceptance identities, then TaskResult and artifacts. DONE alone is insufficient: the result must also be OK. `--no-wait` proves acceptance only. Timeout or CLI exit does not cancel the remote task; use the returned IDs to query it. POST requests are never automatically replayed after network failure; retain the request UUID printed to stderr to reconcile an unknown submission.

Use the raw IDs from the acceptance receipt for queries and downloads. The CLI escapes URL path segments, including colons in Task IDs, for compatibility with the API Space gateway. Do not pre-encode IDs as `%3A`.
