**中文** | [English](runtime.en.md)

# Runtime API：areal.runtime.v0

私有执行协议的类型见 [runtime/protocol](../../runtime/protocol/src/lib.rs)；部署见[Runtime 指南](../guides/runtime.md)。它不带 jsonrpc 字段，不是公共网络 JSON-RPC 服务。

## 握手与传输

UTF-8 JSONL 请求 `{id,method,params}`，响应回显 id 和 result/error，诊断写 stderr。id 为整数或 1–128 字节字符串，在途不得复用。一个 Runtime 仅服务一组继承管道，无重连/认领。

```json
{"id":1,"method":"connection.open","params":{"protocolVersion":"areal.runtime.v0"}}
```

握手返回 protocolVersion、connectionId、runtimeEpoch、rootScopeId、capabilities，版本必须精确匹配。初始化前其他方法 UNAUTHENTICATED。帧最多 128 KiB，规范载荷通常 64 KiB；fs.execute/process.write 编码后最多 124 KiB。

capabilities 描述实际 sandbox、fullAccess、rootNetwork、方法和 processLimits；不授予新权限。coreHostIsolated/processTreeCleanupVerified/directoryObjectIsolation/sandboxDenialAttribution 为 false。旧 Runtime 缺少 rootNetwork 时 Core 保守视为无网络。

标准部署的 capabilities.builtinTools.searchFiles 返回可信文件助手路径。Runtime 文件助手直接链接 ripgrep 搜索库，不读取宿主 rg 配置。Core 的 search_files 在现有 Runtime Scope 内调用该助手；旧外部 Runtime 未提供该能力时返回 UNSUPPORTED 并要求升级。

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

配置独立 scratch 根后，文件与进程 cwd 可使用 `workspace://scratch[/path]`；未配置时拒绝。它与 repo 不重叠，scratch 根可写且独立于 repo 的 allow-write，子 Scope 仍只能收窄。目录身份检查、路径遍历和符号链接限制同样适用。Core 的短句柄在调用 Runtime 前解析，不改变 ProcessId、游标或 ExpectedFile wire 类型。

`fullAccess=true` 时新增 `workspace://host[/绝对路径去掉前导斜线]`，根映射 `/`；普通部署拒绝此命名空间。Core 将工作区外绝对路径规范化为 host URI，文件助手继续拒绝符号链接遍历。只读/研究 Scope 不包含 host 根。

有副作用的方法使用 `${runtimeEpoch}:op:${UUID}` operationId。相同键和规范请求摘要共享同次操作，不同摘要 CONFLICT。记录保留至 epoch 结束，容量满拒绝；旧 epoch 为 STALE_HANDLE。进程 start 的 succeeded 仅表示获得句柄，不表示命令成功；丢失响应不能换新键重放。

默认每进程期限 30 秒，整个 Scope 后代累计 8 MiB 输出、4 个并发进程；连接保留 256 Scope/4096 操作。期限含写路径排队和启动，清理前不释放进程额度。部署可以配置，子 Scope 只能收窄。

Runtime daemon 可用 `--cumulative-output-bytes` 独立设置部署及 Scope 后代累计输出上限；省略时等于 `--output-bytes`，且不得小于单进程上限。进程仍受 `--output-bytes` 限制，输出窗口另由 `--output-window-bytes` 约束。stdout/stderr 的真实接受字节对每个祖先累计一次；重复读取保留输出不再收费。文件助手的 JSON/base64 响应也是进程输出。

## 输出与清理

output.read 的 maxBytes 为 1–65536，waitMs 为 0–1000，每页最多 128 chunks。响应 `{chunks,nextCursor,gap,truncated,closed}`；chunk 含 cursor/stream/dataBase64，stream 为 stdout/stderr/pty。UTF-8 可跨页切开，需持续解码。

gap 表示旧前缀淘汰；truncated 表示预算/故障丢失；closed 表示输出结束且本页读到末尾，不表示命令成功。保留窗口默认 64 KiB/1024 chunks。必须继续读取 cursor，不以未满页判 EOF。

revoke 先关闭后代准入再请求取消；waitClosed 只能在 revoke 后调用。terminate 的 accepted 不等于清理；process.wait 确认退出和输出关闭。事实丢失/清理失败封闭连接并返回 CLEANUP_FAILED，UNKNOWN 保留占额。

Linux native 每次执行由独立的可信 Rust 二进制 `areal-runtime-reaper` 托管；部署须将它与 Runtime 放在同一目录，并提供可读的 `/proc`。嵌入 `NativeBackend` 的宿主也须在宿主可执行文件旁部署该 helper。回收器不依赖 Python，项目 launcher 和自定义工具的解释器要求另行适用。helper 在启动命令前成为 subreaper，独占其子进程的 wait，持续回收被收养的孤儿。命令正常退出、取消或私有生命周期管道 EOF 时，它清退并回收该执行的残留后代，包括调用 `setsid` 改变进程组的后代。Runtime 只等待自己的 helper，实际命令退出状态与清理结果由私有回执传回；helper 退出本身不能替代该回执和输出关闭确认。

启动握手最多等待 3 秒；确认未创建命令且 helper 已回收的启动失败，只拒绝本次执行并释放登记。后端启动返回 `UNAVAILABLE` 或 `CLEANUP_FAILED` 时，Supervisor 将执行及操作保留为 UNKNOWN、封闭连接准入并保留占额，不能按确定未启动释放资源。已启动执行的清理超时会报告失败；helper 继续收养并等待尚未退出的后代，Runtime 保留其 waiter，不以强杀回收器替代回收完成。

macOS 保留进程组清理，并在执行期间使用 `libproc` 约每 10 ms 发现后代，最多跟踪 4096 个进程身份。已发现后代即使调用 `setsid` 或重新归属，仍按 PID 与启动时间核对后清退；确认这些身份消失后才完成输出收尾。发现、信号或退出观察失败会报告清理失败。它不具备 Linux subreaper 的收养能力：两次观察之间快速 fork、父进程退出和重新归属仍可能漏掉后代；身份检查与发信号也不是内核原子操作。该跟踪不提供任意进程树的完整清理保证，也不覆盖 Runtime 被强杀后的清理。

仍归属活着的中间父进程的 zombie，必须由该父进程 wait；helper 在父进程退出、后代被收养后才能代为回收。

此回收边界属于单次 Runtime 执行，不是 cgroup 资源隔离，不覆盖 Core、MCP、插件 Host、Studio 自行启动的进程或主机上已有的 zombie。它依赖可信 helper 存活并持有子进程归属；恶意同 UID 的 full-access 代码或外部 `SIGKILL` 终止 helper 时，后代仍可能交给外层 init，外层部署必须自行回收。因此 `processTreeCleanupVerified` 保持 false，不能据单次清理成功宣称任意逃逸或宿主故障下的全树回收保证。

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
| applyPatches | `path,patches[{oldText,newText}],expectedSha256` | `sha256,size` |

expected 为 `{kind:"absent"}` 或 `{kind:"sha256",value:"digest"}`。read 的 sha256 总是完整文件摘要，offset 为字节；单文件最多 8 MiB，read/write 最多 64 KiB，patch 旧/新文本合计 64 KiB 且旧文本非空唯一匹配。applyPatch 是保留的单条兼容入口，与单元素 applyPatches 共用实现。applyPatches 一次最多 32 个替换，所有替换均唯一匹配后才条件写入；陈旧摘要/已存在/歧义返回 CONFLICT。

list 每页最多 256 项/约 32 KiB，扫描最多 4096 UTF-8 名称；目录变化时不是快照。helper 使用目录描述符与 NOFOLLOW，普通读写拒绝符号链接、硬链接和特殊文件，条件替换 fsync。

默认 helper 按文件、命令按写根协调冲突（writeSerialization=conflictingPaths）；显式绕过命令协调为 filePaths。外部进程不参与，不保证外部 CAS/跨文件事务。helper 结果丢失或提交后清理失败为 UNKNOWN，不能重放。

错误包括 INVALID_REQUEST、INVALID_ARGUMENT、UNAUTHENTICATED、PERMISSION_DENIED、SCOPE_CLOSED、STALE_HANDLE、NOT_FOUND、CONFLICT、RESOURCE_EXHAUSTED、UNSUPPORTED、UNAVAILABLE、CLEANUP_FAILED。signal 为 POSIX 数字字符串；sandboxDenied=false 不能证明无沙箱拒绝。

内置工具相对 Runtime 可执行文件定位：开发构建在 `target/<profile>/tools/`，发行包在 `libexec/areal/tools/`；与公开的 `bin/areal` 分开。

可信 launcher 和 Runtime daemon 可重复传入 `--read-only-path <规范绝对目录>`，最多 16 个。目录必须严格位于既有可读根内，不增加读取权限；公开请求/子 Scope 不能取消保护。Runtime 拒绝其文件写入并固定目录身份；OS 后端保护子树以及祖先删除/重命名，Linux 使用只读挂载与 seccomp，macOS 使用 Seatbelt deny。`full-access` 有此约束时也执行沙箱，不回退为裸命令。只读输入与其他可写 scratch 文件可共存；候选文件的原有权限/链接限制继续适用。这保护命令及 Runtime 文件操作，不约束可信宿主上的外部修改；结束时仍应校验输入摘要。
