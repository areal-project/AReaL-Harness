[中文](architecture.md) | **English**

# Architecture and repository

AReaL-Harness follows **Clients → Core → Runtime**. Core exclusively owns sessions, Turns, model loops and agent state. Runtime handles execution permissions, operation facts and resource lifecycles. Clients project the authoritative history rather than maintaining another one.

![Architecture](diagrams/architecture.svg)

[draw.io source](diagrams/architecture.drawio) · [PNG](diagrams/architecture.png) · [Diagram style](STYLE_GUIDE.en.md)

## Responsibilities

| Module | Responsibility |
|---|---|
| `clients/cli`, `clients/tui`, `clients/web` | CLI, terminal and local Web; connection setup, projections and requests |
| `core/config` | User configuration, provenance, credential references, Skill directories and the tool-host proxy environment allowlist; no Engine/Runtime dependency |
| `core/protocol` | Client protocol projections and shared types |
| `core/engine` | Models, tools, history, persistence, child tasks and Workgroups |
| `core/app-server` | WebSocket, authentication, subscriptions and callback correlation; no separate history |
| `core/local-service` | Shared discovery, configuration compatibility and control client; depends on config/protocol |
| `core/service-host` | Independent local Core/Runtime lifecycle owner; invokes the trusted launcher |
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

Engine’s `trajectory` module records model and tool execution content through `tracing`; server’s `telemetry` module assembles the standard OpenTelemetry Traces/Logs SDK and OTLP exporters. Engine does not read telemetry environment variables or depend on an export backend; see [reporting configuration](../guides/configuration.en.md#opentelemetry-trajectory-reporting).

Skill discovery in `core/config` uses trusted launch parameters and returns metadata with individual warnings. Engine also reuses its stateless header parser for explicit deployment registration, without locating user configuration itself. `core/engine/src/desktop/skills.rs` retains registered directory descriptors and asynchronously reads bounded pages of current resources without Skill content snapshots. See the [Skill guide](../guides/skills.en.md) for configuration and read contracts.

`core/engine/src/goals` owns persistent Goals, request ledgers and continuation across Turns. User queues and automatic continuation share one admission entry point. Clients maintain projections and Runtime retains its execution boundary. See the [Core API](../api/core.en.md#goals).

Interactive TUI and Web launchers attach to one service per deployment. The host survives windows while Store retains its exclusive writer lock. Desktop Main can reuse the same discovery/control entry point; see [local services](../api/local-service.en.md).

`core/engine/src/task_mode` owns Tasks/TaskRuns, time triggers, independent Channels and workers. It reuses Goal ledgers and Thread admission; communication state belongs to Core. Inbox projects authorized questions. TaskRun workers survive coordinator Turns in independent Sessions while Core owns cancellation and settlement. See the [Task contract](../api/tasks.en.md).

![Task Mode](diagrams/task-mode-mailbox-architecture.svg)

[draw.io source](diagrams/task-mode-mailbox-architecture.drawio) · [Asynchronous interaction flow](diagrams/task-mode-mailbox-flow.svg) · [Flow source](diagrams/task-mode-mailbox-flow.drawio)

`clients/cli` provides the sole product executable, `areal`, dispatching to library entry points for TUI, noninteractive execution, Core server and the service host. Core never depends on clients. `scripts/launch.py` still owns separate Core/Runtime processes and private lifetime pipes. The bundle exposes only `areal` in `bin`; Runtime daemon/file helpers live in `libexec/areal` and are not linked into the client process. See the [client guide](../guides/clients.en.md) for commands.

## State and execution

Changes within a Thread are serialized; different Threads progress concurrently. Model, tool and child-task waits do not retain the session lock. Model permits are released during tool execution. Active Turns, model requests and OS processes have separate limits.

Tools persist intent before dispatch to Runtime or an external host, then record confirmed outcomes. Snapshots retain authoritative history; media and large original tool results are stored as SHA-256-addressed Blobs; owning Thread call records authorize result references, and model projections are generated once and persisted with history. Restart marks unfinished execution UNKNOWN without replay. Archiving releases hot history; GC after drain reclaims unreferenced Blobs.

Ordinary [agent delegation](multi-agent.en.md) shares a workspace with independent context; [Workgroups](workgroups.en.md) use isolated writable workspaces and verified artifacts. Core schedules; Runtime does not select width. Plugins, stdio MCP and Core remain trusted hosts. Broker restrictions do not sandbox the Host itself; see [plugin boundaries](plugins.en.md).

Optional [research agents](../guides/tools.en.md#research-agents) use Core-managed read-only source access, private scratch and shared budgets. Dispatch is asynchronous by default and model-selected. Short-handle caches belong to the active Turn, survive compaction and expire on completion; Store retains original execution history. The model HTTP layer audits redacted parameters and usage; incomplete-response recovery does not replay executed tools. See [Core API](../api/core.en.md#recovery).

`core/engine/src/model/tool_calls.rs` centralizes request-level tool buffer budgets and sanitized diagnostics. Engine supplies execution allowances; model adapters bound resource use while accumulating responses. Automatic lossless media compression belongs to modality preprocessing with separate round-trip verification. The current tool buffer budget counts original UTF-8 bytes and does not trigger media compression.

## Repository layout

```text
core/                       Config, protocol, Engine, server, MCP, plugin SDK
clients/                    CLI, TUI, local Web
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

`integrations/envarena` contains runner adapter sources for native release packages. It projects Core terminal outcomes and collects artifacts without owning the model loop. See [Core API](../api/core.en.md#structured-terminal-outcomes).
