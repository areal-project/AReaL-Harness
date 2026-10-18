**中文** | [English](native-host.en.md)

# Native Host v2

显式可信的独立进程可用任意语言通过 UTF-8 JSONL 接入 Core，无需 DSH/SDK。Host 自身不在 OS 沙箱内；受管文件/进程通过 broker，不取得 Runtime 管道。

[机器 schema](../../schemas/native-host-v2.json) · [可运行 Host](../../examples/desktop-api/native-host.mjs)

配置位于 tools.extensions_file 的 plugins：trusted=true、argv、readRoots/writeRoots、timeoutMs；进程 broker 另需 allowProcess=true。首行握手 `{protocolVersion:2,tools:[{name,description,inputSchema,outputSchema?}]}`，最多 32 工具、10 秒；v1 仅文件服务。日志写 stderr，同 Host 串行。

v1/v2 Host 均自动继承标准代理环境，包含代理 URL 的认证信息；其他环境仍受白名单限制。此变更不改变消息协议，也不为 broker 命令增加环境变量。HTTP 库要求及完整继承边界见[插件边界](../design/plugins.md)与[代理配置](../guides/configuration.md#proxies)。

| 方向 | 消息 |
|---|---|
| Core → Host | `{type:"call",callId,params:{tool,arguments,...}}` |
| Host → Core | `{type:"file"或"process",callId,requestId,command}` |
| Core → Host | `{type:"fileResult"或"processResult",callId,requestId,result}`，失败为 error |
| Host → Core | `{type:"result",callId,response:{success,contentItems}}` |

requestId 是当前调用唯一整数，文件/进程共用最多 32 请求。Core 绑定 callId、generation、Scope 和 operationId，先记录意图再产生副作用；Host 不自报 owner。取消、超时、崩溃或协议失败关闭 generation，不确定结果 UNKNOWN。

文件 command.kind 为 stat/read/write，workspace URI，read 从 0 开始、最多 32768 字节；write 带 dataBase64 和 absent/sha256 条件，文件限 32 KiB。

进程 command.op 为 start/get/read/write/resize/closeStdin/terminate；start 接收 argv/cwd/tty/timeoutMs，其余需本次调用创建的 processId。禁止操作外国或上次调用句柄。只读 Profile 拒绝无法证明只读的 Host 工具。

有效参数、generation 和权限参与审批，批准不扩权。每次调用完成前关闭 Scope；常驻服务使用[共享进程 API](desktop.md)。返回结果校验 schema、大小、模态和 Blob 归属，成功嵌套写入在外层失败后仍保留。
