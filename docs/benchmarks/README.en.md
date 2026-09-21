[中文](README.md) | **English**

# Docker benchmarks

`scripts/perf` compares end-to-end task outcomes for real Harness, Codex and Claude Code. Harness launches this repository's TUI/Core/Runtime; the adapter launches and projects statistics without another model loop. See [testing](../development/testing.en.md) for capacity regression.

## Environment and first run

Requires Python 3.11+, Docker/BuildKit and sufficient image storage. Use native Linux amd64 for formal comparisons; cross-architecture emulation is not a same-platform baseline. The host must permit Bubblewrap user/PID namespaces and seccomp. Investigate failed sandbox smoke tests rather than disabling the sandbox to score tasks.

```sh
./scripts/perf self-test
./scripts/perf build
./scripts/perf smoke-loop
cp tests/perf/model.example.toml tests/perf/model.toml
read -r -s AREAL_PERF_API_KEY
export AREAL_PERF_API_KEY
./scripts/perf doctor --model-config tests/perf/model.toml
./scripts/perf run --task lite \
  --runner harness --runner codex --runner claudecode \
  --model-config tests/perf/model.toml --repeat 5 --seed 163
```

self-test and smoke-loop require no real model credentials; smoke-loop uses actual CLIs and local fixtures. Edit model.toml for your reachable service before reading its key; omit credential steps for anonymous services. The file is Git-ignored. For Harness alone, build with `--without-codex --without-claudecode` and select only harness in run.

Interactive `make perf` selects suite/runners/repetitions and prints a summary. Trial failures are reported as results; configuration/orchestration errors exit nonzero. Automation uses run, which exits nonzero on trial failure by default; explicit --allow-failures permits continued reporting.

## Models and images

perf TOML is separate from Core configuration: model, base_url, protocol and api_key_env. Protocol is completions/responses/anthropic. base_url is an API root to which the gateway appends endpoints; Core instead expects a complete model endpoint URL. Do not interchange them. Container gateways map localhost to host.docker.internal.

An LLM-Rosetta sidecar routes requests upstream. runner_upstreams may select native protocols per CLI while sharing model and credentials. parameters supports reasoning_effort/reasoning_summary/verbosity; unsupported runner fields are recorded as unapplied. Identical names do not establish equivalent budgets.

```sh
docker build -f tests/perf/gateway.Dockerfile -t areal-perf-gateway:source-0.13.0 .
./scripts/perf doctor --model-config tests/perf/model.toml \
  --gateway-image areal-perf-gateway:source-0.13.0
```

When using this pinned-source gateway, pass the same gateway-image to run. Default runner versions are pinned in the [Dockerfile](../../tests/e2e/docker/Dockerfile). Builds record image IDs and source fingerprints; preparation and Runtime smoke are outside task timing. Linux Harness uses outer-container-perf; see [deployment boundaries](../guides/runtime.en.md).

<a id="suites"></a>
## lite and pro

| Suite | Environment and grading |
|---|---|
| lite | Local repository tasks, a private workspace per trial and a separate network-disabled grader container |
| pro | Prompts/oracles from 20 pinned external Envs; local Dockerfiles and initial inputs build public amd64 environments. Tests are injected into the same container after Agent exit |

See the [snapshot notes](../../tests/perf/suites/pro/README.en.md) for pro provenance and constraints. fetch-pro validates local materials. build-pro builds environments without a model; run builds and caches the selected tasks automatically. The first build needs public image and package repositories, with no internal credentials:

```sh
./scripts/perf fetch-pro
./scripts/perf build-pro --case tbpc002004-match-device-observation-lines
./scripts/perf run --task pro --runner harness --runner codex --runner claudecode \
  --model-config tests/perf/model.toml --repeat 1 --seed 163 \
  --output target/perf/formal --allow-failures
```

Repeat `--case ID` to select subsets; omit it for all cases. pro uses areal-pro-strict-v1: a nonempty suite with all tests passing and none skipped scores 1. Invalid grading and failure reasons remain visible; scores are not directly comparable with the platform's core-only policy. Model credentials reach only the gateway, never Agent/grader processes.

## Resume and results

run.json saves each trial, report.json holds summaries, and trials/ retains logs, workspaces, grading and events. After interruption, append `--resume-run <batch-directory>` to the original command with unchanged source, configuration and images. Completed trials are not rerun. Environment changes require new batches.

```sh
./scripts/perf report target/perf/formal/pro/RUN_ID
```

--fail-fast pauses on the first failure while retaining evidence. Preserve the whole batch, including redacted configuration, source/task digests, image identities and attempts. See [methodology](methodology.en.md) for interpretation and [reports](reports/README.en.md) for historical results. Task formats are defined by [lite fixtures](../../tests/perf/cases/) and [perf.py](../../tests/perf/perf.py).
