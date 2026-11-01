[中文](environment-service-plan.md) | **English**

# Independent environment service implementation plan

Status: not implemented. This plan and the [design](../design/environment-service.en.md) define delivery order; committing these documents does not pass any stage or acceptance item. Existing protocols remain effective. New methods, owners, and installation entry points require synchronized contracts, types, and consumers during implementation.

## 1. Delivery principles and dependencies

Proceed E0 → E1 → E2 → E3 → E4. E1/E2 may pass in an isolated source environment, but independent-environment support in the distributed package requires E4. E5 is demand-driven follow-up, not a first-release prerequisite. Each stage delivers a complete minimal vertical slice; adding an entry point or hiding a window does not establish the user journey.

| Stage | Observable result | Current status |
|---|---|---|
| E0: contracts and characterization | Distinguish window close, GUI exit, GUI crash, and backend exit; identify transferable capabilities | Not implemented |
| E1: independent owner and in-place handoff | Backend lifetime independent of GUI; no two writers for one home | Not implemented |
| E2: login service and conversation continuity | Real user-level service; phone continues the same work after GUI exit | Not implemented |
| E3: mobile-initiated development | Start from an unopened authorized project, change code, test, and review | Not implemented |
| E4: migration, updates, and package acceptance | Installed artifacts preserve identity and safe recovery across login, exit, restart, and upgrade | Not implemented |
| E5: additional development operations | Add explicit worktree/Git/file/terminal capabilities as needed | Outside first release |

Retain the Runtime → Core → Clients dependency constraints. Add only necessary lifecycle modes and Remote capabilities within existing owners, without first relocating the monorepo, creating another business database, or replacing Provider execution.

## 2. E0: verifiable baseline and contracts

### Work packages

1. Trace `main.cjs` → `service-client.cjs` → `service-main.cjs` → `local-service.cjs` → `core/local-service` for real startup, normal exit, and abnormal EOF behavior.
2. Compare ADR 0008, Remote design, architecture documentation, and expectations in `remote-gui-quit-e2e.mjs`; record differences between documentation, tests, and actual execution. A test name or source assertion is not passing evidence.
3. Inventory tool hosts, Provider/subscription forwarding, proxies, project indexes, Task activation, and notifications that must survive GUI exit, versus windows, WebContentsView, and GUI shells that must be released. Produce the first-release capability list and unavailable reasons.
4. Define modes, stable ownership versus run generation, stop suppression, transition receipts, and attach/start permissions in local-service/Desktop APIs. Synchronize Remote capability compatibility and old-GUI rejection of new owners.

### Exit criteria

Four distinct exit operations have process evidence identifying lifetime-pipe owners. JS and Rust owner changes are mapped together. Old GUI, old backend, and current GUI combinations have explicit attach, reject, or local-upgrade outcomes. An independent process must not be treated as an independent lifecycle before implementation.

## 3. E1: independent owner and single-writer transition

### Work packages

| Responsibility | Main change locations | Deliverable |
|---|---|---|
| GUI/backend owner | `application-owner.cjs`, `core-process.cjs`, `core/local-service/src/gui_owner.rs`, and protocol types | Environment owner support; retained GUI-owned EOF cleanup; backend supervision of managed execution |
| Backend entry/discovery | `service-main.cjs`, `service-config.cjs`, `service-client.cjs` | Independent startup and authenticated attachment, single-instance lock, explicit compatibility rejection |
| Lifecycle coordination | `service-control.cjs`, `lifecycle.cjs`, `local-service.cjs` | Transition intent/receipt, stop suppression, generation checks, single-writer handoff |
| GUI exit | `main.cjs` and existing lifecycle consumers | Detach only in independent mode; explicit shutdown still uses drain |
| Recovery | `submission-recovery.cjs`, `project-connections.cjs` | Reconcile original requests across migration, retain UNKNOWN, never replay |

Unqualified filenames reside in `clients/gui/app/src/core/`. Follow the call chain to Core protocol type owners during implementation rather than duplicating owner definitions or inventing Core state in clients.

Implement isolated handoff first: drain old owner and prove cleanup → start new owner against the same home → publish readiness → attach GUI. A test management entry may start the backend in this stage, but does not establish LaunchAgent or package support. Do not force takeover across active execution; wait or reject without explicit cancellation authorization.

### Exit criteria

- The independent backend performs a restricted file operation through real Core/Runtime without a GUI.
- Normal GUI exit and forced GUI termination do not change backend PID/Core generation because of GUI death; the original running connection produces new progress.
- Backend termination settles managed resources through existing supervision; successors cannot bypass old locks or unknown cleanup.
- Concurrent GUI/backend startup produces one writer; mismatched home, owner, and deployment are rejected.
- Original-mode normal and abnormal exit retain their contracts; lost receipts and interrupted transitions do not redispatch execution.

## 4. E2: user service and mobile continuation after GUI exit

### Work packages

1. Reuse backend application resolution in `desktop-executables.cjs` and add controlled macOS user-level install, status, start, stop, and unregister operations. Implementation determines naming; this plan does not provide nonexistent commands.
2. Fix canonical home, application location, configuration, and tool environment without temporary GUI variables or an interactive shell. Registration failure remains diagnosable and does not fall back to an unmanaged detached process.
3. Persist distinctions between user stop, abnormal exit, and update drain. Verify OS keep-alive does not override explicit stops or cause endless restart loops.
4. Verify credential decryption, model authentication/refresh, subscription forwarding, proxies, and Runtime tool hosts in the real backend. Project capability unavailability accurately while retaining local interaction requirements.
5. Complete the phone path with existing Relay/Noise/Gateway. GUI manages pairing, grants, service state, and local fault handling. Remote revocation and connection budgets remain effective.
6. Keep schedule-owner activation in the independent backend, with explicit project stop, environment stop, and upgrade all suppressing activation. Core still owns triggering and recovery.

### Exit criteria

Start through the actual user-level service without opening the GUI first; the phone connects to an authorized ready project. Start work in the GUI, pause at approval, exit the GUI, approve the same operation from the phone, and continue the original Turn with one side effect. Reopen the GUI to the same Thread/Turn and result. Also exit while the original model request is still active to prove continuation rather than recreation.

Explicit environment stop prevents automatic OS restart. Explicit restart preserves Host identity. Screen lock, wake, unavailable credentials, and Relay interruption each produce accurate state. Mobile refresh does not duplicate scheduled activation; GUI exit does not change enabled schedules.

## 5. E3: mobile-initiated development

### Work packages

1. Extend project projections to distinguish environment reachability, project stopped/starting/ready, configuration/credential blocks, incompatibility, and pending cleanup.
2. Add explicit startup and a separate grant for registered projects; existing device grants do not inherit it. Update Remote API method schemas, context, receipts, and types together.
3. Associate startup commandId in the existing backend lifecycle owner, invoke public `ensure --no-auto-restart`, and validate authenticated identity/capabilities before ready. Reject arbitrary paths and unauthorized projects; never update implicitly.
4. Use existing conversation/model/queue/Goal/approval/stop capabilities for mobile development. Surface unsupported operations and conflicts rather than bypassing restrictions with private Desktop RPC.
5. Complete readable diffs, necessary file context, and test output. Initially request revisions or Git commits through ordinary messages; dedicated Git mutation UI belongs to E5.

### Exit criteria

With the GUI absent and target project stopped, the phone explicitly starts an authorized project, creates a conversation, changes code and runs project tests in a real isolated repository, reviews diff/test evidence, and continues the same conversation. Reject unauthorized projects and explicitly stopped projects without renewed startup authorization.

A lost startup response only reconciles the same operation. Configuration incompatibility cannot automatically kill an old Core. Concurrent phone/desktop sending, configuration, approval, and stopping receive valid Core admission/conflicts; stopping cannot affect a later Turn. Another project remains usable, proving per-project failure isolation.

## 6. E4: migration, upgrades, and package acceptance

### Work packages

1. Complete recoverable enable/disable transitions through existing lifecycle entry points, preserving projects, worktrees, conversations, encrypted credentials, Host pin, grants, pending/outcomes, and original receipts.
2. Inject interruption before shutdown, after old-backend exit, around new-backend startup, and before completion-receipt delivery. Recovery queries the original transition and observes single-writer/compatibility rules.
3. Include the backend in application-update coordination. Drain and prove exit before replacing the main bundle; verify registration paths, signing, deployment identity, and handshake. Active tasks block disruptive upgrades by default.
4. Define downgrade limits. Reject rollback when an old version cannot read new formats; do not restore an old backup over newer history. Disabling login service retains data; uninstall and device revocation remain separate operations.
5. Update installation, user, Remote, and test documentation plus relevant ADR status. Feature lists describe only implemented capabilities with evidence.

### Exit criteria

Use Developer ID-signed, notarized, stapled, and Gatekeeper-verified app and DMG artifacts. Validate login startup after installation, GUI exit/reopen, explicit shutdown, a real phone initiating work over Relay, and same-identity attachment after application update. Development launches do not establish fixed installation paths, Keychain access, or LaunchAgent lifetime.

Record the actual tested artifact version, OS, device, network, model, and outcome. Public-network, real-provider, physical-device, and package checks remain separately unverified when not run. Build and acceptance do not authorize publishing or pushing.

## 7. E5: demand-driven development capabilities

Later slices may add worktree creation, structured Git operations, file viewing/editing, interactive terminals, and browser takeover. Define the resource owner, authorization, reviewed version, operation receipt, disconnect behavior, and demonstrated need before reusing existing modules. Terminal/browser control is resource-specific rather than a global conversation lock.

SSH/WSL/Docker environments, cross-environment delegation, and cloud discovery require separate designs. Identity/route separation leaves room for them without prebuilding a generic Transport framework.

## 8. Acceptance matrix and evidence

| ID | Minimal scenario | Independent assertion | Stage |
|---|---|---|---|
| ENV-01 | Managed backend execution without GUI | Real Core/Runtime operation and exit cleanup are observable | E1/E2 |
| ENV-02 | GUI exit and crash | Original Turn/model connection continues; backend survives GUI | E1/E2 |
| ENV-03 | Phone approval followed by GUI reopen | Same Thread/Turn, one approval and one side effect | E2 |
| ENV-04 | Two launchers and interrupted transition | One writer per home; replacement requires lock release and cleanup proof | E1/E4 |
| ENV-05 | Backend or Core crash | Correct fault domain; UNKNOWN retained, tools not replayed | E1/E4 |
| ENV-06 | Login, screen lock, sleep/wake | Accurate state; offline is not execution failure | E2/E4 |
| ENV-07 | User stop and update drain | OS, GUI, phone reconnect, and schedules cannot auto-start it | E2/E4 |
| ENV-08 | Relay interruption and slow client | Execution continues; snapshot recovers; other client advances | E2/E3 |
| ENV-09 | Lost write/startup receipt | Original request queried; no replay or UNKNOWN clearing from an empty receipt | E1/E3 |
| ENV-10 | Cross-client configuration/send/approval/stop race | Core admission/revision/exact-Turn guarantees hold | E3 |
| ENV-11 | Revocation and unauthorized project startup | New operations/content restricted immediately; no automatic privilege gain | E2/E3 |
| ENV-12 | Credential/tool-environment/per-project failure | No secret leak, accurate attribution, other projects independent | E2/E3 |
| ENV-13 | Full development from a stopped registered project | Phone starts, edits, tests, reviews; desktop continues | E3 |
| ENV-14 | Signed-package update/disable/reopen | Identity/data/receipts preserved; registration path valid | E4 |
| ENV-15 | Scheduling after GUI exit | Core owns triggers; explicit project-stop suppression and recovery hold | E2/E4 |

Assertions come from these goals, not shared implementation-derived answers. Count tool effects and inspect actual Thread/Turn, model requests, subprocesses, and cleanup receipts instead of UI text or caches alone. Inject failures only in isolated home/workspace/Relay environments; retain failures, UNKNOWN, retries, and unconfirmed cleanup records.

### Reuse existing test entry points

Run these existing extensible entry points from the repository root. They do not imply coverage of new owners or LaunchAgent. Follow the [testing guide](testing.en.md) and local fixed-artifact-path requirements; formal packages follow release/signing procedures.

| Scope | Existing entry points |
|---|---|
| Types and public boundaries | `pnpm --dir clients/gui typecheck`, `pnpm --dir clients/gui run verify` |
| Connections, lifecycle, reopen | `pnpm --dir clients/gui test:service-connection`, `pnpm --dir clients/gui test:lifecycle`, `pnpm --dir clients/gui test:service-reopen` |
| Remote commands, approval, review | `pnpm --dir clients/gui test:remote-command-e2e`, `pnpm --dir clients/gui test:remote-interaction`, `pnpm --dir clients/gui test:remote-review` |
| Continuation after exit | `pnpm --dir clients/gui test:remote-gui-quit`; add independent-owner and real OS-registration cases |
| Relay and mobile state | `pnpm --dir clients/gui test:remote-relay`, `pnpm --dir clients/gui test:mobile-command`, `pnpm --dir clients/gui test:mobile-workspace-state` |
| Provider and scheduling | `pnpm --dir clients/gui test:provider-hot-apply`, `pnpm --dir clients/gui test:schedule-reliability-lifecycle` |
| Core/Runtime and documentation | Select `make test-core`, `make test-protocol`, `make verify-runtime` for actual Rust changes; `python3 scripts/check-docs.py` |

Run transport-selectable E2E through Direct and Relay as documented in the [Remote test plan](remote-control-testing.en.md); do not assume every script supports the same environment variable. Add E1 owner, E2 OS-registration, and E4 transition/update cases to suitable existing runners. When none fits, add a narrow scenario script and package command rather than assume existing tests cover it.

Evidence records source commit/owned diff, artifact, macOS/device version, isolated directories, mode, transport, model kind, scenario ID, expected/actual outcome, logs, and cleanup. Deterministic models validate faults and duplicate effects; real Provider, Runtime, desktop visuals, phone, and package outcomes are separate and cannot substitute for one another.

## 9. Documentation updates and stage completion

| Documentation owner | Required changes |
|---|---|
| `docs/api/local-service.*` | Owner, startup/attachment, stop suppression, cleanup, recovery compatibility |
| `docs/api/desktop.*` | GUI detach versus shutdown, environment management, transition receipts |
| `docs/api/remote-control.*` | Project states, startup grants/methods, capabilities, receipts, rejection semantics |
| `docs/design/architecture.*` / `remote-control.*` | Implemented topology/responsibilities; resolve contradictions with actual lifecycle |
| `docs/adr/0008-remote-host-ownership.*` | Refined owner decision and costs after independent-mode acceptance |
| GUI/mobile guides, installation guide, `docs/features.*` | Only accepted entry points, limits, and user actions |
| Remote test plan and this plan | Actual runners, evidence locations, remaining gates; design is not a pass |

Stage completion requires inspected owned diff, synchronized contracts/bilingual docs, proportionate checks with explicit unverified boundaries, isolated-service cleanup results, and a local commit limited to the task. Expand verification only for new changes, failures, or unresolved questions. First-release completion requires evidence for necessary E0–E4 gates and the real mobile development journey; E5 does not block it.
