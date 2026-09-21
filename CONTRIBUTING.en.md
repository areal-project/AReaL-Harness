[中文](CONTRIBUTING.md) | **English**

# Contributing

Read the [quickstart](docs/guides/quickstart.en.md), [architecture](docs/design/architecture.en.md) and [repository instructions](AGENTS.md), then run `make setup` and `make verify` as described in [development](docs/development/README.en.md). Changes to native Runtime, plugins or Workgroups also require the relevant [integration tests](docs/development/testing.en.md).

Bug reports should include commit, platform, a minimal reproduction and expected behavior. Follow the [private reporting process](SECURITY.en.md) for security issues. Use synthetic data; do not commit credentials, session data, personal configuration or machine-specific absolute paths.

Keep changes focused and follow Clients → Core → Runtime dependencies. Update types, callers, examples and both documentation languages with interface/configuration changes. PRs explain purpose, compatibility, documentation locations and actual validation results, including checks not run and why. Documentation-only changes need link checks and example review.

Use locked dependencies and do not bypass failing sandbox tests with unsandboxed execution. This project and contributions use [Apache-2.0](LICENSE).
