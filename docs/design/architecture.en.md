[中文](architecture.md) | **English**

# Architecture and repository

AReaL-Harness follows **Clients → Core → Runtime**. Core exclusively owns sessions, Turns, model loops and agent state. Runtime handles execution permissions, operation facts and resource lifecycles. Clients project the authoritative history rather than maintaining another one.

![Architecture](diagrams/architecture.svg)

[draw.io source](diagrams/architecture.drawio) · [PNG](diagrams/architecture.png) · [Diagram style](STYLE_GUIDE.en.md)

## Responsibilities

| Module | Responsibility |
|---|---|
| `clients/cli`, `clients/tui`, `clients/web` | CLI, terminal and local Web; connection setup, projections and requests |
| `clients/gui` | React/Electron desktop client; narrow IPC, native resources, public service discovery and rebuildable projections |
| `core/config` | User configuration, provenance, credential references, Skill directories and the tool-host proxy environment allowlist; no Engine/Runtime dependency |
| `core/protocol` | Client protocol projections and shared types |
| `core/engine` | Models, tools, history, persistence, child tasks and Workgroups |
| `core/app-server` | WebSocket, authentication, subscriptions and callback correlation; no separate history |
| `core/local-service` | Shared discovery, configuration compatibility and control client; depends on config/protocol |
| `core/service-host` | Rust trusted launcher and independent local service host; manages Core/Runtime lifecycles and private pipes |
| `core/server` | Configuration, models, MCP, Hosts, Runtime and shutdown assembly |
| `core/mcp` | Official rmcp client and result adaptation; no Turn ownership |
| `core/sdk-typescript` | Selected DSH tools/filesystem adaptation and independent Node Host |
| `runtime/protocol`, `runtime/client` | Independent execution contract and Rust private-pipe client |
| `runtime/supervisor` | Scopes, narrowing permissions, ancestor budgets, deduplication and cleanup |
| `runtime/host-tools` | Trusted host tool discovery shared by Core and the native backend; no task execution or permission grants |
| `runtime/exec-native`, `runtime/fs-helper` | OS sandbox, processes/PTYs and descriptor-based file operations |
| `runtime/daemon` | Binary, Cordis assembly and private RPC |
| `runtime/sdk-typescript` | Low-level Node.js SDK for a trusted host with an exclusive connection |

`supervisor` depends on `protocol`; `exec-native` implements its backend interface; the daemon assembles them. Engine does not depend on app-server or clients. Server resolves and injects configuration; SDKs do not discover user configuration themselves.

Linux `exec-native` starts a separate Rust binary provided by the same crate, `areal-runtime-reaper`, for each execution. It becomes a subreaper and owns waiting for and reaping the command and adopted descendants. Runtime waits for the helper and validates its private exit/cleanup receipt. The helper ships with the daemon and file helper in `libexec/areal` and does not require Python. macOS supplements process-group cleanup with `libproc` tracking and termination of observed descendants. These responsibilities stay outside the Core model loop and do not replace an outer service manager or container init; see the [Runtime cleanup contract](../api/runtime.en.md#output-and-cleanup) for platform differences and limits.

Engine’s `trajectory` module records model and tool execution content through `tracing`; server’s `telemetry` module assembles the standard OpenTelemetry Traces/Logs SDK and OTLP exporters. Engine does not read telemetry environment variables or depend on an export backend; see [reporting configuration](../guides/configuration.en.md#opentelemetry-trajectory-reporting).

Server injects a shared Engine capture budget when installing telemetry. Engine uses borrowed serialization and bounded streaming buffers for logical messages and final model requests; exhaustion drops only the telemetry copy. The durable event bridge owns Turn sequences and terminal manifests so receivers can distinguish completed execution from complete delivery. See the [Core trajectory contract](../api/core.en.md#durable-trajectory-protocol).

Optional persistent trajectory export uses `[trajectory]` parsed by `core/config`. `core/server/trajectory` owns bounded memory buffering, the disk queue, and an independent upload process. Queues default to the user home and are isolated by configuration-file identity, with services and owned CLI runs sharing the queue of their configuration; network uploads are outside Turn settlement and Runtime lifecycles. CLI/TUI use a cancellable background check for a single warning; GUI polls according to visibility. Clients only inspect export status and request retries. Receivers accept standard OTLP Logs; platform analysis registration belongs to receiver integrations. See [persistent trajectory export](../guides/configuration.en.md#persistent-trajectory-export) for configuration, capacity, and failure boundaries.

Skill discovery in `core/config` uses trusted launch parameters and returns metadata with individual warnings. Engine also reuses its stateless header parser for explicit deployment registration, without locating user configuration itself. `core/engine/src/desktop/skills.rs` retains registered directory descriptors and asynchronously reads bounded pages of current resources without Skill content snapshots. See the [Skill guide](../guides/skills.en.md) for configuration and read contracts.

`core/engine/src/goals` owns persistent Goals, request ledgers and continuation across Turns. User queues and automatic continuation share one admission entry point. Clients maintain projections and Runtime retains its execution boundary. See the [Core API](../api/core.en.md#goals).

Interactive TUI and Web launchers attach to one service per deployment. The host survives windows while Store retains its exclusive writer lock. Desktop Main can reuse the same discovery/control entry point; see [local services](../api/local-service.en.md).

`core/engine/src/task_mode` owns Tasks/TaskRuns, time triggers, independent Channels and workers. It reuses Goal ledgers and Thread admission; communication state belongs to Core. Inbox projects authorized questions. TaskRun workers survive coordinator Turns in independent Sessions while Core owns cancellation and settlement. See the [Task contract](../api/tasks.en.md).

![Task Mode](diagrams/task-mode-mailbox-architecture.svg)

[draw.io source](diagrams/task-mode-mailbox-architecture.drawio) · [Asynchronous interaction flow](diagrams/task-mode-mailbox-flow.svg) · [Flow source](diagrams/task-mode-mailbox-flow.drawio)

`clients/cli` provides the Rust command executable, `areal`, dispatching to library entry points for TUI, noninteractive execution, Core server and the service host. Core never depends on clients. The Rust launcher in `core/service-host` owns separate Core/Runtime processes and private lifetime pipes without Python on Linux; on macOS, `/usr/bin/python3` is the actual launching parent of the trusted service-host, launcher, Core and Runtime processes to accommodate local executable launch constraints. `core/local-service/native_process` only adapts service-chain process identity, explicit descriptors and lifecycles; it does not make Runtime sandbox or permission decisions. `scripts/launch.py` remains available for development scripts and independent benchmark entry points. The bundle exposes only `areal` in `bin`; Runtime daemon/file helpers live in `libexec/areal` and are not linked into the client process. See the [client guide](../guides/clients.en.md) for commands.

## State and execution

Changes within a Thread are serialized; different Threads progress concurrently. Model, tool and child-task waits do not retain the session lock. Model permits are released during tool execution. Active Turns, model requests and OS processes have separate limits.

Tools persist intent before dispatch to Runtime or an external host, then record confirmed outcomes. Snapshots retain authoritative history; media and large original tool results are stored as SHA-256-addressed Blobs; owning Thread call records authorize result references, and model projections are generated once and persisted with history. Restart marks unfinished execution UNKNOWN without replay. Archiving releases hot history; GC after drain reclaims unreferenced Blobs.

Ordinary [agent delegation](multi-agent.en.md) shares a workspace with independent context; [Workgroups](workgroups.en.md) use isolated writable workspaces and verified artifacts. Core schedules; Runtime does not select width. Plugins, stdio MCP and Core remain trusted hosts. Broker restrictions do not sandbox the Host itself; see [plugin boundaries](plugins.en.md).

Optional [research agents](../guides/tools.en.md#research-agents) use Core-managed read-only source access, private scratch and shared budgets. Dispatch is asynchronous by default and model-selected. Short-handle caches belong to the active Turn, survive compaction and expire on completion; Store retains original execution history. The model HTTP layer audits redacted parameters and usage; incomplete-response recovery does not replay executed tools. See [Core API](../api/core.en.md#recovery).

`core/engine/src/model/tool_calls.rs` centralizes request-level tool buffer budgets and sanitized diagnostics. Engine supplies execution allowances; model adapters bound resource use while accumulating responses. Automatic lossless media compression belongs to modality preprocessing with separate round-trip verification. The current tool buffer budget counts original UTF-8 bytes and does not trigger media compression.

Engine’s `diagnostics` module bounds non-authoritative diagnostic retention; server wires startup and periodic collection. service-host manages leases and cleanup for host/launcher logs and handshake temporary directories. Diagnostic cleanup preserves history and Goal recovery semantics; policies are described in [Core API](../api/core.en.md#recovery) and the [local service contract](../api/local-service.en.md).

The Fork and Side development preview reuses these Core/Runtime owners. Engine creates independent root Threads/Sessions, and Store retains immutable inherited or reference snapshots for each target. `conversation.origin` carries no agent delegation, cancellation or permission inheritance. Fork branches conversation history in the current shared workspace. Side's persistent read-only role is checked at legacy execution routes, model tools and Runtime Scopes. Main and Side share the `Messages` and `ConversationComposer` presentation boundary (Lexical input and model-catalog menu); their controllers retain separate drafts, first-question receipts and configuration ownership. Renderer projects paged history, related discussions and draft insertion; hiding a panel preserves Core work, and bringing an answer back only appends to the local draft. See the [desktop API](../api/desktop.en.md#turn-fork-development-preview) for protocol and access boundaries. Source implementation and focused checks do not establish complete P0 acceptance; the native desktop path, combined acceptance, packaged app and real-provider evidence remain separate pending requirements.

Ordinary Shared Browser loading uses Chromium system proxy, DNS, and site policies. Main isolates active control ports and exposes no product bridge to pages. The adapter binds a new user send to its exact Turn and GUI connection; the first Core-approved discovery lazily binds the current native Page without stealing a host through `thread/resume`. Main fences page reads and actions before dispatching human keyboard or mouse input, drains pending synthetic input, then delivers the first human event. Core read and action permissions bind the Page, control generation, and concrete plan; UNKNOWN is never replayed. See the [Browser contract](../api/browser.en.md) for the flow and limits.

## Repository layout

Desktop ownership follows the [migration decision](../adr/0001-desktop-client-module.en.md). The independent Electron adapter retains OS credentials and subscription forwarding and connects through the public shared-service API. GUI exit preserves Core work. See the [GUI guide](../../clients/gui/README.en.md) for builds, isolation and local packages. Mobile source migration is deferred.

The adapter's project connection owner manages backoff, connection identity and snapshot resubscription. Passive recovery connects only to compatible running services without starting or restarting Core or replaying unknown submissions. Workbench shares the desktop capability contract; Main and service entry points validate their permitted capabilities and retain structured errors. Core still owns final configuration and execution validation. Electron Main owns native previews, releases them by project/Thread and bounds cached pages; the UI retains reconstructable URLs. See the GUI guide's lifecycle section for recovery, type coverage and page-state loss boundaries.

```text
core/                       Config, protocol, Engine, server, MCP, plugin SDK
clients/                    CLI, TUI, local Web, GUI
runtime/                    Protocol, supervisor, OS backend, file helper, SDK
schemas/                    Pinned upstream and AReaL machine contracts
examples/desktop-api/        Direct API, CLI and package validation
scripts/                    Build, checks, launch and smoke tests
upstream/pins.json          Upstream sources and pinned versions
tests/fixtures/             Deterministic tools, hooks and MCP
tests/e2e/docker/           Controlled Linux execution image
tests/perf/                 lite/pro, runners, graders and statistics
tests/perf/suites/pro/cases/*/environment/  Public Dockerfiles, initial inputs and runtime checks
docs/guides/               Usage and configuration
docs/api/                  Interface contracts
docs/design/               Layers, mechanisms and diagrams/ sources/previews
docs/development/          Development, tests and dependency maintenance
docs/examples/             Example documentation
docs/benchmarks/           Running benchmarks and reports/ historical results
```

See [Core](../api/core.en.md), [Runtime](../api/runtime.en.md) and [SDK](../api/typescript-sdk.en.md) for interfaces, [capabilities](../features.en.md) for support and [testing](../development/testing.en.md) for validation.

Core server owns configuration polling and model assembly; Engine pins model revisions at submission and preserves queue snapshots. Local service clients handle safe restart and discovery; Runtime permissions remain deployment boundaries. See [configuration](../guides/configuration.en.md).

Core `permissions` owns approval modes, precedence and persisted exact-request memory; Clients display requests and submit answers. Runtime independently enforces the deployment ceiling and narrowed Scopes. Local full-access is selected by the trusted launcher. See [permissions](../guides/configuration.en.md#permissions).

`integrations/envarena` is an optional platform adapter layer containing the EnvArena runner, dedicated packaging/input smoke scripts and unit tests. It consumes standalone Core/Runtime entry points, projects terminal outcomes and collects artifacts without owning the model loop. Core, Runtime, SDKs, default checks and standalone releases do not depend on it. Adapter checks and the Linux zipapp build require explicit selection; see [testing](../development/testing.en.md#optional-platform-adapters) and the [Core API](../api/core.en.md#structured-terminal-outcomes).

`core/config` owns model catalog parsing, validation, credential-state diagnostics and controlled file writes. `core/server` installs its execution projection into Engine at startup and reuses credential resolution rules. Clients use public configuration commands without duplicating TOML parsing or credential rules. Desktop secure storage supplies keys and injection provenance only through the trusted adapter; Core returns credential sources and readiness, and the renderer does not read keys. No authentication reuses the shared file semantics of an absent credential reference without another provider configuration. The GUI defaults to the CLI's user configuration file; `core/local-service` selects an independent registry without changing configuration lookup, while the GUI deployment keeps runtime data isolated. Shared saves and safe restarts are separate; tasks retain their model snapshots. See the [configuration guide](../guides/configuration.en.md#shared-gui-and-cli-model-catalog).

Store owns authoritative history as hot snapshots plus immutable SHA-256 segments. It syncs segments before publishing snapshot references. Model projection uses bounded checkpoints and recent items; history retrieval pages through original records. Goal accounting similarly rolls settled requests into segments while retaining cumulative usage and unresolved reservations. These storage details remain inside Core and do not change Runtime ownership.

`core/engine/src/delegation.rs` provides unified delegation and execution projections, storing identity, ownership and backend references while existing Thread/Turn and Workgroup state remain authoritative. Core coordinates shared-writer leases, isolated snapshots and delivery; Runtime does not select strategies. `workgroup/delivery.rs` composes candidates, invokes trusted acceptance and journals delivery receipts; `runtime/fs-helper/src/delivery.rs` implements bounded staged commits and conditional deletion. Clients display unified child work and delivery projections, retaining advanced legacy history. See [unified delegation](../api/core.en.md#agent-tools).

Arena public input import/manifests belong to Runner; read-only directory identity, file-operation rejection and OS mount protection belong to Runtime. Core media tools produce bounded image/animation views and model adapters measure final request bytes. Runner owns no model loop. See [tools](../guides/tools.en.md), [Runtime](../api/runtime.en.md) and [benchmarks](../benchmarks/README.en.md).

Shared Browser keeps sessions, approval and history in Core, authenticated tool callbacks in the independent desktop adapter, native Pages in Electron Main, and state projection in Renderer. Implemented capabilities are discovered from the Host; persistent Profiles and cloud browsers remain deferred. See the [Browser specification](browser.en.md), [Browser API](../api/browser.en.md), and [ownership decision](../adr/0002-shared-browser-ownership.en.md) for contracts and limits. Source implementation does not establish installed-app or human acceptance. Human-only independent Frame grants and per-Frame capture privacy checks also belong to Main, bind the current Human Page, grant no cross-origin Agent capability, and reuse existing ThreadBlob/MediaRef.

`core/engine/src/goals/rsi.rs` owns explicit RSI goals, candidate state, and human winner selection. Native isolation reuses independent candidate execution and frozen inputs from `workgroup/service`. Clients project persistent state and submit selection. See [RSI Goal](../api/core.en.md#rsi-goal-extensions).
