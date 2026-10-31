**中文** | [English](tasks.en.md)

# Task Mode 与独立通信

本契约属于 `areal.core.v1`，面向 TUI、GUI、WebUI 和其他客户端。Rust 类型位于 [tasks.rs](../../core/protocol/src/tasks.rs)，请求、响应和通知的机器契约位于 [areal-core-v1.json](../../schemas/areal-core-v1.json)。先完成 [连接与认证](desktop.md)，再检查 `features.taskModes/taskChannels/asyncQuestions/headlessInteractions`；完整 Run 历史另检查 `features.taskRunHistory`。

## 所有权与模式

Task 持有任务身份、目标、调度、总 token 预算和一个持久 Channel；TaskRun 表示一次执行，关联一个 Goal 和协调 Thread。Goal 负责目标进展、执行预算和跨 Turn 续轮。Thread/Session 保存模型历史；关闭客户端不会删除 Task 或 Channel。Runtime 的进程仍沿用既有 Scope 和权限边界。

| mode | threadId | 默认 interactionMode | 触发方式 |
|---|---|---|---|
| foreground | 必填，根 Thread | interactive | 受理后排队启动 |
| scheduled | 必填，执行环境定位用的根 Thread | interactive | 在线桌面 Host 就绪后按 UTC 时间点触发，每次新建 Thread |
| background | 可省略；Core 创建协调 Thread | asynchronous | 受理后排队启动，worker 可使用独立 Session |

`areal/goal/create` 继续原子受理首轮，同时登记 foreground Task，响应增加 `taskId/runId`。`areal/task/create` 先持久受理 Task，执行异步调度；返回成功不表示模型已开始。已有 Goal、活动 Turn 或用户队列占用绑定 Thread 时，新的 TaskRun 等待准入。每个 Task 同时最多一个未结束 Run。

Task 身份不依赖客户端连接，通信不发往执行 Session。当前不支持运行中迁移协调 Thread、跨 Core 部署迁移或任意 mailbox 地址投递；后台 worker 拥有各自 Thread/Session。Inbox 汇总当前身份可访问任务的待回答问题，不保存第二份消息。

## 交互策略

| interactionMode | ask_user_question | 需要人工批准的工具 |
|---|---|---|
| interactive | 默认同步等待；模型可选 `mode="async"` | 沿用绑定 Turn 的审批 |
| asynchronous | 强制持久异步问题，立即返回 | 立即 PermissionDenied |
| headless | 立即返回 `status="unavailable", reason="headless", waiting=false`，不创建问题 | 立即 PermissionDenied |

headless 不等待用户、不自动批准操作；模型可以采用有依据的假设继续，或报告具体 blocker。已由有效策略批准的工具照常执行。background 拒绝 interactive 和依赖客户端动态工具回调的 Thread。scheduled 固定使用 interactive，由在线桌面 Host 提供当前配置和动态工具；已有 Runtime 和 Profile 权限仍然生效。

`GoalCreate.interactionMode` 和 `ClientOptions.interactionMode` 可设置策略；`areal/turn/start/enqueue` 的可选 `interactionMode` 覆盖本次提交，队列冻结该值，不修改 Thread 默认配置。TUI headless 和无双向应答通道的 Claude CLI 提交显式使用 headless；明确启用双向 stream-json 的 CLI 保留 interactive 宿主协议，dontAsk 仍为 headless。交互策略不能扩展工具权限。

模型工具：

| 工具 | 参数 | 行为 |
|---|---|---|
| ask_user_question | `questions, mode?: wait/async, required?: bool, timeoutSeconds?` | async 返回 taskId/runId/questionId，继续独立工作；interactive 的 wait 仍使用 interaction/respond |
| task_channel_read | `afterSequence?` | 读取当前 Task 的消息，身份由 Core 绑定 |
| task_wait | `{}` | 协调者主动结束当前 Turn，清理资源并释放容量；有效回复、问题过期或 worker 结算后继续 |
| task_spawn | `prompt, maxModelRounds?` | 创建 TaskRun 拥有的 worker，立即返回 threadId/turnId；结果写入 Channel |

提问本身不暂停执行。只有没有其他可推进工作时才使用 task_wait；必须先结算普通 Turn 子 agent 和待消费验证。无待回答问题或未完成 worker 时拒绝挂起；headless 仅可等待 worker。下一次模型请求包含有界频道上下文，必要时主动分页读取。回复不会打断已发出的模型请求，也不作为新用户 Turn 注入历史。

async 默认期限 86400 秒，允许 1–604800 秒；同步问题允许 1–3600 秒并受 Turn 期限约束。每批 1–8 题，题 ID 唯一，题目最多 4096 UTF-8 字节，每题最多 8 个选项、每项 1024 字节；整批参数中 questions 最多 32 KiB。`required=true` 阻止未过期、未回答问题存在时提交 Goal complete；过期后模型重新判断假设或 blocker。optional 问题不阻止完成，Run 终态会取消尚未回答的问题。

## 客户端 API

以下方法均省略 `areal/` 前缀。create/update/control/reply 需要 interact；其余需要 observe。修改的 requestId 是业务幂等键，与 RPC id 分开。同身份、方法、requestId 和相同参数的重试返回原始受理结果；不同参数冲突。去重先于 revision 检查，原始响应可能早于当前状态，随后读取最新投影。

| 方法 | 参数 | 响应 |
|---|---|---|
| task/create | `requestId, mode, objective, threadId?, sourceThreadId?, interactionMode?, schedule?, scheduleV2?, tokenBudget?, maxTurns?, maxActiveSeconds?` | Task 投影 |
| task/schedule/context | `timeZone` | `{coreNow,timeZone,localDate,localTime}` |
| task/schedule/preview | `schedule: ScheduleIntent, from?, count: 1..10` | `{coreNow,from,schedule,timeZone,occurrences,warnings}` |
| task/list | `after?, limit?` | `{data: Task[], nextCursor}` |
| task/read | `taskId` | Task 投影 |
| task/runs/list | `taskId, cursor?, limit?` | `{data: TaskRun[], nextCursor, hasMore, runCount}` |
| task/run/read | `taskId, runId` | 完整单条 TaskRun |
| task/update | `requestId, taskId, expectedRevision, objective?, schedule?, scheduleV2?` | 更新后的 Task 投影 |
| task/runNow | `requestId, taskId, expectedRevision` | `{taskId, runId, revision, accepted:true}` |
| task/pause, task/resume, task/cancel, task/delete | `requestId, taskId, expectedRevision` | 已持久受理控制意图的 Task 投影 |
| task/stopRun, task/resumeRun | `requestId, taskId, expectedRevision, expectedRunId` | 当前 Run 的停止／明确恢复意图，重复安排不变 |
| task/host/ready | `{}`；需要 unrestricted manage + tools | `{ready:true}`；登记当前连接作为桌面 Host |
| task/subscribe | `taskId` | 原子快照及后续 task/updated 通知 |
| task/unsubscribe | `taskId` | `{removed:true}`；不取消任务 |
| channel/read | `taskId, afterSequence?, limit?` | `{taskId, channelSequence, data, nextSequence, hasMore}` |
| channel/reply | `requestId, taskId, runId, questionId, answers` | `{accepted:true, messageId, taskId, runId, channelSequence}` |
| inbox/list | `after?, limit?` | `{data:[{taskId, objective, message}], nextCursor}` |

`task/pause` 还接受可选 `expectedRunId`，由 `features.taskPauseRunGuard` 声明。Core 查询收据后，在同一 Task 锁内将其与最新 Run 比较，并同时检查 `expectedRevision`；Run 缺失或变化返回冲突。resume/cancel/delete 不接受此字段。同参数已受理请求即使在版本/Run 改变或重启后仍返回原收据；同键更换 Run 返回冲突。省略字段保持旧调用与收据摘要兼容。对于 scheduled，pause 只暂停之后的触发；stopRun 才停止当前执行。执行停止仍以 Run 和 worker 结算为准。

Task 投影包括 `id, revision, channelSequence, owner, mode, interactionMode, objective, threadId, sourceThreadId?, deletedAt?, schedule, nextRunAt, paused, cancelled, tokenBudget, maxTurns, maxActiveSeconds, runs, runCount, archivedRunCount, runsComplete, skippedRuns, lastSkippedAt, pendingQuestions`；不内嵌 messages。每个 Run 包含 `id, threadId, goalId, status, reason, objective?, trigger, scheduledAt, startedAt, completedAt, usage, waitRequested, workers`。worker 包含 `threadId, turnId, status, settled`；status 为 running/completed/cancelled/failed。

Run status 为 `queued/running/waitingForInput/waitingForAgents/paused/blocked/completed/failed/cancelled`；后三项是终态。paused/cancelled 为 Task 控制意图，清理期间 Run 可能仍为 running。以 Run 终态及 worker.settled 判断执行结算，不以控制请求返回或协调 Turn completed 代替。

取消 Task 撤销后续调度并终止尚未结束的 Run；已经结束的 Run 保留原状态、完成时间和用量账本，重启后仍作为历史展示。

`task/delete` 使用相同的停止结算路径，同时持久保存 `deletedAt` UTC Unix 秒墓碑。墓碑设置 `cancelled=true` 和 `nextRunAt=null`，拒绝后续修改、开启和立即运行。返回成功只表示删除意图已受理。非终态 Run 或未结算 worker 存在时，客户端显示删除中并保留记录入口。Task、Channel、运行历史和原始收据不物理删除，墓碑仍计入 1024 个 Task 的容量。`task/list` 和 `task/read` 保留墓碑，活动目录可在执行全部结算后隐藏。首版没有恢复或永久清除命令。

`sourceThreadId` 与 `deletedAt` 为可选字段，旧快照缺省为无来源、未删除。版本 5 及之后的 Task 账本继续保存这些字段，无需迁移或猜测旧来源。旧版本即使忽略墓碑字段，仍受既有 `cancelled` 停止语义约束。来源 Thread 的删除或归档不取消 Task。

## 轻量目录与 owner 更新

可信、不受 Thread 范围限制的 Desktop 使用以下 observe 接口。它们不启动执行、不恢复 Run，也不替代修改操作前的完整 Task 读取。原有受限身份继续使用前述 Task API。

| 方法 | 参数 | 响应 |
|---|---|---|
| `task/directory/list` | `mode?, sourceThreadId?, cursor?, limit?` | `{generation, revision, data: TaskDirectoryRow[], nextCursor}` |
| `task/directory/read` | `taskIds`，最多 100 个 | `{generation, revision, data, removed}` |
| `task/attention/read` | `taskIds?, threadIds?, cursor?, limit?` | `{generation, revision, data: OwnerAttention[], nextCursor}` |
| `owner/watch` | `{}` | `{generation, sequence, directoryRevision, attentionRevision}`，原子登记接收器并取得基线边界 |
| `owner/unwatch` | `{}` | `{removed:true}`，仅停止本连接的 owner 观察 |

目录行只携带展示所需的规则、控制状态、下次时间、最后触发决定、计数，以及 `latestRun` 和 `activeRun` 小摘要。`objectivePreview/objectiveTruncated` 与 `reasonPreview/reasonTruncated` 显式表示展示截断。行不包含消息、完整 Run 历史或 worker 明细，不是完整 Task。详情、编辑和控制仍读取原 Task 与历史接口。`enabled` 是安排配置事实，`hasUnsettledWork` 表示仍有未结算工作，两者不能证明运行已经停止。`sourceThreadId` 仅筛选来源。

目录与 attention 的 limit 默认 30，接受 1–100，页面还受 128 KiB 字节上限约束。定向读取超出响应预算时应缩小 ID 集合，不返回部分结果冒充完整结果。目录游标绑定 generation、目录 revision 与筛选条件。attention 游标绑定独立的 attention revision 与查询条件，普通 Thread 消息不使其失效。分页期间版本改变返回 `DIRECTORY_CHANGED`，客户端保留上次完整结果并重新取第一页，不能拼接不同版本。定向目录读取通过 `removed` 明确报告应从缓存移除的 ID。定向 attention 的空结果清除该查询范围内旧的关注项。

每个连接只有一个 owner watch，替换旧 watch，不占用 Task/Thread 的 128 个订阅额度。`areal/owner/invalidated` 携带 `{generation,sequence,changedTasks,changedThreads,facts}`。sequence 在同一 generation 内连续。失效 ID 可以合并，completion、question 和 interaction 事实不能被合并丢弃。流序号不表示跨 Task 与 Thread 账本的原子事务。

客户端先登记 watch，再建立目录与 attention 基线，保留边界之后到达的事实和失效 ID。读取期间再次失效的 ID 必须重读。首次基线不通知历史记录，边界之后的事实按既有通知身份去重。`areal/owner/resetRequired {generation}`、断连、缺号或换代要求保留旧展示并重新建立基线，不承诺补发断线期间的历史通知。问题和交互期限使用最近到期点的一次性刷新，不进行周期性全量轮询。

## 普通会话中的定时工具

桌面普通可写 root Thread 可调用 `scheduled_task_list/create/update/control/receipt`。Core 要求来源绑定当前已注册的 Host 连接，同时校验身份和连接 ID。Side、子线程、后台 worker、Task 执行锚点和 Run Thread、只读或 Workflow 会话均不获得这些工具。冻结的 Turn 工具 allowlist 继续生效。工具不能通过已知 Task ID 操作其他来源会话的任务。

| 工具 | 参数 | 结果 |
|---|---|---|
| scheduled_task_list | `taskId?` | 当前来源会话的 `{tasks}`，包括墓碑 |
| scheduled_task_create | `objective, scheduleV2: ScheduleIntent` | `{task, receipt:{requestId,method}}` |
| scheduled_task_update | `taskId, expectedRevision, objective?, scheduleV2?` | 相同写入结果，省略字段保持原值 |
| scheduled_task_control | `taskId, expectedRevision, action, expectedRunId?` | action 为 pause、resume、runNow、delete 或 stopRun |
| scheduled_task_receipt | `requestId` | 当前 Host 身份和来源会话可见的 `{receipts,retention}` |

Core 从持久 Thread、Turn 和 tool-call ID 派生写入 requestId，模型不能指定。错误结果保留 `error.reason`、`error.outcome.kind` 与 `error.recovery`。revision 冲突返回 `REVISION_CONFLICT`，权限拒绝返回 `PERMISSION_DENIED`，存储结果不明返回 `UNKNOWN` 和原 requestId。UNKNOWN 后只核对原收据，不使用新的 tool-call ID 重发。空收据不证明未受理。

创建工具固定来源 Thread 和 cwd，另建执行锚点，并通过现有 `task_create` 提交。公开 `TaskCreate.sourceThreadId` 也要求真实普通来源、相同 cwd、同一已注册 Host 连接及单独锚点。完整 objective 保存执行方法、必要资料与输出要求，Run 不持续读取来源对话。每次 Run 仍使用独立 Thread 和当前默认模型，工作目录可能共享。

聊天任务卡绑定真实工具结果中的 Task 和回执。重载后读取当前 Task，历史成功事实与当前暂停、删除或不可达状态分别展示。右上角来源列表与全局中心读取同一 Core Task；暂停、开启、立即运行和删除通过直接命令执行，不依赖模型。旧 task-draft 管理会话仍可读取和管理历史任务。

ChannelMessage 包含 `id, sequence, runId, author, kind, status, createdAt, expiresAt, questions, required, inReplyTo, answers, text`。kind 为 question/reply/workerReport/report；问题 status 为 pending/answered/expired/cancelled，其他消息为 published。`questionId` 引用 question 消息的 id；answers 是题 ID 到答案字符串的映射，必须恰好覆盖全部问题，非自由文本题须选择给定选项，每个答案非空且最多 4096 字节。

问题必须属于指定 Task/Run，处于 pending 且未过期；已取消 Task、已完成/失败/预算停止 Goal 或已替换 Goal 拒绝新回复。暂停期间可接受有效回复，但不因此解除暂停。相同 requestId 的成功重试仍返回原收据。错误沿用 Core：`-32602` 参数非法、`-32009` 状态或 revision 冲突、`-32003` 权限不足、`-32004` 未找到、`-32001` 容量不足；存储错误以返回的实际 Core 错误为准。

## 独立 Inbox 与订阅

客户端可以在全局 Inbox 或 Task 详情页回答同一问题，无需打开协调 Thread。身份未限制 threadIds 时沿用部署共享工作区授权；受 threadIds 限制的身份必须同时获准访问安排定位 Thread 和所有 Run Thread；不能创建会生成新 Thread 的 scheduled Task，也不能创建/查看未绑定的后台 Task。订阅快照和通知重新检查可见性，新增未授权 Run Thread 后终止该订阅。owner 记录创建身份，不新增私人邮箱 ACL；不同可访问身份竞争回答时只有首个有效回复成功。

`areal/task/updated` 参数为 `{taskId, revision, channelSequence, runId, task}`。订阅不依赖 thread/resume；task/subscribe 在同一锁内取得快照并注册接收器，快照响应先于后续事件。Task 事件和 Thread 事件共用每连接 128 个订阅与有界发送队列；积压时关闭连接，客户端重连并重新取得快照。

客户端以 task/subscribe 快照替换任务状态，以通知中的 task 替换投影。channelSequence 增长时分页 channel/read，按 message.id **替换**记录；问题状态变化会获得新 sequence，同一问题可再次出现在增量页。只有处理完该页后才保存 nextSequence。游标不是 Turn ID、Task revision 或已读标记。频道分页是最新消息状态的增量视图，不是完整不可变事件日志；当前没有服务端已读回执。

limit 为 1–100，Task/Inbox 默认 30，Channel 默认 50；Task/Inbox 使用返回的 nextCursor，频道使用 nextSequence/hasMore。页面还有约 128 KiB 的字节上限，Task 单条投影可超过此值；不要假设一页必然达到 limit。Inbox 按需刷新 inbox/list；目前没有全局 Inbox 订阅。

## 立即运行已保存任务

`areal/task/runNow` 为定时 Task 受理一次真实手动执行。调用方需要 interact 权限、不受 Thread 范围限制的身份、仍受理工作的 Core，以及通过 `task/host/ready` 注册的在线桌面 Host。工作区继续共享，调用方不必是 Task 创建者。

Core 在同一次原子提交中保存 queued Run、冻结 objective 和原请求收据，之后才准备 Host。`accepted:true` 只确认持久受理；准备、凭据、模型和执行仍可能失败。准备失败将同一 Run 标为 blocked。`task/resumeRun` 使用原身份和预算继续这次执行。

手动执行不改变 `schedule`、`scheduleV2`、`lastTriggerDecision`、`nextRunAt`、`paused` 或 `skippedRuns`。暂停计划和自然完成的一次性计划允许手动执行，cancelled Task 拒绝。任意非终态 Run 都阻止新受理。重放收据和检查 Task 资格后，重叠请求先于普通 revision 检查返回 `-32009`，其 data 为 `{reason:"activeRun",taskId,runId,revision,outcome:{kind:"rejected"},recovery:{kind:"none"}}`。没有重叠时必须匹配当前 `expectedRevision`。修改和到期触发共用同一准入锁；到期触发输给 manual Run 时仍按原忙碌跳过策略推进。

`TaskRun.trigger` 为 `schedule` 或 `manual`，旧数据默认 `schedule`。manual 的 `scheduledAt` 是逻辑受理时间，客户端显示“手动触发”。Task 总用量包含热记录、已归档 Run 和预留 Token。总预算耗尽时仍可能受理 Run，但随后在 Goal 执行前 blocked。立即运行不增加额度或权限。

丢失响应后，使用完整原请求 `{requestId,taskId,expectedRevision}` 调用 `areal/request/read`。Task selector 不接受 `threadId` 或其他字段。Core 先检查当前 Task 可见性，再按原身份和摘要查询冷热收据。响应为 `{data:[{identity,requestId,method:"areal/task/runNow",digest,result}],retention:"taskLifetime"}`，result 是原始紧凑受理结果。没有收据时 data 为空，不能据此判断拒绝。同一身份和 requestId 改变参数会冲突。客户端在查到原收据前保留 UNKNOWN pending，不重放写请求，也不按 Run 数量猜测受理。既有 Thread 和部署请求查询保持原行为。

## 修改定时任务

`areal/task/update` 接收 `{requestId, taskId, expectedRevision, objective?, schedule?, scheduleV2?}`，至少提供一个修改字段。仅可修改未取消的 scheduled Task；旧 schedule 必须为未来 UTC 时间，间隔范围同创建。scheduleV2 的后续游标严格晚于本次 Core 时间；interval 保留原 anchorAt 并计算下一次未来时点。省略字段保持原值。接口沿用任务授权、持久幂等收据和版本冲突语义，返回完整任务投影并发出 `areal/task/updated`。

修改保留 Task、Thread、Run 历史、暂停状态与预算；新的时间替换后续 `nextRunAt`。已受理 Goal 继续使用原目标，其控制不会覆盖 Task 的新目标。新 Run 在受理时保存 objective 快照；等待 Host 准备期间也可修改安排，已受理内容不变。已结束的一次性任务可通过新的未来 schedule 再次安排。修改不立即执行任务，也不迁移工作区。客户端先检查 methods 是否包含 `areal/task/update`。

## 日历规则与预览

新计划使用 `scheduleV2`，与旧 `schedule` 互斥。输入、预览与创建/更新共用 `{version:1,rule,misfire,overlap:"skip"}`。misfire 为 `{kind:"coalesce"}` 或 `{kind:"skip",maxLatenessSeconds:0..86400}`。桌面默认显式保存 skip 300，并显示允许延迟。

rule 支持以下形状。

- `once` 为 `{kind:"once",at}`，UTC Unix 整数秒。
- `interval` 为 `{kind:"interval",anchorAt,intervalSeconds}`，间隔 1..31536000 秒。
- `calendar` 为 `{kind:"calendar",timeZone,frequency,interval,localTime,anchorDate,weekdays?,monthDays?}`。frequency 为 daily、weekly 或 monthly，interval 为 1..366。daily 不带选择数组；weekly 必须带互异 ISO 星期 1..7；monthly 必须带互异的 1..31 或 `"last"`。其他频率的字段会被拒绝。

日期严格为 1970..9999 年的 YYYY-MM-DD，localTime 为 HH:mm，时间戳范围为 0..253402300799。时区来自固定 chrono-tz 0.10.4 内置 IANA 数据，不读取宿主 zoneinfo。周规则以 anchorDate 所在周的周一对齐，月规则以其所在月对齐，并排除 anchorDate 之前的日期。不存在的月日期和 DST 跳时跳过；DST 重复当地时间只取较早 UTC 一次。31 与 last 落在同一天时仅运行一次。单次查找及一次到期范围最多检查 146097 个候选日或触发点，超限返回 SCHEDULE_EVALUATION_LIMIT，不提交部分游标。

管理会话可提交 `onceLocal` 或 `intervalLocal`，携带 `timeZone,localTime,date`，intervalLocal 另带 intervalSeconds。date 为 `{kind:"date",date:"YYYY-MM-DD"}`、`{kind:"relative",days:0..366}` 或 `{kind:"next"}`。calendar 输入可省略 anchorDate，Core 使用当地今天。next 最多寻找 370 个当地日，不取重复时段的第二次实例；明确日期的不存在当地时间返回错误。已有带偏移 ISO 消费者可用 `onceIso {atIso}` 或 `intervalIso {atIso,intervalSeconds}`，只接受带偏移、无小数的 RFC3339 秒精度时间。输出只保存 canonical once、interval 或完整 calendar。

context 和 preview 为 observe 操作。from 包含边界，省略时使用同一次捕获的 Core now。预览最多返回 count 个 `{at,localTime}`，同时返回 canonical schedule、时区与缺日期/DST 提示。预览仅用于展示；保存对原意图重新捕获 Core 时间，先按原意图摘要查询收据，再解析 relative/next，所以重试不会改变已受理计划。新 once/interval 创建保留给定时点或锚点，允许已到期；calendar 创建从 Core now 起选择首点。更新后的游标必须严格在未来。读取及重启不重新选择游标。

活动 Run、已受理的显式恢复意图和未结算 worker 优先记为 skippedOverlap。已停住的 paused/blocked Run 在下一次到期触发前可手动恢复；Host 就绪后的下一次触发会结束旧 Run，再按漏执行策略决定新 Run，不再永久跳过。正在恢复或未结算的工作不会被替换。空闲且 Host 不在时不推进。coalesce 受理最早待执行点的一次 Run。skip 延迟不超过窗口时受理最早点；超过窗口则跳过截至 now 的全部到期点，后续游标严格晚于 now。窗口 300 时，300 秒受理，301 秒跳过。错过一次性计划不伪造 Run。

Task 保存固定大小的 `lastTriggerDecision`，包含 sequence、decidedAt、planRevision、originalScheduledAt、dueThrough、dueCount、nextRunAt 和 outcome。outcome 为 admitted（带 runId）、skippedOverlap 或 missedWindow。skippedRuns 只累计重叠次数。新 Run 的 `acceptedSchedule` 保存受理时的规则、策略和 Task revision；自动 Run 另保存真实受理决策，manual 快照省略 decision；后续修改不会重写。客户端按该快照的时区显示历史。旧 Run 不补造快照。

## 定时、预算与恢复

schedule 为 `{at: UTC Unix秒, intervalSeconds?: 1..31536000, timeZone?: IANA 时区名}`；仅 scheduled 可指定。timeZone 保存客户端解释日期时的时区，不改变 UTC／固定间隔语义。省略 intervalSeconds 表示一次性；重复调度以 at 为锚点，服务恢复后错过的触发点合并为一次，与活动或未结算执行重叠时跳过本次触发，不创建重叠 Run。该旧字段始终表示固定秒数，不会因升级变为日历规则。不支持 cron、RRULE 或操作系统关机唤醒。Core 服务和已登记桌面 Host 必须保持在线。空闲且 Host 离线时保留最早待执行时间，恢复后按计划的漏执行策略处理；运行中断则保留原 Run／Thread且不记录完成时间，等待用户明确恢复。重连不会自动恢复中断的 Run；独立到期触发仍可开始新 Run。下一次到期触发前，显式 resumeRun 保留原 Run／Thread并创建新 Turn，旧交互答案仍被拒绝。后续触发替换旧 Run 后，其终态不可再恢复。

Task tokenBudget 覆盖所有 Run 的已确认和预留消费；maxTurns/maxActiveSeconds 分别限制每个 Run。沿用 Goal 的保守准入与未知消费处理。协调 Turn 和 detached worker 的活动时间取并集，重叠不重复计时；释放所有执行后等待用户的时间不计入。每个 worker 继承冻结配置、权限和同一 Goal 预算；最多使用部署 maxChildrenPerTurn 个 worker（按 Run 累计），maxModelRounds 默认取 16 与父上限的较小值，显式值不能超过父配置。交互式协调者的 worker 使用 asynchronous；headless 保持 headless。worker 不再递归创建 Task worker，也不能修改根 Goal；共享工作区写入仍须明确文件归属。

scheduled 的 pause/resume 只影响后续触发，不改变本次执行或 worker；stopRun 在原 Run 结算停止，不取消后续重复安排。resumeRun 必须提供最新 Run ID，保留其 Thread 和冻结配置，Host 就绪后重新检查权限及未知操作。审批默认等待 300 秒，超时后记录 approvalExpired，结束 Turn、释放资源并保留受阻 Run；继续会生成新的审批，过期批准无效。background/foreground 的 pause/resume 继续控制当前工作。cancel 撤销未来安排并停止本次工作；已完成历史不变。

每次新 Run 向经认证的在线 Host 请求 `areal/task/prepare {taskId,runId,threadId,scheduledAt,intent:"start"|"resume"}`。首次准备回复为 ThreadStart 的配置字段（model、agentProfile、parameters、dynamicTools）；Core 固定 cwd、受理键和新 Thread 身份。恢复回复不修改原配置。准备事实和 Thread 受理收据持久化，掉响应不以新键重放；迟到或旧连接回复不能启动执行。新版生效前已启动的定时 Run 按原规则结算，后续 Run 使用新会话与 Host 准入。

周期Task有Token总上限时，更新或恢复关联Goal还会扣除其他Run的已确认及预留消费，校验本轮额度不超过余额；不能将本轮额度改为无限。超限返回`TASK_TOKEN_BUDGET`（参数错误），不保存修改或恢复执行。当前没有修改周期Task总上限的公开接口；需要更多总额度时应明确创建新任务。

`desktop/task-mode.json` 是版本 6 的唯一提交根，引用 `desktop/task-ledger/` 中不可变的热 Task、历史分段与收据/归属索引。每部署仍最多 1024 Task，普通热状态总预算为 32 MiB；单个不可变文件的硬读取上限为 256 MiB。128 Run 和 1024 消息是热保留目标，完整历史和原始幂等响应保留在冷存储中，不因历史数量暂停周期任务。终态、用量已确认、无未知请求、worker 已结算且无待处理问题的 Run 才可归档；未知工具效果、审批或无法在有界检查中确认的 Thread 历史保留热态。常规保留每次最多检查 16 个 Thread 快照；引用超过 16 个 Thread 的 Run 会保持热态，直到启动时完整检查，因此仍可能占用普通热状态预算，默认 worker 上限为 64。普通增长满额时返回 `taskHotStateCapacity`，已受理工作的控制和有界终态结算可使用预留容量。物理写入或提交结果不明返回存储错误，并冻结 Task 写入与新派发；重启校验且同步已提交根与全部引用文件后才恢复。活动或挂起等待的 Run 在 Core 重启后暂停，显式 resumeRun（scheduled）或 resume 后才继续；尚未触发的 schedule 保留。恢复不自动重放未知工具副作用。`server/drain` 停止当前执行并关闭准入，但保留 scheduled 的启用状态；`server/status.activeTasks` 计入待执行时间点，ifIdle 不把它们视为空闲。

私有收据与归属索引使用 256 个桶头和完整 SHA-256 键的压缩 radix。单次查找最多访问 64 个节点，并在最多 64 行的有序终端叶中查找。分支文件读取前限制为 2 KiB，普通打包叶的序列化上限为 128 KiB；单个更大的历史响应可使用 256 MiB 文件上限。更新只重写终端叶与祖先路径。catalog 的 index_version 3 使用节点版本 2。未发布的实验性 index_version 2 会被拒绝，原根不会被替换；已部署的 Task store v1–5 保留完整原根字节与不可变引用文件后迁移。旧收据摘要、响应、nextRunAt 和旧 Run 事实不重算。旧二进制拒绝 v6 根；降级需要恢复完整升级前状态，不提供在线转换。

Thread 快照版本为 13，API 保持 areal.core.v1；旧 Thread/Goal 可读取，旧 Goal 在首次 resume 时补登记 Task。旧二进制不能读取新版本快照。嵌入式宿主在完成模型、工具装配后调用 `Engine::start_task_scheduler()`；app-server 自动调用。

## 请求示例

后台任务创建后，可直接订阅其 taskId：

```json
{"id":1,"method":"areal/task/create","params":{"requestId":"audit-1","mode":"background","objective":"检查模块并提供验证证据","interactionMode":"asynchronous","tokenBudget":200000,"maxTurns":20,"maxActiveSeconds":1800}}
```

```json
{"id":2,"method":"areal/task/subscribe","params":{"taskId":"<create 返回的 id>"}}
```

Inbox 获取的是原频道问题，回复引用其 runId 和 id：

```json
{"id":3,"method":"areal/inbox/list","params":{"limit":30}}
```

```json
{"id":4,"method":"areal/channel/reply","params":{"requestId":"answer-1","taskId":"<taskId>","runId":"<message.runId>","questionId":"<message.id>","answers":{"target":"B"}}}
```

前台 Goal 中模型选择异步提问：

```json
{"questions":[{"id":"target","title":"选择目标版本","options":["A","B"],"allowFreeText":false}],"mode":"async","required":true,"timeoutSeconds":3600}
```

定时请求示例：

```json
{"id":5,"method":"areal/task/create","params":{"requestId":"daily-1","mode":"scheduled","threadId":"<已有根 Thread>","objective":"检查新增失败并整理报告","schedule":{"at":2000000000,"intervalSeconds":86400},"interactionMode":"interactive","maxTurns":10,"maxActiveSeconds":600}}
```

Task worker 在调用方和父配置均未给出轮数时默认无限；显式限制仍继承并执行。部署 Goal 上限为 0 表示无限，不表示零调用额度。Task/Channel 记录容量仍属于独立服务资源限制。

Task 存储写入版本 6，迁移读取版本 1／2／3／4／5；原始旧文件字节备份保存在 `desktop/task-legacy/`。迁移先同步不可变文件，再原子替换原路径的版本 6 根，旧二进制拒绝读取。备份、复制与恢复必须包含根及其可达文件；孤儿文件不代表已受理操作，本阶段不自动回收。准备配置在 Goal 身份已持久绑定或 Run 终结后退出热状态。TaskWorker 保留旧 threadId/turnId，新增可选 execution/executionId，统一投影共享与隔离 worker。新模型入口为 agent_spawn；旧 task_spawn 兼容但不再展示。候选待交付不能完成 Run；没有活跃 Turn 时唤醒原协调者，不重复执行。

## 完整 Run 历史与容量诊断

Task 投影中的 `runs` 是热窗口。`runCount` 包含冷热 Run，`archivedRunCount` 表示已归档数量，`runsComplete=false` 要求客户端通过历史接口读取。`task/runs/list` 默认 30 条，允许 1–100 条，按 `(scheduledAt,id)` 从新到旧返回。游标绑定 Task、第一页的排序上界与最后一行，归档位置和重启不改变游标含义。`task/run/read` 返回原始 TaskRun；超过 128 KiB 响应预算的单条记录明确报容量错误。历史读取、Channel、列表和订阅使用同一捕获快照进行权限判断与投影，归档不扩大受限客户端的 Thread 权限。

Channel 只返回消息的最终状态，按 sequence 升序且每个 ID 一次。`nextSequence` 是最后实际返回的 sequence；状态更新留下的序号空洞不表示仍有下一页。单条消息超过响应预算时明确报错，不返回永远 `hasMore=true` 的空页。

容量错误使用现有 RPC 错误边界。`-32001` 的 `data` 为 `{reason:"taskHotStateCapacity",resource:"taskHotState",recovery:"settleOrCancelExistingWork",retryable:false}`。Task 写入失败及冻结后的 `-32603` 使用 `{reason:"taskStorageRecoveryRequired",resource:"taskStorage",recovery:"restartCore",retryable:false}`。存储失败后不伪造已持久化的磁盘故障状态。停止意图受理、worker 结算和 Run 终态仍是不同的观察结果。
