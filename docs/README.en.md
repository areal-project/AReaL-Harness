[中文](README.md) | **English**

# Documentation

Start with the [quickstart](guides/quickstart.en.md). [Capabilities and limitations](features.en.md) is the single inventory of current support. Commands run from the repository root unless stated otherwise.

[Product vocabulary](../GLOSSARY.en.md) · [Desktop client migration decision (planned)](adr/0001-desktop-client-module.en.md)

[Pause and continue regular conversations](adr/0014-conversation-pause-and-continue.en.md) · [Scheduled conversation targets (in design)](adr/0015-scheduled-conversation-target.en.md)

| Category | Documents |
|---|---|
| Guides | [Quickstart](guides/quickstart.en.md) · [CLI, TUI and Web](guides/clients.en.md) · [Configuration](guides/configuration.en.md) · [Runtime deployment](guides/runtime.en.md) · [Desktop worktrees](guides/worktrees.en.md) |
| Extensions and collaboration | [Tools and hooks](guides/tools.en.md) · [MCP](guides/mcp.en.md) · [Skills](guides/skills.en.md) · [Workgroups](guides/workgroups.en.md) |
| API contracts | [Core](api/core.en.md) · [Desktop](api/desktop.en.md) · [Task Mode and channels](api/tasks.en.md) · [Browser](api/browser.en.md) · [Computer control](api/computer.en.md) · [Runtime](api/runtime.en.md) · [TypeScript SDKs](api/typescript-sdk.en.md) · [Native Host](api/native-host.en.md) · [Claude CLI](api/claude-cli.en.md) · [Local services](api/local-service.en.md) |
| Architecture | [Layers and repository](design/architecture.en.md) · [Context management](design/context-management.en.md) · [Agent delegation](design/multi-agent.en.md) · [Workgroups](design/workgroups.en.md) · [Plugins](design/plugins.en.md) · [TUI](design/tui.en.md) · [Diagram style](design/STYLE_GUIDE.en.md) |
| Runnable examples | [Desktop API and packaging](examples/desktop-api.en.md) · [DSH editor](examples/dsh-editor-plugin.en.md) |
| Development | [Development guide](development/README.en.md) · [Agent improvement goals and method](development/agent-improvement.en.md) · [Testing](development/testing.en.md) · [Cordis upgrades](development/cordis.en.md) |
| Benchmarks | [Running and resuming](benchmarks/README.en.md) · [Methodology](benchmarks/methodology.en.md) · [Historical reports](benchmarks/reports/README.en.md) · [Complex workflow repairs and retest](benchmarks/reports/complex-workflow-repair.en.md) · [Child-result consumption repair](benchmarks/reports/child-result-consumption.en.md) · [Native tool optimization](benchmarks/reports/tool-optimization.en.md) · [Delegation permissions and validation](benchmarks/reports/inspection-permissions-v2.en.md) |

Maintained pages pair a Chinese `.md` file with an English `.en.md` file in the same directory, linked at the top. Update both together. Machine schemas, code and shared diagrams have one copy. API contracts and their linked types/schemas define parameters; guides avoid duplicating them.

- [Installation and upgrades](guides/installation.en.md) · [Release workflow](development/releasing.en.md)

Remote v2 design and implementation boundaries: [architecture](design/remote-control.en.md) · [API](api/remote-control.en.md) · [connectivity and deployment](guides/remote-control.en.md) · [acceptance plan](development/remote-control-testing.en.md) · [Host ownership](adr/0008-remote-host-ownership.en.md) · [iOS v1 implementation spec](development/ios-remote-v1-spec.en.md). Each page distinguishes implemented slices from future design; these documents do not claim full P0 delivery.

Client UI implementation and design constraints: internal [design rules v1](../clients/gui/design-system/README.md) and [@areal/ui components and tokens](../clients/gui/packages/ui/README.en.md).

- [Answer feedback](guides/user-feedback.en.md)
