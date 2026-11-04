[中文](shared-host-spec.md) | **English**

# Shared Host Implementation Spec

Status: target design, in progress. H0 fixes the contract; H1 through H4 require their own runtime evidence. See the [Host API](../api/host.en.md) and [ADR 0016](../adr/0016-shared-host.en.md).

## Summary

Each OS user runs exactly one AReaL Host. CLI, TUI, GUI, `areal web` and the phone are all clients of it, and no client owns it. A client quitting or crashing never affects running work. The Host is written in Rust and ships inside the existing `areal` binary. It owns the project registry, starting and supervising each project's Core, credentials, the Remote Gateway and scheduled-task activation. Threads, Turns and Tasks remain authoritative in each project's Core.

This spec supersedes the dual "GUI-owned / background-owned" modes and the dual-mode transition mechanism in the [independent environment service design](../design/environment-service.en.md) and its [implementation plan](environment-service-plan.en.md). The authority boundaries, Host identity, explicit project start, stop intent and no-replay rules from those documents still apply and are reused below.

Baselines: AReaL-Harness main `62a8f02`; T3 Code `8760d063` (`apps/server/src/serverOwnership.ts`, `docs/user/background-service.md`); ZCode `3c5b2276` (`docs/architecture/r2-server-cli-and-daemon.md`). Commands, protocol methods, fields and exit codes here are proposals. Other documents must not describe them as supported until they are implemented and accepted.

## Decisions

| Question | Decision | Reason |
| --- | --- | --- |
| Implementation language | Rust, as the `areal host` subcommand | One binary; owners, locks and cleanup proofs already live in Rust; deployable to headless Linux |
| How local clients reach Core | The Host finds and starts the project, issues that client an authenticated Core descriptor, and the client connects to Core directly | TUI and `areal web` already connect directly; per-project Cores stay as they are |
| How the phone connects | Only through the Remote Gateway inside the Host | Matches Remote v2 |
| What ⌘Q means | It only disconnects the GUI. When work is running it asks, with "Quit and keep running" as the default and "Stop tasks and quit" as the alternative | Users neither leave work running by accident nor stop it by accident |
| Does an idle Host exit | No. It runs until an explicit stop, logout or shutdown | Matches today's service-host (`docs/api/local-service.en.md`: services have no idle exit timer) |
| Two registries | Merge into `~/.areal`; project data directories stay in place | Core Stores are never moved |

## Handing work to Codex

Implement H0 through H4 continuously in order, using each work package as a verification boundary. Produce reviewable local commits; publishing and pushing require separate authorization. Prompts can refer to the relevant section:

```text
Goal: implement work package H1 of docs/development/shared-host-spec.en.md.
Context: that section's "Current state" and the files it lists; repository rules are in AGENTS.md.
Constraints: "Global constraints" plus that section's "Constraints" and "Stop and ask".
Done when: every item in that section's "Done when" holds, with evidence in the PR.
```

- H0 controlled restart, migration contracts, and continuous implementation are accepted design decisions, with no repeated phase approval. H3 retains the existing Remote wire contract; material protocol changes still require maintainer approval.
- General repository rules (layering, paired Chinese/English docs, test layering, PR template) come from AGENTS.md and are not repeated here.
- Reversible implementation choices inside a work package are Codex's to make, with the reason stated in the PR. Only the "Stop and ask" cases need a question first.

## Target topology

```text
CLI / TUI ─┐
GUI ───────┼─ local socket ─┐
areal web ─┘                ▼
Phone ── Relay ──▶ AReaL Host (one per OS user, holds ~/.areal/host.lock)
                   ├ Project registry (CLI and GUI merged)
                   ├ Start/stop and supervision ──▶ per-project service-host → launcher → Core → Runtime
                   ├ Credentials (macOS Keychain / Linux 0600 file)
                   ├ Remote Gateway
                   └ Scheduled-task activation
Local clients connect directly to a project's Core after receiving its descriptor; the phone always goes through the Gateway.
```

| Component | Owns | Does not own |
| --- | --- | --- |
| Host | Host identity, project registry, top of the Core supervision chain, credentials, device grants, Gateway, scheduled activation, stop intent, upgrade state | Session history, Turns, Task state, the model loop |
| Per-project Core | Threads/Turns/Tasks, approvals, admission receipts, history | Project directory, device pairing, OS service registration |
| GUI | Windows, drafts, rebuildable projections; while connected, desktop-only tools (browser preview, Computer Use, GUI terminal) | The lifetime of any process |
| CLI / TUI / Web | A projection in a terminal or browser | The lifetime of any process |

## Lifecycle contract

| Event | Behavior |
| --- | --- |
| The first client starts and finds no Host | Starts a Host detached from itself, then connects |
| Two clients start a Host at once | Only one acquires `host.lock`; the loser exits with the "already owned" exit code and the client connects to the winner |
| Closing a window, ⌘Q, force-quitting the GUI, closing a terminal, a TUI crash | Only the connection ends; work is unaffected |
| ⌘Q while work is running | Prompt "N tasks will keep running in the background", default "Quit and keep running"; "Stop tasks and quit" uses the existing `ifIdle`/`cancel` stop semantics with a second confirmation |
| Any client reopens | Reconnects to the same Host and sees running Turns and pending approvals |
| `areal host stop` (or "Stop background" in the GUI) | Records stop intent and drains: refuses while busy, cancels only with `--cancel`. Stop intent prevents the service manager from relaunching |
| Login with the system service installed | The service manager starts the Host, which activates only projects needed by scheduled tasks |
| Host crash | The Core chain cleans up through the existing EOF path; with the service installed, bounded restart (at most 5 in 5 minutes, backoff 1, 2, 4, 8, 16 s, then crash-loop-stopped); the new Host waits for the old locks and cleanup proofs |
| Upgrade | See H4: once the new version is installed the Host marks "restart pending", and on user confirmation or when idle drains and restarts on the new version; each Core starts on the new version next time it is needed; running Turns never switch versions mid-way |
| Logout, sleep | No reachability promise; handshake and reconcile on resume |

## Global constraints

- Do not change Core Store formats, move any project's data directory, or rewrite Core or Runtime.
- Keep the existing supervision chain and cleanup proofs. The Host replaces GUI Main as the top holder of the lifetime pipes; the service-host, launcher, Core and Runtime rules below it stay unchanged (the paragraph on how the host controls Core/Runtime startup and shutdown in `docs/api/local-service.en.md`).
- Keep every existing invariant: UNKNOWN is never replayed, admission receipts win, one writer per home.
- The Remote wire protocol stays compatible with shipped iOS and PWA clients; changes are added only through capability negotiation.
- Keep the Runtime → Core → Clients dependency direction. The Host belongs to the Core layer as a crate under `core/`; the GUI uses it through the protocol and the Host never depends on GUI code.
- Credentials, tokens and pairing keys never appear in command-line arguments, plists, logs or diagnostics.
- Out of scope: Windows; SSH deployment to remote machines (`areal up`); multiple OS users; T3 Connect-style cloud accounts.

## Project and migration contract

Client startup is separate from local capability recovery. Failure of one project, model parameter, credential slot, or Remote endpoint must affect only the smallest dependent functional unit. Users must still be able to enter the client, retain visibility of projects, history, and settings, and use other available workspaces. Existing authoritative owners automate migration and version adaptation. Unrecoverable units expose their cause and recovery entry locally rather than replacing the whole client with a recovery gate. Only a shared boundary necessary for safe operation may restrict operations that depend on it. Do not swallow errors, clear user configuration, hide projects, or turn UNKNOWN into success to satisfy startup. This is an acceptance requirement, not a claim that every initialization path already supports local degradation.

Once the GUI has established its shared connection and authoritative project selection, failure to restore the initial project shows an unavailable state and retry action in the conversation area while the sidebar and settings remain accessible. This does not mark the conversation as loaded or expose a submittable empty draft. Retrying retains the loading state until project connection and restoration complete, then reveals the draft. An unavailable shared connection, incomplete project discovery, or blocked lifecycle settlement retains the existing startup gate.

Missing historical cleanup receipts must not turn an upgrade into permanently disabled projects or fork their history into new Stores. A bounded macOS prior-boot recovery policy may check the current kernel boot identity, original service identity and file timestamps, the complete Store metadata inventory, exclusive service and Store locks, and the source singleton under a trusted local system clock. In-place migration proceeds only when this evidence consistently places the original local process lifetime before a full machine boot and the Store has not changed during the current boot. Current-boot failures, active writers, identity conflicts, or unverifiable timestamps still reject adoption. A separate migration receipt records adoption evidence without inventing successful old Runtime cleanup, rewriting old stop receipts, or replaying UNKNOWN requests. This policy does not establish historical external side-effect outcomes and does not treat administrator-tampered or clock-rollback timestamps as reliable provenance.

`ProjectRegistration` independently persists `projectId`, `workspace`, `dataDir`, `source`, and `defaultBinding`; it is not the live-service list. CLI lookup returns `projectAmbiguous` for multiple workspace candidates without one default binding. Commit old GUI `(profile,projectId)` mappings with Remote grants, worktree bindings, and receipt locators. Keep different Stores for one workspace as separate projects. See the [Host API](../api/host.en.md) for complete shapes.

The GUI-root `<projectId>-pending.json` and `<projectId>-outcomes.json` are outside Core Store. Preserve old request IDs, semantic digests, UNKNOWN, and admitted outcomes. After the old writer stops admission and flushes, the Host imports under its exclusive lock, persists a migration receipt with source identity and digest, then switches to one new writer. Interrupted recovery reconciles migration phases without resending old requests. H2 acceptance must cover an accepted request whose response was lost before upgrade, with exactly one side effect after upgrade.

Host supervision identity and Remote Noise peer identity are independent. Automatically migrate pairings, grants, revocations, and the Noise key only from one legacy GUI profile. Distinct Noise identities from multiple profiles produce an explicit conflict and retain their data; never overwrite or merge them. Host credentials include API keys, OAuth, and provider subscription sessions. H3 must move subscription transport ownership so refresh and streaming survive GUI exit.

Stop persists per-project receipts. Aggregate `partial` preserves each completed, blocked, or UNKNOWN result. After Host failure or a lost response, query the original request with `host.operation`; null does not establish non-admission. Stop is not globally atomic across projects. A legacy service-host without an EOF pipe stays `legacyPending`; a fresh Host-owned generation requires drain, cleanup proof, and lock release, or the bounded prior-boot adoption conditions above.

## Work package H0: ADR and protocol contract

### Goal

Fix the Host's boundaries and external contract before writing code, and correct existing documents that contradict the code.

### Current state

- [ADR 0008](../adr/0008-remote-host-ownership.en.md) says a normal GUI exit keeps the background Remote, but `docs/api/local-service.en.md` says quitting the app or ⌘Q stops all Desktop, Host, Core and Runtime processes of that app. The code matches the latter: `watchApplicationLifetime` in `clients/gui/app/src/core/application-owner.cjs` throws without the GUI pipe, and `service-main.cjs` calls `exitProcess(1)` on pipe EOF; `requestQuit` in `main.cjs` stops the whole chain through `recoverConnectedService` in `startup-recovery.cjs`.
- CLI service discovery lives in `~/.areal`. GUI project indexes and Stores live in `areal-core` under userData, while live service discovery defaults to `~/.areal/gui/<serviceHome digest>`. The owning entry points are `home()` in `core/local-service/src/lib.rs` and `serviceOptions` in `service-config.cjs`.
- There is one owner kind: JS `{kind:"gui",appRunId,profile}` (`application-owner.cjs`) and Rust `Owner::Gui` (`core/local-service/src/gui_owner.rs`, `areal_protocol::service`).

### Work

1. A new ADR, "One shared Host per user; every client is a projection", superseding the ownership statements in ADR 0008 and marking 0008 superseded.
2. A Host contract under `docs/api/` (Chinese and English) defining at least:
   - Local transport: a Unix socket under `~/.areal`, directory mode 0700, using the existing `control.sock` path-length derivation; authentication reuses the same-UID plus authFile approach.
   - Methods: `hello` (version and capability negotiation), `host.status`, `host.stop` (`ifIdle` / `cancel`), `projects.list`, `projects.register` (local only), `project.ensure` (returns a Core descriptor usable by that client), `project.stop`, `host.subscribe` (status push), `host.update` (for H4). Names may change; the semantics must cover these.
   - Owner: add `{kind:"host", hostId, generation}` on both the JS and Rust sides; keep `Owner::Gui` runtime support through H1 and H2 until GUI migration completes. Afterward it only identifies legacy instances and cannot claim Host-owned services.
   - Exit code: a dedicated "home already held by another Host" code. On macOS exit with 0 (launchd `KeepAlive.SuccessfulExit=false` will not restart); on Linux use a non-zero code listed in systemd `RestartPreventExitStatus`.
3. Fix the contradicting sentences in `docs/api/local-service.*`, `docs/design/architecture.*` and `docs/design/remote-control.*`, labelled "target design, in progress".

### Constraints

Documentation and schemas only (for example a new Host descriptor under `schemas/`); no runtime code.

### Stop and ask

- An existing invariant conflicts with "no client owns any process" and cannot be resolved inside the Host.

### Done when

- The ADR and Host contract exist in both languages and `python3 scripts/check-docs.py` passes.
- Every contract method states its request, response, errors and idempotency.

## Work package H1: Rust Host with CLI / TUI / Web

### Goal

`areal host` runs; `areal` in a terminal, the TUI and `areal web` find projects through the Host instead of each starting a service-host directly.

### Current state

- `clients/cli/src/service.rs` and the `ensure*` functions in `core/local-service/src/client.rs` start `areal service-host` per workspace; the service-host outlives the CLI.
- `core/service-host` (`lib.rs`, `launcher.rs`) already implements per-project supervision, locks and cleanup proofs.
- `Cargo.lock` already includes `fs2` (file locks).

### Work

1. A new crate (suggested `core/host`) and `areal host run|status|stop`. `run` acquires `~/.areal/host.lock` and exits with the H0 exit code on failure.
2. Project registry: persist independent `ProjectRegistration` records in `~/.areal`; the existing live-service registry only records instance discovery; `project.ensure` reuses `ensure_with_lifetime` from `core/local-service`, with the Host holding the write end of each service-host lifetime pipe.
3. Migrate old CLI service-hosts through controlled restart. An existing process cannot inherit an EOF pipe it did not receive at startup. Mark it `legacyPending` while its work continues. Drain when idle or after explicit `cancel`, verify durable stop receipts, Runtime cleanup, and release of service and Store locks, then start a new generation with the Host owner.
4. Route every ordinary local entry through the Host, including `areal exec`, legacy `-p`, headless TUI, interactive TUI, and Web. Move CLI-generated deployment, MCP, and skills inputs into persistent Host-owned launch inputs; running work cannot depend on a temporary client directory. Clients resolve absolute paths and configuration context; the Host validates at its boundary. Never change global Host cwd or environment to impersonate a client.
5. Client discovery: `areal`, the TUI and `areal web` connect to the Host first, starting a detached Host if none exists, then connect directly to Core with the descriptor. Keep `areal service ...` as a compatibility entry point routed through the Host.
6. `host.stop` reuses Core `drain(ifIdle|cancel)`. Persist per-project receipts, aggregate `partial`, and record stop intent. After a lost response, query the original operation without replaying UNKNOWN. Stop is not globally atomic across projects.

### Constraints

- No GUI changes. During H1 the GUI keeps running the old way on its own home; the two do not interfere.
- Do not change the Core or service-host protocols unless the H0 contract requires it.

### Stop and ask

- Controlled restart would require changing existing lock, generation, or cleanup-proof semantics.
- The TUI can only work if the Host proxies Core traffic.

### Done when

- Integration test with an isolated `AREAL_HARNESS_HOME`: two concurrent `areal host run` processes, only one holds the lock and the other exits with the agreed code.
- Start a Turn from the TUI in terminal A, kill the TUI, reopen it in terminal B, and see the same Turn still running or completed, with side effects applied once.
- `areal host stop` refuses during an active Turn; after `--cancel` all processes and locks are released with complete cleanup proofs.
- A busy legacy CLI service-host keeps its original generation and reports `legacyPending`. After drain and cleanup, a new generation has a Host owner. Killing the Host triggers EOF cleanup for the new chain; pending legacy processes do not claim that guarantee.

## Work package H2: GUI becomes a client

### Goal

The GUI stops starting Desktop Service to manage project lifecycles and connects to the Host instead; ⌘Q gets its new meaning; the old GUI registry and credentials move into the Host.

### Current state

- `service-client.cjs` starts Desktop Service with `AREAL_GUI_DESKTOP_LIFETIME_FD=3`; `service-main.cjs` assembles `CoreBackend`, `RemoteControl`, notifications and power handling.
- Credentials are encrypted with Electron `safeStorage` (`encryption` in `backend.cjs`, `RemoteEncryption` in `remote.cjs`).
- The only direct Electron calls in Desktop Service are `safeStorage`, `Notification`, `powerSaveBlocker` and `crashReporter` (`service-main.cjs:10–13`).

### Work

1. GUI Main connects to the Host, starting one if needed. Listing, opening and stopping projects go through the Host. The Renderer's Core connection is unchanged; only the descriptor now comes from the Host.
2. Registry merge: on first connection the GUI tells the Host its userData path, and the Host imports the GUI registry's projects and worktree mappings, preserving their original `dataDir` without moving Stores. Persist the legacy project-ID, authorization, and receipt mappings before activation. Migrate the Remote identity only under the single-profile conflict rules above; the Host supervision ID is independent. Write a durable migration receipt so interrupted recovery can reconcile each phase. A workspace registered with distinct data directories stays as separate projects; equivalent source imports reuse their saved binding.
3. Credential migration: the Host provides a secret store (macOS Keychain, `security-framework` is already in `Cargo.lock`; Linux 0600 file). The GUI decrypts old ciphertexts with `safeStorage` and hands them to the Host over the local socket, deleting the old ciphertext only after the Host confirms. On failure keep the old ciphertext and ask the user to sign in again; never start with empty credentials.
4. ⌘Q: implement the prompt and both choices from the lifecycle contract; quit without a prompt when nothing is running. Show "Background running, N tasks" in the menu bar or settings with a "Stop background" action.
5. Desktop-only tools: while connected, the GUI publishes browser preview, Computer Use and the GUI terminal to the relevant Core using the existing dynamic ToolHost semantics; on disconnect they are withdrawn and reported unavailable.
6. Transition: the Remote Gateway, scheduled activation and notifications stay in Desktop Service for now, but Desktop Service becomes a Host client and no longer holds any Core lifetime pipe. Until H3, the phone and scheduled tasks still need the GUI running; state this in the PR.

### Constraints

- Retain the old GUI data directory. Import registry snapshots read-only; switch journals with an exclusive writer and a durable migration receipt after the old writer stops writing.
- An older GUI that meets a Host-owned Core must refuse to take it over (`Owner::Gui` mismatch) and must not stop it.

### Stop and ask

- Keychain access needs repeated user authorization, or a signing identity change makes old items unreadable.
- Different workspaces or legacy authorization identities point at the same `dataDir` and cannot be reconciled through persisted same-source mappings. Keep conflicting projects unchanged; do not merge automatically.

### Done when

- A GUI task waits on approval, the GUI is force-quit, the TUI approves, and the reopened GUI shows the same Turn with side effects applied once.
- A session started with `areal` in a terminal appears in the GUI project, and vice versa.
- Both ⌘Q choices verified: after "keep running" `areal host status` still lists the task; after "stop tasks" the task settles and its Core exits.
- Killing the GUI mid credential migration and reopening leaves credentials usable or clearly asks the user to sign in again.
- A creation accepted before upgrade with a lost response still reconciles its original receipt after upgrade, with one side effect. Interrupted migration never leaves old and new journal writers active together.

## Work package H3: Gateway, scheduled activation, push, and subscription transports move into the Host

### Goal

The phone and scheduled tasks no longer depend on the GUI. Desktop Service is removed.

### Current state

- Gateway: `core/host/src/gateway/`, `remote_state.rs`, and `journal.rs`; the original JS behavioral reference is in `clients/gui/app/src/core/remote*.cjs`, with Noise and wire references in `clients/gui/packages/remote` (`channel.mjs`, `wire.mjs`, `relay-codec.mjs`).
- Scheduled activation and preparation: `core/host/src/schedules.rs`, `schedule_connection.rs`, `schedule_admission.rs`, and `schedule_resources.rs`; triggering inside Core is unchanged.
- Subscription source owner: `core/host/src/subscription/`; original account and transport behavioral references remain in `clients/gui/packages/chatgpt-provider/`.
- Existing end-to-end tests: `pnpm --dir clients/gui test:remote-relay`, `test:remote-command-e2e`, `test:remote-interaction`, `test:remote-review`, `test:mobile-command`, `test:mobile-workspace-state`, `test:remote-gui-quit`, `test:schedule-reliability-lifecycle`.

### Work

1. Implement the Gateway in Rust inside the Host: pairing, device grants, Relay and Direct transports, command correlation and journal, immediate revocation, push. Byte-compatible with the current wire protocol.
2. Make the JS end-to-end tests above runnable against the Rust Host as the behavioral reference. Remove the JS implementation only after all of them pass.
3. Move scheduled activation into the Host: on login or Host start, start only projects needed by scheduled tasks; honor project stop intent and Host stop intent.
4. Move provider subscription transport ownership, including ChatGPT login, refresh, account switching, logout, Core reconnect credential injection, and active streaming connections. Credential migration covers API keys, OAuth tokens, and subscription sessions. Core retains model execution authority. These transports survive GUI exit under Host supervision; identity or credential revision mismatch cannot restore an old account.
5. Remove the Desktop Service process and the `AREAL_GUI_DESKTOP_LIFETIME_FD` path. Notifications are shown by the GUI while it is connected and sent only as phone push otherwise. While work is active the Host prevents sleep with `caffeinate -w <host pid>` (macOS) or `systemd-inhibit` (Linux).

### Constraints

- Compare implementations in isolated environments before switching. Each production identity, grant set, and journal has one writer. Retain the JS implementation until Rust passes the reference tests; never serve one identity through two concurrent Gateways.
- Preserve paired devices, the Remote Noise identity, and grants from a single legacy profile without re-pairing. Different identities from multiple profiles produce a conflict; never overwrite them or present them as one peer.

### Background ownership of the local Relay

Host supervises the local Relay server as a separate child process, reusing the HTTP/WebSocket protocol, SQLite Store, and static assets in `services/remote-relay`. Rust Gateway retains ownership of Noise identity, grants, commands, and journals. GUI `relayServiceStartLocal` and `relayServiceStopLocal` express intent; Main does not regain legacy server ownership.

- The runtime and Relay bundle belong to a controlled distribution, with manifest, path, and integrity validation before launch. GUI packages may reuse their bundled Electron in headless Node mode after verifying `node:sqlite` support. Host launches the child independently of GUI IPC and lifetime. CLI layouts without these components explicitly report local Relay unavailable rather than falling back to system PATH.
- A private startup channel carries configuration and the fixed room. Standard output contains only bounded readiness state; diagnostics exclude capabilities, Noise private keys, and request contents. Secrets remain in Host vault and never enter command arguments. Parent-channel EOF cancels startup or drains the server. An exclusive lock remains held until child exit, preventing a second Store writer after Host replacement.
- Start and stop reuse source-level Remote revision, durable intent, and original request receipts. GUI quit leaves Relay running. Normal Host stop and controlled upgrades await Relay closure and process exit before settling shutdown. After a Host crash, a successor cannot start a replacement before the old lifetime and locks are released. Explicit stop intent remains effective; uncertain requests are not replayed to restore service.
- Local HTTP origins are allowed only for an explicitly enabled LAN Relay actually supervised by this Host. Gateway connects to the controlled local endpoint and verifies its public authority. External Relays still require HTTPS/WSS; an arbitrary HTTP configuration cannot opt into local trust.
- A single legacy source retains its original Noise identity, device grants, room, and capability. The old Relay Store stays at its original path and is used only after source migration is authorized, its old writer has exited, and exclusive locking succeeds. A fresh Store, new pairing, or replacement identity cannot substitute for migration evidence. Projects missing original cleanup proof remain subject to source-migration blocking.

Acceptance covers the original GUI controls, actual Relay health and Noise channels, continued service after GUI quit, original Host stop receipts and child exit, crash replacement behind old locks, port conflicts, original pending-operation queries, revoked rooms remaining revoked, and pairing-identity continuity for an isolated legacy source. Source, extracted packages, formally signed packages, and physical devices have separate evidence. This section specifies implementation requirements, not completed acceptance.

### Reference observations and stop settlement

- JS private dispatch-parameter caches, save counts, and connection objects may be replaced by the same original request's Host receipt, durable result, real connection state, and actual effects. Replacement evidence must preserve identity and authorization and must not claim to measure physical calls underneath.
- T24 binds settlement to the original Tool `id`, `runtimeEpoch`, `scopeId`, and `operationId`. Accept a terminated tool and `interrupted` Turn only when the original Runtime result establishes termination through `terminated`, `exited`, closed output, and corresponding evidence; Turn status alone is insufficient. Without a definite result, retain the original strong UNKNOWN assertions. `null`, timeout, and disconnection never prove non-execution. Authorization, target refusal, original-request association, and exactly-once effects remain required.

### Stop and ask

- Outside the explicit observation migration and stop-settlement branches supported by original evidence above, a reference test needs changed business assertions to pass.
- The Relay server protocol (`services/remote-relay`) would have to change.

### Done when

- All end-to-end tests above pass against the Rust Host, with run records in the PR.
- With the GUI fully quit, the phone connects through Relay and completes an approval; scheduled tasks fire on time.
- A paired real device from one legacy profile reconnects without re-pairing. Importing a second distinct Noise identity fails and preserves its grants. ChatGPT subscription work continues after GUI exit; refresh and reconnect cannot restore a logged-out account.

## Work package H4: System service and upgrades

### Goal

Everything works after login without opening a client, and upgrades no longer rely on "quit and reopen".

### Work

1. `areal host install|uninstall`: a per-user LaunchAgent on macOS (`KeepAlive.SuccessfulExit=false`, `ThrottleInterval`), a systemd user service on Linux (`RestartPreventExitStatus` set to the H0 exit code; suggest `loginctl enable-linger` when needed). Write the executable path and `AREAL_HARNESS_HOME` explicitly; never rely on an interactive shell environment. Uninstalling the service keeps data.
2. Crash budget: at most 5 restarts in 5 minutes with backoff 1, 2, 4, 8, 16 s, then `crash-loop-stopped`, shown by `areal host status`.
3. Upgrade: after the new version is installed to its versioned directory, the Host marks `restartPending` and every client shows "New version ready, restart background to apply". On confirmation it drains: waits or refuses while work runs, cancelling needs a second confirmation; then the Host restarts on the new version. Each Core starts on the new version next time it is needed. Optional "restart automatically when idle".
4. Compatibility: new clients with an old Host and old clients with a new Host both work through capability negotiation; missing features are hidden, never inferred from version numbers.
5. A "Start background at login" switch in GUI settings, mapped to install/uninstall.

### Stop and ask

- Signing or notarization requires a package layout change that would break the LaunchAgent path after app updates.

### Done when

- After login, without opening any client, the phone connects and scheduled tasks fire on time.
- After `areal host stop` the service manager does not relaunch it; `areal host run` or any client can start it again.
- Upgrade is refused while work runs, succeeds when idle, and `host.status` shows the new version with unchanged Host identity and pairings.
- Acceptance on a signed installer is recorded separately; development builds do not substitute for it.

## Acceptance scenarios

| ID | Scenario | Work package |
| --- | --- | --- |
| HOST-01 | Concurrent starts yield one Host | H1 |
| HOST-02 | After killing a client the same Turn continues, side effects once | H1, H2 |
| HOST-03 | Terminal and GUI see the same projects and sessions | H2 |
| HOST-04 | Both ⌘Q choices behave correctly | H2 |
| HOST-05 | Interrupted credential migration recovers | H2 |
| HOST-06 | Phone and scheduled tasks work after the GUI quits | H3 |
| HOST-07 | Paired devices need no re-pairing | H3 |
| HOST-08 | Starts at login; stop intent is not overridden by relaunch | H4 |
| HOST-09 | Upgrade refused while busy, succeeds when idle, identity unchanged | H4 |
| HOST-10 | Bounded restart after a Host crash without bypassing old locks | H1, H4 |
| HOST-11 | Busy legacy service stays pending; cleanup permits a new Host-owned generation | H1 |
| HOST-12 | Accepted response-lost request survives journal migration with one side effect | H2 |
| HOST-13 | Distinct legacy Noise identities conflict without overwriting grants | H2, H3 |
| HOST-14 | Provider subscription streaming and refresh survive GUI exit | H3 |
| HOST-15 | Partial stop and lost response reconcile without replaying UNKNOWN | H1, H4 |
| HOST-16 | exec, legacy -p, and headless TUI survive client exit and temporary-input cleanup | H1 |

## Out of scope

- `areal up`-style SSH deployment to remote Linux and a GUI connecting to a remote Host. After H1–H4 the Host already runs on headless Linux; that gets its own spec.
- Starting never-opened projects from the phone (the earlier E3), Windows, sharing across OS users, cloud accounts and hosted tunnels.
