[中文](runtime.md) | **English**

# Runtime deployment

`areal-runtime` is an independent execution service connected to one trusted caller through launcher-inherited private stdin/stdout pipes. TTYs and regular files are rejected. See the [quickstart](quickstart.en.md) for normal Core usage and [Runtime API](../api/runtime.en.md) for wire details.

| Deployment argument | Default and meaning |
|---|---|
| `--workspace` | Required; mapped to `workspace://repo` |
| `--allow-write`, `--allow-network` | Disabled; child Scopes may only narrow grants |
| `--allow-concurrent-writes` | Disabled; enabling bypasses command path coordination, while file helpers still coordinate |
| `--file-helper` | Defaults to trusted `areal-runtime-fs` beside the daemon |
| `--max-processes` | 4 registered commands across descendant Scopes, including startup/cleanup; not internal fork counts |
| `--wall-time-ms` | 30000 per process, including queuing and startup |
| `--output-bytes` | 8 MiB cumulative per connection, not refunded on process exit |
| `--output-window-bytes` | 64 KiB/process, maximum 8 MiB, also bounded to 1024 chunks |
| `--sandbox-profile` | native; explicit outer-container-perf for controlled Linux containers |

The launcher's `--command-timeout-ms` defaults to 300000, unlike the standalone daemon. Root is read-only/network-denied by default. Models, owner strings and approvals cannot expand grants. Commands receive no model credentials and only accept PATH/LANG/LC_ALL/TERM/CI/RUST_BACKTRACE.

`--scratch <directory>` adds an existing task temporary directory that must not overlap workspace. `scripts/launch.py --scratch` configures both Runtime grants and Core TMPDIR. Keep trusted binaries and Core data outside every writable root.

## Platforms and trust

macOS uses fixed `/usr/bin/sandbox-exec` with default-deny Seatbelt policies and no unsandboxed fallback. Permissions cover path subtrees; device/inode revalidation detects stale bindings but is not directory-object isolation. See [sandbox.rs](../../runtime/exec-native/src/sandbox.rs) for system reads. Homebrew and shared temporary-directory writes are not granted by default.

Linux outer-container-perf combines Bubblewrap, Runtime seccomp and an outer read-only container/cgroup. The container relaxes outer seccomp/systempaths to create inner namespaces; tools still receive Runtime filtering. This supports only the [fixed benchmark workflow](../benchmarks/README.en.md), not general Linux deployment.

Core, Node Hosts and stdio MCP are outside the Runtime sandbox. Process-group termination and output closure do not prove all escaped descendants have exited. Complete cleanup after Runtime SIGKILL, host isolation and reliable sandboxDenied attribution are unverified.

The Linux profile establishes a session when spawning Bubblewrap and keeps namespace init in the managed process group, so cancellation covers init and its PID namespace. This does not set cross-platform processTreeCleanupVerified to true. There are no per-Scope cgroup pids/memory limits; deployment must bound internal forks and memory. A signaled inner command may make the launcher exit normally with `128 + signal`. Runtime reports the launcher's actual exitCode/signal without inferring inner signals or OOM. Cleanup still requires confirmation.

## Lifecycle

EOF, SIGINT/SIGTERM or explicit close shuts admission and awaits resources. Dropping an RPC waiter does not cancel an operation; revoke/terminate and then wait. Lost backend facts or failed cleanup preserve UNKNOWN and budget occupancy, close new admission and return CLEANUP_FAILED.

Each epoch retains at most 256 Scopes and 4096 operations until shutdown. Exhaustion requires normal drain/restart; deleting records cannot reuse the epoch. Helpers coordinate target files and commands coordinate write roots by default. Other Runtimes/host editors do not participate, so external CAS is not guaranteed.

Validate with `make verify-runtime`; see [Cordis](../development/cordis.en.md) for component shutdown.
