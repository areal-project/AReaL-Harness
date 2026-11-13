[中文](0017-one-protocol-one-ui.md) | **English**

# 0017: The Host is the only entry point; clients share one protocol and one UI

Status: accepted and implemented; the workbench service (Node) remains a transitional host for moved business. Building on the ownership in [ADR 0016](0016-shared-host.en.md), this decides how clients connect and how the UI is reused. It supersedes the statement in H2 of the [shared Host spec](../development/shared-host-spec.en.md) that "the Renderer keeps its current way of reaching Core": today the Renderer reads through Electron Main's desktop IPC and never connects to Core directly.

## Context

With the shared Host in place there are still three client entry points: the GUI uses 48 desktop commands on Electron Main, the remote web page and the phone use the Remote Gateway inside the Host, and TUI, CLI and the local web page ask the Host for a Core descriptor and connect to Core directly. There are also four UIs: the GUI Renderer, the remote web page, the phone page and `clients/web`. Send, stop, approve, configure and queue are implemented twice, once in Main (JS) and once in the Gateway (Rust). Main still holds about 27k lines of business code that browsers and phones cannot reuse.

## Decision

1. **Clients are projections.** A client keeps only rebuildable projections and unsent drafts. Thread, Turn, Task and receipts are owned by Core; cross-project data is owned by the Host.
2. **The Host is the only client entry point.** GUI, web, phone, TUI and CLI connect only to the Host. The Host authenticates, authorizes, routes by `projectId` and wakes Core on demand. Project services and Core do not face clients; TUI direct-to-Core remains only for development and troubleshooting.
3. **One protocol, several transports.** Methods and messages keep the Host envelope `{version,id,method,params}` and the Gateway method table, with Rust and TypeScript types generated from one schema under `schemas/`. The local GUI and browsers use a `127.0.0.1` WebSocket the Host listens on; TUI and CLI use the Unix socket; remote clients use Noise (Direct or Relay). All three carry the same methods.
4. **One UI, several shells.** GUI, web and phone run the same React build. The Electron shell adds windows, notifications and file dialogs, plus desktop tools it registers with the Host; the Capacitor shell adds keychain, scanning and push; a browser adds nothing and is still fully usable. The UI shows entries by capability, not by platform.
5. **Capabilities follow grants and resources, not platforms.** Device grants are observe, submit, approve and manage. Phones get the first three by default; manage (credentials, pairing, deleting projects) is opted into at pairing. The only remaining limits are resource limits such as paging, frame size and chunked upload, announced in `hello`. Per-platform limits on session type, attachments or Workflow are removed.
6. **Business code moves first into a Node child supervised by the Host.** Main business code not yet rewritten in Rust moves into a headless Node child (the workbench service) supervised by the Host the same way as the local Relay. It is reachable only through the Host and opens no client port. Domains are later rewritten into the Host or Core without blocking protocol unification or the shared UI.

## Trade-offs

- Local traffic takes one extra hop through the Host, which is negligible; in return there is one place for auth, one list and one implementation. The performance risk is data volume, so sync must be a list subscription plus per-session subscriptions, never a full push.
- The Node child adds one supervised process and needs a headless Node in the release layout. Layouts without it report the affected capabilities as unavailable, like the local Relay.
- During migration the old desktop IPC coexists with the protocol. New features go only into the protocol; the old IPC only shrinks.
- Released iOS and PWA clients keep working on the existing method table. New capabilities are added only through `hello` negotiation.

## Unchanged

No Core Store format change, no data directory moves, no change to the supervision chain or cleanup proofs. UNKNOWN is never replayed, admission receipts win, and single-writer rules still hold. Implementation and acceptance are in the [implementation spec](../development/one-protocol-spec.en.md).
