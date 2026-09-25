[中文](clients.md) | **English**

# CLI, TUI and local Web

Complete the [quickstart](quickstart.en.md) first. Clients share Core history; Runtime executes tools without requiring a Codex binary.

## Launch

The product command is `areal`. Use `target/debug/areal` after a source build; add only the bundle's `bin` directory to PATH. Place subcommand options after the subcommand.

| Command | Behavior |
|---|---|
| `areal [PROMPT]` | Open the TUI; submit an optional initial message once the session is ready |
| `areal exec [PROMPT]` | Run noninteractively with text, JSON or stream-json output |
| `areal serve` | Start foreground Core + Runtime with cleanup owned by the launcher |
| `areal app-server` | Start Core directly; Runtime connections require explicit deployment |
| `areal config show/validate` | Inspect redacted configuration or validate it without starting services |
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

```sh
target/debug/areal web --workspace /absolute/task
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
```

`areal exec 'prompt' --output-format stream-json --verbose` provides noninteractive CLI operation; `areal serve` starts a persistent service. See the [CLI contract](../api/claude-cli.en.md) for arguments, authentication, resume and exit codes. Web is served at `/ui`; `areal web` opens it and signs in automatically without copying a token. Direct visits without a valid session can use the local token from `security/auth.json` in the service data directory.

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

TUI headers and Web show YOLO/ASK_PERMISSIONS and Core remains authoritative. TUI approvals show effective arguments; ↑/↓ selects deny/allow once/remember session/project, Enter submits, Esc denies and PgUp/PgDn scrolls arguments. Deny is selected initially. Web provides equivalent buttons. Forced approvals only offer single-use answers. `/permissions` displays mode, source and memory; `/permissions clear-session` or `clear-project` revokes remembered grants. See [configuration](configuration.en.md#permissions). `--prompt`/`--input-file` cannot answer interactive requests: they interrupt and return an error asking for interactive TUI/Web.

## TUI controls

| Control | Behavior |
|---|---|
| Enter | Start a Turn when idle; steer while running |
| ←/→, Ctrl-A / Ctrl-E | In the editor, move by grapheme or jump to the current line start / end |
| Ctrl-D / Delete, Backspace | Delete the grapheme at / before the cursor; empty input or the corresponding boundary is a no-op, without exiting |
| `/`, Tab, Esc | Slash candidates, completion and dismissal |
| Ctrl-C / Ctrl-Q | Pause the current Goal and cancel its Turn (interrupt the Turn without a Goal) / exit |
| Ctrl-R | Reconnect and restore a snapshot without replay |
| F5, `/sessions`, `/new`, `/open ID` | Select, create or open sessions |
| F6, `/model` | Select a model or reset to default while idle |
| `/skills`, `/skill NAME` | Choose or apply a Skill for the current session |
| F2, `/theme` | Preview; Enter saves and Esc reverts |
| `/agents`, F3, `/topology` | Child-task tree and root topology |
| `/spawn prompt` | Manually spawn a child of the active Turn |
| `/tasks`, `/groups` | Plan and Workgroups |
| PageUp/PageDown/Home, End | Read history; End resumes following |
| Click a history summary | Expand the group, then an individual record; the wheel scrolls |
| ↑/↓, Enter/Space, ←/→ | With history focused: select, toggle, collapse/expand; Esc returns to input |
| Ctrl-O, `/details` | Toggle compact/detailed history, preserving local expansion choices |
| `/restore-input` | Restore input retained after a failed or unconfirmed submission |

`--prompt` emits only the current Turn's text, writes Thread ID to stderr and exits nonzero on failure. It skips TUI preferences. See [appearance configuration](configuration.en.md#tui).

## Reasoning and waiting state

Web displays Chat Completions / Responses reasoning in an expandable section, labeled as a reasoning summary when only summary text is available, separately from the answer. While waiting for body text it shows whether reasoning has arrived and how many seconds this page has observed the wait. After 30 seconds it offers a reminder to keep waiting, refresh, or stop. This is a UI reminder, not a model timeout or stop signal. Refresh preserves the observation timer for the same request; reopening the page starts timing from the new observation.

Refresh shows its pending state and replaces history with the latest Core snapshot. Stop shows a pending state after submitting cancellation and waits for Core to settle the task and tools. Controls are disabled while disconnected; the server task may continue. Refresh after reconnecting to confirm state without automatically resending the task.

TUI starts with compact history: consecutive tool calls, reasoning and commentary form one Activity summary. Arguments, successful output previews and reasoning require explicit expansion. Final answers stay visible; legacy messages without a phase remain visible. Click a group and then a record, or focus history with Tab and use the keys above. `--mouse=false` disables capture for native terminal selection.

Failure reasons persist beside the affected Turn, even after reconnect; empty Agent titles are omitted. Partial replies are marked incomplete. Goal blockage, pending interactions, automatic retries and unconfirmed usage have explicit notices. Failed submissions restore the original input only when the editor is empty; `/restore-input` explicitly replaces the current draft. A disconnected session awaits synchronization and never automatically resends submissions or tools. Noninteractive output retains its existing body-text behavior. See [TUI design](../design/tui.en.md) and [Core API](../api/core.en.md#reasoning-progress).

## History, recovery and observability

Core retains original history and tool intents/results; context compaction only changes future model input. Workspace-root `AGENTS.md` is read through Runtime (regular UTF-8 file, up to 32 KiB); nested instructions are not recursively loaded. Default delegation shares the workspace; use [Workgroups](workgroups.en.md) for isolated writes.

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
