[中文](browser.md) | **English**

# Shared Browser: a joint GUI and Harness environment

This is a design specification, not an implementation claim. “Codex App-like” means the testable browser collaboration experience defined here, not private internals, every product feature, or pixel identity. See the [glossary](../../GLOSSARY.en.md) and [Browser API](../api/browser.en.md).

## Problem Statement

Users can preview pages in the desktop app, but the agent cannot reliably inspect, operate, diagnose, edit and verify the same live page. A separate automation browser splits user state; direct Electron access bypasses identity, permission, history and cancellation boundaries. The goal is to promote the existing preview into a controlled shared Browser, not build another agent system.

## Solution

Retain the native browser. One Browser Controller owns physical pages and input control. Core retains tasks, approvals, tool intent and history. The existing independent desktop adapter routes callbacks from the bound Thread to Electron Main. The GUI presents the same page, controller, activity, annotations and verification evidence. Web content cannot call the product bridge or grant agent authority.

### Scope and release gates

| Gate | Delivers | Does not establish |
|---|---|---|
| R0 | Real Electron/Core feasibility for shared-page read, input shield, capture coordinates and CDP/DevTools conflict | Production or general website support |
| R1 | Shared page, semantic observation, capture, approved actions, takeover/resume, existing Threads, tabs, transient contexts, recovery | Complete developer collaboration |
| R2 | R1 plus annotations, diagnostics, responsive/Canvas input, service/code/verification loop, temporary style experiments, controlled file handoff, short batches, observers and package acceptance | All Codex functionality, unattended background browsing or persistent Profiles |
| Separate later proposals | Persistent Profiles, personal Chrome import, independent background browser, remote streaming, arbitrary code execution | An implicit commitment of this spec |

Only passing the full R2 release gate qualifies as this project's Codex-like browser development experience. Profile management may wait; transient isolation may not. Ship capability-gated stages with explicit unsupported responses, never fake success.


### Project experience coverage

This is the project’s target matrix, not a vendor feature inventory.

| User-facing capability | Gate | Boundary |
|---|---|---|
| Existing page, tabs, address, navigation, shared inspection/actions | R1 | Same native object; no background focus theft |
| Approval, action indication, takeover, privacy and resume | R1 | Agent observation stops during human control |
| Temporary login and Workspace isolation | R1 | No restart persistence or personal Profile import |
| Failure, connection, cache and crash handling | R1 | UNKNOWN retained; URL restoration is not memory restoration |
| Region/element comments, drafts and chat submission | R2 | Frozen region capture first; explicit element fallback |
| Temporary text/style preview, undo and edit intent | R2 | Not a source edit; clear overrides before verification |
| Server, code diff, behavioral/visual evidence | R2 | Runtime-owned services and verifiable checks |
| Console/network and manual DevTools | R2 | Scoped agent diagnostics, no app-wide CDP |
| Viewport, zoom, Canvas and coordinates | R2 | Real platform/version tests; hidden capture not guaranteed |
| Download/upload handoff | R2 | User-selected files/destinations, no arbitrary host paths |
| CLI/other observers of the same task | R2 | Preserve ToolHost; no substitute browser without GUI |
| Persistent Profiles, unrestricted CDP, remote video, background browser | Separate proposal | Not implied by “complete experience” |

## User Stories

1. **US-01 (R1)**: As a user, I want the agent to inspect my already-open page without losing its forms, route, scroll position, or temporary login.
2. **US-02 (R1)**: As a user, I want to see the project, Thread and controller of a Browser Page so that I can identify a wrong target.
3. **US-03 (R1)**: As an agent, I want scoped semantic observations with truncation and valid Refs so that I choose targets from observed facts.
4. **US-04 (R1)**: As an agent, I want receipts for clicks, fills, keys and waits so that dispatch is distinguished from goal completion.
5. **US-05 (R1)**: As a user, I want approvals to show the actual page, target and action rather than a generic tool name.
6. **US-06 (R1)**: As a user, I want takeover to fence agent input locally before waiting for Core or network responses.
7. **US-07 (R1)**: As a user, I want agent screenshots, DOM reads and diagnostics paused during private manual interaction.
8. **US-08 (R1)**: As a user, I want explicit resume and a fresh observation before the agent acts again.
9. **US-09 (R1)**: As a user, I want ambiguous outcomes preserved and inspected instead of repeated submissions or purchases.
10. **US-10 (R1)**: As a user, I want to enable Browser on an idle existing Thread without duplicating the chat or discarding history.
11. **US-11 (R1)**: As a user, I want tabs, navigations and popups to remain in the same browser task scope.
12. **US-12 (R1)**: As a user, I want temporary login shared within my Browser Workspace during this desktop run and isolated from other Threads.
13. **US-13 (R1)**: As a user, I want hidden pages retained and executing pages pinned against cache eviction.
14. **US-14 (R1)**: As a user, I want explicit failure and recovery rather than silent routing to a replacement page.
15. **US-15 (R2)**: As a user, I want to annotate a captured region and send the comment to the current Thread.
16. **US-16 (R2)**: As a user, I want element selection to carry verifiable semantics and bounds for the agent.
17. **US-17 (R2)**: As a user, I want chat switches, IME composition, undo and failed sends to preserve and correctly scope my annotation draft.
18. **US-18 (R2)**: As an agent, I want bounded, on-demand Console and network summaries for the current page.
19. **US-19 (R2)**: As a developer, I want DevTools to pause automation and allow safe reattachment afterwards.
20. **US-20 (R2)**: As a user, I want viewport changes, zoom and device scale to keep screenshots, picking and coordinate input aligned.
21. **US-21 (R2)**: As an agent, I want screenshot-grounded coordinate input when DOM semantics are unavailable, including Canvas and games.
22. **US-22 (R2)**: As a user, I want the agent to start or reuse a local service, open its page, edit code and verify the result.
23. **US-23 (R2)**: As a user, I want before/after evidence and behavioral results linked to the code change.
24. **US-24 (R2)**: As a user, I want temporary text/style experiments with undo and explicit handoff rather than an implied code save.
25. **US-25 (R2)**: As a user, I want to review download provenance and select upload files myself rather than grant arbitrary host paths.
26. **US-26 (R2)**: As an agent, I want short action batches on observed pages, with per-step receipts and control checks.
27. **US-27 (R2)**: As a user, I want CLI or another observer to inspect the same task without taking over the GUI Browser ToolHost.
28. **US-28 (R2)**: As a user, I want GUI exit to release its Browser without stopping unrelated Core work and with honest affected-call outcomes.
29. **US-29 (R1)**: As a user, I want evidence retrieval authorized per Thread and sensitive data excluded from default capture/logging.
30. **US-30 (R2)**: As a user, I want keyboard and accessible control, error, approval and feedback workflows.
31. **US-31 (R2)**: As a user, I want packaged Browser behavior without a developer-only Playwright install, global Chrome or exposed debug port.
32. **US-32 (R2)**: As a user, I want tested capabilities distinguished from unavailable and deferred features.

## Implementation Decisions

### Ownership and dependency direction

1. **Core** exclusively owns Thread/Turn, Tool Intent, approval decisions, history and evidence authorization. Use the existing client-tool backend and Blob mechanism; do not invent Runtime execution facts.
2. **Independent desktop adapter** owns the registered ToolHost connection and authenticated routing, request correlation, cancellation and projection. It runs no model loop.
3. **Electron Main Browser Controller** owns Browser Workspaces, Pages, transient contexts, native connections, control fences and in-flight physical facts. It keeps no competing conversation history.
4. **GUI Renderer** owns layout and unsent drafts. Live state is a Controller projection; submitted annotations and evidence belong to Core.
5. **Runtime** continues to manage development servers and code/file execution. A trusted client browser does not automatically inherit Runtime sandbox guarantees.
6. Adopt the existing native preview in place. Preserve its Session, form state and route; neither navigate nor create a second page to simulate adoption.

![Proposed ownership and execution](diagrams/browser-architecture.svg)

[Editable diagram](diagrams/browser-architecture.drawio)

### Invariants

- **INV-01 Same page**: human and agent address one live Page; URL equality is insufficient.
- **INV-02 One authority**: Core owns task/history; Controller owns native resources. Projections are not write authorities.
- **INV-03 Explicit identity**: authenticated deployment, Thread, Host and Page binding; model-supplied identifiers never grant authority.
- **INV-04 Single writer**: one human or agent lease per Browser Workspace; serialized operations and a priority control lane.
- **INV-05 Takeover first**: invalidate the old local control epoch before waiting for Core. Agent observations also pause during human control.
- **INV-06 No ambiguous replay**: potentially dispatched input without confirmation remains UNKNOWN. New connections and late receipts cannot replay it.
- **INV-07 Scoped references**: bind Refs to Page, document, frame and node; bind coordinates to screenshot and viewport. Never substitute a similarly named element after failure.
- **INV-08 Stable permission**: approve a real action plan and target epochs. Changed context requires preparation again. Page text cannot escalate authority.
- **INV-09 Transient isolation**: separate Browser Workspaces do not share cookies/storage; sibling pages may. This is not an OS/network sandbox.
- **INV-10 Honest lifecycle**: hide does not destroy; destruction does not promise state restoration; GUI exit leaves unrelated Core tasks running.
- **INV-11 Evidence**: execution is not business success; verification carries checks, observations and code linkage, or explicitly says unverified.
- **INV-12 Truthful capabilities**: advertise only reachable capabilities; a GUI-less CLI does not silently launch another browser.

### Tools, approval and recovery

Use a fixed versioned Browser Dispatcher with runtime capability documentation and strict per-operation validation; unknown parameters are never evaluated as code. Reads and mutations check resource and control generations. For an action, Core records intent, requests a read-only host prepare, persists the actual plan, obtains approval and only then executes. The host revalidates the authorized target immediately before input. Human input uses the human-control path, not a fabricated agent call.

Register the dispatcher at new Thread creation. Existing tool definitions are immutable: use a bounded idle-time append-only attachment mechanism, preserving prior definitions and history, as specified in [ADR-0007](../adr/0007-browser-tool-compatibility.en.md). Unsupported versions disable the feature rather than duplicate the chat or edit storage manually.

Map known rejection, non-dispatch and ambiguous dispatch to existing Core outcomes. UNKNOWN acknowledgement only appends inspection evidence. Resume is explicit authorization and continuation, never implicit retry.

### Browser experience

Distinguish live control, comments, temporary style previews and real code changes. Retain WebContentsView. If a native overlay is unreliable, use a frozen, provenance-bearing screenshot for region annotation; input fencing and takeover must not degrade. See [UX specification](browser-ux.en.md).

Short typed batches have per-step admission and receipts. No arbitrary Node.js runner is introduced. Reuse mature operation semantics and testing patterns without claiming complete Playwright compatibility.

## Testing Decisions

Prefer the existing desktop E2E seam: real Electron/Core/Runtime, a deterministic model, local fixture sites and isolated data. Drive user-facing or public Core entry points; assert page/server state and Core history. Small state-machine tests exhaust generation, duplicate-callback and rejection cases. Avoid duplicating mocked workflows at every layer.

The main acceptance seam is deterministic model → tool → same native page → Core receipt → GUI and human takeover. Direct private Controller calls are not E2E evidence. Deliver safety, cancellation, errors and large media with happy paths. See [test specification](../development/browser-testing.en.md).

## Out of Scope

Persistent Profiles and login import/persistence, Chrome extensions, unrestricted CDP, arbitrary host JavaScript, OS computer use, cloud browsing, full remote video streaming, concurrent same-page agent writers, CAPTCHA bypass, automated payment/irreversible sensitive operations, and universal site/platform compatibility. High-impact external submissions use human takeover. Real-account compatibility requires separate testing.

## Further Notes

Core/adapter/Main/Renderer ownership boundaries are integrated; operation availability follows Host capability discovery and the implementation limits in the public API. Persistent Profiles, cloud browsers and other deferred capabilities remain unavailable. Source evidence, baseline SHA, run results and remaining checks belong to their acceptance records, rather than this durable specification. External page content is untrusted; publishing GitHub Issues, PRs or production changes requires corresponding authorization.
