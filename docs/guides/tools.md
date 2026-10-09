**中文** | [English](tools.en.md)

# 工具与 hooks

Core 注册表将名称、JSON Schema 与内置/命令/客户端/MCP/插件后端绑定。输入与输出由 Core 校验；本地执行交给 Runtime。完整模型工具 schema 位于 [tools.rs](../../core/engine/src/tools.rs)。

本地默认 YOLO；文件工具与命令 cwd 接受工作区外绝对路径，Core 规范化为 `workspace://host`，Runtime full-access 才允许。相对路径仍从工作区解析，argv 中使用普通文件路径。ASK_PERMISSIONS 在执行前审批实际参数，见[权限配置](configuration.md#permissions)。launcher 自动提供每 Thread scratch；隔离 Workgroup 使用其工作区内的私有 `.scratch/agent-<threadId>`，其 Scope 边界继续有效。

`run_command` 的 `oneOf` 使用两个完整对象分支，分别声明 `command` 或 `argv` 入口及公共选项，以兼容要求完整分支的模型端点；两个分支同步包含 Runtime 的期限上限。调用参数不变，Core 仍拒绝同时提供或同时省略两个入口。

| 工具 | 关键参数与边界 |
|---|---|
| `read_file` | `path,offset?=1,limit?=120`；UTF-8 行、行号、nextLine/eof、完整摘要与 fileVersion；最多 1000 行、约 14 KiB |
| `search_files` | `pattern,path?=".",glob?,context?=2,limit?=50`；rg 正则，context ≤10、limit ≤100；遵循 gitignore，不跟随符号链接 |
| `image_read` | `path,maxDimension?=2048,crop?,frameIndex?/timeMs?`；PNG/JPEG/WebP/GIF，最多 8 MiB/32 MP；仅缩小，返回真实 Core Blob 图像 |
| `fs_read/list/stat` | 相对路径或 workspace URI；read offset 默认 0、maxBytes 默认/上限 8192，返回完整摘要与版本；list 默认 limit=100、最多 256 |
| `fs_create` | `path,text`，只创建不存在的文件 |
| `fs_write` | `path,text,fileVersion?/expectedSha256?`；省略版本使用本 Turn 最近观察，未观察时仅新建 |
| `fs_apply_patches` | `path,patches[1..32],fileVersion?/expectedSha256?`；一次 CAS 原子应用多个唯一文本替换，任一失败则不写入 |
| `run_command` | `command` 或 `argv` 二选一；前者经 `/bin/bash -o pipefail -c`，后者直接执行；cwd 默认 `.` |
| `verify_command` | `argv,cwd?,timeoutMs?,yieldMs?`；直接执行、拒绝 shell 入口，必须配置独立 scratch |
| `read_process/write_process/terminate_process` | 本 Turn 进程句柄；续读、输入与终止 |
| `read_history` | `itemId?,before?,limit?=8,after?,maxBytes?=8192`；按新到旧分页（1–16），nextBefore 续页；指定 itemId 后以 nextCursor 回取原始 JSON |
| `read_tool_result` | `resultId,after?=null,maxBytes?=8192`；读取本 Thread 历史调用的原始 JSON，按 nextCursor 续页，不执行原工具 |
| `task_state` | `{pendingAfter?}`；返回有界的已观察文件/进程/子任务/scratch 与 summaryThroughItemId，不进行实时探测 |

文件最大 8 MiB，单次写/patch 64 KiB，另受每个调用参数 64 KiB 预算限制。显式 fileVersion 和 expectedSha256 互斥；SHA 为 null 表示仅新建。成功编辑返回新版本与规范路径，shell/外部编辑不自动刷新观察，CAS 冲突后需重新读取。行过长或遇到非 UTF-8 二进制内容时使用 fs_read；PNG/JPEG/WebP 图像使用 image_read。read 通过 Python、search 通过内置 Rust 搜索助手在同一 Scope 中执行、最长 15 秒；Linux 从可信宿主 PATH 查找并解析可执行 Python 3，macOS 使用受支持的系统 Python；没有解释器时仅 read_file 不可用，启动服务不受影响。受限 Scope 仍要求解释器位于 Runtime 允许的系统路径中，不自动扩大沙箱权限。搜索库编译进 Runtime 文件助手，使用 Runtime 提供的助手绝对路径，不读取宿主 rg 配置或工作区外 ignore。

完整响应中的调用依次执行；每响应默认 128 次资源保护与显式 Turn 剩余预算取较小值。两种协议均有 4 MiB 工具缓冲；编号非法或超限时，该响应的所有调用都不执行。文本结果页仍最多 16 KiB。`remainingToolCalls` 在无累计预算时为 null，否则为整数，压缩不重置计数；有限剩余额度 ≤32 时提示收尾。`max_output_bytes` 默认无限，显式有限预算不足以执行下一工具时保留已确认结果并要求未完成交接。独立的 `max_response_bytes` 默认限制单响应 4 MiB，包含推理/provider context/媒体。已知参数与工具失败返回模型处理，UNKNOWN 停止执行。

`image_read` 也支持 GIF：省略 `frameIndex` / `timeMs` 时，确定性抽取首、中、尾帧并按动画顺序返回；这不是全动画覆盖。指定零基 `frameIndex` 或 `timeMs` 可查看被略过的瞬间，两者互斥。解码正确合成 disposal，报告帧数、总时长、帧起始时间与持续时间。单次最多扫描 4096 帧/512 Mi 像素的动画，解码内存预算 256 MiB；超限返回可恢复的工具错误。每个 PNG 视图最多 1 MiB，必要时继续等比缩小，返回原始/实际尺寸、原始 SHA、裁剪区域、派生 Blob 与所用策略；原图不修改，细节可重新裁剪读取。

原生文件源上限仍为 8 MiB；更大文本应使用命令工具流式筛选并限制输出。按需加载不会消除历史累积，最终请求另受 `model.max_request_bytes` 约束，见[配置](configuration.md)。

`verify_command` 将完整输出（最多 64 MiB）及 receipt 写入 scratch/verification，记录退出状态、日志与执行前后源码指纹。指纹覆盖 Git 跟踪和未忽略文件，非 Git 目录使用排除依赖/构建/缓存的扫描；源码变化使验证过期。receipt 位于任务可写目录，不是对恶意任务的认证。收尾时未结束的验证进程需要续读终态或显式终止；普通后台 run_command 不受此约束，也不会唤醒已结束 Turn。

## 设计取舍

命令观察将执行、等待、显示和回读分开：`run_command`/`read_process` 只按 cursor 读取 Runtime 保留的事实，明确识别的测试命令仅折叠成功进度行，诊断和未知行原样保留，未知命令不猜格式。这个边界吸收了 Codex 的显式等待/输出上限和 Claude Code 的失败输出保留思路，同时避免把 RTK 的全局管道改写接入模型协议；RTK 的自动格式探测在 Karma 时间戳等普通日志上可能误判，因此解析器只接受命令 argv 的显式类型。

编辑统一使用 `fs_apply_patches`：单处替换传一个元素，多处替换传多个元素，保持 CAS 约束。Runtime 在一次条件写入中按顺序逐项验证，任一旧文本不唯一都不会产生部分写入；匹配失败会报告从 1 开始的替换序号及缺失/歧义原因。重复文本应包含函数等周边上下文。模型工具 `fs_apply_patch` 已移除；工具 allowlist、审批规则和 hook matcher 应改用 `fs_apply_patches`，参数改为 `patches: [{oldText,newText}]`。Runtime/SDK 的 `applyPatch` 保留为单元素兼容入口，复用 `applyPatches` 的实现。

## 等待与状态

命令 timeoutMs 默认 600000，受 Runtime 授权截断并返回 effectiveTimeoutMs。普通命令/续读默认等 120 秒，PTY 1 秒；`yieldMs` / `waitMs` 接受非负 u64，0 不等待新输出，但会在页上限内读完已保留的字节。等待不改变进程期限或持有模型许可，每次收集最多 `tools.policy.outputPageBytes`（默认 8192）字节；JSON 转义会占用模型结果预算，控制字符较多时实际页会自动缩小并通过 cursor 续读。Jest、Karma、Mocha、Cargo test、Pytest 和 Go test 的成功进度行可折叠，完整保留其他行和 stdout/stderr 边界；只在包含元数据的序列化结果更小时启用视图。未知命令、复合 shell 命令和丢失输出保持原样。无输出或早期输出默认都继续等待；显式设置 outputQuietMs>0 才按静默窗口提前返回，底层轮询每次最多 1 秒。

`returnReason` 为 completed、waitBudget、outputLimit、outputLoss 或 outputQuiet。`commandStatus` 为 running/succeeded/failed/terminated；`outputReadComplete` / `outputClosed` 表示生产者关闭且保留输出读完，`outputIntegrity` 为 retained/incomplete，`nextAction` 提示后续操作。completed 不代替退出码检查，gap/truncated 即使读完仍表示丢失。

read_process 省略 after 接续本 Turn 最近返回的游标，显式 null 从最早保留输出开始。`view="auto"` 默认折叠成功进度；`view="raw"` 返回原始页，续读时也须指定 raw。回看已提供 rawResult 的历史页使用 `read_tool_result`；仍在 Runtime 保留的进程输出可用 `after=null,view="raw"`；结束游标之后没有旧内容。短进程/游标/fileVersion 句柄绑定 Turn 和目标，Core 展开后仍执行 Runtime 权限检查；格式错误返回可恢复错误，不猜测句柄。最多缓存 128 个文件版本和每进程一个当前游标别名，旧显式游标会过期。`task_state` 的 observedOnly=true 表示历史观察，不能证明当前状态；压缩保留这些缓存，Turn 结束或重启即失效。

## 原文回取与结构视图

大文本/结构化结果和需要折叠的结果在模型投影前保存为 Blob。`rawResult.resultId` 对应本 Thread 的真实调用 item，`read_tool_result` 校验归属和摘要后分页返回原始 JSON；直接传 Blob hash 或其他 Thread 的 item 无效。跨任务共享应显式导出制品。若 Turn 使用工具 allowlist，需包含 read_tool_result；缺少时禁用依赖回取的投影，并明确原文不可用。回取不刷新当前文件版本、不重跑原工具及其 hooks；回取调用自身仍经过审批和匹配的 hooks，并消耗正常工具预算。

单次快照最多 8 MiB；不设隐式 Thread/Store 累计字节配额，仍受可用磁盘约束。活跃/可恢复历史引用跨重启保留，GC 按引用回收；旧记录无原文时返回 unavailable。存储失败或超限回退为有界结果，明确 `rawAvailable=false`，不会建议自动重跑有副作用的工具。进程快照只包含 Core 实际收到的页，不能恢复未读或已丢失字节；原来的 gap/truncated 状态仍有效。多模态沿用媒体引用及 16 KiB 混合结果封套上限。纯文本/结构化 MCP、命令结果最多接收 8 MiB；插件 SDK 结果限 96 KiB，仍受 128 KiB 传输帧约束。

回取 `maxBytes` 为 4–8192，默认 8192 原始 UTF-8 字节；转义和元数据可能使实际页更小。使用返回的 nextCursor 续页直到 eof。它读取历史快照；`read_process` 继续观察进程，受 Runtime 缓冲保留期约束。

扩展 JSON 的 `policy.resultViews` 支持 `mode: off|observe|on`，默认 observe，以及 `searchGroups`、`repeatLines` 两个独立开关（默认 true）。off 停用新增结构转换；observe 只计算候选；on 才发送通过门槛的候选。既有成功进度折叠和大结果回取不依赖这个开关。

```json
{"policy":{"resultViews":{"mode":"on","searchGroups":true,"repeatLines":true}}}
```

搜索视图 `search-groups-v1` 返回连续的 matchGroups，每组共享 path，rows 按 `[line,kind,text]` 保留全部已返回行和顺序；limited 仍要求缩小搜索。`repeat-lines-v1` 只处理已识别命令的完整输出，stdoutRuns/stderrRuns 的每项为 `[repeat,text]`，按顺序重复拼接即可还原；没有改写的流保留原字段。两者都做还原校验，完整表示至少减少 15% 且 256 字节、估算 token 不增加才启用。未知格式和无收益结果透传；不做抽样、源码删减或跨任务记忆学习。

已发送的视图随历史固定，配置变化不追溯重写。`execution.outputProjection` 记录字节、token 估算、转换原因及预处理耗时；`execution.resultSnapshot` 保存 Blob 引用。observe 指标不是实际 token 节省。compaction 保留原引用，并附最近 16 个快照的回取索引；更早引用仍可读取，但不保证摘要包含它们。

## 扩展配置

在用户 TOML 中设置 `[tools] extensions_file="tools.json"`，JSON 可包含 policy、tools、hooks、mcpServers、plugins、agents。文件限 1 MiB，启动时校验，不自动读取工作区配置。可运行的插件配置见 [tools.json](../../core/sdk-typescript/examples/tools.json)，MCP 见[专页](mcp.md)。

命令工具项为 `{definition:{name,description,inputSchema,outputSchema?},argv,timeoutMs}`；最多 128 个总工具，名称 1–64 ASCII 字母/数字/下划线/连字符，不能重名。schema 使用 Draft 2020-12，禁止外部 `$ref`，输入根为 object，不自动填 schema default。

命令在工作区根执行，从 stdin 读取一行参数 JSON，不等待 EOF；stdout 仅输出一个 [DynamicToolResponse](../api/core.md#dynamic-tools)，stderr 写诊断。退出 0 且 success=false 表示确定业务失败；非零、超时、截断或无效结果可能已有副作用，记 UNKNOWN 并停止。命令工具 stdout 最多 8 MiB、stderr 最多 16 KiB；hook stdout 仍最多 16 KiB。较大的文本/结构化结果使用上文快照投影。argv 不隐式经 shell 或展开变量。

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

## Task 通信与后台 worker

Goal/Task 中 ask_user_question 支持 mode=async；提问持久写入独立频道并立即返回，模型可继续其他工作。task_channel_read 查看消息，task_wait 在无其他工作时释放协调 Turn，task_spawn 创建跨协调 Turn 存活、共享 Goal 预算的 worker。普通 agent_spawn 仍属于父 Turn。headless 不等待用户或人工审批，但可等待 worker。参数、权限和生命周期见 [Task 契约](../api/tasks.md)。

### 验证回收与 Goal 收尾

`task_state` 接受可选 `pendingAfter`，并独立返回 `pendingVerifications: {count, items, nextAfter, guidance}`。每页最多 16 项、通常不超过 4096 字节；单项完整保留，避免截断不透明句柄。条目包含本 Turn 的可用 `processId`、最后观察的 `state`、`receiptPath` 和 `nextAction`。分页按别名排序，不受普通进程列表截断影响；传回 `nextAfter` 继续下一页，回收后重新读取第一页核对 count。该投影不实时探测进程。

异步 `verify_command` 必须通过原进程的 `read_process` 观察终态，或显式 `terminate_process` 并报告取消。文件收据读取及重跑命令不清除原进程的待观察记录；失败/取消的终态可结束等待，但不代表测试通过。完成门禁返回 `GOAL_COMPLETION_PENDING`，工具错误 details 包含 `pendingInputCount` 与首个 `pendingVerifications` 页面。

接受 complete/blocked 报告后，应输出无工具最终说明。Core 仍允许明确列出的观察和清理工具（含 `task_state`、`task_channel_read`）；其他调用在提交前返回带 `reason=goalReportPending`、工具名及允许清单的 `PERMISSION_DENIED`，写入正常工具轨迹，不升级为未分类 Turn 内部错误。blocked 可保留未回收验证作为未完成工作，不能据此声称 complete。预算耗尽、取消和其他基础设施错误保持原有终止语义。

### 无损文件行视图

`policy.resultViews.fileLines` 默认 true，独立于控制搜索/命令候选的 `mode`。read_file 的连续 `{number,text}` 行数组可表示为 `firstLine`、`lineCount`、`source`，保留全部源码和其余元数据；使用 `fileLines:false` 关闭。只接受可还原的连续行、原有行尾和已知行字段，至少节省 128 bytes。完整原文先写入受限快照；快照不可用或不能回取时透传原有有界表示。`read_tool_result` 读取原始 JSON；该视图不把历史 fileVersion 变成跨 Turn 的编辑权限。`execution.outputProjection.transform=file-lines-v1` 与 `reason=lossless` 记录实际应用，搜索/命令 observe 仍只观察对应候选。

`read_history` 只读取当前 Thread，压缩和重启后仍可使用。列表页返回 `{items:[{itemId,turnId,type,preview}],nextBefore,order:"newestFirst"}`；指定 itemId 后使用 read_tool_result 同样的字节分页封套（resultId 标识历史条目）。跨条目/Thread 游标会拒绝。返回的是已记录证据，不执行原工具、不授予权限。显式工具 allowlist 需要包含 read_history，才可访问归档用户输入和回执。
