[中文](runtime.md) | **English**

# Runtime deployment

`areal-runtime` is an independent execution service connected to one trusted caller through launcher-inherited private stdin/stdout pipes. TTYs and regular files are rejected. See the [quickstart](quickstart.en.md) for normal Core usage and [Runtime API](../api/runtime.en.md) for wire details.

| Deployment argument | Default and meaning |
|---|---|
| `--workspace` | Required; mapped to `workspace://repo` |
| `--allow-write`, `--allow-network` | Disabled for standalone native daemon; full-access enables both; children may only narrow |
| `--allow-concurrent-writes` | Disabled; enabling bypasses command path coordination, while file helpers still coordinate |
| `--file-helper` | Defaults to trusted `areal-runtime-fs` beside the daemon |
| `--max-processes` | 4 registered commands across descendant Scopes, including startup/cleanup; not internal fork counts |
| `--wall-time-ms` | 30000 per process, including queuing and startup |
| `--output-bytes` | 8 MiB cumulative per connection, not refunded on process exit |
| `--output-window-bytes` | 64 KiB/process, maximum 8 MiB, also bounded to 1024 chunks |
| `--sandbox-profile` | Standalone daemon: native; product launcher: full-access; controlled Linux containers: outer-container-perf |

The launcher's `--command-timeout-ms` defaults to 300000, unlike the standalone daemon. Desktop mode accepts `--desktop-process-timeout-ms` (1–86400000); managed services in a root Thread may use the Runtime desktop budget, while regular command tools and Turn processes retain the `--command-timeout-ms` limit. Child tasks, hooks, and additionally narrowed Scopes always retain their ancestor limits; the desktop budget does not widen their permissions or budgets. Explicit process durations exceeding the parent limit are rejected before acceptance. Local TUI/Web/CLI and launcher use full-access by default: host filesystem and networking are available with YOLO, while ASK_PERMISSIONS adds Core approvals. Full-access commands run as the current user without an OS sandbox; explicit read-only, research and plugin Scopes still use native isolation. Models and approvals cannot expand an explicitly restricted Runtime. See [permission modes](configuration.en.md#permissions).

Commands do not inherit model credentials. Unrestricted full-access commands with inherited network and no fixed read-only inputs inherit the host PATH/HOME/TMPDIR/LANG/LC_ALL/TERM/SSH_AUTH_SOCK, with Core replacing TMPDIR with Thread scratch. SSH_AUTH_SOCK references an agent already present in the trusted launch session; it neither reads/copies private keys nor forwards Git tokens. Explicit task credentials retain their designated-executable boundary. Narrowed commands keep the restricted environment and do not inherit the host SSH agent. process.start.env accepts PATH/LANG/LC_ALL/TERM/CI/RUST_BACKTRACE/TMPDIR/PYTHONDONTWRITEBYTECODE; TMPDIR changes temporary-file placement without widening path grants.

The launcher creates `scratch/` beside dataDir and one `agent-<threadId>/` per Thread. `--scratch <directory>` selects an existing directory disjoint from workspace and dataDir. Scratch is writable even with a read-only repository and persists until manually cleaned. Under explicit `--sandbox-profile native`, trusted binaries and Core data must remain outside writable workspace/scratch roots. Full-access permits binaries inside the workspace for development.

## Git identity and remote authentication

- **Commit identity** comes from Git's effective configuration. Before an authorized commit, check `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` in the execution environment rather than only repository-local `user.name`. Never invent a name or email. An isolated HOME or denied configuration access means this environment cannot resolve the identity, not that the host lacks configuration. Obtain user-provided or confirmed values before a temporary override; do not silently change global configuration.
- **HTTPS authentication** depends on the configured credential helper and its host permissions. Restricted macOS Scopes do not open Keychain by default. Errors such as `osxkeychain: failed to get: -50` alone do not establish an incorrect password. Distinguish sandbox restrictions, login-session/Keychain state, and remote rejection. Do not automatically disable helpers, change remotes, or export credentials. Network authorization alone does not grant Keychain access: explicit native profiles, narrowed filesystem/network permissions, and fixed read-only inputs retain native isolation. Host authentication requires the user's explicit authorization for unrestricted full-access execution without fixed read-only inputs, or an authorized terminal. Do not automatically widen restricted tasks or unlock Keychain.
- **SSH authentication** under full access reuses the `SSH_AUTH_SOCK` present when AReaL starts. An absent agent, stale socket, locked key, or missing remote authorization can still fail. Restart the owning Core/Runtime service after changing its launch environment. Forwarding the socket does not load private keys, change SSH configuration, grant restricted children agent access, or guarantee a successful push.
- Authentication checks must be bounded and noninteractive, respecting network and file approvals. Never print `git credential fill` results, tokens, private keys, or complete credential configuration. Switching HTTPS/SSH, committing, and pushing are separate operations. Branch changes do not fix authentication; uncertain pushes are not retried automatically. Report local commit and remote push outcomes separately.

## Platforms and trust

The native profile on macOS uses fixed `/usr/bin/sandbox-exec` with default-deny Seatbelt policies and no unsandboxed fallback. Permissions cover path subtrees; device/inode revalidation detects stale bindings but is not directory-object isolation. See [sandbox.rs](../../runtime/exec-native/src/sandbox.rs) for system reads. Native does not grant Homebrew and shared temporary-directory writes by default; full-access does. On Linux, launcher full-access runs directly with the host, and read-only operations in an unrestricted root Scope use the same deployment-level execution path instead of entering the macOS-only native Seatbelt path. Explicitly narrowed Scopes still require native or outer-container-perf and cannot use full-access to bypass path isolation.

The Linux native profile uses Bubblewrap for an empty mount namespace, explicit system read-only mounts and Scope read/write mounts, with Runtime seccomp layered on top. It requires `/usr/bin/bwrap` and usable user namespaces. Startup preflight runs `/bin/true` inside the same system read-only mounts, supporting BusyBox layouts. Failures retain the Bubblewrap exit status and stderr instead of misreporting a missing command as unavailable namespaces. Every Linux profile also requires `areal-runtime-reaper` beside the host executable and readable `/proc`; reaping does not require Python. Both `make build` and complete release bundles include this Rust helper. `outer-container-perf` additionally depends on a controlled outer read-only container/cgroup that relaxes outer seccomp/systempaths/AppArmor for the inner namespaces; it supports only the [fixed benchmark workflow](../benchmarks/README.en.md).

Core, Node Hosts and stdio MCP are outside the Runtime sandbox. Process-group termination and output closure do not prove all escaped descendants have exited. Complete cleanup after Runtime SIGKILL, host isolation and reliable sandboxDenied attribution are unverified.

The Linux profile establishes a session when spawning Bubblewrap and keeps namespace init in the managed process group, so cancellation covers init and its PID namespace. This does not set cross-platform processTreeCleanupVerified to true. There are no per-Scope cgroup pids/memory limits; deployment must bound internal forks and memory. A signaled inner command may make the launcher exit normally with `128 + signal`. Runtime reports the launcher's actual exitCode/signal without inferring inner signals or OOM. Cleanup still requires confirmation.

In the native macOS profile, Python from the default Xcode, `/Applications/Xcode_<numeric version>.app` (for example `Xcode_16.4.app`), or Command Line Tools installation is discovered through shared `runtime/host-tools` by Core and Runtime: the trusted host runs `/usr/bin/xcrun --find python3`, resolves and validates the actual file before entering the existing sandbox; no `/var/select/developer_dir` link is required. Direct `/usr/bin/python3` and `python3` on the default PATH use the real interpreter, avoiding the xcode-select shim. Only the system Python framework gains read/execute access; out-of-workspace files and shared `/tmp` writes remain denied. Custom Xcode locations and Homebrew Node/Python do not gain permissions automatically and require explicit toolchain preparation.

The product launcher supplies scratch automatically and advertises `verify_command`. Direct embedded Core deployments without command scratch do not advertise it; they must explicitly configure Runtime scratch grants.

## Lifecycle

EOF, SIGINT/SIGTERM or explicit close shuts admission and awaits resources. Dropping an RPC waiter does not cancel an operation; revoke/terminate and then wait. Lost backend facts or failed cleanup preserve UNKNOWN and budget occupancy, close new admission and return CLEANUP_FAILED.

Each epoch retains at most 256 Scopes and 4096 operations until shutdown. Exhaustion requires normal drain/restart; deleting records cannot reuse the epoch. Helpers coordinate target files and commands coordinate write roots by default. Other Runtimes/host editors do not participate, so external CAS is not guaranteed.

Validate with `make verify-runtime`; see [Cordis](../development/cordis.en.md) for component shutdown.

On cancellation or startup failure, the launcher reaps Core/Runtime children before removing its internal readiness directory, preventing late child writes from racing directory cleanup.
