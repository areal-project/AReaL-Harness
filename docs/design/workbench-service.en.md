[中文](workbench-service.md) | **English**

# Workbench service

Status: A3 design note, not implemented yet. The decision is [ADR 0017](../adr/0017-one-protocol-one-ui.md); the work package is in the [one-protocol spec](../development/one-protocol-spec.en.md).

Electron Main still holds about 27k lines of cross-project business logic (worktrees, the scheduled-task catalog, library, providers, the management pages, MCP apps). Every client needs it, and rewriting it in Rust is not worth it yet. The interim step moves that code unchanged into a Node process that Host supervises: the workbench service. Logic that stays inside one project still goes to Core first.

## Non-goals

- It opens no port. Clients only connect to Host.
- It never connects to Core directly or touches a Core data directory.
- It holds no plaintext credentials and never writes them to logs, files or command lines.
- It does not depend on Electron APIs. Anything that needs native capabilities stays in the shell and reaches Host through `tool.provide`.

## Supervision

Same approach as the local Relay (`core/host/src/local_relay.rs`):

- Host starts it with `TrustedCommand::supervised`, with a cleared environment that keeps only `PATH`, `HOME` and `TMPDIR`. Desktop installs use the bundled Electron binary with `ELECTRON_RUN_AS_NODE=1`; CLI-only installs use system Node (≥ 22).
- On start the service sends one `ready` frame on the private channel listing the methods and versions it implements. No frame within 20 seconds is a failed start.
- Crashes restart with 1, 2, 4… up to 60 second backoff. Five failures within 10 minutes stop restarts and report the capability unavailable until the user retries from settings.
- On Host stop, Host refuses new requests, waits for in-flight ones to finish or time out, then closes stdin so the service exits.

## Private channel

- A Unix socket pair (`UnixStream::pair`): the service end is the child's stdout and Host writes its stdin. There is no filesystem path, so no other process can reach it.
- One JSON frame per line with `version: 1`, capped at 1 MiB like the client protocol.
- Host to service: `{id, method, params, context}`. `context` carries the verified principal (local desktop, or device ID plus grant revision) and `projectId`. The service never makes its own authorization decisions.
- Service to Host: results, events, and two reverse calls, `core.request` and `vault.read` (below).

## Method routing

- Method names stay registered in `schemas/areal-host-protocol-v1.json`. A client cannot tell whether Host, Core or the workbench service implements a method.
- Host forwards only methods marked `x-owner: workbench` in the schema that also appear in the `ready` frame; everything else is `methodNotFound`.
- Authorization, rate limits and commandId receipts all stay in Host. Write methods are recorded in Host's journal first, then the `operationId` is handed to the service. After a lost reply the client still calls `command.read` with the original ID; Host asks the service for that `operationId`'s outcome and never resends.
- Service events are pushed unchanged by Host to connections subscribed to the matching topic.

## Reaching Core

The service calls `core.request {projectId, method, params}`. Host forwards it over its existing shared connection (`schedule_connection`) and checks the service generation, so the service cannot bypass Host's admission and generation checks.

## Credentials

`vault.read {slot}` returns only the slot the current method is registered to use. The value stays in memory and is dropped after use.

## Without Node

`workbench` is missing from the capabilities in `host.describe` and `hello`, and its methods return `CAPABILITY_UNAVAILABLE`. The UI hides those entries by capability. Sessions, sending and approvals, which Host and Core serve, are unaffected.

## Code location and migration

- The service lives in `services/workbench/`, next to `services/remote-relay/`, and ships with both the desktop and CLI packages.
- One PR per domain: first move the Main `.cjs` files unchanged and connect them to the channel; delete the Main files and IPC commands after acceptance. Rewrites come in later PRs.
- Domain order follows the spec: session operations (fork, side, edit, continue, prediction) → workspaces and worktrees → manage → providers and subscriptions, library, export, feedback and diagnostics. Session operations are mostly single-project, so check first whether they belong in Core.
