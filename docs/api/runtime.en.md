[中文](runtime.md) | **English**

# Runtime API: areal.runtime.v0

Types are defined in [runtime/protocol](../../runtime/protocol/src/lib.rs); see [deployment](../guides/runtime.en.md). This private execution protocol has no jsonrpc field and is not a public network JSON-RPC service.

## Handshake and transport

UTF-8 JSONL requests are `{id,method,params}`; responses echo id with result/error. Diagnostics use stderr. id is an integer or 1–128-byte string and cannot be reused in flight. One Runtime serves one inherited pipe pair without reconnection/adoption.

```json
{"id":1,"method":"connection.open","params":{"protocolVersion":"areal.runtime.v0"}}
```

Handshake returns protocolVersion, connectionId, runtimeEpoch, rootScopeId and capabilities with an exact version match. Other methods before initialization return UNAUTHENTICATED. Frames are limited to 128 KiB; normalized payloads usually to 64 KiB, with encoded fs.execute/process.write up to 124 KiB.

capabilities reports actual sandbox, fullAccess, rootNetwork, methods and processLimits, without granting permissions. coreHostIsolated/processTreeCleanupVerified/directoryObjectIsolation/sandboxDenialAttribution are false. Core treats missing legacy rootNetwork as network-denied.

Standard deployments expose capabilities.builtinTools.searchFiles with a trusted file-helper path. The Runtime file helper links ripgrep search libraries directly and does not consult host rg configuration. Core search_files invokes it inside the existing Runtime Scope; older external Runtimes without this capability receive UNSUPPORTED with upgrade guidance.

On macOS, embedded search and fs.execute share the system Python launch bridge, which runs the original sandbox command. process.start selects this bridge only when its first command argument exactly matches the deployment-configured absolute helper path; this does not expand Scope permissions or access to the helper's parent directory.

If Runtime assembly fails, `connection.open` reports the original error after startup rollback, with `initializationFailed=true` and `cleanupConfirmed` in `error.details`. Only a failure with confirmed rollback and a normal process exit may be treated as unavailable isolation. `CLEANUP_FAILED`, EOF without a receipt, and abnormal exits do not authorize a safe fallback. This failure handshake waits at most four seconds and accepts no task requests. The Rust Client also marks initialization as clean when the operating system refuses process creation before any Runtime starts. Normal shutdown and UNKNOWN semantics remain unchanged.

## System tools in restricted macOS commands

A complete macOS Runtime includes private `shells/bash` and `shells/sh`. Restricted standard Bash/sh entry points and PATH use these programs; `sh` retains POSIX startup behavior. Source, network and scratch permissions remain unchanged. System Bash 3.2 here-documents ignore TMPDIR; environment settings alone cannot give them private temporary storage. The private Bash uses authorized scratch without making shared `/tmp` writable. Missing shell components return UNSUPPORTED at standard shell entry points, with no unsandboxed fallback. Nested scripts hardcoding system `/bin/bash` still invoke that version; scripts requiring private temporary storage should use the Runtime entry point or `env bash`.

Runtime resolves the Apple Git shim on the trusted host. Restricted tasks can read/execute only the selected system Git and its fixed resources, without opening toolchain selection state, host configuration or the complete toolchain directory. Ambient system/global Git configuration and system attributes are not imported by default; repository configuration remains subject to existing path permissions. Explicit Git environment overrides remain subject to the same OS sandbox. Read-only Scopes still reject Git index, configuration and source writes.

Trusted startup PATH retains explicit absolute-directory order without granting file permissions by itself. On macOS, desktop launches also append existing bin/sbin directories under `/opt/homebrew` and `/usr/local`; these prefixes must not redirect into user directories. Only program/library resources are readable. Under etc, only public OpenSSL configuration and CA resources (openssl.cnf, cert.pem, certs) are selected, excluding private keys, other service configuration and var. The same resource rules select macOS system LibreSSL public configuration and certificates under `/private/etc/ssl` for programs such as Cargo, without exposing all of `/etc`.

User tools share the same Runtime startup discovery boundary:

| Installation | Resources and version selection for restricted commands |
|---|---|
| nvm | NVM_DIR or its default installation tree; resolve default/user/LTS aliases against installed versions |
| fnm | FNM_DIR or standard data directories; resolve the default or active multishell link |
| mise, asdf | Concrete installed tool versions selected by literal global configuration; never evaluate templates, env, hooks or plugins |
| pyenv, rbenv | Installed versions and the global version file, retaining explicit deployment version hints |
| rustup / Cargo | Selected toolchain binaries and libraries; independently installed Cargo commands expose bin only, excluding credentials.toml |
| Volta | Installed default Node/npm/pnpm/Yarn images; selected package managers precede npm bundled with Node |
| uv, pipx, Bun, Deno, standalone pnpm and other CLIs | Existing user bin directories; uv/pipx links expose only the corresponding venv and recognized interpreter, not the entire user data tree |

Explicitly activated installation paths take precedence over global defaults. Without a default, discovery selects only an unambiguous installed version. Multiple versions, invalid configuration or missing requested versions never trigger an arbitrary latest-version fallback. Discovery reads bounded files and fixed-depth directories; it runs no shell configuration or manager hooks and installs/downloads nothing. Restricted PATH replaces recognized shims with concrete installations so an isolated HOME does not break startup. Fully authorized execution with inherited network retains original shim order and host project-selection behavior. Restricted execution uses a startup version snapshot: it does not interpret workspace version files, complex manager configuration or install missing project versions. Use an authorized explicit tool path or activate the desired installed version in the trusted launch environment and restart Runtime.

Rust default selection uses an explicit launch version, the user rustup default, then the Homebrew rustup default. Homebrew settings are read only under a trusted standard installation prefix, without granting tasks access to those settings. Restricted PATH projection recognizes Homebrew rustup opt and Cellar shims and replaces them with the installed toolchain.

Desktop services, Rust Client, isolated workers and the development launcher forward the same discovery hints: HOME, XDG_DATA_HOME/XDG_CONFIG_HOME, NVM_DIR, FNM_DIR, VOLTA_HOME, MISE_DATA_DIR/MISE_CONFIG_DIR/MISE_INSTALLS_DIR, ASDF_DATA_DIR, PYENV_ROOT, RBENV_ROOT, RUSTUP_HOME, CARGO_HOME, PNPM_HOME, BUN_INSTALL, DENO_INSTALL and RUSTUP_TOOLCHAIN/PYENV_VERSION/RBENV_VERSION. These values feed trusted startup discovery and are not directly injected into restricted tasks. Configuration contents, the host home, credentials and manager state directories remain excluded. Concrete installation roots must resolve inside recognized installation trees; redirected or removed roots are rejected again before execution. Model-supplied PATH or manager variables cannot add authorization roots. Source writes, network, protected inputs and cleanup retain their Scope limits.

The `commandEnvironment` handshake reports restricted `path`, fully authorized `unrestrictedPath`, `readOnlyToolchains`, and `notices` for unresolved defaults. Discovery runs within the Runtime lifecycle, without launching a shell or rescanning the user directory on every tool call. Restart the service after changing installations or default versions.

Restricted macOS commands default `CARGO_NET_GIT_FETCH_WITH_CLI` to `true`, so Cargo Git fetching uses system Git with its isolated configuration. Explicit command values take precedence. System Git configuration permits only required metadata checks, not content reads. Host Cargo caches still require explicit directory grants.

Restricted commands do not inherit the host HOME. Runtime selects HOME within existing read permissions: a valid TMPDIR (Core’s per-thread scratch), readable deployment scratch or its authorized subdirectory when TMPDIR is absent, or the working directory as a fallback. Missing TMPDIR uses that directory too. The directory must exist and be absolute; its resolved path must remain inside the Scope’s read roots. No read/write roots or network permissions are added. A read-only caller without writable scratch still cannot write caches; trusted callers should supply scratch. Fully authorized host execution with inherited network retains its existing HOME/TMPDIR inheritance rules.

Rust Client `launch_with_limits` projects the trusted PATH and forwards the discovery hints above to Runtime, without inheriting other environment variables. `launch_with_command_path` accepts bounded absolute directory lists from trusted deployments or materialized toolchains. NativeExecutor prefixes private .toolchain/bin for an explicit toolchain without widening source write sets. `launch_with_environment` additionally accepts a network ceiling already authorized by the trusted caller. Existing launch entry points still deny network by default, and child Scopes may narrow it to deny.

Private Bash is a separate GPL-3.0-or-later executable, accompanied by its license, pinned corresponding source and build information, rather than statically linked into Rust. Build and upgrade complete bundles; see [development](../development/README.en.md) and [releasing](../development/releasing.en.md).

## Methods

`restrictedScopes` in the handshake is `{available:true}` or `{available:false,error}`. It reports checked prerequisites for restricted execution, not authorization or guaranteed success for arbitrary commands. A working full-access parent does not establish that narrowed children can run: those children still require the OS sandbox. Linux probes Bubblewrap namespaces and macOS probes Seatbelt. Results are cached for the Runtime process; restart after environment capabilities change. Legacy `restrictedScopeIsolation` also requires this probe to pass rather than trusting the deployment label.

The native backend selects admission, command sandbox and syscall policy from the effective Scope. Restricted Scopes or fixed read-only inputs use native policy even under a full-access deployment; Linux does not skip seccomp because of the parent deployment label. Unrestricted authorization without protected inputs retains full-access behavior.

| Method | params |
|---|---|
| connection.open / close | `{protocolVersion}` / `{}` |
| scope.check | `{parentScopeId,permissions?}`; returns `{available:true}` on success |
| scope.create | `{operationId,parentScopeId,owner,permissions?,limits?}` |
| scope.createParticipant | `{authorityScopeId,scope,participation}` |
| scope.get / revoke / waitClosed | `{scopeId}` |
| owner.revoke | `{pluginInstanceId}` |
| process.start / startQueued | `{operationId,scopeId,argv,cwd,env?,tty?,pipeStdin?,limits?}` |
| process.get / terminate / wait | `{processId}` |
| process.write | `{operationId,processId,dataBase64}` |
| process.resize / closeStdin | `{operationId,processId,cols,rows}` / `{operationId,processId}` |
| fs.execute | `{operationId,scopeId,command}` |
| output.read | `{processId,after?,maxBytes,waitMs?}` |
| operation.get | `{operationId}` |
| runtime.status | `{}` |

Up to 32 long requests may wait; revocation, termination and synchronous queries retain control access. connection.close returns closed=true only after confirmed cleanup. Scope states are active/revoking/closed; operation states accepted/running/succeeded/failed/cancelled/unknown; process states starting/running/exited/unknown.

## Permissions and deduplication

`scope.check` validates paths, narrowed read/write roots and network permissions against the parent, then probes the backend's execution prerequisites. It creates no Scope, operation record or task process and consumes no cumulative quota. Unavailable execution returns `UNSUPPORTED` or the original permission error. A check does not grant permission or promise future execution; `scope.create` checks again. Core uses it before a child's first model request. Rust `Client::check_scope` and TypeScript `client.scopes.check` share this contract. An older Runtime that does not advertise the method rejects new children with an upgrade message, while existing parent work and control requests remain usable.

Paths use unencoded `workspace://repo[/path]`, rejecting percent signs, question marks, hashes, backslashes, NUL and . / .. segments. Child roots must remain within parent grants, and write roots within read roots. network=inherit inherits the parent policy; deny cannot be reversed below it. owner is attribution only. argv has 1–256 entries; see [deployment](../guides/runtime.en.md) for environment allowlists.

A separately configured scratch root enables `workspace://scratch[/path]` for files and process cwd; otherwise this namespace is rejected. It cannot overlap repo; scratch is writable independently of repo allow-write, and children can only narrow access. Directory identity, traversal and symlink checks still apply. Core resolves short handles before Runtime calls without changing ProcessId, cursor or ExpectedFile wire types.

With `fullAccess=true`, `workspace://host[/absolute-path-without-leading-slash]` maps to `/`; restricted deployments reject this namespace. Core normalizes outside-workspace absolute paths to host URIs. File helpers continue to reject symlink traversal. Read-only/research Scopes exclude the host root.

Side-effecting methods use `${runtimeEpoch}:op:${UUID}` operationId. Identical keys and normalized request digests share the same operation; changed digests return CONFLICT. Records remain through the epoch and exhaustion rejects new operations. Old epochs return STALE_HANDLE. Successful process start means a handle was obtained, not command success. Lost responses never justify replay with a new key.

Defaults are 30 seconds per process, 8 MiB cumulative descendant output and 4 concurrent processes per Scope, with 256 Scopes/4096 operations retained per connection. Deadlines include write-path queuing and startup. Process quota remains until cleanup. Deployment may configure limits; children can only narrow them.

`fs.execute` helper processes and explicit `process.startQueued` wait when an ancestor has no free process slots. Waiting counts against the original process deadline; capacity checks and reservations are atomic and never raise the concurrency limit. An epoch-local operation receipt is retained before waiting. Duplicate IDs share the same wait and result; Scope revocation ends the wait. Exhausted cumulative output, permissions, or operation-record capacity still reject immediately, without replaying effects. `process.start` retains immediate admission or rejection. Core negotiates queued starts for short file reads and searches; older Runtimes retain the original entry point without retry after failure.

The Runtime daemon accepts `--cumulative-output-bytes` to set cumulative deployment/descendant-Scope output independently. Omitted values equal `--output-bytes` and explicit values cannot be smaller than the per-process cap. Each process remains bounded by `--output-bytes`; retained windows are separately bounded by `--output-window-bytes`. Accepted stdout/stderr bytes are charged once to each ancestor; rereading retained output does not charge again. File-helper JSON/base64 responses are process output too.

Core uses `readForHistory` to capture a conditional edit's historical preimage. Only this validated filesystem helper uses a private response cap of `MAX_FRAME_BYTES - 4096` and does not consume command or ancestor output quotas. Read permissions, file bounds, process capacity, deadlines and retained-operation limits still apply. Ordinary `read` and `process.start` retain their existing output accounting.

## Bounded hook write groups

`scope.createParticipant` is connection-owner admission. `authorityScopeId` must equal this epoch's opaque connection root; `scope` has the existing `scope.create` fields. `participation` is `{kind:"task",admissionWindowMs}` or `{kind:"hook",taskScopeId}`. A task can only be created outside an existing group. A hook's parent must already belong to the specified validated task Scope. Ordinary child scopes inherit participation; copying owner metadata does not confer authority. Existing `scope.create` and `ScopeInfo` remain unchanged; unsupported Runtimes reject the new method without a permissive fallback.

The admission window is 1–min(task process wall limit,60000) milliseconds. First write admission fixes the generation deadline; later members cannot extend it. Covered paths permit same-group overlap when at least one participant is Hook. Ordinary/ordinary remains serial and cross-group conflicts remain exclusive. Path expansion requires a complete new reservation behind earlier foreign waiters. After sealing, new members enter the next generation's FIFO position; existing processes retain their own limits and leases until confirmed cleanup. UNKNOWN retires admission rather than releasing uncertain effects. Typed participants retain this scheduling even with the legacy concurrent-write option; ungrouped legacy behavior is unchanged.

This changes the fairness unit to a bounded group and permits hook/tool races within a task. It does not grant new paths, promise transactional isolation, or ensure arbitrary dependency chains can reenter after sealing. Core owns a per-Session task Scope, derives ordinary tool and hook scopes from it, and closes it after joined hook tasks and SessionEnd. Per-process permission narrowing and hook secret exclusion remain enforced.

## Output and cleanup

output.read accepts maxBytes 1–65536 and waitMs 0–1000, up to 128 chunks/page. Response is `{chunks,nextCursor,gap,truncated,closed}`; each chunk carries cursor/stream/dataBase64, with stdout/stderr/pty stream. UTF-8 may span pages and needs incremental decoding.

gap means an older prefix was evicted; truncated means budget/fault loss; closed means output ended and this page reached its tail, not command success. Retention defaults to 64 KiB/1024 chunks. Continue by cursor rather than interpreting a short page as EOF.

revoke closes descendant admission before cancellation. waitClosed requires prior revoke. terminate accepted is not cleanup; process.wait confirms exit and output closure. Execution outcome and cleanup are independent: `ProcessInfo.cleanupConfirmed` confirms only managed resources within the platform boundary, while `failureReason` preserves the original execution error. Missing fields from older Runtimes are not cleanup evidence.

Handshake capability `failureIsolationV1=true` advertises graded failure handling. When process and platform-tracked resources have exited but output reading or delivery fails, Supervisor revokes only the owning execution Scope, releases resource quota, and retains the UNKNOWN process and original operation receipt. Other Scopes remain usable. Uncertain startup, unconfirmed cleanup, EOF without an error receipt, or invalid event ordering fences the root Scope and shuts down the backend. Only a trusted successful backend shutdown receipt releases those UNKNOWN resource reservations. Root admission stays closed and outcomes remain unknown; no operation is replayed.

`runtime.status` adds `admissionOpen` and nullable `recovery`: `state=restartRequired|inspectionRequired`, `reason`, `cleanupConfirmed`, nullable `cleanupFailure`, up to 16 unconfirmed `processes`, and total `unconfirmedProcesses`. Original faults and shutdown failures/timeouts are preserved separately; shutdown waits are bounded by the deployment cleanup deadline. The first state allows a trusted host to replace the Runtime epoch after resources and durable state settle; the second requires inspection. Neither restores old handles. Rust `backend::Event::Failed {error,cleanup_confirmed}` replaces the single-value failure event. Embedders must update exhaustive matches and supply true only with cleanup evidence; explicit `ProcessInfo` initializers also need the new fields. RPC fields are additive, and TypeScript accepts missing fields from older Runtimes.

Each Linux native execution has a dedicated trusted Rust binary, `areal-runtime-reaper`; deployment requires this helper beside Runtime and readable `/proc`. Hosts embedding `NativeBackend` must also deploy the helper beside their executable. Reaping does not require Python; the project launcher and custom tools retain their separate interpreter requirements. Before launching the command, the helper becomes a subreaper and exclusively waits for its children, continuously reaping adopted orphans. On normal command exit, cancellation or EOF on the private lifetime pipe, it terminates and reaps remaining descendants of that execution, including descendants that change process groups with `setsid`. Runtime waits only for its helper and receives the actual command exit status and cleanup result through a private receipt; helper exit alone does not replace that receipt or output-closure confirmation.

Runtime passes the actual command arguments through a sealed anonymous memory-file descriptor. The helper command line contains only private descriptor numbers and mode. Before starting the payload, it reads and closes the argument descriptor, preventing workload command-line matching from accidentally killing the reaper. This private startup protocol requires matching daemon and helper versions. It does not prevent full-access code from explicitly signalling the helper by identity; existing UNKNOWN and cleanup-failure rules remain unchanged.

The startup handshake waits at most 3 seconds. When it confirms that no command was created and the helper has been reaped, startup failure rejects only that execution and releases its registration. If backend startup returns `UNAVAILABLE` or `CLEANUP_FAILED`, Supervisor keeps the process and operation UNKNOWN, closes connection admission and retains quota until a trusted backend cleanup receipt, instead of assuming nothing started. Cleanup timeouts after startup are reported as failures; the helper continues adopting and waiting for descendants that have not exited, while Runtime retains its waiter instead of killing the reaper and treating that as completed cleanup.

macOS retains process-group cleanup and discovers descendants through `libproc` approximately every 10 ms during execution, tracking at most 4096 process identities. Observed descendants remain tracked across `setsid` and reparenting; cleanup checks PID and the kernel unique process ID before signalling and confirms that these identities disappear before completing output drain. The unique-identity query also covers descendants executing setuid programs, avoiding false backend closure from restricted BSD process-info queries; parent identity uses the same kernel IDs. Discovery, signalling or exit-observation failures report cleanup failure. This is not Linux subreaper adoption: descendants can still be missed when they fork and become orphaned between observations, and identity checks and signals are not atomic kernel operations. Tracking does not guarantee complete cleanup of arbitrary process trees or cleanup after Runtime is forcibly killed.

Zombies still owned by a live intermediate parent must be waited for by that parent. The helper can reap them only after the parent exits and they are adopted.

This boundary covers one Runtime execution. It is not cgroup resource isolation and does not cover Core, MCP, plugin Hosts, processes launched independently by Studio, or zombies already present on the host. It depends on the trusted helper staying alive and retaining child ownership. Malicious same-UID full-access code or an external `SIGKILL` that terminates the helper can still leave descendants to the outer init, whose deployment must reap them. Therefore `processTreeCleanupVerified` remains false; a successful individual cleanup is not a guarantee of complete tree cleanup under arbitrary escapes or host failures.

stdin accepts 1–65536 raw bytes per write. resize dimensions are 1–65535. closeStdin closes pipe FDs or sends canonical PTY VEOF; raw PTYs reject it. Empty writes are not EOF. owner.revoke permanently closes the current generation and revokes descendants; each Scope still needs waitClosed.

## Files

fs.execute is available only with a trusted helper. command.kind selects:

| kind | Other fields | Result fields |
|---|---|---|
| read | `path,offset?=0,maxBytes` | `dataBase64,sha256,size,nextOffset,eof` |
| readForHistory | `path,offset?=0,maxBytes` | Same as `read`; internal historical evidence |
| stat | `path` | `kind,size` |
| list | `path,after?,limit` | `entries,nextCursor` |
| search | `path,pattern,glob?,context,limit` | `matches[{path,line,text,kind}],limited,guidance` |
| write | `path,dataBase64,expected` | `sha256,size` |
| applyPatch | `path,oldText,newText,expectedSha256` | `sha256,size` |
| applyPatches | `path,patches[{oldText,newText}],expectedSha256` | `sha256,size` |

Large artifact delivery uses `stageFileChunk {path,uploadId,offset,dataBase64}` (at most 64 KiB per chunk, 8 MiB total), followed by `commitFile {path,uploadId,expected,expectedExecutable,sha256,executable}`. The upload ID is a UUID; offset=0 creates private staging and later offsets must match its current size. Staging lives beside the destination; missing parent directories are created with mode 0755. The target remains unchanged until commit. Commit checks the complete content hash, baseline hash, and executable bit before conditional replacement. New files use mode 0644/0755. Existing files retain read/write permissions; unchanged executable intent preserves execute bits, while newly enabled execution follows existing read bits and always enables owner execution. Special permission bits are not copied. Publication rechecks the complete original mode and rejects concurrent chmod. New files use null expectedExecutable. `removeFile {path,expectedSha256,expectedExecutable}` deletes only a matching regular file. All three operations require write authority for the target; descriptor traversal continues to reject links. `read` additionally returns executable; filesystem.artifactDelivery=true in the handshake advertises support.

Staging and commit are separately auditable operations, not a multi-file transaction. Disconnection, unknown results, or post-commit cleanup failure must not be replayed with a new operation ID; abandoned staging remains available for inspection. Conditional replacement and removal do not provide atomic CAS against external processes outside Runtime locking.

expected is `{kind:"absent"}` or `{kind:"sha256",value:"digest"}`. read sha256 always covers the complete file; offsets are bytes. Files are limited to 8 MiB, reads/writes to 64 KiB, and combined patch old/new text to 64 KiB with a nonempty unique match. applyPatch remains a compatibility entry point sharing the one-element applyPatches implementation. applyPatches accepts at most 32 replacements and writes only after every replacement matches uniquely against the conditional version. Stale digests, existing create targets and ambiguous patches return CONFLICT.

list pages have at most 256 entries/about 32 KiB, scanning at most 4096 UTF-8 names. Directory pagination is not a snapshot. Helpers use directory descriptors and NOFOLLOW; ordinary reads/writes reject symlinks, hardlinks and special files, with fsync for conditional replacement.

When opening an existing root directory, intermediate directory or read-only file, the helper retries `EINTR` at the same descriptor boundary, preserving flags such as `NOFOLLOW` without replaying the operation or consuming another model round. Permission denials are not retried. Creation, writes, replacement and deletion are not replayed on `EINTR`; an unrecovered interruption returns `UNAVAILABLE`, preserving unknown-outcome semantics. Retrying cannot repair an unavailable OS authorization or storage service; existing Scope wall-time, cancellation and cleanup still bound the helper process.

`search` is a read-only native `FileCommand` that searches a file or directory authorized by the current Scope using the regular expression `pattern`, with an optional path-filtering `glob`. Required `context` is 0–20 and required `limit` is 1–1000; the limit counts matching lines, excluding context lines. Result rows contain a host file `path`, a line number or null in `line`, UTF-8 text or null in `text`, and `kind` of `match` or `context`. Exceeding the match limit, a 64 KiB line, 8 MiB of accumulated result-line bytes, or 13000 bytes of serialized result rows sets `limited=true`. Follow `guidance` to narrow the path or pattern; empty results mean no matches only when `limited=false`. Search honors workspace ignore rules, does not consult host rg configuration and does not follow symlinks. This branch extends the existing `fs.execute` command union; older Runtimes that do not recognize `search` reject the request, and the SDK does not automatically downgrade or retry.

By default helpers coordinate by file and commands by write root (writeSerialization=conflictingPaths). Explicit command bypass uses filePaths. External processes do not participate; external CAS/cross-file transactions are not guaranteed. Lost helper results or cleanup failure after commit become UNKNOWN without replay.

When a read-only file helper is known to have hit the output quota, its process has exited and cleanup is confirmed, return `RESOURCE_EXHAUSTED` with `details.reason=FILE_OUTPUT_LIMIT_EXCEEDED` and mark the operation Failed. This is not an unknown mutation and does not replay the read automatically. A possibly applied write with lost acknowledgement, a lost backend or unconfirmed cleanup remains UNKNOWN. Cumulative output hard limits are unchanged.

Errors include INVALID_REQUEST, INVALID_ARGUMENT, UNAUTHENTICATED, PERMISSION_DENIED, SCOPE_CLOSED, STALE_HANDLE, NOT_FOUND, CONFLICT, RESOURCE_EXHAUSTED, UNSUPPORTED, UNAVAILABLE and CLEANUP_FAILED. signal is a POSIX number string. sandboxDenied=false does not prove no sandbox denial occurred.

Built-in tools are resolved beside the Runtime executable: `target/<profile>/tools/` in development and `libexec/areal/tools/` in installed bundles, separate from public `bin/areal`.

Trusted launchers and the Runtime daemon accept repeated `--read-only-path <canonical absolute directory>` flags, up to 16. Each directory must be strictly below an existing readable root; this grants no new read access and public requests/child Scopes cannot remove protection. Runtime rejects file writes and pins directory identity. OS backends protect the subtree and ancestor deletion/rename, using read-only mounts and seccomp on Linux and Seatbelt denies on macOS. Linux also pins intermediate parents between the input and writable roots, so a Scope narrowed to a writable workspace cannot rename those directories; protection does not expand the Scope's read access. With these constraints, `full-access` also enters the sandbox without a bare-command fallback. Protected input can coexist with writable scratch siblings; existing file/link restrictions still apply. This covers commands and Runtime file operations, not external trusted-host mutations; verify input hashes at completion.
