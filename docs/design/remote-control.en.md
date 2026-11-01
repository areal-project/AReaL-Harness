[中文](remote-control.md) | **English**

# Remote Control architecture

The shared Host is a [target design, in progress](../development/shared-host-spec.en.md), with ownership defined by [ADR 0016](../adr/0016-shared-host.en.md). The current Gateway remains in Desktop Service under the GUI lifecycle. Remote after full GUI quit requires H3 migration and acceptance of Gateway, grants, the submission journal outside Store, scheduled activation, and provider subscription transports. Host supervision identity is separate from Remote Noise peer identity; distinct Noise identities from multiple profiles cannot overwrite each other.

This document specifies planned Remote v2 behavior, not shipped capability. See [architecture and layout](architecture.en.md) for module ownership and the [test plan](../development/remote-control-testing.en.md) for verification entry points.

## RC-01 implementation scope

`RemoteControl` manages the read-only Direct entry within the existing desktop background adapter on a separate loopback listener. It does not enter the privileged DesktopService dispatcher. The browser shell uses the existing GUI build and shared `@areal/remote` Noise implementation; it sends only v2 hello and two read methods, with no Core connection or execution loop. v2 applies tighter message and buffer limits before JSON decoding; existing local services retain their owners.

The loopback switch defaults to off. Test fixtures provide isolated grants; production pairing and public/Relay deployment are not available. See the [test plan](../development/remote-control-testing.en.md) for commands and evidence boundaries. Existing Shared Browser, native preview and browser tools are outside this ticket's change scope.

## Goal and authority

The desktop computer is the Host. Its existing background adapter owns the Remote Gateway lifecycle. Core remains the sole authority for Threads, Turns, Tasks, TaskRuns, interactions and history; Runtime retains execution boundaries and operation facts. Web/PWA stores reconstructable projections and unsent drafts.

Direct and Relay share pairing, authorization, commands and observations. Method details have one home: the [Remote API](../api/remote-control.en.md). ADRs 0002–0005 record the durable trade-offs.

## Components

| Component | Responsibility | Excluded responsibility |
|---|---|---|
| Desktop GUI | Local enablement, connectivity settings, pairing approval, revocation, diagnostics | Keeping Remote alive |
| Existing background adapter | Project connections, credentials, Gateway lifecycle and Core submission correlation | Another agent or task scheduler |
| Remote Gateway | Current device grants, method allowlist, narrow projections, command mapping, audit metadata | Generic RPC, filesystem or terminal proxy |
| SecureChannel / Transport | Existing Noise implementation, Direct/Relay bytes and backpressure | Execution authorization |
| Core | Admission, durable receipts, history, interaction decisions and Task coordination | Trusting client-declared permission |
| Web/PWA | Overview, Session, attention, read-only review, connection generations and drafts | Replaying unconfirmed mutations or holding Core tokens |
| Optional Relay | Host enrollment, routing, quotas and connection health | Business payload storage, approval or offline execution |

All remote access crosses the Gateway. Direct does not proxy the existing privileged desktop socket or make the Core loopback endpoint public. Thin UI does not move security or execution recovery into the browser.

## Shared client implementation

PWA and native shells share `@areal/remote-client`. `RemoteConnection` owns the Direct/Relay wire, Noise Host pin, hello/ready, RPC timeouts and cleanup. The page presents handshake events. The `ready` hook persists identity before requests become available. A `session.open` result callback synchronously publishes its baseline before the RPC Promise resolves, with subsequent updates handled on the same message stream.

`CommandState` keeps command and draft maps. `acceptSessionMessage` checks subscription identity and sequence. `SessionBodyReader` holds disposable body-page caches. `ClientState` owns identity epochs, remembered-device revisions and UNKNOWN command locators. Its injected atomic storage transaction compares and commits `{ schema: 1, revision, credential, locators }` without resending unconfirmed commands. The synchronous transaction callback returns the record and result; the adapter resolves the result only after the commit completes.

Web `BrowserState` supplies IndexedDB, BroadcastChannel and sessionStorage adapters. A successful IndexedDB request is not a committed transaction. Cross-tab invalidation and aborts after a put remain protected by that transaction boundary. PWA owns the DOM, page lifecycle and reconnect scheduling. The shared package does not access the DOM, IndexedDB or Capacitor.

## Connectivity

**A — no self-built cloud backend.** The browser reaches a dedicated low-privilege Host service through organizational HTTPS/VPN or Tailscale Serve. The service hosts the static PWA and encrypted WebSocket on one origin. No AReaL Relay or vendor registration is needed. Private access is the default. Explicit Funnel enablement can provide a public browser endpoint while retaining device pairing. Existing organizational HTTPS proxies are also supported; the protocol is provider independent. See [deployment](../guides/remote-control.en.md).

**B — self-hosted Relay.** Both Host and Client open outbound WSS connections. The Relay routes rooms/channels containing Noise records. Administrators deploy HTTPS, the static PWA and a single Relay instance, then issue one-use Host enrollment credentials. The desktop imports a deployment profile and users pair by QR. The Relay never requires model credentials, project paths or a human account platform. A same-origin Web deployment is operationally convenient, but its JavaScript publisher remains trusted.

## Ownership and failure domains

A Host aggregates saved, explicitly granted projects, each bound to a discovered Core service identity and generation. Host identity, Gateway process generation, Core service generation, Runtime epoch and tool-host generation are distinct.

Closing a page or GUI window releases observations. The current adapter maintains Remote and tool-host duties while the application remains running. Full GUI quit currently ends the GUI-owned supervision chain; the shared Host target retains Gateway after H3 migration. Remote subscription cleanup must not close subscriptions used by other clients. Stopping Gateway does not cancel accepted work. Sleep, logout, power loss, and explicitly stopped services have no availability guarantee.

Passive recovery only discovers compatible running services; it does not start stopped projects, restart services or widen permission. One unavailable project does not make the whole Host unavailable.

## Commands

Add remote correlation metadata to the existing adapter submission journal/outcomes: authenticated device, command key, semantic digest and native Core request identifier. These records may say forwarded or receipt-unknown; they may not declare execution successful. Do not build a second Session store or model execution ledger.

Normal messages use idle-only Core admission, not the desktop command's implicit enqueue behavior. Stop targets the Turn the user saw. Approval binds the reviewed argument digest. Task pause targets a particular Run and revision. The API specifies comparisons and conflicts.

A project grant exposes work visible within that project; it is not an OS sandbox. An operator can cause the agent to use permitted tools. Pairing UI must make the existing execution boundary visible.

## Observation and information architecture

A WorkItem projects a regular Thread or an existing TaskRun. A coordinating Thread covered by a TaskRun is not duplicated; workers are nested under the Run. Session keeps the native Thread identifier.

Execution state and attention reason are separate dimensions. An asynchronous question can require an answer while execution continues. Unknown execution, connectivity loss and a readable result are not interchangeable waiting states.

Overview carries bounded summaries and attention counts. Session details subscribe on demand; history, diffs and images are paged/chunked. Cached state is display-only and replaced on recovery.

P0 has no durable global event stream. Reuse native subscriptions. If unopened Threads lack a complete summary query, add a bounded read-only projection over Core's existing authoritative state rather than subscribing to every transcript. Its minimal contract is specified in the API overview section.

## Security and organizational scope

Local confirmation grants control. Connectivity, room identifiers and QR possession are insufficient. Observer/operator presets have explicit capabilities and no remote administration permission. Narrowing a grant applies to cached outputs, subscriptions, artifact streams and new commands.

One Relay deployment is one organization/personal administrative domain with multiple Hosts. Separate organizations use separate instances, volumes and enrollment credentials. P0 does not promise strong tenant isolation within one Host OS user; organizations needing it must use separate users, machines or isolated deployments.

Keep handshake, identity and AEAD responsibilities in the existing Noise library. Publish pinned, same-origin static assets with strict CSP and no third-party runtime scripts; never render arbitrary raw HTML. Browser identities are accessible to malicious same-origin code and are not keychain-grade protection.

## Migration and release

Negotiate application v2 inside the established encrypted channel. The existing Noise prologue is a transport compatibility marker; do not redesign cryptography for added business fields. Migrate configuration transactionally with a recoverable backup and require local grant review. Do not silently downgrade mutations to legacy clients.

Do not reorganize the entire monorepo, clone Workbench or import an ADE. Reuse contracts and suitable presentation pieces; Electron-native behavior remains local. Both connectivity routes must pass common behavioral conformance plus their own TLS, Origin, quota, credential and real-device gates in the [test plan](../development/remote-control-testing.en.md).

Related decisions: [Host ownership](../adr/0008-remote-host-ownership.en.md) · [transports and trust](../adr/0009-remote-transports-and-trust.en.md) · [command recovery](../adr/0010-remote-command-recovery.en.md) · [thin-client domain](../adr/0011-remote-thin-client-domain.en.md).
