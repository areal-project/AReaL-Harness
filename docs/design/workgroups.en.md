[中文](workgroups.md) | **English**

# Workgroup scheduling and verification

Workgroups execute bounded DAGs through the production Engine, with private Runtimes and workspaces for writing tasks and verifiers. Core owns graphs, artifacts, repairs and integration; Runtime owns permissions and processes. See the [usage guide](../guides/workgroups.en.md).

![Workgroup architecture](diagrams/workgroup-architecture.svg)

[Source](diagrams/workgroup-architecture.drawio) · [Concurrency diagram](diagrams/workgroup-concurrency.svg) · [Concurrency source](diagrams/workgroup-concurrency.drawio)

## Scheduling and artifacts

Plans declare exact writes, execution dependencies `depends` and verification dependencies `integrationDepends`; their union must be acyclic. Tasks sharing writes may be packed together while independent branches retain concurrency. Task packing and execution admission are separate controls.

Workers submit source changes only within allowed paths. Verification uses a trusted toolchain and the exact candidate tree, checking that verification itself did not alter it. Local passes allow incremental integration; final combined checks establish completion. Receipts bind tree hashes and generations, so old results cannot authorize new artifacts.

## Concurrency

| Mode | Admission |
|---|---|
| Fixed | At most W active Workers |
| Auto | At most W active Workers and W+1 unverified tasks |
| Adaptive | Target T varies within W; at most T active and T+1 unverified tasks |

Adaptive uses local model-permit queues, occupancy and verification backlog to adjust subsequent dispatch without cancelling running Workers. It starts from ready width and model-pool capacity unless `initial-workers` is explicit. Feedback does not measure GPU utilization or hidden gateway RPM/TPM and cannot promise optimal width.

The embedded service shares Worker, verifier and model permits across groups, while each group retains its own budget. Coordination waits hold no model/execution permits. Before normal completion, a parent Turn joins its groups. Observer disconnection does not cancel accepted client groups.

## Failure and recovery

Confirmed check failures may be repaired within original write scope, repair count and root budget. A model failure may preserve a checkpoint for independent verification only after tools settle, Runtime closes and paths remain within scope. UNKNOWN, permission violations and uncertain cleanup are excluded from automatic recovery.

Four observed boundaries with identical successful operations, results and source trigger independent candidate verification. Comparison excludes process IDs, cursors and the `remainingToolCalls` scheduling metadata; a decreasing call budget is not source progress. Failures, incomplete output, changed arguments or changed source do not meet this condition.

Task failure blocks dependent branches; independent branches may continue, but partial artifacts are not complete delivery. Restart retains history and projects unfinished runs as UNKNOWN without adopting old processes or replaying side effects. Plan revisions may affect unstarted tasks or append tasks; they cannot remove original checks or expand frozen authorization. See [Core API](../api/core.en.md#workgroups) for state, artifacts and control.
