[中文](workgroups.md) | **English**

# Using Workgroups

Workgroups give writing tasks and verifiers private workspaces/Runtimes through the production Engine. Completion requires final combined checks. They target trusted macOS hosts; see [agents](../design/multi-agent.en.md) for shared-workspace delegation.

## Standalone CLI

Configure a [model](configuration.en.md) first. This Python example needs a materialized trusted toolchain without symlinks, including `bin/python3`, and input source containing the referenced tests.

```sh
cargo build --locked --workspace
target/debug/areal-workgroup run \
  --workspace /absolute/source --state-dir /absolute/runs/new-run \
  --plan /absolute/plan.json --checks /absolute/checks.json \
  --runtime "$PWD/target/debug/areal-runtime" \
  --file-helper "$PWD/target/debug/areal-runtime-fs" \
  --toolchain /absolute/materialized-python \
  --strategy balanced --workers 2 --seconds 600
```

state-dir must be a new, nonexistent directory outside the source tree. Toolchain and attempt storage cannot overlap as equal or ancestor paths. Input is a snapshot source; output goes to `<state-dir>/candidate/` without overwriting the original checkout. Avoid external edits while snapshotting.

## Plan and checks

`plan.json`:

```json
{"objective":"Implement a parser","tasks":[{"id":"parser","instruction":"Implement parse(text): parse JSON Lines into objects, reject non-object records, preserve order.","writes":["parser.py"],"depends":[],"checks":[[".toolchain/bin/python3","-B","-m","unittest","tests.test_parser"]]}]}
```

`checks.json`:

```json
[[".toolchain/bin/python3","-B","-m","unittest","discover","-s","tests"]]
```

writes are exact relative filenames, excluding directories, globs and escaping paths. depends waits for prerequisite integration; integrationDepends delays verification only, allowing implementation against an agreed interface. Their union must be acyclic. Final checks must be nonempty and controlled by the trusted caller; editable tests or `true` cannot establish quality.

Model planning replaces `--plan` with `--prompt-file` and requires `--write-scope` (a JSON array of exact paths). Planning cannot expand grants and consumes root budget.

## Strategies and budgets

| Option | Default and range |
|---|---|
| strategy | balanced; single packs into one agent, contract preserves boundaries, cohesion merges shared writes, balanced also merges small tasks/serial boundaries |
| workers / admission | 2 (1–32) / fixed; auto bounds unverified tasks to W+1; adaptive adjusts a target within W |
| initial-workers | 0 selects automatically; explicit 1–32 affects adaptive only |
| verification-batch | 4 (1–32), combines available candidates without waiting to fill |
| repairs / integration-repair | 1 (0–3) / true, within original grants and budgets |
| seconds / command-timeout-ms | 600 (1–86400) / 300000 (1–86400000) |
| max-model-requests | 128 shared by planning, Workers and repairs |
| worker-context-bytes | 65536; 0 disables; trims model view, not history |
| worker-stall-rounds | 0 disables; 8–128 enables experimental unchanged-source checkpoints |
| worker-tools | all or command; does not change Runtime grants |

Limits are 64 tasks, 16 MiB/10000 source files, 2 MiB per file and 128 MiB artifacts; symlinks, hardlinks and special files are rejected. Model concurrency, Worker limits and gateway RPM/TPM are distinct. Adaptive is opt-in and not guaranteed to outperform defaults.

## Results and service

`run.json` records status, head, verification and cleanup; `usage.json` retains known tokens and missing statistics. `candidate/` contains accepted source only. Partial delivery is not completed. `areal-workgroup inspect /absolute/runs/new-run` takes the owner lock and verifies hashes; crashed runs become UNKNOWN without replay. SIGINT/SIGTERM cancellation still awaits cleanup.

TUI/server/launcher accept `--workgroup-policy /absolute/policy.json --workgroup-toolchain /absolute/toolchain` with explicit write grants. Policy includes allowedWrites (or allowedDirectories), nonempty checks, shared workers/verifiers/activeGroups and budgets. Models cannot modify deployment policy.

The service exposes workgroup_start/read/wait/revise/cancel/artifact. TUI uses `/groups`, `/group ID` and `/group-start FILE`. requestId deduplicates; revisions require expectedRevision. Reconnect does not cancel client groups; restart does not rerun old groups. artifact returns file chunks up to 4096 bytes with base/candidate digests; applying them to the original tree still requires conditional checks.

Desktop Workflows are versioned plans with per-stage Profile, model, Skill, tool and readOnly settings. isolatedWrite child agents reuse this service. See [Core API](../api/core.en.md#workgroups) and [scheduling design](../design/workgroups.en.md).
