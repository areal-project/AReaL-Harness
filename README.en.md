[中文](README.md) | **English**

<div align="center">
  <img src="docs/assets/milk-tea-logo.svg" alt="AReaL-Harness milk tea logo" width="112" height="126">
  <h1>AReaL-Harness</h1>
  <p><strong>A modular framework for tool execution and multi-agent collaboration</strong></p>
  <p>Composable Core · Independent Runtime · Persistent sessions</p>
  <p>
    <a href="docs/design/architecture.en.md"><img src="https://img.shields.io/badge/Rust-Tokio-000000?logo=rust&amp;logoColor=white" alt="Built with Rust and Tokio"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="Apache-2.0 license"></a>
    <a href="docs/guides/installation.en.md"><img src="https://img.shields.io/badge/Status-Developer%20preview-orange" alt="Development preview: view installation methods"></a>
  </p>
  <p><a href="docs/guides/quickstart.en.md">Quickstart</a> · <a href="docs/features.en.md">Capabilities &amp; limitations</a> · <a href="docs/README.en.md">Documentation</a> · <a href="CONTRIBUTING.en.md">Contributing</a></p>
</div>

![AReaL-Harness architecture: Clients → Core → Runtime](docs/design/diagrams/architecture.svg)

## 🎯 Focus On

- **Multi-Agent**: Split tasks, coordinate dependencies, and collect results through agent delegation and Workgroup.
- **Unlimited Context**: Continue sessions through context compaction and checkpoints while retaining the original history.
- **Long-Horizon Tasks**: Advance work across multiple stages with persistent sessions, task plans, and recovery mechanisms.
- **Efficient Execution**: Use Rust and Tokio for asynchronous execution and layered concurrency control, aiming for high throughput with low runtime overhead.

See [capabilities and limitations](docs/features.en.md) for the implemented scope and its boundaries. Core, Runtime, standalone releases and standard OTLP trajectory export do not depend on Arena; platform adapters integrate optionally through public interfaces.

## 🖥️ TUI

See the [client guide](docs/guides/clients.en.md) for details.

![AReaL-Harness TUI: conversation, session plan, and input area](docs/assets/tui.png)

## 🌐 WebUI

Local Web is available through `areal web`; see the [client guide](docs/guides/clients.en.md).

## 🚀 Start here

> [!NOTE]
> The project is under development. Availability of complete macOS arm64 / Linux x86_64 standalone bundles and the macOS Homebrew formula depends on GitHub Releases and the tap. Restricted Linux execution requires Bubblewrap and user namespaces. Native Windows Runtime and npm CLI/SDK packages are not published.

For your first run, follow the [quickstart](docs/guides/quickstart.en.md) to build, verify without an API key, and start a model session. Then choose a guide below.

| You want to… | Read |
|---|---|
| Work in a terminal | [CLI and TUI](docs/guides/clients.en.md) |
| Configure models, credentials, and execution permissions | [Configuration](docs/guides/configuration.en.md) · [Runtime deployment](docs/guides/runtime.en.md) |
| Connect tools and reusable instructions | [Tools and hooks](docs/guides/tools.en.md) · [MCP](docs/guides/mcp.en.md) · [Skills](docs/guides/skills.en.md) |
| Coordinate multiple agents | [Agent delegation](docs/design/multi-agent.en.md) · [Workgroup guide](docs/guides/workgroups.en.md) |
| Integrate with your own application | [Core API](docs/api/core.en.md) · [Runtime API](docs/api/runtime.en.md) · [TypeScript SDK](docs/api/typescript-sdk.en.md) · [Examples](docs/examples/desktop-api.en.md) |
| Understand and develop the internals | [Architecture and layout](docs/design/architecture.en.md) · [Development](docs/development/README.en.md) |
| Run benchmarks and interpret results | [Benchmarks](docs/benchmarks/README.en.md) · [Methodology](docs/benchmarks/methodology.en.md) |

Browse the [full documentation](docs/README.en.md), or read the [security policy](SECURITY.en.md) for trust boundaries and vulnerability reporting.

## 🤝 Contributing

Try the project, [report issues](https://github.com/areal-project/AReaL-Harness/issues), or contribute an improvement. Read the [contribution guide](CONTRIBUTING.en.md) before getting started.

## Acknowledgments and license

Uses [cordis-rs](https://github.com/dshbox/cordis-rs) components and draws on Codex protocol and DeepSeek Harness plugin interfaces. Sources are recorded in [upstream/pins.json](upstream/pins.json).

**License:** [Apache-2.0](LICENSE). Third-party materials retain their own licenses and copyright notices.

See [installation](docs/guides/installation.en.md) for supported platforms, channels and upgrades.
