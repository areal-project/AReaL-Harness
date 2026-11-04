**中文** | [English](tools.en.md)

# 工具与 hooks

Core 注册表将名称、JSON Schema 与内置/命令/客户端/MCP/插件后端绑定。输入与输出由 Core 校验；本地执行交给 Runtime。完整内置工具参数契约位于 [tools.rs](../../core/engine/src/tools.rs)，模型投影位于[注册表](../../core/engine/src/tools/registry.rs)。

本地默认 YOLO；文件工具与命令 cwd 接受工作区外绝对路径，Core 规范化为 `workspace://host`，Runtime full-access 才允许。相对路径仍从工作区解析，argv 中使用普通文件路径。ASK_PERMISSIONS 在执行前审批实际参数，见[权限配置](configuration.md#permissions)。launcher 自动提供每 Thread scratch；隔离 Workgroup 使用其工作区内的私有 `.scratch/agent-<threadId>`，其 Scope 边界继续有效。

模型请求同时带有实际 workspacePath、workspaceUri、commandCwd、scratchPath 和已探测的 restrictedScopes。`workspace://repo` 映射到实际工作区根，不是状态目录下的 repo 子目录；临时 scratch 不是交付目录。生成文件应从用户要求的最终位置重新打开，业务计算应使用独立预期或小样本核对；schema、退出码和内部加总一致各自只证明对应的局部约束。Scope 创建前的明确 UNSUPPORTED/权限拒绝作为未派发的工具失败返回，UNKNOWN 仍停止执行。

`read_file`、`search_files`、`image_read`、`fs_read`、`fs_list` 和 `fs_stat` 支持可选 `permissionRequest:{readRoots,justification}`。配置显式权限预设后，可为当前读取操作申请工作区外的具体读取根；只读请求不接受 `writeRoots` 或 `network`。审批通过后仍受部署和父权限上限约束，只作用于当前操作，不改变会话 base Scope，不自动重试失败调用。目录链接本身不授予权限。图片可直接从获批的原目录读取，经 Core 媒体投影进入视觉模型，无需先复制到临时目录。

运行上下文的 `temporaryDirectory` 是当前 Agent 的实际私有路径，`temporaryDirectoryUri` 是相同目录的规范 URI；`task_state` 也提供 `scratchUri`。使用返回的完整路径；`workspace://scratch/文件名` 不代表当前 Agent 的私有目录。

内置 `run_command` 向模型提供普通 object schema，描述中要求 `command` 或 `argv` 二选一，避免部分模型端点拒绝顶层 `oneOf`。Core 的执行校验仍保留完整 `oneOf` 契约，拒绝同时提供或同时省略两个入口；模型投影和执行校验均包含 Runtime 的期限上限。该投影只适用于内置命令工具，不修改外部工具的 schema。

| 工具 | 关键参数与边界 |
|---|---|
| `read_file` | `path,offset?=1,limit?=120,column?=1,expectedSha256?`；UTF-8 行或精确长行片段、nextLine/nextRead、完整摘要与 fileVersion；最多 1000 行、约 14 KiB |
| `search_files` | `pattern,path?=".",glob?,context?=2,limit?=50`；rg 正则，context ≤10、limit ≤100；遵循 gitignore，不跟随符号链接 |
| `image_read` | `path,maxDimension?=2048,maxViewBytes?=1048576,crop?,frameIndex?/timeMs?`；PNG/JPEG/WebP/GIF，最多 8 MiB/32 MP；仅缩小，返回真实 Core Blob 图像 |
| `fs_read/list/stat` | 相对路径或 workspace URI；read offset 默认 0、maxBytes 默认/上限 8192，返回完整摘要与版本；list 默认 limit=100、最多 256 |
| `fs_create` | `path,text`，只创建不存在的文件 |
| `fs_write` | `path,text,fileVersion?/expectedSha256?`；省略版本使用本 Turn 最近观察，未观察时仅新建 |
| `fs_apply_patches` | `path,patches[1..32],fileVersion?/expectedSha256?`；一次 CAS 原子应用多个唯一文本替换，任一失败则不写入 |
| `edit_files` | `files[1..16]`；每项 `{path,text}` 新建或 `{path,patches,fileVersion?/expectedSha256?}` 修改；复用上述原生合同，按序执行、首错停止，非跨文件原子事务 |
| `run_command` | `command` 或 `argv` 二选一；前者经 `/bin/bash -o pipefail -c`，后者直接执行；cwd 默认 `.` |
| `verify_command` | `argv,cwd?,timeoutMs?,yieldMs?`；直接执行、拒绝 shell 入口，必须配置独立 scratch |
| `read_process/write_process/terminate_process` | 本 Turn 进程句柄；续读、输入与终止 |
| `read_history` | `itemId?,before?,limit?=8,after?,maxBytes?=8192`；按新到旧分页（1–16），nextBefore 续页；指定 itemId 后以 nextCursor 回取原始 JSON |
| `read_conversation_context` | `threadId,cursor?,maxBytes?=8192`；按需读取本轮用户明确引用的同工作区主会话，预算为 1024–32768 bytes |
| `read_tool_result` | `resultId,after?=null,maxBytes?=8192`；读取本 Thread 历史调用的原始 JSON，按 nextCursor 续页，不执行原工具 |
| `task_state` | `{pendingAfter?}`；返回已观察文件/进程/子任务、workspacePath/workspaceUri/commandCwd/scratchPath 与 summaryThroughItemId；超大路径明确省略，不进行实时探测 |

文件最大 8 MiB，单次写/patch 64 KiB，另受每个调用参数 64 KiB 预算限制。显式 fileVersion 和 expectedSha256 互斥；SHA 为 null 表示仅新建。成功编辑返回新版本与规范路径，shell/外部编辑不自动刷新观察，CAS 冲突后需重新读取。非 UTF-8 二进制内容使用 fs_read；PNG/JPEG/WebP 图像使用 image_read。read 通过 Python、search 通过内置 Rust 搜索助手执行，最长 15 秒。Runtime 支持受限 Scope 时，原生导航复用当前 Turn 中继承原读取边界、无写权限且禁止网络的子 Scope，不占用后台命令的工作区写队列；取消、输出及进程额度仍归原父 Scope。未提供受限 Scope 能力的部署保留原执行方式，并记录 navigationInherited；创建受限 Scope 后的失败不会回退到更宽权限。文件版本观察与 CAS 不变；Linux 从可信宿主 PATH 查找并解析可执行 Python 3，macOS 使用受支持的系统 Python；没有解释器时仅 read_file 不可用，启动服务不受影响。受限 Scope 仍要求解释器位于 Runtime 允许的系统路径中，不自动扩大沙箱权限。搜索库编译进 Runtime 文件助手，使用 Runtime 提供的助手绝对路径，不读取宿主 rg 配置或工作区外 ignore。

完整响应中的调用依次执行；每响应默认 128 次资源保护与显式 Turn 剩余预算取较小值。两种协议均有 4 MiB 工具缓冲；编号非法或超限时，该响应的所有调用都不执行。文本结果页仍最多 16 KiB。`remainingToolCalls` 在无累计预算时为 null，否则为整数，压缩不重置计数；有限剩余额度 ≤32 时提示收尾。`max_output_bytes` 默认无限，显式有限预算不足以执行下一工具时保留已确认结果并要求未完成交接。独立的 `max_response_bytes` 默认限制单响应 4 MiB，包含推理/provider context/媒体。已知参数与工具失败返回模型处理，UNKNOWN 停止执行。

`image_read` 将显式裁剪、缩放与 GIF 采样请求交给 Runtime 文件助手，在已授权的读取边界内一次读取有界原图、预处理后再传输视图。原图不经过 Core，也不需要安装 Pillow 等依赖。`maxViewBytes` 可设为 4096–1048576，默认每幅 1 MiB，必要时等比缩小并报告实际尺寸。sourceBytes、sourceSha256、源/输出尺寸、runtimeOutputBytes 与派生 Blob 一起返回；实际派生响应（含 JSON/base64）继续消耗进程和祖先输出额度，预处理继续受进程时限、源大小、解码工作及内存边界约束。额度不足明确失败，不自动改请求重试或安装依赖；压缩原图很小时，派生 PNG 的传输计费可能更大，不承诺每张图都省字节。要求同版 Runtime 的 runtimeImageViewsV1 能力，旧 Runtime 返回 UNSUPPORTED，不回退到传输原图。

`image_read` 也支持 GIF：省略 `frameIndex` / `timeMs` 时，确定性抽取首、中、尾帧并按动画顺序返回；这不是全动画覆盖。指定零基 `frameIndex` 或 `timeMs` 可查看被略过的瞬间，两者互斥。解码正确合成 disposal，报告帧数、总时长、帧起始时间与持续时间。时间线扫描只读取最多 4096 帧的元数据；实际解码截至最后所选帧，按帧矩形累计最多 1 Gi 像素，避免为每帧重复物化完整画布。GIF 画布最多 16 MP，四个有界缓冲共用 256 MiB 工作预算；超限返回可恢复的工具错误，早期帧可独立读取。每个 PNG 视图最多 1 MiB，必要时继续等比缩小，返回原始/实际尺寸、原始 SHA、裁剪区域、派生 Blob 与所用策略；原图不修改，细节可重新裁剪读取。

原生文件源上限仍为 8 MiB；更大文本应使用命令工具流式筛选并限制输出。按需加载不会消除历史累积，最终请求另受 `model.max_request_bytes` 约束，见[配置](configuration.md)。


超长行（包括压缩为一行的 JSON）返回有界原文片段，行项带 `column`（从 1 开始的 Unicode 字符位置）及 `complete`。`nextRead` 包含 path/offset/column/expectedSha256，原样传给 read_file 续读；版本变化拒绝拼接。片段不是完整 JSON 值，不能把截断视为解析失败或文件末尾。普通行的 nextLine 行为保持不变；片段保留原结构，不套用 file-lines 无损行合并。

`verify_command` 将完整输出（最多 64 MiB）及 receipt 写入 scratch/verification，记录退出状态、日志与执行前后源码指纹。模型返回保留最多 8 KiB 原始日志尾部 `outputTail`，以 `outputTailStartByte` 和 `outputTailTruncated` 标明前部遗漏；显示预算不足时另记 `outputTailDisplayOmittedBytes`，完整日志仍通过 `logPath` 回取。尾部包含真实错误及验证结果，不以退出码替代必要诊断。指纹覆盖 Git 跟踪和未忽略文件，非 Git 目录使用排除依赖/构建/缓存的扫描；源码变化使验证过期。receipt 位于任务可写目录，不是对恶意任务的认证。Blender Python 验证必须在 `--python/-P/--python-expr` 前显式提供 `--python-exit-code 1..255`，缺失或无效时派发前拒绝，不自动改写 argv；receipt 的 `exitContract` 说明失败传播边界，不证明检查覆盖。其它解释器仍按实际退出状态记录。收尾时未结束的验证进程需要续读终态或显式终止；普通后台 run_command 不受此约束，也不会唤醒已结束 Turn。

macOS 的受限命令直接调用 `bash`/`sh` 时使用随 Runtime 发布的私有 Bash，here-document 使用独立 scratch；系统 Git 在沙箱前解析到可信工具链程序，默认不读取工作区外的系统/用户 Git 配置。源码写入、网络和外部临时文件权限仍由原 Scope 限制。嵌套硬编码 `/bin/bash` 或其 shebang 仍是系统旧 Bash，完整边界见 [Runtime 契约](../api/runtime.md#macos-受限命令的系统工具)。

## 按工作区选择可见工具

对以命令和文件产出为主的新建、独占工作区，可以使用现有 CLI 工具选择，显式提供一个较小的工具集：

```sh
areal exec --config ./config.toml --workspace ./artifact-workspace \
  --tools run_command,read_process,image_read,write_process,terminate_process,task_state,read_tool_result \
  '读取公开输入，创建所需制品，并检查实际结果。'
```

工具集合只改变模型可见能力，不扩大 Runtime 权限、预算或网络访问。模型仍自行选择步骤；一个命令可组合目录和多个文件的创建，`image_read` 仍用于观察实际图像，异步命令继续通过原进程句柄结算，原始结果可用 `read_tool_result` 回取。工具选择不会自动合并调用，也不会代替验证。

这不是通用默认配置。已有代码库的并发编辑或需要文件版本检查的任务，应保留原生文件读取与 CAS 编辑工具；依赖历史回取、浏览器、委派或扩展工具的任务，应显式包含相应能力。缩小工具集后的时延和质量需要在实际工作流中配对验证，不能仅凭 schema 更短判断效果。限定开发对照与未晋级候选见[建模工具集合对照](../benchmarks/reports/modeling-tool-surface.md)。

## 设计取舍

命令观察将执行、等待、显示和回读分开：`run_command`/`read_process` 只按 cursor 读取 Runtime 保留的事实，明确识别的测试命令仅折叠成功进度行，诊断和未知行原样保留，未知命令不猜格式。这个边界吸收了 Codex 的显式等待/输出上限和 Claude Code 的失败输出保留思路，同时避免把 RTK 的全局管道改写接入模型协议；RTK 的自动格式探测在 Karma 时间戳等普通日志上可能误判，因此解析器只接受命令 argv 的显式类型。

编辑统一使用 `fs_apply_patches`：单处替换传一个元素，多处替换传多个元素，保持 CAS 约束。Runtime 在一次条件写入中按顺序逐项验证，任一旧文本不唯一都不会产生部分写入；匹配失败会报告从 1 开始的替换序号及缺失/歧义原因。重复文本应包含函数等周边上下文。模型工具 `fs_apply_patch` 已移除；工具 allowlist、审批规则和 hook matcher 应改用 `fs_apply_patches`，参数改为 `patches: [{oldText,newText}]`。Runtime/SDK 的 `applyPatch` 保留为单元素兼容入口，复用 `applyPatches` 的实现。

## 等待与状态

`run_command` 的非 PTY stdin 默认关闭；显式 `stdinOpen:true` 保持管道以供后续写入，`stdinOpen:false` 明确关闭，PTY 行为不变。`write_process {processId,text?,close?}` 可写入非空文本、用 `close:true` 单独发送 EOF，或先写入再关闭；不能同时省略文本与关闭动作。不重启命令，仍要求当前 Turn 所有权和 Runtime 权限。`stdinMode` 报告 closed/pipe/pty；旧配置可显式选择默认开放管道，见配置指南。

命令 timeoutMs 默认 600000，受 Runtime 授权截断并返回 effectiveTimeoutMs。普通命令/续读默认等 120 秒，PTY 1 秒；`yieldMs` / `waitMs` 接受非负 u64，0 不等待新输出，但会在收集上限内读取已保留字节。等待不改变进程期限或持有模型许可；`tools.policy.outputPageBytes`（默认 8192）限制展示量和 raw 页，auto 的收集上限独立。JSON 转义也计入展示预算。Jest、Karma、Mocha、Cargo test、Pytest 和 Go test 的成功进度行可折叠，完整保留其他行和 stdout/stderr 边界；只在包含元数据的序列化结果更小时启用视图。未知命令和复合 shell 命令不做格式猜测；大结果仍有显式的有界预览，输出丢失不会被隐藏。无输出或早期输出默认都继续等待；显式设置 outputQuietMs>0 才按静默窗口提前返回，底层轮询每次最多 1 秒。

单独 EOF 使用该工具调用已持久化的 Runtime operation ID；写入后再关闭使用两个不同操作 ID，保留执行顺序，避免审计身份指向未执行的操作。

`returnReason` 为 completed、waitBudget、collectionLimit、outputLimit（raw 转义上限）、outputLoss 或 outputQuiet。`commandStatus` 为 running/succeeded/failed/terminated；`outputReadComplete` / `outputClosed` 表示生产者关闭且保留输出读完，`outputIntegrity` 为 retained/incomplete，`nextAction` 提示后续操作。completed 不代替退出码检查，gap/truncated 即使读完仍表示丢失。

`run_command` 与 `read_process` 保留 Runtime 的 `exitCode`、`signal`、`sandboxDenied` 和 `stopReason`。`signal` 为 POSIX 信号编号的十进制字符串（例如 `"9"`），正常退出时为 null；shell 返回 137 不会被推断为信号 9。信号本身不说明发送者，`sandboxDenied=false` 也不能证明没有沙箱拒绝；仅凭 SIGKILL 不能认定是超时、内存不足或系统安全软件终止。

默认 `auto` 在一次调用内有界收集最多 1 MiB、512 个含数据的 Runtime 页（空等待不消耗数据页限额），等待仍遵守显式预算、Turn 截止时间与取消；不会因 8 KiB 展示量已满而立即返回模型。`waitMs=0` 只排空当前保留输出。已退出进程仍可能 `outputReadComplete=false`；`processComplete`、输出读完与证据充分不是同一事实。完整已收集区间由现有工具结果快照保存，模型保留结构化状态和有界正文；遗漏量、原文引用、游标均显式返回，未识别正文仅作头尾预览，不声称语义总结。必要诊断可能位于遗漏范围，必须按判断需要回取，不能凭退出码或预览宣布验证通过。`raw` 保留旧的逐页读取契约。

read_process 省略 after 接续本 Turn 最近返回的游标，显式 null 从最早保留输出开始。`view="auto"` 默认折叠成功进度；`view="raw"` 返回原始页，续读时也须指定 raw。回看已提供 rawResult 的历史页使用 `read_tool_result`；仍在 Runtime 保留的进程输出可用 `after=null,view="raw"`；结束游标之后没有旧内容。短进程/游标/fileVersion 句柄绑定 Turn 和目标，Core 展开后仍执行 Runtime 权限检查；格式错误返回可恢复错误，不猜测句柄。最多缓存 128 个文件版本和每进程一个当前游标别名，旧显式游标会过期。`task_state` 的 observedOnly=true 表示历史观察，不能证明当前状态；压缩保留这些缓存，Turn 结束或重启即失效。

## 原文回取与结构视图

工具返回确定失败时，Core 检查本 Turn 内相同工具及完整 JSON 参数的既有失败；再次失败的对象结果附 `previousMatchingFailures` 与 `recoveryNote`。同一调用的成功、未知、取消或未完成记录中断计数；其他调用不参与计数。不跨 Turn 累积，也不把参数不同的调用合并。提示在执行后生成，不阻止调用、不自动重试，也不证明失败没有副作用。可见状态变化仍需模型核实，不能靠清空未获授权的字段来恢复。

大文本/结构化结果和需要折叠的结果在模型投影前保存为 Blob。`rawResult.resultId` 对应本 Thread 的真实调用 item，`read_tool_result` 校验归属和摘要后分页返回原始 JSON；直接传 Blob hash 或其他 Thread 的 item 无效。跨任务共享应显式导出制品。若 Turn 使用工具 allowlist，需包含 read_tool_result；缺少时禁用依赖回取的投影，并明确原文不可用。回取不刷新当前文件版本、不重跑原工具及其 hooks；回取调用自身仍经过审批和匹配的 hooks，并消耗正常工具预算。

单次快照最多 8 MiB；不设隐式 Thread/Store 累计字节配额，仍受可用磁盘约束。活跃/可恢复历史引用跨重启保留，GC 按引用回收；旧记录无原文时返回 unavailable。存储失败或超限回退为有界结果，明确 `rawAvailable=false`，不会建议自动重跑有副作用的工具。进程快照只包含 Core 实际收到的页，不能恢复未读或已丢失字节；原来的 gap/truncated 状态仍有效。多模态沿用媒体引用及 16 KiB 混合结果封套上限。纯文本/结构化 MCP、命令结果最多接收 8 MiB；插件 SDK 结果限 96 KiB，仍受 128 KiB 传输帧约束。

回取 `maxBytes` 为 4–8192，默认 8192 原始 UTF-8 字节；转义和元数据可能使实际页更小。使用返回的 nextCursor 续页直到 eof。它读取历史快照；`read_process` 继续观察进程，受 Runtime 缓冲保留期约束。

扩展 JSON 的 `policy.resultViews` 支持 `mode: off|observe|on`，默认 observe，以及 `searchGroups`、`repeatLines` 两个独立开关（默认 true）。off 停用新增结构转换；observe 计算候选并保留可用原文快照，但不为未变且未超限的结果增加 `rawResult` 包装；on 才发送通过门槛的候选。既有成功进度折叠和大结果回取不依赖这个开关。

```json
{"policy":{"resultViews":{"mode":"on","searchGroups":true,"repeatLines":true}}}
```

搜索视图 `search-groups-v1` 返回连续的 matchGroups，每组共享 path，rows 按 `[line,kind,text]` 保留全部已返回行和顺序；limited 仍要求缩小搜索。`repeat-lines-v1` 只处理已识别命令的完整输出，stdoutRuns/stderrRuns 的每项为 `[repeat,text]`，按顺序重复拼接即可还原；没有改写的流保留原字段。两者都做还原校验，候选的完整表示（含回取元数据）相对实际发送的基线至少减少 15% 且 256 字节、估算 token 不增加才启用；不能先扩大基线再计算节省。未知格式和无收益结果透传；不做抽样、源码删减或跨任务记忆学习。

已发送的视图随历史固定，配置变化不追溯重写。`execution.outputProjection` 记录字节、token 估算、转换原因及预处理耗时；`execution.resultSnapshot` 保存 Blob 引用。observe 指标不是实际 token 节省。compaction 保留原引用，并附最近 16 个快照的回取索引；更早引用仍可读取，但不保证摘要包含它们。

## 扩展配置

`task_state` 是 Core 诊断查询，不创建 Runtime Scope、不运行执行 hooks，也不占普通工具执行槽；明确的执行准入拒绝后仍可查询已知句柄和工作区事实。权限规则和所属会话校验继续有效。独立计算和最终交付核对的模型指导由显式 `limits.execution_tracking` 候选提供，默认关闭；任务收益需要单独验证。

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

普通 `agent_spawn` 的 `intent="inspect"` 是工作职责。默认额外强制源码只读；可信部署显式设置 `delegation.inspection_permissions="inherit"` 才继承父权限。工作区事实的 `inspectionPermissions` 与 `restrictedScopes` 分别表示策略和环境能力；不可用的 restrictedScopes 只阻止实际需要受限执行的子任务，父/Profile 已有只读不会被移除。继承模式下原生读取可并行，命令或外部副作用取得整 Turn 写租约；无法保证源码不可写。强制只读模式、旧 sharedReadOnly 和下述研究 Agent 继续要求 OS 隔离。详见[权限策略](configuration.md#分析子任务的权限策略)。

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

普通交互聊天的 `ask_user_question` 仅展示 `mode=wait`；`mode=async` 需要当前 Task/Goal 的持久频道，不会隐式创建 Task 或改成阻塞等待。

Goal/Task 中 ask_user_question 支持 mode=async；提问持久写入独立频道并立即返回，模型可继续其他工作。task_channel_read 查看消息，task_wait 在无其他工作时释放协调 Turn，task_spawn 创建跨协调 Turn 存活、共享 Goal 预算的 worker。普通 agent_spawn 仍属于父 Turn。headless 不等待用户或人工审批，但可等待 worker。参数、权限和生命周期见 [Task 契约](../api/tasks.md)。

### 验证回收与 Goal 收尾

`task_state` 接受可选 `pendingAfter`，并独立返回 `pendingVerifications: {count, items, nextAfter, guidance}`。每页最多 16 项、通常不超过 4096 字节；单项完整保留，避免截断不透明句柄。条目包含本 Turn 的可用 `processId`、最后观察的 `state`、`receiptPath` 和 `nextAction`。分页按别名排序，不受普通进程列表截断影响；传回 `nextAfter` 继续下一页，回收后重新读取第一页核对 count。该投影不实时探测进程。

异步 `verify_command` 必须通过原进程的 `read_process` 观察终态，或显式 `terminate_process` 并报告取消。文件收据读取及重跑命令不清除原进程的待观察记录；失败/取消的终态可结束等待，但不代表测试通过。完成门禁返回 `GOAL_COMPLETION_PENDING`，工具错误 details 包含 `pendingInputCount` 与首个 `pendingVerifications` 页面。

接受 complete/blocked 报告后，应输出无工具最终说明。Core 仍允许明确列出的观察和清理工具（含 `task_state`、`task_channel_read`）；其他调用在提交前返回带 `reason=goalReportPending`、工具名及允许清单的 `PERMISSION_DENIED`，写入正常工具轨迹，不升级为未分类 Turn 内部错误。blocked 可保留未回收验证作为未完成工作，不能据此声称 complete。预算耗尽、取消和其他基础设施错误保持原有终止语义。

### 无损文件行视图

`policy.resultViews.fileLines` 默认 true，独立于控制搜索/命令候选的 `mode`。read_file 的连续 `{number,text}` 行数组可表示为 `firstLine`、`lineCount`、`source`，保留全部源码和其余元数据；使用 `fileLines:false` 关闭。只接受可还原的连续行、原有行尾和已知行字段；计入回取元数据后的完整表示须比原结果节省超过 128 bytes，否则透传原结果并记录 `reason=noNetSaving`、`transform=none`。完整原文先写入受限快照；快照不可用或不能回取时透传原有有界表示。`read_tool_result` 读取原始 JSON；该视图不把历史 fileVersion 变成跨 Turn 的编辑权限。`execution.outputProjection.transform=file-lines-v1` 与 `reason=lossless` 记录实际应用，搜索/命令 observe 仍只观察对应候选。

`read_conversation_context` 只接受真实用户输入中目标为 `#sess_UUID` 的会话 Markdown 链接，`threadId` 使用原始 UUID，标题不参与寻址。每轮最多授权 32 个不同引用，steer 可加入引用，显式 Continue 从原始输入恢复授权。压缩与重启后仍读取权威原文，assistant、工具结果和摘要不能增加授权。拒绝当前会话、Side、worker、计划任务、其他工作区及不可用目标。Side 不能调用此工具。首次模型请求只增加含 ID 的轻量提醒，不加载被引用历史。返回 `{snapshotId,data,nextCursor,complete}`，完整 JSON 页受 maxBytes 限制；`item.type="historyDeferred"` 的条目通过 `item.cursor` 读取 UTF-8 分片，再用分片 `nextCursor` 续读，列表自身的 `nextCursor` 继续读取其他条目。游标绑定调用者 Thread、Turn 和目标。历史仅为资料，不授予执行权限；显式工具 allowlist 必须包含此工具。

`read_history` 只读取当前 Thread，压缩和重启后仍可使用。列表页返回 `{items:[{itemId,turnId,type,preview}],nextBefore,order:"newestFirst"}`；指定 itemId 后使用 read_tool_result 同样的字节分页封套（resultId 标识历史条目）。跨条目/Thread 游标会拒绝。`agent_read` 返回的 `sourceItemId` 与 `activity.lastTool.id` 属于子会话，不能传给父会话的 `read_history`；完整交接应通过 `agent_read` 的 offset/nextOffset 读取。返回的是已记录证据，不执行原工具、不授予权限。显式工具 allowlist 需要包含 read_history，才可访问归档用户输入和回执。

参考保留预算与连续失败硬上限属于默认关闭的实验策略；检查点回取及仍默认关闭非交互 stdin 的命令契约见[配置指南](configuration.md#参考保留与有界工具恢复)。原文回取、失败提示与 UNKNOWN 不重放不依赖这些实验开关。

## 关联文件编辑与环境事实

`edit_files` 不要求 JavaScript，保留全部旧文件入口。批量参数合计最多 64 KiB，路径规范化后不得重复；更新前必须观察文件，目录须已存在。形状和重复路径先校验，版本、权限、hooks 在各文件真正执行时校验，不承诺整批预检或回滚。每个文件消耗原生工具预算并持久化独立收据；Turn allowlist 必须同时允许容器及所用的 `fs_create/fs_apply_patches`。

结果包含 `allApplied` 和逐文件 `files`：`APPLIED` 表示已确认成功，`FAILED` 表示已确认调用失败，`UNKNOWN` 表示效果未确认（包括在途取消），`NOT_RUN` 表示未派发。`receipt` 保留原生状态、版本、`callId/itemId`，不重复 JSON 的 data/text。容器错误附 `error`；首错后续文件不执行。失败不回滚已完成文件，不自动重放；重启从持久收据恢复，只有 UNKNOWN 仍需检查。只有调用成功且 allApplied=true 时才顺接预先选定的验证。

每个 Turn 的指令快照记录 `workspaceRoot/sessionCwd/commandDefaultCwd` 与 `checkedFiles`，包括缺失、空内容和已加载文件的观察及摘要。只认证 root→cwd 链；目标子树的额外祖先仍需检查。路径、指令或作用域改变后重新发现；不据此扫描工作区外父目录。解释器和测试入口不由 Core 猜测或自动安装：使用同一命令环境的真实探测和项目声明，保留来源/版本；源码、环境或测试选择改变后，旧验证回执不再证明当前版本。

## 环境事实与重复观察候选

`environment_info({cwd?,executables?:[{name,kind}]})` 在工作区根及 cwd 检查固定公开声明（Python/Node 清单、测试配置、Makefile、锁文件），保留缺失、不可读和超大状态，不递归或执行配置。cwd 必须在工作区；每个声明最多 1 MiB，原文预览最多 1024 字符。默认从 PATH、VIRTUAL_ENV/CONDA_PREFIX、根/cwd 的 `.venv`/`venv` 及 PATH/CONDA_EXE 声明的 conda 清单发现解释器，不激活环境。只读 `conda env list --json` 最多读取 16 个环境，记录遗漏；相同目录的 Python 别名合并，不合并不同 venv。显式 executables 覆盖发现，空数组不探测。最多四个 Python/Node 解释器，每个最多 3 秒/64 KiB，整次发现 13 秒；超时/超量清理探测进程组并保留失败。Python 报告隔离模式下 pytest 的可发现性，不导入或执行测试。测试配置优先预览声明的测试章节并标记其他章节省略。复用 Runtime 导航 Scope；支持受限 Scope 时收窄为只读且禁网，不支持时保留父授权并记录 navigationInherited，不能把逻辑只读操作描述为 OS 隔离保证。记录实际解析路径、版本、prefix、库目录身份及环境摘要，环境变量值不返回。

事实绑定来源哈希、工作区/cwd、解释器身份与环境摘要；配置、声明、解释器、依赖或环境变化后重新确认。库目录身份不是完整依赖内容哈希，原地修改包后必须重新验证。当前 Turn 最多保留四组观察；`task_state` 只返回 cwd、指纹、失效条件和 `sourceItemId` 索引，使用 `read_history` 回取完整事实，避免重新携带声明原文；均为 observedOnly，重启/新 Turn 失效。没有自动安装、切换 shell、全盘扫描或自动选择测试。验证收据额外记录命令摘要、cwd、有效可执行文件及执行前后环境绑定；不会据历史通过省略新的验证。

`resultViews.repeatedObservations:true` 显式启用重复文件片段/环境事实投影。实际只读操作仍执行；仅完全相同内容且含回取引用后有净节省时折叠正文，保留本次 fileVersion、分页、遗漏、指纹及原文引用。首次观察及同一收据的重复投影不折叠；程序子调用的数据需要供代码消费，也不登记为模型已见观察。最多保留 128 个身份，压缩/新 Turn 清空。原文不可回取、失败或短结果不折叠；进程状态及错误不因相似日志被省略。
