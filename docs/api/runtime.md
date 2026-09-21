**中文** | [English](runtime.en.md)

# Runtime API：areal.runtime.v0

私有执行协议的类型见 [runtime/protocol](../../runtime/protocol/src/lib.rs)；部署见[Runtime 指南](../guides/runtime.md)。它不带 jsonrpc 字段，不是公共网络 JSON-RPC 服务。

## 握手与传输

UTF-8 JSONL 请求 `{id,method,params}`，响应回显 id 和 result/error，诊断写 stderr。id 为整数或 1–128 字节字符串，在途不得复用。一个 Runtime 仅服务一组继承管道，无重连/认领。

```json
{"id":1,"method":"connection.open","params":{"protocolVersion":"areal.runtime.v0"}}
```

握手返回 protocolVersion、connectionId、runtimeEpoch、rootScopeId、capabilities，版本必须精确匹配。初始化前其他方法 UNAUTHENTICATED。帧最多 128 KiB，规范载荷通常 64 KiB；fs.execute/process.write 编码后最多 124 KiB。

capabilities 描述实际 sandbox、rootNetwork、方法和 processLimits；不授予新权限。coreHostIsolated/processTreeCleanupVerified/directoryObjectIsolation/sandboxDenialAttribution 为 false。旧 Runtime 缺少 rootNetwork 时 Core 保守视为无网络。

## 方法

| 方法 | params |
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

最多 32 个长请求等待，撤销、终止和同步查询保留控制通道。connection.close 仅在清理确认后返回 closed=true，否则错误。Scope 状态 active/revoking/closed；操作 accepted/running/succeeded/failed/cancelled/unknown；进程 starting/running/exited/unknown。

## 权限与去重

路径使用未编码 `workspace://repo[/path]`，拒绝百分号、问号、井号、反斜线、NUL 和 . / .. 段。子根须在父授权内，写根在读根内；network=inherit 继承父策略，deny 后不能恢复。owner 仅归因。argv 为 1–256 项，环境白名单见[部署](../guides/runtime.md)。

配置独立 scratch 根后，文件与进程 cwd 可使用 `workspace://scratch[/path]`；未配置时拒绝。它与 repo 不重叠，根权限遵循 allow-write，子 Scope 仍只能收窄。目录身份检查、路径遍历和符号链接限制同样适用。Core 的短句柄在调用 Runtime 前解析，不改变 ProcessId、游标或 ExpectedFile wire 类型。

有副作用的方法使用 `${runtimeEpoch}:op:${UUID}` operationId。相同键和规范请求摘要共享同次操作，不同摘要 CONFLICT。记录保留至 epoch 结束，容量满拒绝；旧 epoch 为 STALE_HANDLE。进程 start 的 succeeded 仅表示获得句柄，不表示命令成功；丢失响应不能换新键重放。

默认每进程期限 30 秒，整个 Scope 后代累计 8 MiB 输出、4 个并发进程；连接保留 256 Scope/4096 操作。期限含写路径排队和启动，清理前不释放进程额度。部署可以配置，子 Scope 只能收窄。

## 输出与清理

output.read 的 maxBytes 为 1–65536，waitMs 为 0–1000，每页最多 128 chunks。响应 `{chunks,nextCursor,gap,truncated,closed}`；chunk 含 cursor/stream/dataBase64，stream 为 stdout/stderr/pty。UTF-8 可跨页切开，需持续解码。

gap 表示旧前缀淘汰；truncated 表示预算/故障丢失；closed 表示输出结束且本页读到末尾，不表示命令成功。保留窗口默认 64 KiB/1024 chunks。必须继续读取 cursor，不以未满页判 EOF。

revoke 先关闭后代准入再请求取消；waitClosed 只能在 revoke 后调用。terminate 的 accepted 不等于清理；process.wait 确认退出和输出关闭。事实丢失/清理失败封闭连接并返回 CLEANUP_FAILED，UNKNOWN 保留占额。

stdin 单次 1–65536 原始字节；resize 尺寸 1–65535。closeStdin 对 pipe 关闭 FD，对 canonical PTY 发送 VEOF，raw PTY 拒绝。空写不等于 EOF。owner.revoke 永久封闭当前 generation 并撤销后代，各 Scope 仍需 waitClosed。

## 文件

fs.execute 仅在配置可信 helper 时可用；command.kind：

| kind | 其他字段 | 结果字段 |
|---|---|---|
| read | `path,offset?=0,maxBytes` | `dataBase64,sha256,size,nextOffset,eof` |
| stat | `path` | `kind,size` |
| list | `path,after?,limit` | `entries,nextCursor` |
| write | `path,dataBase64,expected` | `sha256,size` |
| applyPatch | `path,oldText,newText,expectedSha256` | `sha256,size` |

expected 为 `{kind:"absent"}` 或 `{kind:"sha256",value:"digest"}`。read 的 sha256 总是完整文件摘要，offset 为字节；单文件最多 8 MiB，read/write 最多 64 KiB，patch 旧/新文本合计 64 KiB 且旧文本非空唯一匹配。陈旧摘要/已存在/歧义返回 CONFLICT。

list 每页最多 256 项/约 32 KiB，扫描最多 4096 UTF-8 名称；目录变化时不是快照。helper 使用目录描述符与 NOFOLLOW，普通读写拒绝符号链接、硬链接和特殊文件，条件替换 fsync。

默认 helper 按文件、命令按写根协调冲突（writeSerialization=conflictingPaths）；显式绕过命令协调为 filePaths。外部进程不参与，不保证外部 CAS/跨文件事务。helper 结果丢失或提交后清理失败为 UNKNOWN，不能重放。

错误包括 INVALID_REQUEST、INVALID_ARGUMENT、UNAUTHENTICATED、PERMISSION_DENIED、SCOPE_CLOSED、STALE_HANDLE、NOT_FOUND、CONFLICT、RESOURCE_EXHAUSTED、UNSUPPORTED、UNAVAILABLE、CLEANUP_FAILED。signal 为 POSIX 数字字符串；sandboxDenied=false 不能证明无沙箱拒绝。
