[中文](README.md) | **English**

<div align="center">
  <h1>AReaL-Harness</h1>
  <p><strong>A modular framework for agent execution</strong></p>
  <p>Independent Runtime · Composable Core · CLI, TUI and local Web</p>
  <p><a href="docs/guides/quickstart.en.md">Quickstart</a> · <a href="docs/README.en.md">Documentation</a> · <a href="docs/design/architecture.en.md">Architecture</a> · <a href="CONTRIBUTING.en.md">Contributing</a></p>
</div>

AReaL-Harness is built with Rust and Tokio. Core manages models, tool loops and multi-agent tasks; Runtime owns execution permissions and resources. Clients share one authoritative conversation history.

The project is under development and distributed as source. The full local toolchain targets trusted macOS hosts; Linux tool execution is limited to a controlled Docker environment. The SDKs are not published on npm. See [capabilities and limitations](docs/features.en.md).

| Start here | Contents |
|---|---|
| [Quickstart](docs/guides/quickstart.en.md) | Build, credential-free checks and your first model session |
| [Documentation](docs/README.en.md) | Guides, APIs, architecture, development and benchmarks |
| [Development](docs/development/README.en.md) | Dependencies, checks and contribution workflow |
| [Security](SECURITY.en.md) | Trust boundaries and vulnerability reporting |

Uses [cordis-rs](https://github.com/dshbox/cordis-rs) components and draws on Codex protocol and DeepSeek Harness plugin interfaces. Sources are recorded in [upstream/pins.json](upstream/pins.json).

**License:** [Apache-2.0](LICENSE). Third-party materials retain their own licenses and copyright notices.
