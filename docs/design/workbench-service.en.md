[中文](workbench-service.md) | **English**

# Workbench service

Status: A3 in progress. Host routing and the first domain (usage analytics) are implemented; the rest move in the order below. The decision is [ADR 0017](../adr/0017-one-protocol-one-ui.md); the work package is in the [one-protocol spec](../development/one-protocol-spec.en.md).

Electron Main still holds about 27k lines of cross-project business logic (worktrees, the scheduled-task catalog, library, providers, the management pages, MCP apps). Every client needs it, and rewriting it in Rust is not worth it yet. The interim step moves that code unchanged into a Node process that Host supervises: the workbench service. Logic that stays inside one project still goes to Core first.

## Non-goals

- It opens no port. Clients only connect to Host.
- It never connects to Core directly or touches a Core data directory.
- It holds no plaintext credentials and never writes them to logs, files or command lines.
- It does not depend on Electron APIs. Anything that needs native capabilities stays in the shell and reaches Host through `tool.provide`.

## Supervision

Same approach as the local Relay (`core/host/src/local_relay.rs`):

- It starts on the first request. Host starts it with `TrustedCommand::supervised`, with a cleared environment that keeps only `PATH`, `HOME`, `TMPDIR` and the data directory `AREAL_WORKBENCH_DATA` (`workbench/` under Host's data directory).
- Desktop installs run it from `Resources/areal-workbench` in the signed app, after checking the signature and the `bundle.json` manifest, with the bundled Electron and `ELECTRON_RUN_AS_NODE=1`. System Node for CLI-only installs (≥ 22) is not wired up yet and reports unavailable.
- On start the service sends one `ready` frame on the private channel listing the methods and versions it implements. No frame within 20 seconds is a failed start.
- After a crash the next request restarts it with 1, 2, 4… second backoff; before the delay passes it reports unavailable. Five failures within 10 minutes stop restarts.
- On Host stop, Host closes stdin so the service saves its data and exits, and kills it after 5 seconds.

## Private channel

- A Unix socket pair (`UnixStream::pair`): the service end is the child's stdout and Host writes its stdin. There is no filesystem path, so no other process can reach it.
- One JSON frame per line with `version: 1`, capped at 64 MiB: `thread/read` results for long sessions come back to the service through reverse calls, so the cap matches the desktop Core client. Results handed to clients still follow the client protocol limits.
- Host to service: `{id, method, params, context}`. `context` carries the verified principal and connection ID. The service never makes its own authorization decisions.
- Host to service events: `core.event` forwards `turn/started`, `turn/completed` and `item/completed` from the shared Core connections. Host does not start the service just to deliver them.
- Service to Host: results, and the reverse calls `projects.list`, `core.request` and `vault.read` (below).

## Method routing

- Method names stay registered in `schemas/areal-host-protocol-v1.json`. A client cannot tell whether Host, Core or the workbench service implements a method.
- Host forwards only methods marked `x-owner: workbench` in the schema, listed in `core/host/src/workbench_route.rs`, and present in the `ready` frame; everything else is `methodNotFound`.
- For now these methods are only for the local desktop connection (a ticket connection that negotiated gui-write-v1). Cross-project analytics would cross a remote device's project grant, so remote access needs its own authorization decision first.
- Authorization, rate limits and commandId receipts all stay in Host. Write methods are recorded in Host's journal first, then the `operationId` is handed to the service. After a lost reply the client still calls `command.read` with the original ID; Host asks the service for that `operationId`'s outcome and never resends. The methods moved so far are reads or repeatable merges and take no commandId.
- Service events are pushed unchanged by Host to connections subscribed to the matching topic.

## Reaching Core

The service calls `core.request {projectId, method, params}`. Host forwards it over its existing shared connection (`schedule_connection`) and checks the service generation, so the service cannot bypass Host's admission and generation checks. Core methods are allowlisted; today only the read-only `thread/list` and `thread/read`.

## Credentials

`vault.read {slot}` returns only the slot the current method is registered to use. The value stays in memory and is dropped after use. No domain needs it yet, so it is always refused.

## Without Node

Its methods return `CAPABILITY_UNAVAILABLE` and the desktop UI falls back to the Main path. Sessions, sending and approvals, which Host and Core serve, are unaffected.

## Code location and migration

- The service lives in `services/workbench/`, next to `services/remote-relay/`, and ships with both the desktop and CLI packages.
- One PR per domain: first move the Main `.cjs` files unchanged and connect them to the channel; delete the Main files and IPC commands after acceptance. Rewrites come in later PRs.
- Domain order follows the spec: session operations (fork, side, edit, continue, prediction) → workspaces and worktrees → manage → providers and subscriptions, library, export, feedback and diagnostics. Session operations are mostly single-project, so check first whether they belong in Core.

## Domains moved so far

- Usage analytics (`analytics.read`, `analytics.sync`, `analytics.activity`, `analytics.import`), in `services/workbench/src/domains/analytics.cjs`. It differs from Main in three places: sync reads through `core.request` and never holds a Core address or token; turns are dated by Core's start time when Core recorded one, and older history stays undated; active time comes from each client every 5 seconds and the service counts the union.
- UI switch `areal.oneProtocol.domains=analytics` (reads must be on too). On the first connection the desktop's daily active time is merged in (larger value per day, safe to repeat). While switched, Main keeps writing its own file, so turning the switch off returns to Main's data.
