[中文](local-service.md) | **English**

# Shared local services

TUI, the Web launcher and trusted Desktop Main use `areal service`. An independent `areal service-host` owns one Core/Runtime pair; windows own connections. Platform support follows the [Runtime boundary](../guides/runtime.en.md). This is not a system-wide, multi-user or remote daemon.

## Public entry points

```sh
target/debug/areal service ensure --workspace /absolute/workspace --json
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
# Explicitly cancel current work and wait for settlement
target/debug/areal service stop --instance INSTANCE_ID --cancel --json
target/debug/areal web --workspace /absolute/workspace
# Desktop Main obtains the same descriptor without opening a browser
target/debug/areal web --workspace /absolute/workspace --json
```

`ensure`, `restart` and `web` accept the same local options: `--config`, `--workspace`, `--data-dir`, `--allow-write`, `--allow-network`, `--allow-concurrent-writes`, `--workgroup-policy`, `--workgroup-toolchain`, `--command-timeout-ms`, `--desktop-process-timeout-ms`, `--command-output-bytes`, `--runtime-max-processes`, `--model-endpoint`, `--model-protocol`, `--model`, `--model-provider`, `--api-key-env`, and `--desktop-config`. `--agent id@revision` is a TUI/headless/exec client option for selecting a Profile when creating a Thread; it also works with a remote `--endpoint` and does not change local service identity. Workspace defaults to the current directory; the service binds a random loopback port. Management can start without a model; model tasks still require valid configuration.

Explicitly select `AREAL_CORE_SANDBOX_PROFILE=native` before starting the GUI, or `--sandbox-profile native` for `areal service ensure/restart`, to request the native Runtime sandbox. The default remains `full-access`. The profile participates in deployment compatibility; stop active work and explicitly restart when changing it. Side chat offers read-only access to current workspace files only when Core verifies the native isolation capability. If native isolation is unavailable, startup fails closed; there is no fallback to full access.

`--desktop-process-timeout-ms` sets the desktop PTY timeout (1..86400000 ms), independently of ordinary command timeouts. It participates in service identity; changes require safe restart. The GUI uses the 24-hour limit.

`--runtime-max-processes` sets the Runtime active-process limit shared by ancestor and child Scopes in this service. It defaults to `4` and accepts integers in `1..4294967295`. The value is part of service configuration identity: `ensure` does not silently reuse a service with a different capacity; restart safely after work settles. It is independent of Core `max_active_turns` and does not increase Goal time or usage budgets.

The model-free capacity regression is `python3 scripts/runtime-capacity-smoke.py --bin-dir target/debug`: default capacity rejects a fifth concurrent process, while an explicit capacity of 32 allows six child Scopes to run concurrently and clean up. The test defaults to the native sandbox; `--sandbox-profile` explicitly selects the deployment profile under test, with no automatic fallback.

`--runtime-output-bytes` independently sets cumulative output for the deployment and descendant Scopes (at least `--command-output-bytes`, at most 16 GiB). Omitting it preserves the previous behavior of sharing the single-command limit. It does not increase the per-command output cap or retained-output window. `--runtime-max-operations` controls retained operations for the Runtime lifetime, defaulting to 4096 and accepting positive integers up to 4294967295. Completed operations remain for deduplication/query and are not reclaimed when children finish. Both settings enter service identity. A long task may explicitly use `--command-output-bytes 67108864 --runtime-output-bytes 1073741824 --runtime-max-operations 65536` while monitoring cumulative usage. Image tools read the original file before Core resizing; file-helper JSON/base64 stdout counts toward cumulative output, so reducing model-visible dimensions does not remove that read overhead.

Use `python3 scripts/runtime-output-smoke.py --bin-dir target/debug` to verify preserved per-process caps, cumulative charging across commands, and uncharged retained-output replay; sandbox options match the process-capacity regression.

`status` and `stop` select the current workspace by default; use `--workspace`, `--data-dir`, or `--instance` to disambiguate. `restart` resolves the desired deployment from the current workspace and the same local options as `ensure`; pass the original custom configuration/permission options when needed. It preserves history and refuses outstanding work unless `--cancel` is explicit.

Service commands always emit JSON on stdout; `--json` explicitly selects machine use. `web` also opens a browser unless `--json` is set. ensure/restart/status/stop return a descriptor, list returns an array, and bind returns `{dataDir}`. Operation failures exit 1 with `{error:{code:"localServiceError",message}}` on stderr; argument errors follow CLI behavior. Startup diagnostics go to stderr or private logs. Long-lived tokens never appear in commands, URLs or descriptors. The one-time login URL is passed only to the browser opener and is never printed.

Descriptor fields are defined in [local-service-v1.json](../../schemas/local-service-v1.json):

| Field | Meaning |
|---|---|
| `protocolVersion` | Discovery/control version, currently 1 |
| `serviceId` | First 24 hex characters of canonical dataDir path SHA-256; stable across restarts |
| `generation` | Fresh UUID per launch; distinct from Runtime epoch and tool Host generation |
| `workspace`, `dataDir` | Canonical absolute paths |
| `configFingerprint` | Digest of deployment configuration, model CLI/environment overrides, permissions, deployment files and binary contents; hot model values are versioned separately |
| `endpoint`, `webUrl` | Core WebSocket and `/ui` URLs |
| `authFile`, `logFile` | Authentication and host log paths for trusted callers |
| `hostPid`, `corePid` | Diagnostic only; never signal a stale PID from discovery |
| `state` | `ready`, `stopping`, `stopped` or `unavailable` |

## Published task catalog preview

Trusted local callers can read the published scheduled-task catalog before connecting to the execution Core for live state:

```sh
areal service task-catalog --workspace /absolute/workspace \
  --data-dir /absolute/state --limit 30 --json
```

This command does not start Engine, Runtime, models or plugins, restore runs, migrate older formats, or replay operations. It validates canonical workspace and data-directory identity and the `service-workspace` binding. Core reads one atomically published root and its content-hash-verified immutable Task files. The entry point is for trusted local users, not HTTP/WS or thread-restricted principals. `--source-thread-id` filters provenance; it is not an authorization parameter.

The response contains `version: 1`, `target: {workspace, dataDir, instanceId}`, `source: "published"`, `executionState: "unobserved"`, and `catalog`. A `snapshot` catalog includes `rootDigest`, `data`, and `hasMore`. A valid binding with no root returns `empty`, meaning no published catalog was observed. An unbound store, known older format, or exceeded 32 MiB hot-state read budget returns `requiresCore`, with reason `unbound`, `legacyFormat`, or `readBudgetExceeded`. Corruption, unknown formats, identity mismatches and read errors do not become empty catalogs. `--limit` defaults to 30 and accepts 1–1024. The reader selects scheduled tasks, filters by source, and excludes settled deleted tasks before sorting by task ID and applying the limit. Deleted tasks with nonterminal Runs or unsettled workers remain visible. One read uses one root, without combining publication versions.

A published catalog does not establish execution liveness, full-store recoverability, or acceptance of an unknown submission. It does not restore runs, so saved status and revisions can differ from the subsequently started Core. The GUI shows task names with a status-refreshing notice while preserving normal Core startup and live catalog reads. Previews do not enter the live task model or supply revisions for management operations. Live results replace previews; late previews cannot replace live results. A failed live read retains an unconfirmed notice and retry action.

## Inspectable stop operations

When the original instance still holds its lease but its control endpoint has closed or disconnected, `status` reports `unavailable`, not a completed stop. Protocol, permission and timeout errors remain failures. `ensure` does not take over that active owner. Store startup allows about 100 ms for inherited-descriptor handoff, never cleans pending writes before acquiring the exclusive lock, and still refuses a persistent owner.

GUI uses `service ensure --no-auto-restart`: compatible services with the same GUI application owner may be reused, and absent instances start under the existing locks. Replacement of a running instance requires an explicit lifecycle operation. Ordinary CLI ensure and TUI reconnect may still apply configuration changes to an idle service running the same binaries. Changed binary hashes require explicit `service restart` or a GUI lifecycle update, preventing implicit upgrades and downgrades.

```sh
areal service capabilities --instance INSTANCE --expected-generation GENERATION --json
areal service stop --instance INSTANCE --expected-generation GENERATION --request-id UUID --cancel --json
areal service operation --instance INSTANCE --expected-generation GENERATION --request-id UUID --json
```

Capabilities returns `{version:1,stopOperations:1}`. Unsupported hosts reject new writes without a Stop probe. Stop with request-id returns `{version:1,requestId,serviceId,generation,cancel,state,message?,lifecycle?}`; operation returns `{operation:<original receipt or null>}`. Within each service registry, an ID permanently binds the generation and cancel strategy; changed parameters conflict. The current CLI also creates a durable stop operation when request-id is omitted, returning a Service descriptor only after the original instance exits. Failures retain the request ID and generation for inspection. New hosts reject the legacy control protocol's unreceipted `Stop` without draining or cancelling work, preventing a still-running old TUI from stopping a newer backend during reconnect. Hosts from 0.1.5 support durable stop operations. Stop hosts without that capability, including 0.1.4, explicitly with their original CLI before starting the new version; capability-query failures never trigger a fallback to legacy Stop.

Before drain, Host atomically stores and fsyncs a receipt in private registry `operations/`, outside generation cleanup. States are `acceptedPending`, `blocked`, `admissionUnknown`, `settlementIncomplete`, and `completed`. Known refusal is distinct from admitted but incomplete settlement. Reads never repeat drain or cancel; null does not prove non-admission. A new explicit intent may observe again and use a new ID after known refusal or incomplete settlement. Uncertain admission requires inspection first.

Public operation reads derive `completed` only after confirmed launcher/Runtime cleanup and release of the original service and Store locks, or lock-protected replacement ownership. A vanished Core PID, disconnected socket or missing registration is insufficient. Host crashes before cleanup confirmation retain uncertainty. Duplicate private-socket requests return durable snapshots; public operation reads verify physical exit.


## Default CLI and GUI isolation

Model configuration defaults to the shared `~/.areal/config.toml`. Sharing that file does not share execution instances, history or every authentication state. `areal exec` without `--endpoint` uses `<home>/cli/runs/<runId>/state` per run, with session mappings under `<home>/cli/sessions/`; `--resume` reuses the original run. Here home is `AREAL_HARNESS_HOME` or `~/.areal`. Direct exclusive `serve`/launcher entry points use the general configuration default `<configuration home>/state/`. Public `areal service` uses `~/.areal` as its default registry (overridden by `AREAL_HARNESS_SERVICE_HOME`) and `<registry>/instances/<workspace-hash>/state` as its default dataDir; existing bind mappings and explicit configuration take precedence.

The GUI defaults to `~/.areal/gui/<GUI Core home digest>` for its registry and `<GUI Core home>/<projectId>/state` for each project. GUI Core home defaults to `areal-core` under GUI userData. Development userData is scoped to the source checkout; installed builds and explicit profiles/worktrees can use separate directories. Each GUI application run has `{kind:"gui", appRunId, profile}`, where `profile` is the canonical absolute userData directory. The optional `owner` field in service descriptors records that identity. Independent persistent CLI services have no GUI owner. GUI stop/exit checks every registered instance belonging to the owner, including hidden or disconnected projects and accepted startup work. Restored projects retain the ID in their saved project index; ownership matching verifies that registered workspace and data directory instead of replacing the ID with a new workspace hash. It does not stop the default CLI registry or other profiles. A new GUI cannot silently adopt a detached legacy Desktop or another appRunId; migration first checks and safely stops the original generation.

Execution and history are shared only by explicitly connecting to the same service, for example using CLI `--endpoint` and `--auth-file`. The same model configuration, source workspace or even registry alone is insufficient. The Store single-writer lock still protects each dataDir across processes and clients. Separate dataDirs do not isolate changes to files in the same source workspace: coordinate writes or use separate Git worktrees.

## Identity, compatibility and history

One dataDir allows one Core. `ensure` serializes concurrent launches and checks the running identity/configuration. Model file edits reload without restarting. Other TOML changes with the same binaries restart automatically when the service is idle; active work prevents automatic restart. Binary, permission, Runtime, deployment-file or model CLI/environment override changes require `areal service restart`. It never silently expands write/network permissions or kills an unmanaged Core. Symlinks resolve to canonical identity.

Development and PATH-installed binaries select the same instance for the same workspace and dataDir, but their binary contents and version-specific defaults may be incompatible. Conflict diagnostics provide the current client binary's absolute path and resolved deployment arguments. Run that command with the same environment so a bare `areal` does not restart another version. Ordinary configuration changes with the same binaries still restart automatically when idle; binary, Runtime and permission boundary changes require an explicit restart.

Service home is selected by `AREAL_HARNESS_SERVICE_HOME` (a nonempty absolute path), falling back to `AREAL_HARNESS_HOME` or `~/.areal`. It controls only service registration, workspace mappings, and default instance data, without changing Core configuration lookup. `ensure`, `restart`, `list`, `status`, `stop`, `bind`, and `web` use the same service home. Without an explicitly configured dataDir, shared entry points use `<service home>/instances/<first24-workspace-hash>/state`. CLI/environment/TOML dataDir overrides retain their precedence. Owned launchers and noninteractive CLI retain their existing default directories.

Existing `~/.areal-harness/state` history is not moved or merged automatically. Pass `--data-dir`, or stop the old Core and bind the workspace default:

```sh
target/debug/areal service bind --workspace /absolute/workspace \
  --data-dir /absolute/old-state --json
```

Initial binding holds the Core data lock, checks that every stored Thread cwd belongs to the workspace, and writes `service-workspace` without copying history. Workspace mappings live under home/workspaces. A bound store cannot switch workspaces; mixed history requires separate organization. Data and service registry must be outside the workspace, as must trusted binaries in write mode.

Compatibility separates deployment identity from the default model revision. Model reload validates the whole TOML and retains the previous configuration on error. Limits, permissions, Runtime budgets, deployment manifests/tool extensions/Workgroup policies and binary contents retain restart boundaries. Model credential values are excluded from digests and registration. The service inherits its initial environment. If the model revision still differs after waiting three seconds for reload, the client attempts a safe restart; ordinary reload errors return the specific cause. A credential unavailable to the old service sets `restartRequired=true`; when the client supplies credentials in its current environment, an idle restart can inherit them. Busy services retain their generation and work; retry after settlement, without automatic cancellation. Rotating only an existing credential value or changing other environment variables still requires explicit restart. Live Provider/Thread configuration remains owned by Core.

Shared services start in management mode: a missing, empty or invalid HTTP-header credential for the default model does not prevent Core connections. The model catalog marks that model unavailable; execution returns `MODEL_CREDENTIAL_UNAVAILABLE` without an anonymous request or model substitution. GUI users can enter a key and save/apply it. A Core with hot-apply support appends secure-storage references and confirms the file revision through the [protected model configuration API](desktop.en.md#model-configuration-hot-apply), without restarting Core or Runtime. Ordinary startup-environment credentials and non-model deployment changes retain their existing restart rules. Configuration syntax, endpoint, protocol and other validation remain enforced.

### Derived conversations and data compatibility

`areal/capabilities.features.conversationDerivationV1` returns `preview:false`, the supported method set, Fork boundaries, `sharedCurrent`, available Side `workspaceAccess` and effective limits by default, without a development environment flag. Clients enable creation from the current connection’s public capabilities.

The feature's `historyBytes` is Engine's derived-snapshot cap: the smaller of configured `max_history_bytes` and 64 MiB, with 0 selecting 64 MiB. `limits` reports `maxThreads`, `maxActiveTurns`, `maxSideTurnsPerSource`, `maxSideTurnsPerDeployment`, `maxSideModelRounds`, `maxSideToolCalls` and `maxSideTurnSeconds` from this service's actual Engine configuration. Side tool calls also take the smaller nonzero global tool budget. These are deployment ceilings rather than remaining capacity; per-Turn configuration can narrow them further. Shared Core admits work across all windows. `readOnly` is advertised only when the connected Runtime meets the native read-only boundary; clients must not silently substitute `none`. See the [desktop API](desktop.en.md#side-chat) for methods and recovery.

The experimental plugin build’s `hookRuns`, `allowPluginSkills`, and `pluginSkills` are retained as inert historical data. Reading an idle session does not rewrite its file for compatibility; ordinary subsequent saves retain these values without scheduling hooks, loading plugin skills, or granting plugin permissions. Other unknown fields remain strictly validated.

Store writes, `areal/server/status.stateVersion` and release `manifest.json.stateVersion` are currently 15. The API remains `areal.core.v1` and service discovery stays at version 1. Version 15 adds the last admitted main-conversation model preference and continues reading version 1–14 records; older Core binaries may not read new records, so rollback requires a pre-upgrade backup. Old records without derivation metadata load and upgrade on their next write. Fork/Side records require a supported conversation version and version-14 permission semantics; lowering a record's version is not a safe way to hand it to an older binary. Restart does not replay creation or the first question; query `areal/request/read` when the outcome is uncertain. Capability declarations do not replace independent acceptance of platform-native permissions, packaged apps or real providers.

On macOS, the owned TUI uses the same trusted system-parent startup as Core/Runtime, preserving the actual PID, exit status and cleanup receipt. Interactive startup transfers the controlling terminal to its separate process group before TUI reads begin, then restores the original foreground group and terminal attributes after settlement. Non-terminal input performs no handoff, and Linux keeps direct native startup. This adaptation handles trusted-client lifecycle only; it neither executes model commands nor changes Runtime permissions or sandboxing.

## Lifecycle and recovery

Closing a window retains the GUI application session. Active Turns/Goals may continue and multiple windows may subscribe to one Thread. Application Quit, including Cmd+Q, stops the application’s complete Desktop, Host, Core, and Runtime chain. Active work requires confirmation or cancellation of quit; incomplete settlement keeps Main available for recovery. Concurrent writes still follow Core admission, CAS, queues and requestId rules. Explicit cancellation is separate from closing a window.

Services have no idle exit timer. File model updates keep the same generation and connections; TUI detects other TOML changes and requests a restart once background work settles. Web and other clients can run `areal service ensure` or `restart`; browsers do not own process lifecycle. Default stop checks `restartSafe`, `activeGoals`, `pendingQueueItems` and `activeTasks`, then checks again under Core admission with `drain(strategy="ifIdle")`, rejecting outstanding work/resources without pausing them. Idle schedules awaiting their next trigger permit safe restart and remain enabled. GUI recovery also checks explicit task, goal and queue counts from older adapters. If an old backend counts idle schedules as busy, explicit stop or update recovery can pause them after a separate user confirmation; history is retained and schedules require manual resume after restart. `--cancel` uses Core drain to cancel and settle. Historical tool/hook UNKNOWN remains visible in `lifecycle.executionOutcomes.uninspectedUnknown` and `unresolvedTools`, and still blocks continuation of its original Thread. It does not block stopping a physically settled service. Runtime observation failure, live processes, hook task scope uncertainty, and unconfirmed cleanup still prevent success. Accepted stop closes admission; inspect logs/authoritative state after cleanup failure instead of assuming no work happened. Work admitted between the status check and drain follows drain's wait/pause rules.

The host controls Core/Runtime startup and shutdown. The Rust launcher owns the separate processes and private pipes without Python on Linux. On macOS, a working `/usr/bin/python3` is the actual parent of service-host, launcher, Core and Runtime. The trusted service chain passes only explicit lease/lifetime descriptors, records the actual child PID and verifies its wait/reap exit receipt; a missing receipt cannot report successful cleanup. The PID handshake has a 10-second deadline; failure or cancellation clears that invocation’s independent process group. After the handshake, ordinary signals target the actual child. A supervised bridge sends TERM when its original owner dies, then kills and reaps the child after 45 seconds if necessary, covering the launcher’s Core/Runtime cleanup interval. An independent CLI service-host detaches from the initial client and survives CLI exit. GUI Main exclusively holds the Desktop lifetime-pipe writer, and Desktop exclusively holds each GUI Host writer. A short-lived management CLI forwards only the read end; Host watches EOF before and during startup and while serving. Read descriptors become CLOEXEC before unrelated children spawn, and owner environment variables do not reach Core, Runtime, or model tools. Main or Desktop death triggers the existing bounded cleanup chain through EOF. Interrupted work and UNKNOWN outcomes do not become successful execution. Configuration preflight also uses the trusted launch and exit receipt: stdin is closed, stdout/stderr are drained concurrently with a 2 MiB limit each, and the total deadline is 15 seconds. Timeout, overflow or cancellation continues bounded cleanup of the temporary process; cancelling a cleanup waiter does not cancel the cleanup itself. Runtime retains its existing process-group timeout cleanup. Startup checks interpreter availability; install Xcode Command Line Tools if it is unavailable. Launcher death closes the Core lifetime pipe; Runtime cleans up through its private transport. Launcher parent checks detect host death. The launcher inherits the instance lock but does not pass it to Core/Runtime, and retains it through cleanup even if the host is killed. No replacement starts until the old Core releases its lock. `service.json` is a discovery hint: clients verify locking, the control socket and authenticated Core identity rather than trusting historical PIDs or ports.

TUI rediscovers after disconnection and can start a new generation after crash cleanup. Explicit stop leaves a marker so existing windows do not automatically undo it; opening a new window or manually running ensure can restart it. Recovery uses thread/resume snapshots without request replay. Goals pause across restart and tool UNKNOWN keeps its inspection requirements.

### Guarded GUI crash replacement

`service status --instance ID --recovery --json` is an opt-in read returning `{service,recovery:{version:1,generation,eligible,reason}}`. Default status still returns the strict v1 Service; Capabilities remains `{version:1,stopOperations:1}`. `eligible:true` with reason `confirmedCoreCrash` is only a candidate: a surviving Host has published generation-bound positive cleanup after an unexpected Core exit, both leases are free, and no original-generation stop intent was admitted. Missing, malformed, stale, or legacy proof is ineligible. Lock release, PID absence, and nonzero exit codes alone never prove cleanup.

Trusted GUI adapters may call `service recover --instance ID --expected-generation GENERATION --json` with the original LocalArgs, GUI owner, and inherited lifetime descriptor. Under the existing `start.lock`, recovery revalidates canonical workspace/data, full configuration/components/binary hashes, owner identity, live lifetime, both leases, and durable stop receipts. Host rechecks the authorization and fresh configuration before spawning. Runtime reports successful resource cleanup separately after shutdown and request settlement; an output-transport failure does not erase that fact or become evidence of cleanup by itself. Launcher binds the proof to its reaped Core/Runtime handles; Host publishes it outside the disposable generation directory. Host/launcher death without publication, owner closure, and unconfirmed Runtime cleanup cannot authorize replacement.

A private single-attempt replacement receipt is persisted before spawn, and Host binds it to its successor generation. Repeating the same original generation after a lost CLI response only returns that recorded, compatible, Ready successor. Unknown startup or a crashed successor cannot start a second replacement from the original receipt. A stop receipt in accepted, admission-unknown, incomplete, or completed state fences recovery, including a persisted acceptance whose control handler never updated its in-memory stopping flag. An explicitly blocked, unadmitted stop does not fence it. This is accepted-intent ordering: a later stop still waiting for `start.lock` is not yet admitted and retains ordinary generation checking.

Desktop must also check its lifecycle intent, project/client ownership and closing state before dispatch and before publishing the replacement. Restore uses authoritative snapshots and original request receipts without replaying interrupted model/tool/turn work. Existing Core startup pauses interrupted Goals, queues and workers and marks uncertain effects UNKNOWN; already-authorized unstarted schedules and future configured triggers keep their existing semantics. Ordinary ensure/restart contracts are unchanged.

The deterministic cross-process regression is `AREAL_TEST_BIN_DIR=/absolute/bin node scripts/local-service-recovery-smoke.mjs`; it uses isolated state and a local model fixture, never a user profile or real provider.

## Web and Desktop integration

`areal service stop --expected-generation <generation>` checks the target generation under the startup lock and refuses to stop a replacement instance. GUI cancellation confirmation binds the original Desktop, project scope and Core generations; the final public host stop retains the cancel intent. Partial stops and unknown responses remain recovery states, without claiming rollback or replaying mutations. Clients confirm registration withdrawal and original-process exit.

- `areal web` reads authFile in the trusted local client, verifies service identity, obtains a one-time code and opens `/ui` to exchange it automatically for an independent HttpOnly cookie. The page never receives the long-lived token. Browsers never launch processes, read authFile or access the control socket. Run `areal web` again after link/session expiry, restart or port changes; manual token login remains a fallback. `--json` only discovers the service and does not mint codes. Rust callers can use `browser_login_url(&Service)` to obtain the one-time URL; never log it or forward it to untrusted pages. See [browser login](desktop.en.md#browser-auth) for endpoints and lifetimes.
- Desktop Main executes `areal service ensure --json` with an argument array, checks `protocolVersion`, reads authFile in Main and establishes the authenticated connection. Expose only filtered application operations/state to Renderer, never the full descriptor or token.
- Rediscover and compare generation before initialize/initialized and thread/resume. Query request/read or authoritative state before deciding to retry; never replay accepted operations automatically.
- Dynamic ToolHosts that must survive windows belong in a stable Main/independent host connection. Window tools do not transfer automatically; disconnect retains Host generation and UNKNOWN semantics.

Internal control uses one-line JSON over a Unix socket, with 0700 directories and 0600 records and credentials. The address remains `home/services/INSTANCE_ID/control.sock` when its encoded length is less than 104 bytes. Longer addresses use `/tmp/areal-<effective-uid>/<sha256>.sock`, hashing the full path bytes of the canonical registry directory. The host and client use the same derivation and verify that the socket parent belongs to the current user, is not a symlink, and grants no group or other permissions. Registration, locks, history, and operation receipts remain in their original locations. Host exit removes only its instance socket and retains the shared UID directory. A missing socket does not prove that the backend has stopped.

Requests are `{method:"status",version:1}` or `{method:"stop",version:1,generation,cancel}`. Responses are `{result:"ok",service}` or `{result:"error",message}`. Non-Rust clients should use the CLI instead of duplicating address derivation, locking, and recovery.

Authenticated GET `/areal/service` returns the six identity fields (protocolVersion/serviceId/generation/workspace/dataDir/configFingerprint), requires observe permission and rejects a mismatched Origin. An authenticated Core without managed identity returns 404. Business operations retain the [Core](core.en.md) and [desktop API](desktop.en.md) protocols and the same Agent loop.

LocalArgs adds permissions (YOLO/ASK_PERMISSIONS) and scratch. Effective permission policy and scratch participate in deployment compatibility. Local launcher now defaults to full-access; the changed default requires an explicit restart for an existing service. No client attach operation silently widens the old service. See [permissions](../guides/configuration.en.md#permissions).

The running host checks `host.log` every second and clears it above 1 MiB. Its inherited writer uses append mode to avoid sparse files after truncation. The current launcher log also has a 1 MiB check threshold. Completed `launch-*.log` files are retained for at most 7 days, 8 files and 8 MiB total, checked on startup, exit and every minute while running. These are periodic thresholds, not hard per-write limits; sizes may briefly exceed them between checks. File-lock leases protect active launcher logs from completed-log eviction.

Launcher handshake temporary directories live under `data_dir/launcher-state/`. Normal exit removes them; the next startup reclaims crashed remnants using leases. After acquiring the instance lock and confirming the Store has no previous owner, the host removes old UUID generation directories and registry atomic-write staging files. Other instances, user scratch and authoritative state are preserved. Unattributed remnants from older versions in the system temporary directory cannot be identified safely and are not globally scanned. See [Core API](core.en.md#recovery) for model/Core diagnostic retention.
