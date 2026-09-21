[中文](features.md) | **English**

# Capabilities and limitations

This page describes implemented behavior. Compilation, mechanism tests and real-task benefits require separate evidence. See the [architecture](design/architecture.en.md).

| Capability | Implementation and entry point |
|---|---|
| Sessions and models | Persistent Threads/Turns, streaming, steering, cancellation and resume; Chat Completions / Responses, with modalities constrained by adapter and model. [Clients](guides/clients.en.md) |
| Files and processes | Conditional writes, commands, stdin, PTYs, bounded output, narrowing Scopes and cleanup. [Runtime](api/runtime.en.md) |
| Tool extensions | Command tools, hooks, client callbacks, MCP stdio/Streamable HTTP and trusted Node plugin Hosts. [Tools](guides/tools.en.md) |
| Multiple agents | Model delegation, independent histories, shared workspace, checkpoints and result aggregation. [Agent design](design/multi-agent.en.md) |
| Workgroups | DAGs, isolated writable workspaces, artifact verification and integration; fixed/auto/adaptive admission through CLI and service. [Guide](guides/workgroups.en.md) |
| Desktop interface | Authentication, Profiles/Skills/Plans, approvals/questions, submission receipts and queues, shared terminals, configuration CAS, model switching, media Blobs, archiving and GC. [Desktop API](api/desktop.en.md) |
| Clients | CLI, TUI and local Web; selected Claude Code noninteractive arguments and messages. [CLI contract](api/claude-cli.en.md) |
| Skills | Discovery and explicit Profiles share metadata registration and on-demand body/attachment reads; invalid individual global Skills are isolated with warnings, without content snapshots. [Skill guide](guides/skills.en.md) |
| SDKs | Private in-repository `@areal/runtime` and `@areal/plugins` packages; Node.js 22.19.0+. [SDK contracts](api/typescript-sdk.en.md) |
| Observability and validation | tracing and optional OTLP; deterministic regression tests, native smoke tests and Docker lite/pro benchmarks. [Testing](development/testing.en.md) |

## Limitations

- Full local tool execution uses macOS Seatbelt. Linux only has the controlled Docker `outer-container-perf` profile. General production Linux and Windows native Runtime support is unavailable.
- Core, stdio MCP servers and plugin Hosts are trusted processes outside the Runtime OS sandbox. Remote services own their permissions. Approvals cannot expand deployment grants.
- `UNKNOWN` requires inspection and is never automatically replayed. There is no cross-epoch Runtime recovery, external-writer CAS, cross-file transaction or verified cleanup of all escaped descendants.
- A pinned Codex app-server subset and Claude CLI message adaptation do not establish full official-client compatibility. DSH support covers selected tools/filesystem services, not Core loop replacement.
- Workgroups support up to 64 tasks and 32 Workers; the CLI defaults to `balanced + fixed` with 2 Workers. Greater width or adaptive admission does not guarantee a speedup.
- Real GUI integration, signed/notarized packages, third-party services and production capacity need independent validation. All 20 pro cases provide [public Dockerfiles](../tests/perf/suites/pro/README.en.md); historical source images are provenance only.
