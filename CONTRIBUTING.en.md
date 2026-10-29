[中文](CONTRIBUTING.md) | **English**

# Contributing

Read the [quickstart](docs/guides/quickstart.en.md), [architecture](docs/design/architecture.en.md) and [repository instructions](AGENTS.md), then run `make setup` and `make verify` as described in [development](docs/development/README.en.md). Changes to native Runtime, plugins or Workgroups also require the relevant [integration tests](docs/development/testing.en.md).

Bug reports should include commit, platform, a minimal reproduction and expected behavior. Follow the [private reporting process](SECURITY.en.md) for security issues. Use synthetic data; do not commit credentials, session data, personal configuration or machine-specific absolute paths.

For GUI pages, components, styling, motion or UI copy, read the [design-system workflow](clients/gui/design-system/README.md#开工顺序) before editing and follow its [delivery criteria](clients/gui/design-system/governance.md#完成条件).

Keep changes focused and follow Clients → Core → Runtime dependencies. Update types, callers, examples and both documentation languages with interface/configuration changes. PRs explain purpose, compatibility, documentation locations and actual validation results, including checks not run and why. Documentation-only changes need link checks and example review.

Deliver behavior, tests, and verification rules together. Before implementation, run `make check-changed CI_BASE=<actual-comparison-ref> ARGS=--plan` and use the generated required checks. Shared interfaces, lockfiles, build scripts, CI changes, and unknown paths broaden selection. For behavior or interface changes, review schemas, callers, assertions and fixtures, the test manifest, environment capabilities, artifact dependencies, and documentation together. Existing coverage can be retained with execution evidence; new capabilities and prerequisites must be registered in the shared plan. Migrate tests to current product entry points while retaining underlying compatibility, security, and UNKNOWN contracts.

Run focused checks before committing and `make check-changed CI_BASE=<actual-comparison-ref>` on the final commit before pushing. This runs affected quick checks plus previously unsuccessful checks and their dependencies. Full local validation remains available through `make ci-preflight CI_BASE=<actual-comparison-ref>`. Installed commit hooks validate the staged manifest and generate its impact plan; push hooks require a clean HEAD and execute the same quick checks and failure follow-ups. Historical reports only guide selection; passing results are never reused. See the [testing guide](docs/development/testing.en.md) for report discovery and progress commands. Remote CI independently recalculates the plan and checks the current source, run/attempt, required checks, and results. Missing, failed, cancelled, blocked, or invalidated evidence cannot pass. Only rule-defined inapplicable checks may skip. Delivery requires all applicable required gates for the current commit to pass while retaining first-attempt failures. Measure first-attempt green rate, time to first credible failure, total feedback time, and runner minutes without hiding instability behind reruns.

Use locked dependencies and do not bypass failing sandbox tests with unsandboxed execution. This project and contributions use [Apache-2.0](LICENSE).
