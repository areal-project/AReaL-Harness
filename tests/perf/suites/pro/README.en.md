[中文](README.md) | **English**

# pro: harness-bench-terminal

All 20 tasks build from local Dockerfiles and initial inputs. No internal registry, EnvArena, or OSS credentials are required. See the [benchmark guide](../../../../docs/benchmarks/README.en.md#suites) for execution and scoring.

```sh
./scripts/perf fetch-pro
./scripts/perf build-pro --case tbpc002004-match-device-observation-lines
# Omit --case to build all tasks; repeat it to select a subset.
```

`run --task pro` builds the selected environments and then adds the runners, outside task timing. `build-pro` makes no model calls. Base images use pinned public Docker Hub amd64 manifests. Builds need public package repositories; build first before running offline.

| Path | Contents |
|---|---|
| [benchmark.json](benchmark.json) | Original Benchmark version, digest, ordered Env references and weights |
| `cases/<id>/env.json` | Redacted Env provenance; historical image addresses use the `source.invalid` placeholder and are never pulled |
| `cases/<id>/environment/Dockerfile` | Public build recipe; the context is only that environment directory |
| `cases/<id>/environment/resources/` | Original initial inputs and unfinished implementations; no oracle |
| `cases/<id>/environment/origin.json` | Original image identity, Env digests before and after redaction, and initial file checksums |
| `cases/<id>/task.toml` | Local build, resource and grading configuration |
| `cases/<id>/prompt.md`, `oracle/` | Original prompt and hidden tests, injected only after Agent exit |

Build an individual task independently:

```sh
docker build --platform linux/amd64 -t observation-lines:local \
  tests/perf/suites/pro/cases/tbpc002004-match-device-observation-lines/environment
docker run --rm --platform linux/amd64 observation-lines:local \
  cat /app/public/corpus.txt
```

## Environment and scoring boundaries

Public recipes preserve initial task materials and remove internal sandbox services, internal certificates, and unrelated legacy `/testbed` contents. General tasks use public Python/GCC bases. Migration tasks pin Debian packages and check the runtime files required by the evaluator. The numerical task pins AlmaLinux Python RPMs and NumPy wheel hashes. The Git snapshot task preserves original objects and refs. The initial failing C shared library is compiled from source. Three originally empty workspaces remain empty.

`origin.json` describes the original inputs. Recompiled C binaries, system tools and image IDs may differ, so these builds are distinct from the historical private images and do not inherit their performance results. Fix dependencies if strict runtime validation fails; do not bypass evaluator checks. Copied materials retain their original copyright, canary and license notices and remain subject to their respective license terms.

Historical registry names and namespaces are redacted; tags, image digests and task inputs are unchanged. `source_env_sha256` verifies the redacted `env.json` in this repository, while `unredacted_source_env_sha256` preserves the original file digest. `content_hash` remains the digest recorded by the source platform, not a hash of the redacted file.

The chess oracle vendors `chess 1.11.2` under GPL-3.0-or-later, with its [provenance](cases/tbpc030001-enumerate-legal-chess-successors/oracle/vendor/chess/PROVENANCE.txt) and [upstream license](cases/tbpc030001-enumerate-legal-chess-successors/oracle/vendor/chess/LICENSE.txt). This benchmark reference material is not bundled with the Harness product binaries. Third-party materials retain their own licenses; the repository's Apache-2.0 license does not relicense them.

`areal-pro-strict-v1` awards 1 only when a nonempty test suite passes with no skips. Agent and grader share an exclusive container; model credentials go only to the gateway. Limits are 2 CPUs, 4 GiB and 512 PIDs; Agent timeouts come from the Env and grading allows 7200 seconds. Results are not directly interchangeable with the platform's core-only scores.

`environment.build` selects the isolated build directory; `environment.image` is a local tag prefix, with the build digest appended to the actual tag. These replace the former internal-image configuration. Strict runtimes are checked again after runner installation.

Update provenance, inputs, build recipes and oracle together. The build cache includes recipes, resources and executable bits; reports record the public image ID and build digest. Start a new batch after environment changes instead of resuming historical private-image batches.
