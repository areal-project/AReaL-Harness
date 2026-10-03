[中文](features.md) | **English**

# Capabilities and limitations

This page describes implemented behavior. Compilation, mechanism tests and real-task benefits require separate evidence. See the [architecture](design/architecture.en.md).

| Capability | Implementation and entry point |
|---|---|
| Task Mode and channels | foreground/scheduled/background, durable TaskRuns, independent Inbox replies, headless without human waits, and task_spawn workers surviving coordinator Turns under shared budgets. Web includes task controls, schedule creation and an independent Inbox. [API](api/tasks.en.md) |
| Sessions and models | Persistent Threads/Turns, streaming text, Chat Completions reasoning and Responses reasoning summary/text events, steering, cancellation and resume; Chat Completions / Responses, with modalities constrained by adapter and model. [Clients](guides/clients.en.md) |
| Files and processes | Conditional writes, commands, stdin, PTYs, bounded output, narrowing Scopes and cleanup. [Runtime](api/runtime.en.md) |
| Tool results | Bundled pinned rg, paged original historical results, and configurable search grouping/exact repeated-line views, defaulting to observe. [Tools](guides/tools.en.md) |
| Tool extensions | Command tools, hooks, client callbacks, MCP stdio/Streamable HTTP and trusted Node plugin Hosts. [Tools](guides/tools.en.md) |
| Network proxies | HTTP/HTTPS/SOCKS5 proxies, authentication and NO_PROXY for models, HTTP MCP and OTLP; trusted stdio MCP/plugin Hosts inherit proxy variables. [Configuration](guides/configuration.en.md#proxies) |
| Multiple agents | Model delegation, independent histories, shared workspace, checkpoints and result aggregation. [Agent design](design/multi-agent.en.md) |
| Workgroups | DAGs, isolated writable workspaces, artifact verification and integration; fixed/auto/adaptive admission through CLI and service. [Guide](guides/workgroups.en.md) |
| Permissions | Default local YOLO; configurable ASK_PERMISSIONS; TUI/Web approvals, exact session/project grants, automatic Thread scratch. [Configuration](guides/configuration.en.md#permissions) |
| Desktop interface | Authentication, Profiles/Skills/Plans, `--agent id@revision` selection, automatic startup of Profile-bound Workflows, approvals/questions, submission receipts and queues, shared terminals, configuration CAS, model switching, media Blobs, archiving and GC. [Desktop API](api/desktop.en.md) |
| Clients | Unified `areal` command (default TUI, exec, app-server, config, workgroup, service, web) and local Web; TUI has Unicode cursor editing and common input shortcuts, persistent errors, grouped traces collapsed by default, mouse/keyboard expansion and commentary/final phases; selected Claude Code noninteractive arguments and messages. [CLI contract](api/claude-cli.en.md) |
| Skills | Discovery and explicit Profiles share metadata registration and on-demand body/attachment reads; invalid individual global Skills are isolated with warnings, without content snapshots. [Skill guide](guides/skills.en.md) |
| Persistent Goals | Explicit creation through `/goal` or other clients, with no configuration toggle; automatic continuation across Turns, pause/resume/edit/clear, explicit reopening of completed Goals for acceptance repairs without resetting accounting, and user-input priority; root/child Agents, Workgroups and summaries share accounting. [Client guide](guides/clients.en.md#goals) · [API](api/core.en.md#goals) |
| Shared local services | Multiple TUI windows and Web reuse one Core/Runtime; local Web launches sign in automatically with one-time codes; public JSON discovery/control for Desktop Main, workspace isolation, model configuration reload, safe idle restart, explicit stop and crash cleanup. [Contract](api/local-service.en.md) |
| SDKs | Private in-repository `@areal/runtime` and `@areal/plugins` packages; Node.js 22.19.0+. [SDK contracts](api/typescript-sdk.en.md) |
| Observability and validation | Standard OpenTelemetry Traces and Events/Logs, full trajectory export through standard OTEL configuration (OTLP HTTP/protobuf); deterministic regression tests, native smoke tests and Docker lite/pro benchmarks. [Configuration](guides/configuration.en.md) · [Testing](development/testing.en.md) |

## Limitations

- Narrowed tool execution on macOS uses Seatbelt. Linux native uses Bubblewrap namespaces with Runtime seccomp and requires `/usr/bin/bwrap` plus user namespaces. Linux launchers support host execution in full-access mode, while the controlled Docker `outer-container-perf` profile remains the fixed benchmark workflow. Windows native Runtime support is unavailable.
- Core, stdio MCP servers and plugin Hosts are trusted processes outside the Runtime OS sandbox. Remote services own their permissions. Approvals cannot expand deployment grants.
- `UNKNOWN` requires inspection and is never automatically replayed. There is no cross-epoch Runtime recovery, external-writer CAS, cross-file transaction or verified cleanup of all escaped descendants.
- A pinned Codex app-server subset and Claude CLI message adaptation do not establish full official-client compatibility. DSH support covers selected tools/filesystem services, not Core loop replacement.
- Workgroups support up to 64 tasks and 32 Workers; the CLI defaults to `balanced + fixed` with 2 Workers. Greater width or adaptive admission does not guarantee a speedup.
- Real GUI integration, signed/notarized packages, third-party services and production capacity need independent validation. All 20 pro cases provide [public Dockerfiles](../tests/perf/suites/pro/README.en.md); historical source images are provenance only.
- Goals do not resume automatically after restart. Each ledger permits 4096 requests/4 MiB; history and Thread capacities remain bounded. clear retains ledgers, with no automatic ledger GC. Conservative tokenBudget admission estimates do not guarantee a strict provider billing ceiling; unknown consumption retains reservations and stops automatic continuation.

Release preparation supports macOS arm64 Homebrew formula generation and complete Linux x86_64 glibc bundles, including SHA256 verification, versioned Linux installation and relocated read/write checks. Availability depends on published GitHub Releases/tap; see [installation](guides/installation.en.md).
