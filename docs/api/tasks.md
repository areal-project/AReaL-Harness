**中文** | [English](tasks.en.md)

# Task Mode 与独立通信

本契约属于 `areal.core.v1`，面向 TUI、GUI、WebUI 和其他客户端。Rust 类型位于 [tasks.rs](../../core/protocol/src/tasks.rs)，请求、响应和通知的机器契约位于 [areal-core-v1.json](../../schemas/areal-core-v1.json)。先完成 [连接与认证](desktop.md)，再检查 `features.taskModes/taskChannels/asyncQuestions/headlessInteractions`。

## 所有权与模式

Task 持有任务身份、目标、调度、总 token 预算和一个持久 Channel；TaskRun 表示一次执行，关联一个 Goal 和协调 Thread。Goal 负责目标进展、执行预算和跨 Turn 续轮。Thread/Session 保存模型历史；关闭客户端不会删除 Task 或 Channel。Runtime 的进程仍沿用既有 Scope 和权限边界。

| mode | threadId | 默认 interactionMode | 触发方式 |
|---|---|---|---|
| foreground | 必填，根 Thread | interactive | 受理后排队启动 |
| scheduled | 必填，根 Thread | headless | UTC 时间点，可按固定间隔重复 |
| background | 可省略；Core 创建协调 Thread | asynchronous | 受理后排队启动，worker 可使用独立 Session |

`areal/goal/create` 继续原子受理首轮，同时登记 foreground Task，响应增加 `taskId/runId`。`areal/task/create` 先持久受理 Task，执行异步调度；返回成功不表示模型已开始。已有 Goal、活动 Turn 或用户队列占用绑定 Thread 时，新的 TaskRun 等待准入。每个 Task 同时最多一个未结束 Run。

Task 身份不依赖客户端连接，通信不发往执行 Session。当前不支持运行中迁移协调 Thread、跨 Core 部署迁移或任意 mailbox 地址投递；后台 worker 拥有各自 Thread/Session。Inbox 汇总当前身份可访问任务的待回答问题，不保存第二份消息。

## 交互策略

| interactionMode | ask_user_question | 需要人工批准的工具 |
|---|---|---|
| interactive | 默认同步等待；模型可选 `mode="async"` | 沿用绑定 Turn 的审批 |
| asynchronous | 强制持久异步问题，立即返回 | 立即 PermissionDenied |
| headless | 立即返回 `status="unavailable", reason="headless", waiting=false`，不创建问题 | 立即 PermissionDenied |

headless 不等待用户、不自动批准操作；模型可以采用有依据的假设继续，或报告具体 blocker。已由有效策略批准的工具照常执行。scheduled/background 拒绝 interactive，也拒绝依赖客户端动态工具回调的 Thread。它们使用服务端持有的工具；已有 Runtime 和 Profile 权限仍然生效。

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
| task/create | `requestId, mode, objective, threadId?, interactionMode?, schedule?, tokenBudget?, maxTurns?, maxActiveSeconds?` | Task 投影 |
| task/list | `after?, limit?` | `{data: Task[], nextCursor}` |
| task/read | `taskId` | Task 投影 |
| task/update | `requestId, taskId, expectedRevision, objective?, schedule?` | 更新后的 Task 投影 |
| task/pause, task/resume, task/cancel | `requestId, taskId, expectedRevision` | 已持久受理控制意图的 Task 投影 |
| task/subscribe | `taskId` | 原子快照及后续 task/updated 通知 |
| task/unsubscribe | `taskId` | `{removed:true}`；不取消任务 |
| channel/read | `taskId, afterSequence?, limit?` | `{taskId, channelSequence, data, nextSequence, hasMore}` |
| channel/reply | `requestId, taskId, runId, questionId, answers` | `{accepted:true, messageId, taskId, runId, channelSequence}` |
| inbox/list | `after?, limit?` | `{data:[{taskId, objective, message}], nextCursor}` |

Task 投影包括 `id, revision, channelSequence, owner, mode, interactionMode, objective, threadId, schedule, nextRunAt, paused, cancelled, tokenBudget, maxTurns, maxActiveSeconds, runs, pendingQuestions`；不内嵌 messages。每个 Run 包含 `id, threadId, goalId, status, reason, scheduledAt, completedAt, usage, waitRequested, workers`。worker 包含 `threadId, turnId, status, settled`；status 为 running/completed/cancelled/failed。

Run status 为 `queued/running/waitingForInput/waitingForAgents/paused/blocked/completed/failed/cancelled`；后三项是终态。paused/cancelled 为 Task 控制意图，清理期间 Run 可能仍为 running。以 Run 终态及 worker.settled 判断执行结算，不以控制请求返回或协调 Turn completed 代替。

取消 Task 撤销后续调度并终止尚未结束的 Run；已经结束的 Run 保留原状态、完成时间和用量账本，重启后仍作为历史展示。

ChannelMessage 包含 `id, sequence, runId, author, kind, status, createdAt, expiresAt, questions, required, inReplyTo, answers, text`。kind 为 question/reply/workerReport/report；问题 status 为 pending/answered/expired/cancelled，其他消息为 published。`questionId` 引用 question 消息的 id；answers 是题 ID 到答案字符串的映射，必须恰好覆盖全部问题，非自由文本题须选择给定选项，每个答案非空且最多 4096 字节。

问题必须属于指定 Task/Run，处于 pending 且未过期；已取消 Task、已完成/失败/预算停止 Goal 或已替换 Goal 拒绝新回复。暂停期间可接受有效回复，但不因此解除暂停。相同 requestId 的成功重试仍返回原收据。错误沿用 Core：`-32602` 参数非法、`-32009` 状态或 revision 冲突、`-32003` 权限不足、`-32004` 未找到、`-32001` 容量不足；存储错误以返回的实际 Core 错误为准。

## 独立 Inbox 与订阅

客户端可以在全局 Inbox 或 Task 详情页回答同一问题，无需打开协调 Thread。身份未限制 threadIds 时沿用部署共享工作区授权；受 threadIds 限制的身份只看到绑定到允许 Thread 的 Task，不能创建/查看未绑定的后台 Task。owner 记录创建身份，不新增私人邮箱 ACL；不同可访问身份竞争回答时只有首个有效回复成功。

`areal/task/updated` 参数为 `{taskId, revision, channelSequence, runId, task}`。订阅不依赖 thread/resume；task/subscribe 在同一锁内取得快照并注册接收器，快照响应先于后续事件。Task 事件和 Thread 事件共用每连接 128 个订阅与有界发送队列；积压时关闭连接，客户端重连并重新取得快照。

客户端以 task/subscribe 快照替换任务状态，以通知中的 task 替换投影。channelSequence 增长时分页 channel/read，按 message.id **替换**记录；问题状态变化会获得新 sequence，同一问题可再次出现在增量页。只有处理完该页后才保存 nextSequence。游标不是 Turn ID、Task revision 或已读标记。频道分页是最新消息状态的增量视图，不是完整不可变事件日志；当前没有服务端已读回执。

limit 为 1–100，Task/Inbox 默认 30，Channel 默认 50；Task/Inbox 使用返回的 nextCursor，频道使用 nextSequence/hasMore。页面还有约 128 KiB 的字节上限，Task 单条投影可超过此值；不要假设一页必然达到 limit。Inbox 按需刷新 inbox/list；目前没有全局 Inbox 订阅。

## 修改定时任务

`areal/task/update` 接收 `{requestId, taskId, expectedRevision, objective?, schedule?}`，至少提供一个修改字段。仅可修改未取消的 scheduled Task；schedule 必须为未来 UTC 时间，间隔范围同创建。省略字段保持原值。接口沿用任务授权、持久幂等收据和版本冲突语义，返回完整任务投影并发出 `areal/task/updated`。

修改保留 Task、Thread、Run 历史、暂停状态与预算；新的时间替换后续 `nextRunAt`。已受理 Goal 继续使用原目标，其控制不会覆盖 Task 的新目标。Run 已排队但尚未受理 Goal 的短暂窗口拒绝修改，待其启动后可重试。已结束的一次性任务可通过新的未来 schedule 再次安排。修改不立即执行任务，也不迁移工作区。客户端先检查 methods 是否包含 `areal/task/update`。

## 定时、预算与恢复

schedule 为 `{at: UTC Unix秒, intervalSeconds?: 1..31536000}`；仅 scheduled 可指定。省略 intervalSeconds 表示一次性；重复调度以 at 为锚点，服务恢复后错过的触发点合并为一次，已有未结束 Run 时跳过本次触发，不创建重叠 Run。不支持 cron、日历时区规则或操作系统关机唤醒。Core 服务必须保持运行。

Task tokenBudget 覆盖所有 Run 的已确认和预留消费；maxTurns/maxActiveSeconds 分别限制每个 Run。沿用 Goal 的保守准入与未知消费处理。协调 Turn 和 detached worker 的活动时间取并集，重叠不重复计时；释放所有执行后等待用户的时间不计入。每个 worker 继承冻结配置、权限和同一 Goal 预算；最多使用部署 maxChildrenPerTurn 个 worker（按 Run 累计），maxModelRounds 默认取 16 与父上限的较小值，显式值不能超过父配置。交互式协调者的 worker 使用 asynchronous；headless 保持 headless。worker 不再递归创建 Task worker，也不能修改根 Goal；共享工作区写入仍须明确文件归属。

pause 持久暂停调度并取消当前协调者和 worker；cancel 还撤销后续时间点且不可恢复。resume 不重置预算，不重放已结束 worker；失败/取消的 worker 不能被算作成功依赖。Goal pause/resume/update/clear 同步对应 Task；已取消 Task 的 Goal 不可再 resume。周期 Run 之间会清除同一 Task 的旧 Goal，保留历史和计量。

周期Task有Token总上限时，更新或恢复关联Goal还会扣除其他Run的已确认及预留消费，校验本轮额度不超过余额；不能将本轮额度改为无限。超限返回`TASK_TOKEN_BUDGET`（参数错误），不保存修改或恢复执行。当前没有修改周期Task总上限的公开接口；需要更多总额度时应明确创建新任务。

状态保存在 `desktop/task-mode.json`，含 Task、Channel 和幂等收据。每部署最多 1024 Task、8192 收据、32 MiB；每 Task 最多 128 Run、1024 消息，满后拒绝或暂停，不自动删除历史。活动或挂起等待的 Run 在 Core 重启后暂停，显式 resume 后才继续；尚未触发的 schedule 保留。恢复不自动重放未知工具副作用。`server/drain` 暂停任务与时间触发；`server/status.activeTasks` 计入待执行时间点，ifIdle 不把它们视为空闲。

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
{"id":5,"method":"areal/task/create","params":{"requestId":"daily-1","mode":"scheduled","threadId":"<已有根 Thread>","objective":"检查新增失败并整理报告","schedule":{"at":2000000000,"intervalSeconds":86400},"interactionMode":"headless","maxTurns":10,"maxActiveSeconds":600}}
```

Task worker 在调用方和父配置均未给出轮数时默认无限；显式限制仍继承并执行。部署 Goal 上限为 0 表示无限，不表示零调用额度。Task/Channel 记录容量仍属于独立服务资源限制。

Task 存储写入版本 2，兼容读取版本 1。TaskWorker 保留旧 threadId/turnId，新增可选 execution/executionId，统一投影共享与隔离 worker。新模型入口为 agent_spawn；旧 task_spawn 兼容但不再展示。候选待交付不能完成 Run；没有活跃 Turn 时唤醒原协调者，不重复执行。
