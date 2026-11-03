[中文](environment-service.md) | **English**

# Independent development environment service

> Superseded by the [shared Host implementation spec](../development/shared-host-spec.en.md): the dual "GUI-owned / background-owned" modes and transition receipts are dropped. The authority boundaries, Host identity, explicit project start, stop intent and no-replay rules here are carried into the new spec.

Status: target design, not implemented. This document defines how Desktop Service evolves; it does not claim independent startup, execution after GUI exit, or a complete mobile development workflow has shipped. See the [implementation plan](../development/environment-service-plan.en.md) for stages and evidence gates. The current [local service](../api/local-service.en.md), [Desktop API](../api/desktop.en.md), and [Remote API](../api/remote-control.en.md) remain authoritative. New capabilities require updates to those contracts before activation.

## 1. Goal and scope

The Mac is the execution machine. Code, Git, development tools, and model credentials stay on the Mac. A phone operates authorized projects through the existing Relay; the Mac GUI accesses the same projects and conversations through the local backend. Once enabled, the environment service keeps execution and remote access available after the GUI exits. Reopening the GUI attaches to the same authoritative state.

The acceptance journey is: enable and pair locally → select an authorized project on the phone → explicitly start it if necessary → create a conversation requesting code changes → execute and test on the Mac → answer questions, approve operations, and review the diff on the phone → request further changes or a commit → open the same conversation in the Mac GUI.

“Desktop equivalence” means the same workspace, Thread, permissions, execution system, and command semantics, not every desktop window or editor on a phone. A user's ordinary “development task” maps first to Thread/Turn. Remote development does not introduce another Task model. Existing Task/TaskRun retain their scheduling meaning; WorkItem remains an overview projection.

The first release covers an independent backend for one logged-in macOS user, the existing Relay, and registered projects. It retains local enablement and pairing without adding a T3 Connect-style cloud account, device directory, or managed tunnel. SSH/WSL/Docker deployment, cross-environment agent delegation, pre-login services, mobile terminals, and browser takeover are not first-release dependencies.

## 2. Existing foundations and gaps

| Existing owner or entry point | Current responsibility | Required evolution |
|---|---|---|
| `service-main.cjs` / `service-protocol.cjs` | Windowless Desktop Service assembling Backend, Remote, notifications, and power integration | Reuse the process and business assembly with managed startup independent of the GUI |
| `application-owner.cjs` / `main.cjs` | GUI owner, lifetime pipes, backend shutdown coordination on exit | GUI releases only client resources in independent mode; backend death still triggers supervised cleanup |
| `service-client.cjs` / `service-config.cjs` | Discovery, deployment identity, startup, configuration, and data locations | Separate attachment from startup while retaining single-writer, version, and configuration checks |
| `local-service.cjs` / public `areal service` | Locate and manage Core by canonical workspace | Retain public lifecycle entry points rather than managing Core/Runtime PIDs directly |
| `remote.cjs` / `remote-session-commands.cjs` | Pairing, authorization, command association, conversation operations | Keep the Gateway boundary and add explicitly authorized project startup |
| `remote-session-controls.cjs` | Configuration, Goal, queue, and steer mapping | Reuse Core semantics without a mobile execution loop |
| `submission-recovery.cjs` / `project-connections.cjs` | Receipt reconciliation, reconnection, generation fencing | Preserve original records, UNKNOWN outcomes, and identity constraints across owner migration |

These files reside in `clients/gui/app/src/core/`. Currently, `watchApplicationLifetime` requires the GUI lifetime pipe and `requestQuit` coordinates shutdown of the connected backend. Closing a window and exiting the application are different. [ADR 0008](../adr/0008-remote-host-ownership.en.md) describes retaining background Remote access, but does not prove independence of the current exit path. Early read-only slices in the Remote design also do not describe all current capabilities; source and the Remote API define the write surface.

An independent environment service first changes the lifecycle and deployment form of Desktop Service. The first release reuses the Electron backend, OS credentials, and subscription adapters. It adds neither a parallel agent daemon nor a prerequisite directory migration or Rust/Node rewrite.

## 3. Topology and authority

The phone business path is “phone → Relay → environment backend Remote Gateway → workspace Core → Runtime.” The desktop path is “Renderer → narrow IPC/Main → local environment backend → the same Core.” The phone path does not traverse the GUI Renderer. Adapters may differ; business admission and results converge in Core.

| Component | Owned state and responsibilities | Excluded responsibilities |
|---|---|---|
| GUI Renderer / phone | Drafts, connection state, reconstructible projections, user operations | Durable execution authority or automatic replay of unknown writes |
| GUI Main | Windows, narrow IPC, native UI lifetime, local management entry | Backend and Core lifetime leases in independent mode |
| Environment backend | Host identity, device grants, project registry, credential adapters, Gateway, Core discovery/activation, existing composite-command associations | Agent loop, duplicate conversation history, another Task scheduler |
| Core | Thread/Turn, model loop, Goal/Task/TaskRun, configuration, business admission, approvals, authoritative receipts and history | Cloud discovery, GUI windows, OS service registration |
| Runtime | Tool execution permissions, operation facts, subprocess and resource cleanup proof | Conversation orchestration, device pairing, project catalog |
| Relay | Host registration and routing metadata, rate limits, encrypted record forwarding | Business authorization decisions, model credentials, persisted task bodies, offline execution |
| macOS service manager | User-level backend startup and exit supervision | Determining business admission or proving tool cleanup |

“Environment service” is a product boundary, not a new owner of all business state. The backend owns project registration and connection mappings; each Core retains execution and history. Relay unavailability affects remote reachability, not the Mac's execution outcome or an available local client.

### Identity and isolation

Reuse the persistent Remote Host identity as the remote environment identifier. The product may display “development environment” without introducing a second Environment UUID. A local instance without Remote retains its existing discovery identity; first-time enablement persists a Host identity through the existing owner.

| Identifier | Lifetime and purpose |
|---|---|
| Host identity | Authorization domain bound to canonical data home and OS user; unchanged by network, Relay endpoint, or backend restart |
| Backend/Gateway generation | One backend run and its connection admission; restart invalidates old connections |
| Project ID / workspace binding | Backend registration maps to canonical workspace and Core data directory; not derived from a Relay room or GUI window |
| Core serviceId / generation | Authoritative instance and current run, using existing reconciliation rules |
| Thread / Turn / Task / TaskRun | Core business identities; switching clients does not clone them |
| Runtime epoch / tool Host generation | Execution and host capability ownership; Gateway connectivity does not establish validity |

One environment aggregates projects while each execution workspace retains an independent Core and locked data directory. Logical projects and worktrees reuse existing mappings; worktrees do not share execution state. PIDs, ports, and `service.json` are discovery hints. Attachment also validates authenticated identity, locks, deployment compatibility, and owner.

The first release does not support copying one persistent identity directory to two active machines. Independent installations and development worktrees use isolated homes; resetting identity requires pairing again. Key rotation requires a separate authenticated migration contract, not silent pin replacement with old grants retained. GUI and backend application identities may differ, but the first release retains existing user-data, Keychain access, and signing relationships.

## 4. Independent Desktop Service operation

### Enablement and a single owner

Without independent mode, retain the current GUI-owned lifecycle. After a local user enables the background development environment, a user LaunchAgent starts the existing backend application entry point. Service registration and remote network enablement are persisted separately; disabling Relay does not implicitly stop local execution.

Only one execution owner may use a home at a time. The new owner identifies the stable environment and current backend run rather than treating `appRunId` as environment identity. The GUI becomes an authorized local client; the independent backend holds the supervision chain to its managed Core hosts. Implementation must update JS/Rust owner decoding, CLI arguments, and public lifecycle contracts together, not relax validation on only one side.

LaunchAgent startup, restart, and exit do not replace Core locks, admission receipts, or cleanup protocols. After backend death, inherited pipes/launchers still terminate owned execution resources. A successor waits for proven cleanup, released locks, and valid recovery conditions; an absent PID alone cannot authorize replacement. GUI-owned crash cleanup remains effective.

### User actions and runtime behavior

| Action | Target behavior in independent mode |
|---|---|
| Close windows or exit the GUI | Release GUI-only resources and subscriptions; backend, Remote, and admitted work continue |
| Phone disconnects or enters background | Release observers; Mac continues; reconcile on reconnect |
| Explicitly stop the environment | Persist stop intent and suppress automatic restart first, then use existing drain; reject busy stops by default, requiring explicit confirmation to cancel |
| Start the environment again | Clear explicit-stop suppression, start through the service manager, and reconcile rather than replay interrupted work |
| Backend crash | Supervised cleanup and bounded restart; repeated failure becomes diagnosable instead of a busy loop |
| GUI crash | Clean up that GUI's resources without terminating the backend |
| Logout, sleep, or shutdown | No availability or execution-continuity promise; observe and reconcile after recovery |

LaunchAgent support is limited to the logged-in user session. Screen lock and system sleep require separate acceptance: locking does not imply backend exit, but Keychain and interactive native capabilities may be unavailable. Existing `SharedPowerMonitor` owns active-work power policy; the feature does not globally disable sleep.

Startup policy distinguishes abnormal-exit restart, user stop, and update drain. Unconditional keep-alive must not override an explicit stop. Failed, partial, or cleanup-unknown shutdown retains diagnostics and the original operation reference rather than reporting stopped. GUI exit semantics remain unchanged when independent mode is disabled.

### Login, credentials, and native capabilities

LaunchAgent does not inherit an interactive shell environment. Backend launch configuration fixes trusted executable paths, canonical home, configuration paths, and supported tool environment, reusing existing toolchain and proxy resolution. Secrets must not enter plist files, command lines, or diagnostics. Startup cannot depend on temporary credentials or PATH injected by the first GUI launch.

Existing `safeStorage`, Provider/subscription forwarding, network proxies, and credential refresh belong to the environment backend. Failure to decrypt or refresh after login produces a real unavailable state recoverable through local settings; starting with empty credentials must not turn a setup failure into a task failure. Initial login and OS permission prompts remain explicit local interactions.

Classify native capabilities by their actual owners: files/commands and existing GUI-independent tools remain available through Core/Runtime and backend adapters; WebContentsView, window previews, and GUI-owned terminals are released with their windows. Tools requiring an interactive desktop, TCC permission, or a visible page advertise availability only when their real Host is ready. Otherwise report unavailability without opening windows or stealing focus. The first release does not migrate all Browser/Computer ownership.

### Scheduling and project activation

Retain existing schedule owners for project discovery and activation. Core exclusively owns triggers, missed-run handling, overlap admission, and TaskRun. In independent mode these responsibilities may survive with the backend after GUI exit; this behavior change requires dedicated acceptance.

Login startup restores only explicitly enabled background execution policies and projects required by existing schedules, not every historical project. Activation coordination and mobile entry points both respect explicitly stopped projects. Restart does not resume interrupted Goals, queues, or execution that Core paused; future schedules follow Core recovery rules.

## 5. Project and development contracts

### Project availability

Environment connectivity, project readiness, model availability, and running Turns are separate facts. The project list must represent stopped, starting, ready, incompatible, configuration/credential-blocked, and cleanup-pending states; cached state is only a last observation.

The phone accesses only locally registered projects granted to its device. The first release does not accept arbitrary absolute paths, register new directories, or change data directories remotely. Add explicit startup for a registered project:

1. Gateway checks current device, project scope, and a separately granted startup capability. Existing `submit` grants do not automatically gain it.
2. Accept commandId and expected grant/backend generation, persist the operation association, then use the existing startup owner to invoke public `ensure --no-auto-restart`.
3. Under the workspace lock, reuse a compatible instance or start one. Configuration/binary/permission conflicts require local resolution without silent upgrades, cancellation, or privilege expansion.
4. Publish ready only after authenticated identity and capability checks. For unknown startup results, inspect the original startup operation and exact instance; retain uncertainty instead of blindly starting again.

Startup may precede a Core generation and cannot be forced into the existing write context that requires an online Core. The Remote API needs a separate environment/project lifecycle target and receipt contract. Method names, fields, and versions become schemas during implementation; this design does not claim those calls exist. Passive reconnect, list refresh, and conversation creation never implicitly start a project.

### Conversation and result workflow

The phone keeps existing conversation creation, sending, configuration, queue, Goal, approval, stop, and read-only Review operations. Desktop and phone adapters follow Core rules; unifying behavior does not expose the entire private Desktop RPC surface. Clients negotiate methods/capabilities rather than infer support from version strings.

Clients may observe and submit concurrently. Configuration carries expected revision, stopping targets a specific Turn, and approval binds the interaction and argument digest. Conflicts return updated state for a user decision. Ordinary conversations do not gain a global exclusive mobile-control lease.

The first result workflow provides diff/necessary file context, tool output, and test conclusions, followed by messages requesting changes or a commit. Test results require execution evidence; an agent's summary cannot stand in for passing records. Dedicated Git commit actions, editing, worktree creation, and terminals are later capabilities. Each needs explicit targets, authorization, reviewed versions, and effect receipts while reusing existing Git/worktree owners.

### Transport and recovery

Direct and Relay retain the same business commands and permissions. Both phone and Host initiate Relay connections. Noise identity pinning, application authorization, and TLS chain/hostname/expiry validation remain intact. Relay room/channel identify routes, not environment identity or permissions. If Relay also serves the Web client, its static-code publisher remains a trust boundary.

On reconnect, the phone handshakes, reads grants/capabilities, and establishes an authoritative snapshot with ordered deltas. Gaps, generation changes, or backpressure require a new baseline. The existing journal retains original commandId, semantic digest, and Core request association. Disconnects, timeouts, empty receipts, and a new generation do not prove non-admission. Only matching authoritative receipts or strict negative evidence settle UNKNOWN. This also applies to project startup and lifecycle operations.

Device revocation or reduced grants block new operations, invalidate subscriptions, and restrict subsequent content at the Gateway without waiting for client refresh. Already admitted Core work is not implicitly canceled by revocation; the local user may explicitly stop it. Project grants are not an OS sandbox; Core/Runtime retain effective tool and execution permission enforcement.

## 6. Data handoff, compatibility, and updates

### Evolve in place without duplicate state

Keep existing service home, Core registry, workspace bindings, project/worktree indexes, Host keys and grants, encrypted Provider credentials, submission pending/outcomes, and operation receipts. Do not import history into a new environment database, move Core Store, or reuse another development worktree's state.

Add only the versioned launch/owner configuration and transition receipt required by the new mode. Registration records the chosen application location and deployment identity; discovery descriptors and PIDs are reconstructible. Transition receipts reference the original home, old owner/generation, target deployment, completed steps, and outcomes, reusing lifecycle persistence rather than creating a generic workflow engine.

### Safe transition

1. Locally preflight backend entry point, signing/credential access, directory binding, and compatibility; obtain explicit authorization to install a login service.
2. Persist transition intent under existing lifecycle serialization, stop new admission and automatic activation. Wait or reject when work is active; cancellation requires a separate explicit decision.
3. Settle the old backend and its owned Core/Runtime through existing shutdown, checking actual exit, released locks, and cleanup proof. Preserve history, drafts, and UNKNOWN.
4. Start the new owner through the service manager against the same data, validating identity, compatibility, and credentials. Any format migration uses the original write lock, backups, and each Store's contract.
5. Publish readiness; GUI and phone reattach, renegotiate capabilities, read snapshots, and reconcile old requests.
6. Persist transition completion. Lost responses require reading the original transition record, never racing the old launcher against LaunchAgent for the same home.

After interruption, local recovery first reconciles receipts, OS registration, and actual processes. Attach to an already-started new owner or report incompatibility; block while old execution lacks cleanup proof. Restoring the old mode requires no active writer, confirmed cleanup, and compatible data. A new GUI's inability to connect is not rollback evidence.

### Upgrade and disablement

Independent backend and GUI negotiate compatibility separately. An old GUI must not terminate or take over an unrecognized owner; implementation must verify old-client rejection behavior. The same lifecycle owner coordinates application updates: protect active work, stop, reconcile, switch application resources, and handshake again. Do not overwrite a bundle whose resources the backend still uses.

Stopping and uninstalling login registration are distinct operations. Disabling independent mode uses the same drain and single-writer handoff, retaining user data and device grants unless separately revoked. Local explicit shutdown must be possible when Remote is enabled but execution is idle; the old “Remote enabled means busy” rule cannot permanently block maintenance.

Check binary, deployment, permission, and persistence compatibility separately. Downgrade requires old-version-readable data, a stopped new owner, and confirmed cleanup; automatic rollback across irreversible Store migrations is not promised. Signing, notarization, LaunchAgent paths, and bundle-update consistency require package acceptance, not merely source tests.

## 7. Failures and observable results

| Failure | User-visible state | Authoritative recovery evidence |
|---|---|---|
| Relay unreachable | Remote offline; result unobserved | Core snapshot after reconnecting to Host |
| Write response lost | Pending reconciliation; draft association retained | Original commandId/request receipt, without replay |
| GUI exit/crash | Environment remains online; GUI resources close by ownership | Backend identity and actual Core progress |
| Backend crash | Environment recovering; interrupted work not reported successful | Owner receipts, cleanup proof, locks, and Core recovery state |
| One project configuration fails | That project unavailable; others continue | Its authenticated state and configuration diagnostics |
| Phone and desktop race | Admitted or explicit conflict | Core admission lock, revision, and exact target |
| Sleep/logout | Environment unreachable | Post-login/wake handshake, grants, and authoritative snapshot |
| Partial update/transition | Maintenance pending reconciliation | Durable lifecycle intent and actual instance, not assumed rollback |

Existing diagnostics carry Host, backend generation, Project, Core serviceId/generation, commandId, admission/settlement state, and redacted errors. Connectivity, request admission, and execution success remain separate. Credentials and unauthorized business bodies are excluded.

## 8. Tradeoffs and implementation entry

Reusing the Electron backend preserves credentials, subscriptions, and native adapters, at the cost of a desktop runtime and logged-in user session in the first release. Per-workspace Core reuse avoids history and permission migration, at the cost of multi-project availability management. Explicit project startup avoids reconnect side effects, at the cost of an extra mobile action when necessary.

ZCode's separation of Source identity from route, and T3's separation of client and environment lifecycles, are references rather than deployment or Provider architectures to copy. Sources: [ZCode Source Server](https://github.com/zai-org/ZCode/blob/3c5b2276/docs/architecture/r3-source-server-remote-architecture.md), [T3 Remote architecture](https://github.com/pingdotgg/t3code/blob/c8a606c7b7/docs/internals/remote.md). This repository's owners and acceptance evidence determine implementation choices.

See the [phased implementation plan](../development/environment-service-plan.en.md). This design refines the lifecycle of ADR 0008's existing-backend/no-new-agent-daemon direction; the old mode and current APIs remain valid until their respective implementation stages are complete.
