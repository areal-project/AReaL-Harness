[中文](architecture.md) | **English**

# Architecture and repository

AReaL-Harness follows **Clients → Core → Runtime**. Core exclusively owns sessions, Turns, model loops and agent state. Runtime handles execution permissions, operation facts and resource lifecycles. Clients project the authoritative history rather than maintaining another one.

![Architecture](diagrams/architecture.svg)

[draw.io source](diagrams/architecture.drawio) · [PNG](diagrams/architecture.png) · [Diagram style](STYLE_GUIDE.en.md)

## Responsibilities

| Module | Responsibility |
|---|---|
| `clients/cli`, `clients/tui`, `clients/web` | CLI, terminal and local Web; connection setup, projections and requests |
| `core/config` | User configuration, sources, credential references and Skill discovery; independent of Engine and Runtime |
| `core/protocol` | Client protocol projections and shared types |
| `core/engine` | Models, tools, history, persistence, child tasks and Workgroups |
| `core/app-server` | WebSocket, authentication, subscriptions and callback correlation; no separate history |
| `core/server` | Configuration, models, MCP, Hosts, Runtime and shutdown assembly |
| `core/mcp` | Official rmcp client and result adaptation; no Turn ownership |
| `core/sdk-typescript` | Selected DSH tools/filesystem adaptation and independent Node Host |
| `runtime/protocol`, `runtime/client` | Independent execution contract and Rust private-pipe client |
| `runtime/supervisor` | Scopes, narrowing permissions, ancestor budgets, deduplication and cleanup |
| `runtime/exec-native`, `runtime/fs-helper` | OS sandbox, processes/PTYs and descriptor-based file operations |
| `runtime/daemon` | Binary, Cordis assembly and private RPC |
| `runtime/sdk-typescript` | Low-level Node.js SDK for a trusted host with an exclusive connection |

`supervisor` depends on `protocol`; `exec-native` implements its backend interface; the daemon assembles them. Engine does not depend on app-server or clients. Server resolves and injects configuration; SDKs do not discover user configuration themselves.

Skill discovery in `core/config` uses trusted launch parameters and returns metadata with individual warnings. Engine also reuses its stateless header parser for explicit deployment registration, without locating user configuration itself. `core/engine/src/desktop/skills.rs` retains registered directory descriptors and asynchronously reads bounded pages of current resources without Skill content snapshots. See the [Skill guide](../guides/skills.en.md) for configuration and read contracts.

## State and execution

Changes within a Thread are serialized; different Threads progress concurrently. Model, tool and child-task waits do not retain the session lock. Model permits are released during tool execution. Active Turns, model requests and OS processes have separate limits.

Tools persist intent before dispatch to Runtime or an external host, then record confirmed outcomes. Snapshots retain authoritative history; media is stored as SHA-256-addressed Blobs. Restart marks unfinished execution UNKNOWN without replay. Archiving releases hot history; GC after drain reclaims unreferenced Blobs.

Ordinary [agent delegation](multi-agent.en.md) shares a workspace with independent context; [Workgroups](workgroups.en.md) use isolated writable workspaces and verified artifacts. Core schedules; Runtime does not select width. Plugins, stdio MCP and Core remain trusted hosts. Broker restrictions do not sandbox the Host itself; see [plugin boundaries](plugins.en.md).

Optional [research agents](../guides/tools.en.md#research-agents) use Core-managed read-only source access, private scratch and shared budgets. Dispatch is asynchronous by default and model-selected. Short-handle caches belong to the active Turn, survive compaction and expire on completion; Store retains original execution history. The model HTTP layer audits redacted parameters and usage; incomplete-response recovery does not replay executed tools. See [Core API](../api/core.en.md#recovery).

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
