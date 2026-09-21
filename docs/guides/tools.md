**中文** | [English](tools.en.md)

# 工具与 hooks

Core 注册表将名称、JSON Schema 与内置/命令/客户端/MCP/插件后端绑定。输入与输出由 Core 校验；本地执行交给 Runtime。完整模型工具 schema 位于 [tools.rs](../../core/engine/src/tools.rs)。

| 工具 | 关键参数与边界 |
|---|---|
| `read_file` | `path,offset?=1,limit?=120`；UTF-8 行、行号、nextLine/eof、完整摘要与 fileVersion；最多 1000 行、约 14 KiB |
| `search_files` | `pattern,path?=".",glob?,context?=2,limit?=50`；rg 正则，context ≤10、limit ≤100；遵循 gitignore，不跟随符号链接 |
| `image_read` | `path,maxDimension?=2048,crop?`；PNG/JPEG/WebP，最多 8 MiB/32 MP；仅缩小，返回真实 Core Blob 图像 |
| `fs_read/list/stat` | 相对路径或 workspace URI；read offset 默认 0、maxBytes 默认/上限 8192，返回完整摘要与版本；list 默认 limit=100、最多 256 |
| `fs_create` | `path,text`，只创建不存在的文件 |
| `fs_write` | `path,text,fileVersion?/expectedSha256?`；省略版本使用本 Turn 最近观察，未观察时仅新建 |
| `fs_apply_patch` | `path,oldText,newText,fileVersion?/expectedSha256?`；旧文本非空且唯一匹配 |
| `run_command` | `command` 或 `argv` 二选一；前者经 `/bin/bash -o pipefail -c`，后者直接执行；cwd 默认 `.` |
| `verify_command` | `argv,cwd?,timeoutMs?,yieldMs?`；直接执行、拒绝 shell 入口，必须配置独立 scratch |
| `read_process/write_process/terminate_process` | 本 Turn 进程句柄；续读、输入与终止 |
| `task_state` | `{}`；返回有界的已观察文件/进程/子任务/scratch 与 summaryThroughItemId，不进行实时探测 |

文件最大 8 MiB，单次写/patch 64 KiB，另受工具参数 64 KiB 总预算限制。显式 fileVersion 和 expectedSha256 互斥；SHA 为 null 表示仅新建。成功编辑返回新版本与规范路径，shell/外部编辑不自动刷新观察，CAS 冲突后需重新读取。行过长时使用 fs_read。read/search 通过同一 Scope 中的 Python/rg 执行、最长 15 秒；需要 `/usr/bin/python3` 和 PATH 中的 rg，不自动扩大沙箱权限。

每个完整模型响应最多 16 个调用，依次执行；工具结果最多 16 KiB，参数错误和已知命令失败返回模型处理，UNKNOWN 停止。结果报告 remainingToolCalls，剩余 ≤32 时提示收尾。

`verify_command` 将完整输出（最多 64 MiB）及 receipt 写入 scratch/verification，记录退出状态、日志与执行前后源码指纹。指纹覆盖 Git 跟踪和未忽略文件，非 Git 目录使用排除依赖/构建/缓存的扫描；源码变化使验证过期。receipt 位于任务可写目录，不是对恶意任务的认证。收尾时未结束的验证进程需要续读终态或显式终止；普通后台 run_command 不受此约束，也不会唤醒已结束 Turn。

## 等待与状态

命令 timeoutMs 默认 600000，受 Runtime 授权截断并返回 effectiveTimeoutMs。普通命令/续读默认等 120 秒，PTY 1 秒；`yieldMs` / `waitMs` 接受非负 u64，0 立即返回。等待不改变进程期限或持有模型许可，每次收集最多 2 KiB。无输出时继续等待；已收到输出后按 100 ms 静默合并，底层轮询每次最多 1 秒。

`returnReason` 为 completed、waitBudget、outputLimit、outputLoss 或 outputQuiet。`commandStatus` 为 running/succeeded/failed/terminated；`outputReadComplete` / `outputClosed` 表示生产者关闭且保留输出读完，`outputIntegrity` 为 retained/incomplete，`nextAction` 提示后续操作。completed 不代替退出码检查，gap/truncated 即使读完仍表示丢失。

read_process 省略 after 接续本 Turn 最近返回的游标，显式 null 从最早保留输出开始。短进程/游标/fileVersion 句柄绑定 Turn 和目标，Core 展开后仍执行 Runtime 权限检查；格式错误返回可恢复错误，不猜测句柄。最多缓存 128 个文件版本和每进程一个当前游标别名，旧显式游标会过期。`task_state` 的 observedOnly=true 表示历史观察，不能证明当前状态；压缩保留这些缓存，Turn 结束或重启即失效。

## 扩展配置

在用户 TOML 中设置 `[tools] extensions_file="tools.json"`，JSON 可包含 policy、tools、hooks、mcpServers、plugins、agents。文件限 1 MiB，启动时校验，不自动读取工作区配置。可运行的插件配置见 [tools.json](../../core/sdk-typescript/examples/tools.json)，MCP 见[专页](mcp.md)。

命令工具项为 `{definition:{name,description,inputSchema,outputSchema?},argv,timeoutMs}`；最多 128 个总工具，名称 1–64 ASCII 字母/数字/下划线/连字符，不能重名。schema 使用 Draft 2020-12，禁止外部 `$ref`，输入根为 object，不自动填 schema default。

命令在工作区根执行，从 stdin 读取一行参数 JSON，不等待 EOF；stdout 仅输出一个 [DynamicToolResponse](../api/core.md#dynamic-tools)，stderr 写诊断。退出 0 且 success=false 表示确定业务失败；非零、超时、截断或无效结果可能已有副作用，记 UNKNOWN 并停止。stdout/stderr 各最多 16 KiB。argv 不隐式经 shell 或展开变量。

## Hooks

最多 64 个唯一名称，配置 `{name,event,matcher,argv,timeoutMs}`；matcher 为精确工具名或 `*`。按顺序运行，不递归。

| 事件 | 响应 |
|---|---|
| PreToolUse | 输入校验后允许 allow/block 或 updatedArguments；改写后重验 |
| PostToolUse | 确定成功后仅 allow；不能改写结果或撤销副作用 |
| PostToolUseFailure | 确定失败后仅 allow；不自动重试 |

输入一行 `{event,threadId,turnId,callId,tool,arguments,result}`，stdout 对象可含 decision（默认 allow）、reason、updatedArguments。初始拒绝、pre 阻止和 UNKNOWN 不运行 post。主工具和 hook 分别 journal；post 崩溃不抹掉已确认的工具结果。检查 UNKNOWN 后通过 acknowledge 记录说明。

客户端工具宿主自行负责副作用；TUI/Web 不执行任意客户端回调。插件与 stdio MCP 的宿主信任边界见[插件](../design/plugins.md)和 [MCP](mcp.md)。

<a id="research-agents"></a>
## 可选研究 Agent

在 extensions JSON 中显式添加 agents，才以 `delegate_tasks/read_agent/cancel_agent` 替换默认模型 Agent 工具。默认关闭，不改变客户端 spawn_child RPC。

```json
{"agents":{"maxModelRequests":256,"maxToolCalls":512,"maxWorkerModelRequests":48,"maxWorkerToolCalls":96,"workerTimeoutSeconds":1200}}
```

需要 Runtime、独立 task scratch 及非零 max_children_per_turn/max_agent_depth。比如 model_concurrency=4、max_active_turns=4、max_children_per_turn=3、max_agent_depth=1。子任务数是父 Turn 的累计额度，结束不返还；Worker 不能再次委派。模型请求（含摘要/完成恢复）与工具预算在一个 Engine 生命周期内共享，另有 Worker 上限，重启重新计数；HTTP 内部重试沿用模型配置。它不是精确的全局 token 限额。

| 工具 | 契约 |
|---|---|
| `delegate_tasks` | `{tasks,wait?=false}`；1–3 个字符串或 `{prompt}`，每个 prompt ≤16000 字符；默认立即返回，显式 true 等整批终态 |
| `read_agent` | `{threadId,waitMs?=0}`；等待 0–60000 ms，返回当前有界报告 |
| `cancel_agent` | `{threadId}`；取消并等待资源结算；已结束任务可重复调用，不返还配额 |

启动返回 requested/started/allAccepted、reports[]、rejected[]、asynchronous，以及 advisory=true/sourceWriter=parent。部分准入失败仍保留全部已创建句柄，未启动项按输入索引解释；零准入失败。报告含实际 status、reportKind=final/partial/none、最多 3000 UTF-8 字节 report、截断标记、最多 512 字节 error.message 与 usage，子用量不重复计入父用量。只有 completed Turn 才有 final 报告。句柄仅能操作当前父 Turn 创建的子任务，不能跨 Turn/重启复用。父 Turn 完成时自动取消并等待所有未结束 Worker。

**兼容性：省略 wait 现在默认异步；依赖旧同步行为的调用方须传 wait=true。** Worker 失败交由父任务处理；清理或持久化无法确认仍使父任务失败。

父 Agent 是唯一源码写入者。Worker 使用同一模型配置、独立上下文与内置工具，只能写 `workspace://scratch/agent-<thread-id>`；命令 TMPDIR 与验证 receipt 使用该目录，Runtime Scope/OS 沙箱强制源码只读。不继承命令扩展、hooks、动态客户端工具、MCP 或插件。完整历史在独立 Thread，source=nativeResearchAgent 恢复相同权限；没有源码快照隔离或多写入者合并，父任务须核实报告及最终检查。

委派时机、数量和内容由模型决定，无固定阶段或 case ID 分支。未准入 Worker 的空 scratch 仅用 remove_dir 回滚；成功准入后的证据保留，由调用方采集/清理，取消只回收执行资源。通用、委派与压缩指令分别见 [instructions](../../core/engine/src/instructions.md)、[agent-instructions](../../core/engine/src/agent-instructions.md) 和 [summary-instructions](../../core/engine/src/summary-instructions.md)。
