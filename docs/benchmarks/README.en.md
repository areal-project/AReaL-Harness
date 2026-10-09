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

## Arena lazy public inputs

The native Runner uses `lazy_files`: it imports `ARENA_QUERY_PATH`, optional frozen Harness rules and public files from `/problem_assets` into `workspace://scratch/public-inputs/`. The first turn carries only the task entry and JSONL manifest paths, capped at 64 KiB, without inline media or the full task. The manifest preserves original paths/aliases, MIME hints, byte counts and SHA-256; identical content shares a copy. Core `image_read` decodes and reports actual formats, dimensions and animation coverage. Shell commands use physical manifest paths, not workspace URIs. Inputs and diagnostic copies stay outside the repository/delivery directory.

Runner protects input through Runtime `--read-only-path` and verifies hashes at completion. Existing Graybox public paths and collection remain intact. Case/Env/Reward identities are unchanged. `public-inputs/`, `input-delivery.json` and `input-media.json` retain input files, envelope measurements and integrity results without Base64 or credentials in diagnostics. Packages must include `public_inputs.py` and Rust binaries built from the same source.

Build reproducible `areal-arena.pyz`, per-file manifests and SHA256SUMS with `scripts/package-arena.py --bin-dir <same-build release binaries> --utilities <tools and shared libraries> --settings <frozen settings.json> --target x86_64-unknown-linux-musl --output <new directory>`. Utilities contain `bin/bwrap`, `bin/tools/rg`, and `lib/`; preserve third-party licenses under `licenses/`. Packaging requires a clean source commit and checks ELF architecture. Before invoking Runner, the bootstrap verifies every archived file and the running architecture. Binaries must come from a release build with the pinned toolchain; retain build logs and image digests with the package. Before publishing, run `python3 scripts/arena-input-smoke.py --package <pyz>` in an isolated Linux container to exercise the actual archive, Runner, tools, visual input and result file. Registry artifact globs should include `public-inputs/**/*` and `input-delivery.json`.

Frozen settings accept `max_request_bytes` (a 16 MiB local default guard; set it to the actual gateway limit before publishing) and `context_compaction_enabled` (false by default; enable after separate evaluation). Wire bytes and context tokens are independent. Native 50 MiB paging and long-trajectory compaction are outside acceptance for this input fix.

Packages support the default `task_profile: "generic"` and `task_profile: "original"`. Use `original` for original-task comparisons: only the public-input Bootstrap is added, without Runner implementation or test advice. Native Core instructions are determined by the same build. The packaged `system-prompt.md` is an audit copy of the Core base instructions and does not override native instructions. Historical configurations requiring external delivery/piggy modules are outside this packaging entry point and are rejected during packaging.

Offline checks are `python3 -m unittest discover -s integrations/envarena`, `cargo test --locked -p areal-engine --lib` and `python3 scripts/arena-input-smoke.py --bin-dir target/debug`. The deterministic model verifies real CLI/Core/Runtime reads, PNG/GIF visual content, read-only enforcement and oversized-envelope diagnostics; it does not establish real-model reruns or scores for the four tasks. Online acceptance must freeze the new Harness ref/hash, retain original tasks/rewards and separately report input delivery, terminal status and original Reward.

Add `--public-inputs-dir <directory containing TASK.md and assets/>` to replay frozen real public attachments with the same fixture model; this remains distinct from online-model or Reward acceptance.
