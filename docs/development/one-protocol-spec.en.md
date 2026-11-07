[中文](one-protocol-spec.md) | **English**

# One Protocol and One UI: Implementation Spec

Status: target design, not implemented. Decisions are in [ADR 0017](../adr/0017-one-protocol-one-ui.en.md); ownership follows [ADR 0016](../adr/0016-shared-host.en.md); current Host contracts are in the [Host API](../api/host.en.md) and [Remote API](../api/remote-control.en.md). Method names, fields and commands here are proposals and must not be described as supported elsewhere until implemented and accepted.

## Conclusion

Every client connects only to the Host and speaks one protocol. GUI, web and phone run the same UI build; desktop-only capabilities come from the Electron shell. The phone has no per-platform feature limits. Business code in Electron Main that is not yet rewritten moves first into a Node workbench service supervised by the Host, so protocol unification and the shared UI do not wait for a Rust rewrite.

Baselines: AReaL-Harness `codex/shared-host` `7611582f`; T3 Code `8760d063` (`docs/internals/connection-runtime.md`, `docs/internals/remote.md`, `packages/contracts/src/rpc.ts`).

## Decisions

| Question | Decision | Reason |
| --- | --- | --- |
| Client entry point | Only the Host; TUI direct-to-Core only for development and troubleshooting | One place for auth, one list, one implementation |
| How the local GUI and browsers connect | The Host listens on a `127.0.0.1` WebSocket; Electron Main does not relay | Electron and browsers connect the same way, so Main can shrink |
| Protocol base | Extend the Host envelope and Gateway method table instead of a new protocol; generate Rust and TS types from a schema | The Gateway already has lists, session subscriptions and receipts, and released clients use it |
| Default phone grants | Observe, submit and approve by default; manage is opted into at pairing | No phone-specific limits, while dangerous actions still need explicit consent |
| Main business code not yet rewritten | Move into a Host-supervised Node workbench service, then rewrite by domain | A 27k-line Rust rewrite must not block the protocol and the UI |
| Phone shell | Stay on Capacitor with the same UI | It already reuses GUI code; no separate native UI |

## Handing work to Codex

Implement A0 → A4 in order and continuously, without waiting for H4 acceptance to finish: branch from `codex/shared-host` and merge H4 in once it lands. Packages do not wait for maintainer review; each package is its own local commit and the next package starts only after every completion condition of the current one is met. Prompts cite the matching section and the "Execution rules" below.

Merging takes two PRs:

1. **Integration PR**: A0–A3 plus A4 item 1 (the shared UI). Every new path sits behind a flag that defaults to off, so an installed build behaves as the released one does. It merges when CI is green without loosening any gate (line caps, IPC freeze, protocol checks, renderer boundary); it does not require packaged acceptance.
2. **Retirement PR**: A4 items 2–4, which delete the old pages, old IPC and the flags and move TUI/CLI onto the Host. Open it only after release acceptance passes (real-data upgrade, old pairing upgrade, login autostart and reboot, unchanged identity after upgrade, a signed and notarized package, and OP-01 to OP-08), and ask the maintainer before deleting.

- Use high reasoning effort throughout. The A3 workbench service design note goes into the commit and may be implemented directly; stop only for "Stop and ask" items.
- General repository rules (layering, paired Chinese/English docs, test layers, PR template) follow AGENTS.md and are not repeated here.
- Reversible implementation choices within a package are Codex's call, explained in the PR; only "Stop and ask" items need asking first.

## Execution rules

These turn problems from the previous shared Host migration into hard requirements.

1. **Report progress by real journeys.** State whether the appropriate environment and data copy can complete the package journey before listing unit tests and static checks. Shared business uses Web and real Host services as its main acceptance environment; start the desktop only for Electron-specific capabilities. GUI packaging is not a routine functional-test prerequisite. Protocol tests do not replace page interaction, and Web evidence does not replace native or release-package evidence.
2. **Connect end to end first, then fill in.** Run the shortest end-to-end journey (even one method) in the appropriate environment with isolated data to prove the wiring reaches Host, then fill in the implementation and failure paths. Verify existing-data compatibility with real-data copies. A0 needs only conformance and freeze checks. Release resources, signing and upgrades are accepted separately in their corresponding release tasks.
3. **Close one package at a time.** Do not start the next package until every completion condition of the current one is met. Problems that belong to another package or to the shared Host go into "Known issues" and are reported, not fixed on the side.
4. **Keep historical facts separate from the current switch.** This spec migrates no storage and rewrites no history. Every data-path switch sits behind a flag and can fall back to the old IPC path, which stays intact during the switch. An UNKNOWN on a historical command affects only that command's display and lookup; it must not block a project from working, a flag from being turned on, or a package from completing.
5. **Stop when stuck and come back with options.** If the same blocker survives two rounds of investigation without new evidence, stop searching. Write a table of what can and cannot be proven, and give two or three options in which the software carries the complexity, for the maintainer to choose. Never work around it by disabling a project, skipping tests, loosening assertions or deleting data.
6. **Budget test fixtures.** Reuse existing fixtures and smoke scripts first. If fixture problems themselves (process exit waits, simulated port conflicts and the like) take more than half a day in total, stop and report; do not build a new fixture framework.
7. **Stay compatible with released clients.** Released iOS and PWA clients know only the existing method table. Changes to existing methods' semantics or limits apply to new clients only through `hello` capability negotiation.

## Target topology

```text
Electron shell ─┐                    ┌─ capabilities: windows, notifications, file dialogs, desktop tool registration
Browser ────────┼─ ws://127.0.0.1 ─┐ │
Capacitor ──────┘ (remote: Noise)  │ └─ capabilities: keychain, scanning, push
TUI / CLI ───── Unix socket ───────┤
                                    ▼
             AReaL Host (one method set)
             ├ entry: auth, grants, capability negotiation, resource limits
             ├ routing: by projectId to Core, wake on demand
             ├ read model: cross-project list and attention
             ├ journal and command.read
             ├ tool relay: desktop tools registered by shells
             ├ static UI publishing
             └ workbench service (Node child, carries Main business code during transition)
                                    ▼
             per project: project service → launcher → Core + Runtime
```

| Component | Owns | Does not own |
| --- | --- | --- |
| Host | Only protocol entry, grants, routing, cross-project list, journal, credentials, schedules, tool relay, UI publishing | Session history authority, windows and native UI |
| Workbench service | Cross-project business not yet rewritten (worktrees, library, plugin/MCP management, providers, etc.), reachable only through the Host | Public client entry points, credential persistence authority, process supervision |
| Core | Thread, Turn, Task, approvals, receipts, single-project files and Git | Devices, grants, facing clients |
| `@areal/client` | One connection owner per Host, list and session subscriptions, command state, offline cache | Business decisions, automatic resend of unknown commands |
| `@areal/app` | Every page, showing entries by capability | Direct access to Electron, Capacitor or the filesystem |
| Electron shell | Native UI capabilities; registers browser preview, Computer Use, screenshots and GUI terminal as a tool provider | Business commands for projects, sessions, tasks or credentials |

## Global constraints

- No Core Store format change, no data directory moves, no change to the supervision chain, cleanup proofs or the shared Host migration contract.
- UNKNOWN is never replayed, admission receipts win, single-writer holds. Clients generate `commandId`; reconnecting never replays writes automatically.
- Sync is a list subscription plus per-session subscriptions: snapshot first, then sequenced increments; a sequence gap closes the subscription and rereads the snapshot; leaving a session keeps its cache and cursor for a few minutes. Never push a full projection.
- Connection health and data freshness are reported separately: a ready connection does not mean the list or session is current.
- The local WebSocket listens only on loopback, exchanges a one-time ticket for a session and checks Origin; no address or port is baked into build output.
- Credentials, tokens and tickets never appear in command-line arguments, URL history, logs or diagnostics.
- Dependency direction stays Runtime → Core → Clients. The Host does not depend on GUI code; the workbench service does not depend on Electron.
- No Windows support; no remote SSH deployment, multiple OS users or cloud accounts.

## Package A0: ADR, protocol schema and freeze

### Goal

Fix one protocol definition from which every later method is generated, and freeze the desktop IPC.

### Current state

- The Host envelope is in `core/host/src/wire.rs` (`{version,id,method,params}`, 1 MiB per frame); local methods are in the [Host API](../api/host.en.md).
- Gateway methods are in `core/host/src/gateway/`, with the contract in the [Remote API](../api/remote-control.en.md); snapshots are capped at 192 KiB (`projection.rs`), text at 64 KiB (`controls.rs`), with no attachments and ordinary ask sessions only.
- The desktop IPC contract is `clients/gui/packages/workbench/client/desktop-contract.cjs` (48 commands); the Renderer platform interface is `clients/gui/renderer/src/services.ts`.
- Existing schemas: `schemas/areal-core-v1.json`, `schemas/native-host-v2.json`.

### Work

1. Add `schemas/areal-host-protocol-v1.json` covering every existing local and Gateway method without changing semantics. Record the two existing envelopes as they are: local `{version,id,method,params}` (`core/host/src/wire.rs`) and Remote `{id,method,context,params,commandId}` (`core/host/src/gateway/session.rs`), including their strict rejection of unknown fields. The unified envelope and the `hello` extension go in a separately marked "proposal" section; A0 does not claim the current implementation accepts them.
2. Generate Rust and TS types into their own `generated/` directories, not yet wired into the runtime, with deterministic generation and `--check`. Conformance tests reuse the real wire implementations and existing Host/Relay fixtures to check actual messages, illegal fields and resource limits. Switching the Host and `@areal/remote-client` to the generated types is the first step of A1, to avoid conflicts with Host code under H3–H4 acceptance.
3. The proposal section defines the `hello` extension: protocol version, method list, grant scope (observe/submit/approve/manage), resource limits (frame size, paging, upload chunk), transport type.
4. The destination table keeps the 48 top-level commands as rows; commands with mixed responsibilities are split by operation or parameter. Rule: native interaction (pickers, confirmation dialogs, quit UI, login windows) stays in the shell; business handling goes to the Host, the workbench service or Core; combined operations are split and explained. Behavior the Gateway covers only partly is marked "partly covered by an existing method", never treated as a drop-in alias, and old semantics are not changed. The table goes in an appendix of this spec.
5. The freeze check covers both top-level command names and business operation sets (such as the operations under `manage`), only allowing removals relative to the PR base; additions fail CI. The shell's native bridge is outside the A0 freeze.

### Constraints

- Methods and fields used by released iOS and PWA keep their names and limits.
- Documents, schema, generators and checks only; no runtime behavior change.

### Stop and ask

- An existing Gateway method conflicts with a desktop command's semantics and one must change.
- A desktop command does not fit the Host, the workbench service, Core or the shell.

### Done when

- The schema accurately describes both existing envelopes and every existing method, generated output passes `--check`, conformance tests pass, and existing Remote tests pass unchanged.
- The destination table covers all 48 commands (with their split operations) and the maintainer has confirmed it.
- Injecting a new command and a new business operation each makes CI fail, with raw output attached.
- The PR's target branch already contains the integration baseline, so the diff holds only A0 changes; integration work such as merging upstream main goes to `codex/shared-host` on its own, not into the A0 PR.

## Package A1: local WebSocket, shared data layer and the GUI read path

### Goal

The GUI reads its project list and session details from the Host; a browser opening the same address sees the same content.

### Current state

- The Renderer receives Main's full projection (`packages/workbench/client/state-projection.cjs`) through `requestProjection`/`onProjection` in `preload.cjs`, read by `renderer/src/desktop-services.ts`.
- The remote web page uses `@areal/remote-client` (`RemoteConnection`, `acceptSessionMessage`, `SessionBodyReader`) over Noise only.
- The Electron window loads `areal-ui://app/`.

### Work

0. Switch the Host and `@areal/remote-client` to the types generated in A0, with no behavior change.
1. Add a loopback WebSocket listener to the Host: random port recorded in the Host descriptor; a one-time ticket method (issued after local-socket auth, short-lived, single use); an Origin allowlist of `areal-ui://app` and the Host's own address.
2. Add `shell.subscribe`: the cross-project list (projects, session summaries, attention counts) as snapshot plus sequenced increments; opening the list starts no stopped Core. Session details reuse `session.open`, with the 192 KiB cap replaced by paging according to transport and grants.
3. Build `@areal/client` on `@areal/remote-client`: one connection owner per Host (jittered backoff, probes on foreground and network changes), list and session stores, WebSocket or Noise transport.
4. Switch the Renderer read path to `@areal/client` behind a flag; with the flag off the old projection stays. The Electron preload only fetches the ticket from Main.
5. The Host publishes the same Renderer build that Electron loads; `areal web` opens it (read-only is enough).

### Constraints

- No write paths change; writes still use the old IPC.
- The flag is off by default until the maintainer accepts it.

### Stop and ask

- Ticket or Origin checks would require baking an address into the build.
- The list cannot get summaries without starting a Core.

### Done when

- Installed package with a copy of real data: with the flag on, the GUI shows the same projects and sessions as the old path (item-by-item comparison recorded), and a browser opening the Host address sees the same.
- After network loss, Host restart and Core restart, the list and sessions recover without duplicates; a sequence gap triggers a reread.
- Opening the list starts no stopped Core (shown by process observation).
- With the flag off, behavior matches the pre-change build.

## Package A2: move covered writes to the Host and lift phone limits

### Goal

Writes the Gateway already supports also go through the protocol from the GUI; Main's duplicates are deleted; the phone gets the same capabilities.

### Current state

The Gateway already has `session.create`, `session.send`, `session.control` (configuration, goals, queue, steer), `turn.stop`, `interaction.respond`, `task.read`/`task.pause`/`task.question.*` and `command.read`. Main's equivalents are spread across `backend.cjs`, `submission-recovery.cjs`, `history-observation.cjs` and others.

### Work

1. Replace platform limits with grants and resource limits: remove "ordinary ask only", "Workflow rejected" and "no attachments"; add a chunked upload method whose chunk size is announced in `hello`.
2. Use four grant levels. Pairing checks observe, submit and approve by default; manage is a separate checkbox. Already paired devices keep their grants and are never widened automatically.
3. Switch the GUI's writes above to the protocol (same flag or a sub-flag). Unsettled submissions during the switch are checked against the original journal and ID, never resent.
4. After the flag is accepted, delete Main's duplicate implementations and their IPC commands.

### Constraints

- Released clients keep their understanding of the old limits; relaxations apply only to clients that declare the new capability.
- Historical UNKNOWN entries do not block this package; they show as unknown on their own commands.

### Stop and ask

- A write has different semantics in Main and the Gateway and cannot be merged without a user-visible change.
- Removing a phone limit requires changing Core admission rules.

### Done when

- Installed package: the GUI and the phone each complete create, send (with attachment), queue, stop, approve, answer and task pause; after killing the GUI, the phone completes an approval with exactly one side effect.
- A lost reply is only looked up by its original ID, never resent (reusing existing recovery tests).
- Main's equivalent implementations and IPC commands are deleted and CI blocks their return.

## Package A3: workbench service and remaining domains

### Goal

Move the rest of Main's business code into the Host-supervised Node workbench service or Core, open it to every client through the protocol, and relay desktop tools through the Host.

### Current state

- Main business code is about 27k lines (`worktrees.cjs`, `task-catalog.cjs`, `schedule-admission.cjs`, `library.cjs`, `providers.cjs`, `management.cjs`, `mcp-apps.cjs` and more).
- The Host already supervises the local Relay's Node child the same way (`core/host/src/local_relay.rs`).
- Desktop tools are currently published to Core by Main.

### Work

1. Write and commit a design note first: workbench service supervision, its private channel to the Host, method namespace routing, how it gets Core connections, and capability fallback when Node is absent.
2. First put the existing `CoreBackend` and `DesktopService` under Host supervision, using the existing Main attach path and retaining native capabilities in the shell, to avoid rebuilding shared backend dependencies per domain. Then wire domain protocols in order: library and Worktrees → scheduled-task catalog → trajectory and feedback (with credentials) → manage and providers → MCP apps. Switch send, steer and create only after Gen-UI context and browser tools reach Host. Later move project-local logic into Core and rewrite cross-project logic in Host as needed.
3. Add `tool.provide`: once connected to the Host, the Electron shell registers desktop tools and the Host relays them to the Cores that need them; on disconnect they are revoked and reported unavailable.
4. After each domain moves, delete the matching Main files and IPC commands.

### Constraints

- Public clients connect only to Host; the backend's private authenticated attach channel is reserved for the shell. The workbench service does not depend on Electron. System encryption is provided by the shell or Host vault; decrypted values are used only in runtime memory and never persisted in plaintext.
- Migrations mostly move code; do not rewrite logic in the same PR.

### Stop and ask

- A domain depends on an Electron-only API that cannot move into the shell.
- A domain cannot be cleanly split between cross-project and single-project.

### Done when

- For each domain: shared business completes its main journeys through Web and real Host services, including data-copy compatibility; native capabilities are verified separately in Electron and phones where relevant. Remove the old implementation after acceptance and pass the Main line-count gate.
- A session started from the phone uses browser preview while the GUI is open, and reports it unavailable once the GUI closes.

## Package A4: one UI and retirement

### Goal

Only one UI remains, and the Host is the only client entry point.

### Work

1. Web, remote web and phone all use the same `@areal/app` build, adapting to narrow screens through responsive layout.
2. Retire `clients/web`, `renderer/remote-web`, `renderer/src/remote/RemoteWorkbench.tsx` and the standalone pages in `renderer/src/mobile/`; Core no longer embeds a web page.
3. TUI and CLI connect through the Host protocol; direct-to-Core remains only as an explicit development option.
4. Delete the old IPC projection and the flags; Main contains only shell code.

### Stop and ask

- A released iOS version depends on a page or method slated for deletion.

### Done when

- Integration PR: the shared UI works with its flag on and matches the released behaviour with it off; CI is green.
- Retirement PR: the repository has a single UI build; Electron Main has no business commands; the installed package, a browser and the phone each pass acceptance scenarios OP-01 to OP-08.

## Acceptance scenarios

| ID | Scenario | Package |
| --- | --- | --- |
| OP-01 | GUI and a browser open the same Host and see the same projects and sessions | A1 |
| OP-02 | Opening the list starts no stopped Core | A1 |
| OP-03 | Recovery after network loss, Host restart and Core restart, without duplicates, rereading on gaps | A1 |
| OP-04 | The phone sends an attachment and uses a session with a Workflow profile | A2 |
| OP-05 | After killing the GUI the phone completes an approval with one side effect | A2 |
| OP-06 | A lost reply is looked up by its original ID, never resent | A2 |
| OP-07 | A phone session uses desktop tools while the GUI is open and reports them unavailable after it closes | A3 |
| OP-08 | Released iOS/PWA clients keep working on the new Host with the original method table | A0–A4 |

## Out of scope

- Remote Linux deployment, GUI connecting to a remote Host, multiple OS users, cloud accounts.
- A deadline for rewriting the workbench service in Rust; this spec only requires it to be reachable through the protocol.
- Rewriting the phone UI natively.


## Appendix: A0 desktop command destinations

Existing methods are partial coverage, never aliases. Proposals name operation families, not implemented methods. Preserve published Gateway semantics and limits. Host routes to Core; no parallel runtime is introduced. Shell-only native interactions are outside the freeze. Source: `clients/gui/packages/workbench/client/desktop-contract/transport.cjs`, `app/src/core/main.cjs`, `backend.cjs`, `workspace.cjs`, `plugin-archives.cjs`, and `core/host/src/gateway/session.rs`.

| Command | Protocol destination: existing partial / proposal | Target owner and split |
| --- | --- | --- |
| `cloud` | proposal `cloud.*` | Host account configuration (`status`, `save`) |
| `cloudSession` | proposal `cloudSession.*` | Workbench cloud session (`open`, `create`, `reconnect`, `send`, `stop`); Core execution and history |
| `connect` | existing `project.ensure` (partial); proposal project subscription | Host supervision; Core project subscription |
| `list` | existing `work.list` (partial); proposal session listing | Core project sessions; workbench only cross-project aggregation |
| `open` | existing `session.open` (partial); proposal desktop subscription | Core snapshot; Host subscription transport; client projection |
| `history` | existing `session.history`, `session.body` (partial); proposal history subscription | Core history for `acquire`, `loadOlder`, `loadItem`; Host subscription and client projection/cache for `retain`, `ensureAnchor`, `release` |
| `create` | existing `session.create` (partial); proposal desktop creation | Core creation and receipt |
| `prepareCreator` | proposal creator preparation | Core project preparation |
| `fork` | proposal session fork | Core fork and receipt |
| `side` | existing `session.create`, `session.send` (partial); proposal side-session operations | Core `recover`, `context`, `list`, `start`, `send`, `create`, `close` and receipts |
| `prediction` | proposal session prediction | Core context prediction |
| `send` | existing `session.send` (partial); proposal desktop submission | Core submission and receipt |
| `editMessage` | proposal session edit | Core edit and receipt |
| `continue` | proposal session continuation | Core continuation and receipt |
| `stop` | existing `turn.stop` (partial); proposal desktop stop | Core stop and receipt |
| `attachBrowser` | proposal browser attachment | Core execution binding; shell native browser |
| `respond` | existing `interaction.respond` (partial); proposal desktop response | Core interaction response |
| `reconcile` | existing `command.read` (partial); proposal desktop receipt query | Core authoritative receipt; never replay uncertain submission |
| `configure` | existing `session.control` (partial); proposal desktop configuration | Core session configuration |
| `queue` | proposal session queue read | Core queue |
| `queueEdit` | existing `session.control` (partial); proposal desktop queue edits | Core `update`, `remove`, `reorder`, `pause`, `resume`, `steer` |
| `library` | proposal `library.*` | Workbench cross-project catalog and preferences: `dropSidebar`, `renameProject`, `renameThread`, `pinThread`, `pinProject`, `createSection`, `renameSection`, `removeSection`, `orderSection`, `moveThread`, `moveProject`, `readThread`, `markAllRead`, `orderSidebarThread`, `hideProject`, `orderProject`, `orderThread`, `settings`; shell coordinates desktop tool for `computerControlEnabled`, `computerControlProvider`, `computerControlExecutable` |
| `manage` | existing `session.control`, `task.read`, `task.pause`, `task.question.read`, `task.question.reply`, `artifact.read` (partial); proposal project management operations | Core project management operations, including plugins, MCP, providers, processes, goals, plans, permissions, execution, agents, workflows, workgroups and tasks. Host owns credentials. Shell owns `pluginArchivePick`, resolves the `pluginArchiveImport` selection token, confirms `archive`, and handles native browser/dialog interaction. Workbench retains only cross-project or transitional catalog business; `pluginInstall` and import remain business operations Core project operation set: `pluginComponents`, `pluginHooks`, `pluginMcp`, `mcpApps`, `genUiSource`, `mcpForms`, `mcpToolResult`, `plugins`, `plugin`, `providers`, `mcp`, `profile`, `skills`, `skill`, `inspect`, `context`, `inheritedHistory`, `plan`, `processes`, `process`, `processWait`, `goal`, `permissions`, `interactions`, `processOutput`, `executions`, `execution`, `executionTrace`, `executionTraceResult`, `executionArtifact`, `executionWait`, `agents`, `agentWait`, `workflows`, `server`, `workflow`, `workgroupPolicy`, `workgroups`, `workgroup`, `workgroupWait`, `workgroupArtifact`, `workgroupArtifactStatus`, `workgroupCapabilities`, `workgroupSubmission`, `pluginCapabilities`, `pluginReadiness`, `pluginSubmission`, `processSubmission`, `agentSubmission`, `mcpFormResourceSubmission`, `tasks`, `task`, `taskInbox`, `taskChannel`, `taskDraftHistory`, `taskDraftRead`, `taskSchedulePreview`, `taskScheduleContext`, `taskHistoryCapabilities`, `taskRuns`, `taskRun`, `taskWatch`, `taskUnwatch`, `pluginUserConfigSave`, `pluginDevelopmentLink`, `pluginDevelopmentUnlink`, `pluginArchiveImport`, `mcpFormResourceStage`, `pluginHooksConfigure`, `hookAcknowledge`, `marketplaceAdd`, `marketplaceAddGit`, `marketplaceRemove`, `marketplaceUpdate`, `pluginResolve`, `pluginAuthConfigure`, `pluginConnection`, `connectorConfigure`, `connectorCredential`, `pluginInstall`, `pluginConfigure`, `pluginComponentConfigure`, `pluginUninstall`, `pluginSetup`, `providerSave`, `providerRemove`, `mcpSave`, `mcpConnect`, `mcpDisconnect`, `archive`, `unarchive`, `processCloseStdin`, `processStart`, `processWrite`, `processResize`, `processTerminate`, `goalCreate`, `goalUpdate`, `goalPause`, `goalResume`, `goalClear`, `workgroupStart`, `workflowStart`, `workgroupRevise`, `agentSpawn`, `taskCreate`, `taskUpdate`, `taskRunNow`, `taskPause`, `taskResume`, `taskStopRun`, `taskResumeRun`, `taskCancel`, `taskDelete`, `taskReply`, `taskDraftSend`, `pluginCredentialsReload`, `pluginAuth`, `pluginAuthCredential`, `mcpAppOpen`, `mcpAppOpenFromResult`, `mcpAppRequest`, `mcpAppClose`, `mcpExtensionCall`, `mcpFormRespond`, `mcpFormPreview`, `mcpFormResourcePrepare`, `mcpFormResourceRelease`, `executionCancel`, `executionApply`, `serverDrain`, `serverGc`, `workgroupApplyArtifact`, `workgroupCancel`, `closeResources`, `planUpdate`, `toolAcknowledge`, `contextCompact`, `permissionsForget`, `providerProbe`, `taskDraftConfirm`, `taskDraftStart`. Workbench owns user-scoped `pluginStoreSnapshot` and `pluginStoreDoctor`; project-scoped variants belong to Core. Secret fields and `pluginAuthCredential`, `connectorCredential` cross the Host credential boundary. Shell handles native MCP views/resources and the external browser for `pluginAuth` start. |
| `workspace` | existing `review.read`, `artifact.read` (partial); proposal project files/Git and worktree operations | Core `list`, `search`, `localDirectoryReference`, `read`, `save`, `review`, `reviewCommits`, `reviewBranches`, `turnReview`, `status`, `info`, `gitState`, `gitStage`, `gitUnstage`, `gitCommit`, `gitPush`; workbench cross-project `worktreeList`, `worktreeSettings`, `worktreeOptions`, `worktreeEnvironmentSave`, `worktreeEnvironmentDelete`, `worktreeCancel`, `worktreeAction`, `worktreeDelete`, `worktreeCreate`, `worktreeRead`, `worktreeOpen` (workspace registration) |
| `media` | proposal session media operations | Core `list`, `read`, `upload`, `release` and session references |
| `steer` | existing `session.control` (partial); proposal desktop steer | Core execution steering |
| `dismissRecovery` | proposal recovery dismissal | Core project recovery state |
| `providers` | existing `vault.read`, `vault.replace` (partial); proposal provider operations | Host credentials for `revealKey`, `save`, `saveAndApply`, `remove`, `removeAndApply`; Core provider configuration and `list`, `discover`, `probe`, `apply`, `default`, `defaultAndApply` |
| `chatgpt` | existing `vault.read`, `vault.replace` (partial); proposal account operations | Host `status`, `login`, `forget`, `logout`, `selectAccount`, `cancel`, `probe`; shell opens external browser for `login` |
| `analytics` | proposal analytics operations | Workbench cross-project `read`, `sync`; Core project usage |
| `resources` | proposal resource operations | Core `hooks`, `builtinSkill`, `skills`, `mcp`, `skillRead`, `hooksSave`, `skillToggle`, `skillSave`, `mcpSave`, `mcpConnect`, `mcpDisconnect`; Host credentials |
| `projectless` | existing `project.ensure` (partial); proposal projectless operations | Workbench `catalog`, `directory`, `prepare`; Host project supervision |
| `tasks` | existing `task.read` (partial); proposal cross-project task operations | Workbench aggregation for `list`, `inbox`, `preview`, `observe`; Core project task authority |
| `trajectory` | proposal trajectory operations | Workbench `status`, `retry`, `setEnabled` |
| `feedback` | proposal feedback operations | Workbench `status`, `read`, `preference`, `prepare`, `draft`, `refine`, `submit`, `close` |
| `serviceLifecycle` | existing `host.status`, `host.stop`, `host.updateStatus`, `host.update` (partial); proposal recovery | Host `check`, `stop`, `recover`, `update`; shell `quitInterface`, confirmations and notifications; `stopAndQuit` splits Host stop and shell quit |
| `hostInstallation` | proposal installation operations | Host `status`, `install`, `uninstall`; shell local interaction and stop coordination |
| `hostUpdate` | existing `host.updateStatus`, `host.update` (partial); proposal update preparation | Host `status`, `check`, `prepare`, `apply` |
| `serviceStatus` | existing `host.status` (partial); proposal desktop status | Host status |
| `stopService` | existing `host.stop` (partial); proposal desktop stop | Host stop; shell confirmation |
| `recoverResources` | proposal resource recovery | Host recovery; shell notification |
| `browserData` | shell only | Shell `status`, `importChrome`, `clearCache`, `clearAll` |
| `computerControl` | shell only; proposal configuration coordination | Shell `status`, `requestAccess`, `openSettings`, `restart`, `stop`; workbench configuration coordination |
| `bugReport` | proposal bug report operations | Workbench `prepare`, `list`, `read`, `save`, `delete`, `export` data; shell chooses destination and saves export |
| `exportDiagnostics` | proposal diagnostics export | Workbench diagnostic data; shell save dialog |
| `connectService` | existing `host.subscribe`, `host.status` (partial); proposal discovery | Host service discovery and connection |
| `export` | existing `session.history`, `session.body` (partial); proposal export | Core history and export data; shell chooses destination and saves |
| `remoteControl` | existing `remote.read`, `remote.replace`, `remote.gateway.state`, `remote.gateway.status`, `remote.gateway.control` (partial); proposal pairing/configuration | Host remote configuration and pairing |

## Rust convergence acceptance boundary

The library, execution/connections, scheduled tasks, and worktree implementations may proceed in parallel, with acceptance performed after integration. Register protocols and a decreasing source budget before moving authoritative behavior. Execution migration requires a function-by-function equivalence and behavior-difference table before implementation. Report implementation, compilation, live-service, page-journey, and CLI-only evidence separately. Retiring previous paths requires explicit confirmation; rollback never replays UNKNOWN commands. Worktree deletion logs retain the desktop lifecycle receipt shape; private `lifecycle.dependencies.lifecycleGeneration` provides the original lifecycle generation read-only in fallback mode. See [workbench ownership and selectors](../design/workbench-service.en.md#rust-domain-implementations-and-rollback).

Combined acceptance includes field-by-field library receipt comparisons, backend smoke tests, journeys against a real-data copy created by `node clients/gui/scripts/seed-host-copy.mjs`, and CLI scheduled-task and worktree lifecycles without a GUI installation. Unexecuted platforms remain pending; unit tests do not replace them.
