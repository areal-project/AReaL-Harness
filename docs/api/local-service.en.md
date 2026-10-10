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

## Identity, compatibility and history

One dataDir allows one Core. `ensure` serializes concurrent launches and checks the running identity/configuration. Model file edits reload without restarting. Other TOML changes and rebuilt binaries restart automatically when the service is idle; active work prevents automatic restart. Permission, Runtime, deployment-file or model CLI/environment override changes require `areal service restart`. It never silently expands write/network permissions or kills an unmanaged Core. Symlinks resolve to canonical identity.

Development and PATH-installed binaries select the same instance for the same workspace and dataDir, but their binary contents and version-specific defaults may be incompatible. Conflict diagnostics provide the current client binary's absolute path and resolved deployment arguments. Run that command with the same environment so a bare `areal` does not restart another version. Binary-only and ordinary configuration changes still restart automatically when idle; Runtime and permission boundary changes still require an explicit restart.

Service home is selected by `AREAL_HARNESS_SERVICE_HOME` (a nonempty absolute path), falling back to `AREAL_HARNESS_HOME` or `~/.areal`. It controls only service registration, workspace mappings, and default instance data, without changing Core configuration lookup. `ensure`, `restart`, `list`, `status`, `stop`, `bind`, and `web` use the same service home. Without an explicitly configured dataDir, shared entry points use `<service home>/instances/<first24-workspace-hash>/state`. CLI/environment/TOML dataDir overrides retain their precedence. Owned launchers and noninteractive CLI retain their existing default directories.

Existing `~/.areal-harness/state` history is not moved or merged automatically. Pass `--data-dir`, or stop the old Core and bind the workspace default:

```sh
target/debug/areal service bind --workspace /absolute/workspace \
  --data-dir /absolute/old-state --json
```

Initial binding holds the Core data lock, checks that every stored Thread cwd belongs to the workspace, and writes `service-workspace` without copying history. Workspace mappings live under home/workspaces. A bound store cannot switch workspaces; mixed history requires separate organization. Data and service registry must be outside the workspace, as must trusted binaries in write mode.

Compatibility separates deployment identity from the default model revision. Model reload validates the whole TOML and retains the previous configuration on error. Limits, permissions, Runtime budgets, deployment manifests/tool extensions/Workgroup policies and binary contents retain restart boundaries. Model credential values are excluded from digests and registration. The service inherits its initial environment. If the model revision still differs after waiting three seconds for reload, the client attempts a safe restart; ordinary reload errors return the specific cause. A credential unavailable to the old service sets `restartRequired=true`; after client configuration resolution validates credentials in the current environment, an idle restart can inherit them. Busy services retain their generation and work; retry after settlement, without automatic cancellation. Rotating only an existing credential value or changing other environment variables still requires explicit restart. Live Provider/Thread configuration remains owned by Core.

## Lifecycle and recovery

Closing a window disconnects it. Active Turns/Goals may continue and multiple windows may subscribe to one Thread. Concurrent writes still follow Core admission, CAS, queues and requestId rules. Explicit cancellation is separate from closing a window.

Services have no idle exit timer. File model updates keep the same generation and connections; TUI detects other TOML changes and requests a restart once background work settles. Web and other clients can run `areal service ensure` or `restart`; browsers do not own process lifecycle. Default stop checks `restartSafe`, `activeGoals` and `pendingQueueItems`, then checks again under Core admission with `drain(strategy="ifIdle")`, rejecting outstanding work/resources without pausing them. `--cancel` uses Core drain to cancel and settle; UNKNOWN or unconfirmed cleanup still prevents success. Accepted stop closes admission; inspect logs/authoritative state after cleanup failure instead of assuming no work happened. Work admitted between the status check and drain follows drain's wait/pause rules.

The host controls Core/Runtime startup and shutdown. The Rust launcher owns the separate processes and private pipes without Python on Linux. On macOS, a working `/usr/bin/python3` waits for Runtime; timeout cleanup kills their dedicated process group. Startup checks interpreter availability; install Xcode Command Line Tools if it is unavailable. Launcher death closes the Core lifetime pipe; Runtime cleans up through its private transport. Launcher parent checks detect host death. The launcher inherits the instance lock but does not pass it to Core/Runtime, and retains it through cleanup even if the host is killed. No replacement starts until the old Core releases its lock. `service.json` is a discovery hint: clients verify locking, the control socket and authenticated Core identity rather than trusting historical PIDs or ports.

TUI rediscovers after disconnection and can start a new generation after crash cleanup. Explicit stop leaves a marker so existing windows do not automatically undo it; opening a new window or manually running ensure can restart it. Recovery uses thread/resume snapshots without request replay. Goals pause across restart and tool UNKNOWN keeps its inspection requirements.

## Web and Desktop integration

- `areal web` reads authFile in the trusted local client, verifies service identity, obtains a one-time code and opens `/ui` to exchange it automatically for an independent HttpOnly cookie. The page never receives the long-lived token. Browsers never launch processes, read authFile or access the control socket. Run `areal web` again after link/session expiry, restart or port changes; manual token login remains a fallback. `--json` only discovers the service and does not mint codes. Rust callers can use `browser_login_url(&Service)` to obtain the one-time URL; never log it or forward it to untrusted pages. See [browser login](desktop.en.md#browser-auth) for endpoints and lifetimes.
- Desktop Main executes `areal service ensure --json` with an argument array, checks `protocolVersion`, reads authFile in Main and establishes the authenticated connection. Expose only filtered application operations/state to Renderer, never the full descriptor or token.
- Rediscover and compare generation before initialize/initialized and thread/resume. Query request/read or authoritative state before deciding to retry; never replay accepted operations automatically.
- Dynamic ToolHosts that must survive windows belong in a stable Main/independent host connection. Window tools do not transfer automatically; disconnect retains Host generation and UNKNOWN semantics.

Internal control uses one-line JSON over home/services/INSTANCE_ID/control.sock, with 0700 directories and 0600 records/credentials. Requests are `{method:"status",version:1}` or `{method:"stop",version:1,generation,cancel}`; responses are `{result:"ok",service}` or `{result:"error",message}`. Non-Rust clients should use the CLI instead of duplicating locking/recovery. Shorten AREAL_HARNESS_SERVICE_HOME if the Unix socket path exceeds the platform limit.

Authenticated GET `/areal/service` returns the six identity fields (protocolVersion/serviceId/generation/workspace/dataDir/configFingerprint), requires observe permission and rejects a mismatched Origin. An authenticated Core without managed identity returns 404. Business operations retain the [Core](core.en.md) and [desktop API](desktop.en.md) protocols and the same Agent loop.

LocalArgs adds permissions (YOLO/ASK_PERMISSIONS) and scratch. Effective permission policy and scratch participate in deployment compatibility. Local launcher now defaults to full-access; the changed default requires an explicit restart for an existing service. No client attach operation silently widens the old service. See [permissions](../guides/configuration.en.md#permissions).

The running host checks `host.log` every second and clears it above 1 MiB. Its inherited writer uses append mode to avoid sparse files after truncation. The current launcher log also has a 1 MiB check threshold. Completed `launch-*.log` files are retained for at most 7 days, 8 files and 8 MiB total, checked on startup, exit and every minute while running. These are periodic thresholds, not hard per-write limits; sizes may briefly exceed them between checks. File-lock leases protect active launcher logs from completed-log eviction.

Launcher handshake temporary directories live under `data_dir/launcher-state/`. Normal exit removes them; the next startup reclaims crashed remnants using leases. After acquiring the instance lock and confirming the Store has no previous owner, the host removes old UUID generation directories and registry atomic-write staging files. Other instances, user scratch and authoritative state are preserved. Unattributed remnants from older versions in the system temporary directory cannot be identified safely and are not globally scanned. See [Core API](core.en.md#recovery) for model/Core diagnostic retention.
