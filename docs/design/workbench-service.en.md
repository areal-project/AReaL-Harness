[中文](workbench-service.md) | **English**

# Workbench services and desktop attachments

Rust Host owns cross-project workbench behavior. Core owns project Threads, Turns, Tasks, and execution receipts. The GUI, Web, and mobile clients use the same Host protocol. Electron Main owns native windows, system encryption, native file handoff, and browser views. See the [architecture](architecture.en.md) and [ADR 0017](../adr/0017-one-protocol-one-ui.en.md).

## Rust domain implementations

| Domain | Authority and entry points |
| --- | --- |
| Library and analytics | Host aggregates navigation, read status, settings, and usage. Writes use `library.command`. Use `command.read` to check the original request. |
| Sessions and execution | Host prepares creation, send, queue, and steer operations and binds them to the original source, execution project, and Core generation. Core stores the session, execution state, and original receipt. |
| Scheduled tasks | Core manages schedules, Runs, and workers. Host provides the cross-project catalog, published previews, and activation. Reading a stopped project's catalog leaves it stopped. |
| Worktrees and resources | Host resolves logical and execution projects, configuration, and cleanup scope. Core runs Git, file, and managed process operations. |
| Models, plugins, trajectories, and feedback | Host manages shared configuration, credentials, cross-project publication, and domain receipts. Core executes with its applied configuration. |

Each new business operation identifies its writer, reader, target, generation, and completion signal. The [local service contract](../api/local-service.en.md) and [Host API](../api/host.en.md) describe public methods and authorization scopes.

## Source, startup, and upgrades

Main holds the original GUI singleton while publishing and verifying its source through Host. Navigation keeps stable GUI aliases. Execution uses the canonical project ID and original data directory bound to the source. Older credentials are imported once using system encryption and retired against the original migration receipt. Plaintext is limited to authenticated connections and memory required to run. Projects awaiting cleanup proof remain pending while other published projects stay available.

Host validates source launch configuration and ordinary environment credential references. The first project start materializes configuration, hooks, and resources. Later starts reuse registered inputs and the existing launcher. The original Core generation provides proof of configuration application. Reading published state or history leaves stopped projects offline.

Upgrade checks use `backend.status` to identify a prior Host that still owns the previous Node backend. Installation handoff checks the original Host stop request and project cleanup receipts. It then waits for the original instance to exit and release its exclusive lock before confirming the new generation. A lost reply is checked by its original identity. Older stop records without an operation identity stay in the original GUI directory.

## Native attachments and history

Main attaches to its original GUI source over the authenticated local connection. Embedded `browser_v1` callbacks bind the attachment, execution project, Core generation, and Thread. The Electron view owns browser automation, approval presentation, and page control. Workbench commands are scoped to the original window's browser lease.

A Side Chat connection owns the tabs and resources it creates. Closing or disconnecting settles resources for that connection. An unknown outcome keeps its original request ID for inspection. Auxiliary and foreground history, item details, and attachments use their respective Host observation subscriptions. Completed Runs open a one-shot preview by default. Full history opens a read-only subscription that is released on switch or close.

## Verification

Run `pnpm --dir clients/gui test:web-journeys` for shared behavior against isolated Host and Core processes. Verify protocol, receipts, page behavior, and native resources independently. Embedded browsing, system encryption, signing, and application upgrades require desktop acceptance.
