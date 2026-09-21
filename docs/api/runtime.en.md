[中文](runtime.md) | **English**

# Runtime API: areal.runtime.v0

Types are defined in [runtime/protocol](../../runtime/protocol/src/lib.rs); see [deployment](../guides/runtime.en.md). This private execution protocol has no jsonrpc field and is not a public network JSON-RPC service.

## Handshake and transport

UTF-8 JSONL requests are `{id,method,params}`; responses echo id with result/error. Diagnostics use stderr. id is an integer or 1–128-byte string and cannot be reused in flight. One Runtime serves one inherited pipe pair without reconnection/adoption.

```json
{"id":1,"method":"connection.open","params":{"protocolVersion":"areal.runtime.v0"}}
```

Handshake returns protocolVersion, connectionId, runtimeEpoch, rootScopeId and capabilities with an exact version match. Other methods before initialization return UNAUTHENTICATED. Frames are limited to 128 KiB; normalized payloads usually to 64 KiB, with encoded fs.execute/process.write up to 124 KiB.

capabilities reports actual sandbox, rootNetwork, methods and processLimits, without granting permissions. coreHostIsolated/processTreeCleanupVerified/directoryObjectIsolation/sandboxDenialAttribution are false. Core treats missing legacy rootNetwork as network-denied.

## Methods

| Method | params |
|---|---|
| connection.open / close | `{protocolVersion}` / `{}` |
| scope.create | `{operationId,parentScopeId,owner,permissions?,limits?}` |
| scope.get / revoke / waitClosed | `{scopeId}` |
| owner.revoke | `{pluginInstanceId}` |
| process.start | `{operationId,scopeId,argv,cwd,env?,tty?,pipeStdin?,limits?}` |
| process.get / terminate / wait | `{processId}` |
| process.write | `{operationId,processId,dataBase64}` |
| process.resize / closeStdin | `{operationId,processId,cols,rows}` / `{operationId,processId}` |
| fs.execute | `{operationId,scopeId,command}` |
| output.read | `{processId,after?,maxBytes,waitMs?}` |
| operation.get | `{operationId}` |
| runtime.status | `{}` |

Up to 32 long requests may wait; revocation, termination and synchronous queries retain control access. connection.close returns closed=true only after confirmed cleanup. Scope states are active/revoking/closed; operation states accepted/running/succeeded/failed/cancelled/unknown; process states starting/running/exited/unknown.

## Permissions and deduplication

Paths use unencoded `workspace://repo[/path]`, rejecting percent signs, question marks, hashes, backslashes, NUL and . / .. segments. Child roots must remain within parent grants, and write roots within read roots. network=inherit inherits the parent policy; deny cannot be reversed below it. owner is attribution only. argv has 1–256 entries; see [deployment](../guides/runtime.en.md) for environment allowlists.

A separately configured scratch root enables `workspace://scratch[/path]` for files and process cwd; otherwise this namespace is rejected. It cannot overlap repo, follows allow-write, and child Scopes can only narrow access. Directory identity, traversal and symlink checks still apply. Core resolves short handles before Runtime calls without changing ProcessId, cursor or ExpectedFile wire types.

Side-effecting methods use `${runtimeEpoch}:op:${UUID}` operationId. Identical keys and normalized request digests share the same operation; changed digests return CONFLICT. Records remain through the epoch and exhaustion rejects new operations. Old epochs return STALE_HANDLE. Successful process start means a handle was obtained, not command success. Lost responses never justify replay with a new key.

Defaults are 30 seconds per process, 8 MiB cumulative descendant output and 4 concurrent processes per Scope, with 256 Scopes/4096 operations retained per connection. Deadlines include write-path queuing and startup. Process quota remains until cleanup. Deployment may configure limits; children can only narrow them.

## Output and cleanup

output.read accepts maxBytes 1–65536 and waitMs 0–1000, up to 128 chunks/page. Response is `{chunks,nextCursor,gap,truncated,closed}`; each chunk carries cursor/stream/dataBase64, with stdout/stderr/pty stream. UTF-8 may span pages and needs incremental decoding.

gap means an older prefix was evicted; truncated means budget/fault loss; closed means output ended and this page reached its tail, not command success. Retention defaults to 64 KiB/1024 chunks. Continue by cursor rather than interpreting a short page as EOF.

revoke closes descendant admission before cancellation. waitClosed requires prior revoke. terminate accepted is not cleanup; process.wait confirms exit and output closure. Lost facts/cleanup failure close admission and return CLEANUP_FAILED while UNKNOWN retains quota.

stdin accepts 1–65536 raw bytes per write. resize dimensions are 1–65535. closeStdin closes pipe FDs or sends canonical PTY VEOF; raw PTYs reject it. Empty writes are not EOF. owner.revoke permanently closes the current generation and revokes descendants; each Scope still needs waitClosed.

## Files

fs.execute is available only with a trusted helper. command.kind selects:

| kind | Other fields | Result fields |
|---|---|---|
| read | `path,offset?=0,maxBytes` | `dataBase64,sha256,size,nextOffset,eof` |
| stat | `path` | `kind,size` |
| list | `path,after?,limit` | `entries,nextCursor` |
| write | `path,dataBase64,expected` | `sha256,size` |
| applyPatch | `path,oldText,newText,expectedSha256` | `sha256,size` |

expected is `{kind:"absent"}` or `{kind:"sha256",value:"digest"}`. read sha256 always covers the complete file; offsets are bytes. Files are limited to 8 MiB, reads/writes to 64 KiB, and combined patch old/new text to 64 KiB with a nonempty unique match. Stale digests, existing create targets and ambiguous patches return CONFLICT.

list pages have at most 256 entries/about 32 KiB, scanning at most 4096 UTF-8 names. Directory pagination is not a snapshot. Helpers use directory descriptors and NOFOLLOW; ordinary reads/writes reject symlinks, hardlinks and special files, with fsync for conditional replacement.

By default helpers coordinate by file and commands by write root (writeSerialization=conflictingPaths). Explicit command bypass uses filePaths. External processes do not participate; external CAS/cross-file transactions are not guaranteed. Lost helper results or cleanup failure after commit become UNKNOWN without replay.

Errors include INVALID_REQUEST, INVALID_ARGUMENT, UNAUTHENTICATED, PERMISSION_DENIED, SCOPE_CLOSED, STALE_HANDLE, NOT_FOUND, CONFLICT, RESOURCE_EXHAUSTED, UNSUPPORTED, UNAVAILABLE and CLEANUP_FAILED. signal is a POSIX number string. sandboxDenied=false does not prove no sandbox denial occurred.
