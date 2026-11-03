[中文](shared-host-spec.md) | **English**

# Shared Host Implementation Spec

## Summary

Each OS user runs exactly one AReaL Host. CLI, TUI, GUI, `areal web` and the phone are all clients of it, and no client owns it. A client quitting or crashing never affects running work. The Host is written in Rust and ships inside the existing `areal` binary. It owns the project registry, starting and supervising each project's Core, credentials, the Remote Gateway and scheduled-task activation. Threads, Turns and Tasks remain authoritative in each project's Core.

This spec supersedes the dual "GUI-owned / background-owned" modes and the mode-transition receipts in the [independent environment service design](../design/environment-service.en.md) and its [implementation plan](environment-service-plan.en.md). The authority boundaries, Host identity, explicit project start, stop intent and no-replay rules from those documents still apply and are reused below.

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

Run H0 → H4 in order, one Codex task and one PR per work package. Four short prompt sections are enough; refer to this document instead of pasting it:

```text
Goal: implement work package H1 of docs/development/shared-host-spec.en.md.
Context: that section's "Current state" and the files it lists; repository rules are in AGENTS.md.
Constraints: "Global constraints" plus that section's "Constraints" and "Stop and ask".
Done when: every item in that section's "Done when" holds, with evidence in the PR.
```

- Use high reasoning effort throughout. For H0 and H3, start in Plan mode and produce a design note for maintainer approval before implementing.
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

## Work package H0: ADR and protocol contract

### Goal

Fix the Host's boundaries and external contract before writing code, and correct existing documents that contradict the code.

### Current state

- [ADR 0008](../adr/0008-remote-host-ownership.en.md) says a normal GUI exit keeps the background Remote, but `docs/api/local-service.en.md` says quitting the app or ⌘Q stops all Desktop, Host, Core and Runtime processes of that app. The code matches the latter: `watchApplicationLifetime` in `clients/gui/app/src/core/application-owner.cjs` throws without the GUI pipe, and `service-main.cjs` calls `exitProcess(1)` on pipe EOF; `requestQuit` in `main.cjs` stops the whole chain through `recoverConnectedService` in `startup-recovery.cjs`.
- The CLI registry lives in `~/.areal` (`home()` in `core/local-service/src/lib.rs`); the GUI registry lives in `areal-core` under the GUI userData directory (`serviceHome` in `service-config.cjs`).
- There is one owner kind: JS `{kind:"gui",appRunId,profile}` (`application-owner.cjs`) and Rust `Owner::Gui` (`core/local-service/src/gui_owner.rs`, `areal_protocol::service`).

### Work

1. A new ADR, "One shared Host per user; every client is a projection", superseding the ownership statements in ADR 0008 and marking 0008 superseded.
2. A Host contract under `docs/api/` (Chinese and English) defining at least:
   - Local transport: a Unix socket under `~/.areal`, directory mode 0700, using the existing `control.sock` path-length derivation; authentication reuses the same-UID plus authFile approach.
   - Methods: `hello` (version and capability negotiation), `host.status`, `host.stop` (`ifIdle` / `cancel`), `projects.list`, `projects.register` (local only), `project.ensure` (returns a Core descriptor usable by that client), `project.stop`, `host.subscribe` (status push), `host.update` (for H4). Names may change; the semantics must cover these.
   - Owner: add `{kind:"host", hostId, generation}` on both the JS and Rust sides; keep `Owner::Gui` for decoding only, to recognize and refuse old instances.
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
2. Project registry: read and write the existing `~/.areal` registry; `project.ensure` reuses `ensure_with_lifetime` from `core/local-service`, with the Host holding the write end of each service-host lifetime pipe.
3. Adopt running CLI service-hosts that have no owner: verify identity, locks and generation with existing rules and bring them under supervision without restarting.
4. Client discovery: `areal`, the TUI and `areal web` connect to the Host first, starting a detached Host if none exists, then connect directly to Core with the descriptor. Keep `areal service ...` as a compatibility entry point routed through the Host.
5. `host.stop`: reuse Core's existing `drain(ifIdle|cancel)` and record stop intent.

### Constraints

- No GUI changes. During H1 the GUI keeps running the old way on its own home; the two do not interfere.
- Do not change the Core or service-host protocols unless the H0 contract requires it.

### Stop and ask

- Adopting a running service-host would require changing its lock or generation semantics.
- The TUI can only work if the Host proxies Core traffic.

### Done when

- Integration test with an isolated `AREAL_HARNESS_HOME`: two concurrent `areal host run` processes, only one holds the lock and the other exits with the agreed code.
- Start a Turn from the TUI in terminal A, kill the TUI, reopen it in terminal B, and see the same Turn still running or completed, with side effects applied once.
- `areal host stop` refuses during an active Turn; after `--cancel` all processes and locks are released with complete cleanup proofs.
- A CLI service-host that was already running keeps the same generation after the Host starts.

## Work package H2: GUI becomes a client

### Goal

The GUI stops starting Desktop Service to manage project lifecycles and connects to the Host instead; ⌘Q gets its new meaning; the old GUI registry and credentials move into the Host.

### Current state

- `service-client.cjs` starts Desktop Service with `AREAL_GUI_DESKTOP_LIFETIME_FD=3`; `service-main.cjs` assembles `CoreBackend`, `RemoteControl`, notifications and power handling.
- Credentials are encrypted with Electron `safeStorage` (`encryption` in `backend.cjs`, `RemoteEncryption` in `remote.cjs`).
- The only direct Electron calls in Desktop Service are `safeStorage`, `Notification`, `powerSaveBlocker` and `crashReporter` (`service-main.cjs:10–13`).

### Work

1. GUI Main connects to the Host, starting one if needed. Listing, opening and stopping projects go through the Host. The Renderer's Core connection is unchanged; only the descriptor now comes from the Host.
2. Registry merge: on first connection the GUI tells the Host its userData path, and the Host imports the GUI registry's projects, worktree mappings and Host identity, registering each at its original `dataDir` without moving Stores. Write a completion marker; re-running after an interruption must be safe. A workspace registered on both sides stays as two projects.
3. Credential migration: the Host provides a secret store (macOS Keychain, `security-framework` is already in `Cargo.lock`; Linux 0600 file). The GUI decrypts old ciphertexts with `safeStorage` and hands them to the Host over the local socket, deleting the old ciphertext only after the Host confirms. On failure keep the old ciphertext and ask the user to sign in again; never start with empty credentials.
4. ⌘Q: implement the prompt and both choices from the lifecycle contract; quit without a prompt when nothing is running. Show "Background running, N tasks" in the menu bar or settings with a "Stop background" action.
5. Desktop-only tools: while connected, the GUI publishes browser preview, Computer Use and the GUI terminal to the relevant Core using the existing dynamic ToolHost semantics; on disconnect they are withdrawn and reported unavailable.
6. Transition: the Remote Gateway, scheduled activation and notifications stay in Desktop Service for now, but Desktop Service becomes a Host client and no longer holds any Core lifetime pipe. Until H3, the phone and scheduled tasks still need the GUI running; state this in the PR.

### Constraints

- Do not delete the old GUI data directory; the import only reads the old registry.
- An older GUI that meets a Host-owned Core must refuse to take it over (`Owner::Gui` mismatch) and must not stop it.

### Stop and ask

- Keychain access needs repeated user authorization, or a signing identity change makes old items unreadable.
- The import finds two registry entries pointing at the same `dataDir`.

### Done when

- A GUI task waits on approval, the GUI is force-quit, the TUI approves, and the reopened GUI shows the same Turn with side effects applied once.
- A session started with `areal` in a terminal appears in the GUI project, and vice versa.
- Both ⌘Q choices verified: after "keep running" `areal host status` still lists the task; after "stop tasks" the task settles and its Core exits.
- Killing the GUI mid credential migration and reopening leaves credentials usable or clearly asks the user to sign in again.

## Work package H3: Gateway, scheduled activation and push move into the Host

### Goal

The phone and scheduled tasks no longer depend on the GUI. Desktop Service is removed.

### Current state

- Gateway: `clients/gui/app/src/core/remote*.cjs`; Noise and wire format: `clients/gui/packages/remote` (`channel.mjs`, `wire.mjs`, `relay-codec.mjs`).
- Scheduled activation: `schedule-owner-activation.cjs`; triggering inside Core is unchanged.
- Existing end-to-end tests: `pnpm --dir clients/gui test:remote-relay`, `test:remote-command-e2e`, `test:remote-interaction`, `test:remote-review`, `test:mobile-command`, `test:mobile-workspace-state`, `test:remote-gui-quit`, `test:schedule-reliability-lifecycle`.

### Work

1. Implement the Gateway in Rust inside the Host: pairing, device grants, Relay and Direct transports, command correlation and journal, immediate revocation, push. Byte-compatible with the current wire protocol.
2. Make the JS end-to-end tests above runnable against the Rust Host as the behavioral reference. Remove the JS implementation only after all of them pass.
3. Move scheduled activation into the Host: on login or Host start, start only projects needed by scheduled tasks; honor project stop intent and Host stop intent.
4. Remove the Desktop Service process and the `AREAL_GUI_DESKTOP_LIFETIME_FD` path. Notifications are shown by the GUI while it is connected and sent only as phone push otherwise. While work is active the Host prevents sleep with `caffeinate -w <host pid>` (macOS) or `systemd-inhibit` (Linux).

### Constraints

- Run side by side before switching: the JS Gateway stays available until the Rust Gateway passes every reference test.
- Paired devices, the Host Noise identity and grants are kept as they are; no re-pairing.

### Stop and ask

- Any reference test needs a changed assertion to pass.
- The Relay server protocol (`services/remote-relay`) would have to change.

### Done when

- All end-to-end tests above pass against the Rust Host, with run records in the PR.
- With the GUI fully quit, the phone connects through Relay and completes an approval; scheduled tasks fire on time.
- An already paired real device connects after the upgrade without re-pairing.

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

## Out of scope

- `areal up`-style SSH deployment to remote Linux and a GUI connecting to a remote Host. After H1–H4 the Host already runs on headless Linux; that gets its own spec.
- Starting never-opened projects from the phone (the earlier E3), Windows, sharing across OS users, cloud accounts and hosted tunnels.
