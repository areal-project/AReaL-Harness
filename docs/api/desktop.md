**中文** | [English](desktop.en.md)

# 桌面 API：areal.core.v1

本契约扩展 [Core WebSocket](core.md)，与 Runtime JSONL 和 [CLI stdio](claude-cli.md) 分开。完整请求、响应、通知和持久类型见 [areal-core-v1.json](../../schemas/areal-core-v1.json)；请求拒绝未知字段。

Web/PWA Remote 使用独立的受限 [areal.remote.v2 契约](remote-control.md)，由桌面后台代理并重新检查设备授权。它不向浏览器提供本契约的通用调用入口或本地 Bearer；Remote 的设计与已实现范围分别标注。

Thread 快照和 Item 通知支持可选 `agentMessage.phase`，生命周期、示例与旧数据兼容规则见 [Core 消息阶段](core.md#agent-message-phase)。此响应字段为兼容性新增，保持 `areal.core.v1` 版本。

## 认证与连接

产品服务监听 loopback，WebSocket 和 Blob 使用启动器认证。可信 Main 从 ready 元数据的 authFile 读取 Bearer token；Renderer 不持有该文件或模型密钥。内置 Web 使用独立的 HttpOnly、SameSite=Strict 会话 Cookie，并验证 Origin；本地启动自动登录见下文。

认证文件 `{version:1,principals:[{id,token,permissions,threadIds?}]}` 必须为 0600。权限为 observe/interact/manage/tools；显式 threadIds 限制观察与交互。客户端名称和 Thread ID 不等于认证。

initialize → initialized → areal/capabilities（可带 apiVersion）。请求 ID 双向独立，item/tool/call 是须应答的服务器请求。恢复用 thread/resume 替换基线；订阅、发送队列与背压见 [Core](core.md)。

<a id="browser-auth"></a>
### 浏览器登录

- `POST /areal/auth/bootstrap`：可信本地客户端携带 `Authorization: Bearer <本地 token>`，不发送 Origin；成功返回 `200 {code,expiresIn:60}`。Cookie 不能签发登录码，带 Origin 的请求返回 403。
- `POST /areal/auth/bootstrap/exchange`：网页发送 JSON `{code}`，Origin 必须与当前服务完全一致；最多 1 KiB，请求拒绝未知字段。成功返回 204 并设置会话 Cookie；无效、过期、已使用或其他服务实例的 code 返回 401，缺失或不匹配的 Origin 返回 403。
- `POST /areal/auth/session`：保留手工 Bearer 登录，成功同样返回 204 并设置独立会话 Cookie；已有 Cookie 不能续签。提供 Origin 时必须匹配服务。

登录码使用 244 位随机熵，60 秒有效且原子消费一次。CLI 将其放入 `/ui#bootstrap=<code>`；片段不进入 HTTP 请求目标，网页先用 `history.replaceState` 清除当前历史记录中的片段，再通过 POST 兑换，不写入 localStorage/sessionStorage。自动登录失败提示重新运行 `areal web` 或手工登录。认证响应使用 `Cache-Control: no-store`；客户端禁用代理和重定向，启动器长期 token 不进入 URL、服务描述、日志或 Cookie。

Cookie 名为 `areal_session_<origin摘要>`，不指定 Domain，使用 `HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`。当前传输仅限 HTTP loopback，不设置依赖 HTTPS 的 Secure 属性。名称区分本机端口，不能将 Cookie 当作对同机不可信进程的隔离边界。独立会话继承原身份权限和 threadIds；服务端保存登录码和会话 ID 的 SHA-256 摘要，1 小时绝对期限到达后拒绝 HTTP/新 WebSocket 并断开已有浏览器连接，不取消后台任务。服务重启使所有登录码和浏览器会话失效。每服务最多保留 64 个有效登录码和 1024 个有效会话；满额返回 429，不驱逐已有会话。

兼容性：原始 Bearer 客户端与认证文件格式不变，旧的 `areal_session=<长期 token>` Cookie 不再接受；升级后重新运行 `areal web` 或手工登录。`areal web --json` 的服务描述保持原样，既不打开浏览器，也不签发登录码。请求/响应类型见 [local-service-v1.json](../../schemas/local-service-v1.json) 的 browserBootstrap / browserBootstrapExchange。

## 方法目录

| 方法（省略 `areal/`） | 权限 | 行为 |
|---|---|---|
| capabilities | observe | 协商 areal.core.v1、方法、事件与实际限制 |
| profile/list/read, skill/list/read | observe | 版本化定义与按需资源读取 |
| thread/start/configure | interact；动态工具另需 tools | 持久受理、空闲时 CAS 配置 |
| plan/read/update | observe / interact | 最多 64 步，expectedRevision 条件更新 |
| permissions/read/forget | manage（不允许 threadIds 限定身份） | 模式、来源、授权记忆查询与撤销 |
| interaction/list/respond | observe / interact（allowProject 另需不限定 Thread 的 manage） | 追问/审批，绑定 Thread/Turn/requestId |
| provider/list/read/upsert/remove/probe | manage | 凭据引用、CAS 写入与显式连通性探测；TOML 托管 ID 的 upsert/remove 返回 `CONFIGURATION_MANAGED`，改用共享配置命令 |
| model/list | observe | providerId/modelId、能力和可用状态 |
| turn/start/enqueue, queue/list/update/remove/reorder/pause/resume | observe / interact | 持久提交、冻结配置与队列管理 |
| goal/get, goal/create/update/pause/resume/clear | observe / interact | 持久目标、CAS 控制与共享预算；显式创建目标后运行，见 [Goal 契约](core.md#goals) |
| request/read | observe | 按当前身份找回受理收据 |
| process/start/list/get/read/wait/write/resize/closeStdin/terminate | observe / interact | 受管进程与共享终端 |
| process/acknowledgeCleanup | manage | 旧 epoch 的外部清理证据，保留 UNKNOWN |
| thread/closeResources | interact | 等待受管资源回收 |
| agent/delegate, execution/list/read/wait/artifact/cancel/apply | observe / interact | 统一委派与结果交付，见 [Core 契约](core.md#agent-tools) |
| agent/spawn/wait, workflow/list/read/start | observe / interact | 配置化子任务或 Workgroup |
| mcp/list/read/configure/connect/disconnect | manage | 配置、连接和目录 revision 分开管理 |
| thread/inspect, context/read/compact | observe / interact | 权威执行视图、分页和空闲压缩 |
| thread/archive, blob/release | interact | 冷历史与未引用上传释放 |
| server/status/drain/gc | manage | 资源使用、收敛与 Blob 回收 |
| subscription/remove | observe | 退订观察，不撤销工具宿主 |

<a id="submissions"></a>
## 提交、配置与恢复

requestId 是持久业务键，RPC id 只关联响应。相同身份、方法、键和规范参数返回原结果；参数不同冲突。Thread 最多 1024 收据，管理日志 4096；容量满拒绝而不遗忘旧键。重启后 accepted 但无结果的管理记录为 UNKNOWN，不重新执行。

turn/start/enqueue 使用 `{requestId,threadId,input,expectedConfigRevision?,interactionMode?}`。队列最多 128 历史项，每项冻结配置；仅成功自动推进，Stop/失败/UNKNOWN/重启/drain 暂停，必须显式恢复。超时后先 request/read 或读权威状态，不能推断没发生副作用。

可选 `turn/start.admissionGuard: {configRevision,ordinarySession:true}` 在冻结配置和持久化 Turn 前原子检查配置版本与普通会话当前所有权。托管子会话、活动或结算中的 Goal、排队/运行/等待中的 Task Run 以及未结算 worker 均拒绝准入；完全结算的历史或仅未来调度不占有 Thread。已归档会话、暂停或未结算队列及既有 busy/UNKNOWN/工具宿主检查仍是准入屏障。Core 保持 Task 预留锁直到持久化激活完成。enqueue 不接受此 guard；`ordinarySession:false` 无效。能力由 `features.turnStartAdmissionGuard` 声明。

可选 `thread/start.admissionGuard: {ordinarySession:true}` 在创建 Thread 或启动 Workflow 前检查实际解析的显式/默认 Profile。绑定 Workflow 的 Profile 返回参数错误 `-32602`，消息以 `UNSUPPORTED_PROFILE:` 开头。已受理的 guarded 创建重放返回原 Thread，不再尝试启动 Workflow。能力由 `features.threadStartAdmissionGuard` 声明。省略 guard 保持既有本地行为；省略字段保持旧收据摘要不变。新 guard 检查之前先查询收据，同参数已受理请求返回记录结果，不重新判定变化后的状态。

`areal/thread/observe` 在 `thread` 旁返回 `ownership: {kind: "ordinary" | "task", taskId?, runId?}`。`features.atomicObserveOwnership=true` 保证所有权、快照与订阅在同一 Thread → Tasks 锁内捕获。判定与普通准入共用：活动/结算中 Goal、受管/子 Thread、排队/运行/等待 Run 或未结算 worker 属于 Task；已结算的暂停/阻塞 Run、历史和未来调度本身不构成所有权。Task/Run 标识遵循既有 Task 与协调会话可见性授权；隐藏或无对应 Task 的所有权仍返回不带标识的 `kind: "task"`。同一 Thread 有多个 Run 预留时，标识只指向当前活动/结算中 Goal 对应的唯一 Run；没有这类 Goal 时，仅唯一候选 Run 可提供标识。无法确定唯一归属时仍返回不带标识的 `kind: "task"`。该投影不持久化到 Thread。

`areal/queue/steer` 使用 `{requestId,threadId,expectedRevision,queueItemId,expectedTurnId}` 将 pending 项原子转为指定活动轮次的引导。Core 在同一 Thread 锁下预留引导容量、校验目标轮次与输入，并将消息、队列状态 `steered` 和请求收据一次持久化后通知执行器；失败保留 pending 项。成功返回 `{queueRevision,queueItemId,turnId,itemId}`。执行沿用活动轮次的模型和模式；队列更新仍保留加入时配置。相同身份、业务键和参数返回原结果，参数变化冲突；`areal/request/read` 带 threadId 查询该收据。未知结果只查询、不自动重发。

Composer 队列在主输入区编辑消息：确认暂停后加载内容，保存更新原位置及附件引用，保留原模型/模式；保存或取消恢复原草稿。只有队列版本与暂停原因仍属于该次编辑时才恢复先前的未暂停状态。外部更新、删除或 UNKNOWN 保留编辑草稿，不自动覆盖或恢复旧状态。现有未发送 File 草稿在当前 GUI 进程内跨任务切换保留，不新增磁盘附件缓存。`pnpm --dir clients/gui run test:queue` 使用隔离 Electron/Core/Runtime 和确定性 HTTP/SSE 模型验证队列路径。

`EffectiveConfig.defaultModelRevision` 是可选的不透明默认模型快照引用，在 Turn/队列项提交时固定。会话默认配置不固定此字段；显式 Provider 选择保持原语义。模型版本归数据目录所有，不包含环境凭据值。

thread/configure 使用 expectedRevision，仅空闲且不压缩时生效。resetModel=true 清除会话模型覆盖并回到 Profile/服务默认，不能与非空 model 同传；parameters 省略保留，`{}` 使用目标 Provider 默认。`selectedSkills` 可传 Skill 的 `{id,revision}` 列表，空数组清除会话覆盖并恢复 Profile；列表必须属于当前 Profile。features.modelReset 声明支持。

`areal/thread/start` 使用 `{requestId,agentProfile:{id,revision},cwd?,model?,parameters?,dynamicTools?}` 创建按指定 Profile 冻结配置的 Thread。客户端可以用 `--agent id@revision` 传入同一引用；不需要再指定 Workflow。Profile 的 `workflow` 字段是 Agent 属性，创建 Thread 时自动启动一次并在快照 `desktop.workflowRun` 中记录 Workgroup ID 与启动状态；实时状态通过 Workgroup API 查询。相同 requestId 重试和恢复 Thread 不会重复启动；绑定 Workflow 的 Profile 只能在创建 Thread 时选择，不能通过 `thread/configure` 切换。没有 Workflow 的 Profile 不要求 Workgroup policy，仍可使用其 `toolAllowlist` 允许的工具。

可选 `parameters.reasoningSummary` 接受 `auto` / `concise` / `detailed`，仅用于 Responses，按 Provider 默认 → Thread 参数合并；Provider/服务默认与 Thread 都未配置时不启用摘要请求。`areal/model/list.parameterCapabilities` 只在 Responses Provider 下包含 `reasoningSummary`，表示适配器支持传参，不保证供应商的每个模型都支持所选模式。`areal/model/list.reasoningEffortOptions` 返回现有 HTTP 适配器允许的 `none/minimal/low/medium/high/xhigh`（其他适配器为空），同样不保证远端每个模型都支持。Composer 从目录读取这些选项，通过原会话配置提交参数。事件与分段规则见 [Core 思考进度](core.md#思考进度)。

options.readOnly 收窄 Scope 写根和网络；toolAllowlist 收窄 Profile；preapprovedTools 不能取消部署强制审批，且只匹配当前工具名；预批准读取工具不会豁免它触发的 hook。maxModelRounds 为 1–1024，最后一轮仅交接，不等于团队请求预算。Profile/Workflow 定义使用不可变 id/revision；Skill 引用不冻结资源内容，见下文。

<a id="skills"></a>
## Skill 元信息与资源

可信部署清单的 skills 接受 `{id,revision,root,metadata?:{name,description}}`；root 相对清单目录。省略 metadata 时只解析 SKILL.md 的有界文件头，不扫描附件；显式部署和自动发现使用同一种按需读取行为。

`areal/skill/list` 接受 `{threadId}`；新草稿可用 `{agentProfile:{id,revision}}` 观察已登记 Profile 的技能，两者互斥。Profile 目录查询不创建 Thread、不读取正文；`areal/skill/read` 同样接受两种互斥上下文，以便草稿预览当前 Profile 允许的资源。Profile 读取不登记 Thread 加载状态，发送前仍在所属 Thread 中重新读取。Composer 保存技能引用与来源，发送前读取 SKILL.md 并附加到当前消息；读取失败保留草稿。

`areal/skill/list` 的 data 条目增加 name/description，resources 统一为 null（不再返回完整资源清单），available 和 resourceRoot 保持原意。模型初始提示只注入名称和有界描述；需要正文时调用 skill_read。

`areal/skill/read` / `skill_read` 每次从当前磁盘读取，maxBytes 为 1–8192，使用 offset/nextOffset 分页；sizeBytes 表示该次打开文件时的大小。资源允许超过 256 KiB，二进制返回 dataBase64；并发修改下不保证跨页一致性。资源路径限制与发现告警见[Skill 指南](../guides/skills.md)。

兼容性：Skill revision 不再是内容不可变保证，旧 skillHashes 被忽略；现有 `{id,revision,root}` 清单仍可使用。历史引用必须由可信启动器登记，否则标为不可用。自动发现 revision 改为元信息摘要；Profile/Workflow 定义与会话历史的持久化语义不变。

## 交互与媒体

审批绑定 Thread/Turn/callId、Host generation、有效参数摘要与权限，支持 allowOnce/deny；effectivePermissions.rememberAllowed=true 时另支持 allowSession/allowProject，仍不能扩大 Runtime Scope。问题最多 8 题/题 8 选项、答案 4096 字节、交互历史 256 项；等待不持有模型许可，Stop 优先，迟到或跨 Turn 回答拒绝。

`permissions/read {threadId}` 返回 configuration（mode/allow/ask/deny）、source、sandbox、workspace、session/project 授权条目和 projectFile。`permissions/forget {threadId,project}` 清除会话或项目记忆；目标 Thread 必须空闲。项目批准需要不限定 Thread 的 manage 身份。记忆与规则优先级见[权限配置](../guides/configuration.md#permissions)。旧快照缺少 permissionGrants 时按空数组读取；thread/start/resume 增加 permissionMode 字段，底层 full-access 投影为 dangerFullAccess。

POST `/areal/blobs?threadId=...` 上传原始字节，Content-Type 与签名一致；工具上传另带 callId/hostGeneration 并需 tools 权限。单文件 16 MiB，Thread 上传登记 128 项/64 MiB；不设全局 Blob 累计配额。支持 PNG/JPEG/GIF/WebP、WAV/MP3、PDF、UTF-8 文本。GET 需要认证、threadId 和引用归属；摘要不是令牌。

contentItems 按顺序保存 inputText 或 arealMedia，实际字节进入模型。认证 RPC 拒绝宿主 localImage/localAudio 路径，使用上传返回的 areal://blob URI。不支持的模态明确失败。

## 进程与保留

process/start 默认 lifetime=turn；thread 生命周期需 Profile allowThreadProcesses，写服务还需部署 allow-concurrent-writes。输入归因到认证身份，输出游标与清理沿用 Runtime。PTY resize 为实际 ioctl；pipe EOF 关闭 FD，canonical PTY 使用 VEOF，raw mode 不支持。

面向模型的 `development_service_inspect` 只列出当前 Thread 的受管记录，或返回单条记录的 Runtime 当前状态与最多 16 KiB 输出。`development_service_start` 通过同一持久 process/start 所有者提交 thread 生命周期进程，请求身份由可信的 Core Thread、Turn 和工具调用 ID 生成。Core 审批、Profile 权限和 Runtime 写入序列化检查仍然生效。启动结果未知时检查原记录，不自动重发。这两个工具不另建进程执行器，也不推断监听端口。

旧 epoch 句柄为 STALE_HANDLE，不恢复活进程。Thread 进程、UNKNOWN、活动组或压缩阻止 restartSafe。归档需空闲且队列/资源结算，释放热历史并保留磁盘和去重键；GC 在 drain 完成后扫描冷热引用，不能删除历史仍引用的 Blob。

事件使用 areal/ 前缀，包括 thread/configured/archived、plan/updated、queue/updated、goal/updated/cleared、interaction/requested/resolved、process/updated、server/draining。各自 revision 不可与输出 cursor 混用。未知模型窗口/usage 保留 null 或缺失，不猜测。示例见[直接协议验收](../examples/desktop-api.md)。

features.goals=true 表示服务支持 Goal，无需单独配置开关；Goal 事件遵循相同的权限与原子订阅边界。drain 关闭自动续轮准入并暂停目标；归档和显式上下文压缩要求先停止 Goal 并等待资源结算。

本地服务发现、独立于窗口的生命周期和 Desktop Main 接入使用[本地服务契约](local-service.md)。`server/status` 与 `server/drain` 新增返回 `activeGoals`（Thread ID 数组）和 `pendingQueueItems`（pending/running 队列项数量）。这是响应字段的向后增量扩展；restartSafe 仍描述执行清理，不代表没有待调度工作。

`server/status` 与 `server/drain` 还返回 `lifecycle={version:1,admission:"open"|"draining"|"closed",ifIdle:{allowed,reasons},settled:{allowed,reasons}}`。`reasons` 为 `{code,count}` 数组，code 包括 `activeTurn`、`resource`、`uninspectedUnknown`、`compaction`、`workgroup`、`activeGoal`、`queuedMessage`、`activeTask`。Core 共用观察和准入锁内的操作判定；观察不是停止授权。`ifIdle` 要求没有工作且执行已结算，`settled` 仅描述 cancel 的执行/资源结算后置条件。cancel 保留暂停 Queue 中的输入，不重新套用 pending 必须为零的前提；UNKNOWN 和未清理资源仍阻止退出。超时可能返回 draining，RPC 成功不证明进程已退出。未知版本、原因或缺失字段不能推断为允许。

共享服务的 `server/status.configuration` 返回 `{modelRevision,restartRequired,error}`，其他部署为 null。模型热更新缺失环境凭据时可同时返回 `restartRequired=true` 和 `error`，表示需要由持有有效凭据的本地客户端安全重启；其他加载错误不触发自动重启。`areal/server/configurationChanged` 向已订阅会话发布 `{threadId,configuration}`。`server/drain` 增加 `strategy="ifIdle"`：在同一准入锁内检查空闲并关闭准入，忙碌拒绝时保留任务运行。见[配置热更新](../guides/configuration.md)。

## Task Mode 接入

`task/create/list/read/pause/resume/cancel/subscribe/unsubscribe`、`channel/read/reply`、`inbox/list` 构成独立于 Thread 的任务控制与通信 API，详见 [Task 契约](tasks.md)。task/updated 通知携带 Task 投影和 channelSequence；客户端通过分页频道读取维护消息。server/status 与 drain 的 activeTasks 统计需要结算的任务工作：定时任务只在 Run 排队、执行、等待输入或子任务时计入，不计仅等待下一次触发的安排；暂停后仍在运行的定时 Run 继续计入。空闲定时安排可安全重启，保留时间、启用状态和历史。GUI/TUI/WebUI 可共享同一 Inbox；现有会话交互面板仍处理同步问题和审批。

可选 `parameters.contextWindowTokens`（1–2000000）声明模型容量，保存在模型默认参数与 Thread 覆盖中。`areal/model/list.contextWindowTokens` 未声明时仍为 null，`effectiveContextWindowTokens` 包含全局兜底。上下文检查增加 budget 字段 windowTokens、outputReserveTokens、inputLimitTokens、targetTokens、windowSource（model/fallback）。模型配置或凭据不可用时仍可查看上下文，budget 返回 null。这些元数据控制本地预检，不改变供应商模型容量。

<a id="turn-fork-开发预览"></a>

## Turn Fork

`areal/capabilities` 默认声明 `conversationDerivationV1`，`preview:false`，并公布六个派生会话方法。Fork 支持主会话或 Fork 中已持久化 Turn 的 `before` / `after` 锚点，以及 `sharedCurrent` 工作区模式。创建、列表、恢复、历史与证据读取均执行现有身份、角色与准入校验；客户端按当前连接公布的方法及能力启用入口。

`areal/thread/fork` 接受 `{requestId,sourceThreadId,anchor:{turnId,boundary:"before"|"after"},workspaceMode:"sharedCurrent",target?}`。可选 `target` 使用 `agentProfile?`、`model?` 和 `parameters?` 选择普通配置；`{}` 使用当前部署默认配置，省略时冻结最后一轮继承历史的配置。`before` 不包含锚点 Turn；`after` 要求锚点已终结。前缀中的工具、Hook 与插件操作必须结算；UNKNOWN 须经来源检查。Core 从已提交来源记录与固定冷段读取锚点前缀；来源也是 Fork 时先扁平化其继承快照。Core 持久化目标自有快照、逐轮来源 ID 和创建收据，再公开一个空闲的独立 Thread/Session；目标本地 `turns` 起初为空，来源 Goal、队列、审批和执行宿主均不继承。创建不启动模型或工具，不修改工作区文件。相同业务键和参数返回同一目标，参数冲突的 `error.data.reason` 是 `REQUEST_CONFLICT`。创建和同键重试仅返回 `turns=[]` 的 Thread 摘要；当前历史通过目标的 read/observe 恢复。目标 `conversation.kind=fork`、`origin` 和 `historySeed` 是内容来源，不是 `parentThreadId` 委派关系。

`areal/conversation/history {threadId,view:"inherited"|"reference",cursor?,maxBytes?}` 按目标授权读取 Fork 继承项或 Side 参考快照，默认页预算 64 KiB、最大 256 KiB（包括整个序列化结果）。游标绑定目标、快照、历史层和位置，跨目标或层复用被拒绝。不存在对应历史层时返回空 data、snapshotId=null 和 complete=true。超大 Item 按 UTF-8 边界分页，fragment.text 是完整条目 JSON 的连续片段，带 offsetUtf8、nextOffsetUtf8、totalBytes；客户端拼接后解析，不产生执行事件。每个完整条目的 `turn` 保存原轮次的状态、错误、耗时与 Goal 展示信息（不含 items）；GUI 按轮次重组后直接复用主消息流，不增加继承历史折叠层。分支与轮次菜单仅在回复结束后和复制按钮一起展示。`areal/context/read` 和目标后续模型请求从持久快照与本地 Turn 构造逻辑历史，不读取来源实时会话。快照上限为配置的历史上限与 64 MiB 中较小者。工具批次、已结算回执、媒体和原始结果引用按历史事实保存，不登记为目标新执行或用量；目标只可读取其快照实际引用的 Blob。目标模型必须支持继承模态与 Provider 原生上下文格式；不支持时创建返回 `MODEL_MODALITY_INCOMPATIBLE` 或 `MODEL_CONTEXT_INCOMPATIBLE`，自动 Workflow Profile 返回 `PROFILE_NOT_SUPPORTED`。旧记录缺少 `conversation` 时仍按普通主会话读取；未知 kind 或不支持的版本拒绝恢复。

<a id="side-chat-开发预览"></a>

## Side Chat

`areal/side/start` 请求 `{requestId,sourceThreadId,anchor?,selection?,workspaceAccess:"none"|"readOnly",input:[{type:"text",text}]}`；`anchor` 可为 `latestCommitted` 或 `{kind:"turn",turnId,boundary:"before"|"after"}`，省略时选取首问受理时最后一个已提交 Turn。`selection` 可为 `{kind:"itemRange",turnId,itemId,startUtf8,endUtf8,textSha256}`，在冻结前缀的单个文本 Item 上按 UTF-8 字节范围及 SHA-256 摘要验证；重复原文按位置区分，边界、范围或摘要失效返回 `STALE_SELECTION`，首问未提交。对尚未落盘或无法精确映射的文本使用 `{kind:"userQuote",text,claimedTurnId?,claimedItemId?}`，持久标记为未确认用户引文，声明的 ID 不证明来源。`turn/after` 接受完成、失败和中断轮次，活动轮次返回 `TURN_NOT_TERMINAL`。空面板不创建 Thread。首问将目标独立 Session、不可变参考快照、首个 Turn 和业务收据一起提交，然后启动模型；同键重复请求在归档、历史移入冷段或重启后仍返回同一个目标与原首轮，不启动执行或取消归档。创建和同键重试返回 `thread.turns=[]`、`turn.items=[]` 的摘要，保留目标与首轮身份、状态和配置；完整历史从目标的 read/observe 恢复。提交后响应丢失时用 `areal/request/read {requestId}` 查找，不能改键重试。重启时已提交但尚未完成的轮次明确中断，不会重发首问。

Side 的 `conversation.kind=side` 与 `policy.kind=sideReadOnlyV1` 是持久角色，`none` 仅允许 Core 固定的 `side_context_read`；`readOnly` 在创建时来源当前配置的工具允许集、身份授权、部署权限与受信任 Runtime 原生 `fs_read`、`fs_list`、`fs_stat` 和 `search_files` 的交集中读取当前工作区。历史锚点配置不扩大此授权；冻结后的工具子集跨模型配置、归档与重启保持不变。`areal/capabilities.features.conversationDerivationV1.sideWorkspaceAccess` 仅在原生路径沙箱、文件助手及搜索能力可验证且无命令 Hook 时公布 `readOnly`；否则创建明确返回 `WORKSPACE_READ_UNAVAILABLE`，用户可另选 `none`。Side Runtime Scope 仅在冻结子集包含文件工具时具有工作区读取根，否则读取根也为空；写入根为空且网络被拒绝；命令、MCP、插件、动态工具、Goal、自动 Workflow 与委派不能获得执行权限。文件读取返回 `source:"currentWorkspace"`、当前 SHA-256 与范围；同一轮次再次读取同路径时若 SHA 改变则返回 `changedSincePreviousPage:true`。目录和搜索也标记为当前工作区观察，不保证跨页原子快照。历史中的指令和工具输出都是参考数据。模型上下文只含有界最近摘录、证据引用和省略数量；追问仍使用创建时快照。`areal/side/context/read {threadId,evidenceRef?,cursor?,maxBytes?}` 受目标身份授权分页读取冻结证据，默认 8192 字节、最大 16 KiB；`evidenceRef` 与 `cursor` 不能同时传。GUI 证据阅读标明快照和确认状态，来源推进或无法查询当前状态时不会声称引用为最新。旧执行入口不能改变 Side 角色或扩权，`thread/list` 默认任务列表排除 Side。`turn/start` 和 `areal/turn/start` 仅接受文本追问，`turn/interrupt` 只停止 Side 当前 Turn；关闭 GUI 面板不发送中断。

已完成轮次的 GUI 选区默认传该轮 `after` 锚点；流式用户引文使用首问受理时的最新持久观察。富文本显示无法直接映射到 canonical 文本时，即使回复已完成，GUI 仍将其标成未确认 `userQuote`。单选区原文超过 16 KiB，或转义后无法装入初始包，返回 `SELECTION_TOO_LARGE`。初始模型包按序列化 UTF-8 字节限制在 32 KiB；证据页的 `maxBytes` 计入整个序列化结果，预算不足时明确拒绝。已有 Side 再从选区发起会打开新草稿，旧快照保持不变。

GUI 可从 Side 的一条回复中选择文字，或显式选择整条回复，预览并编辑附有 Side 与来源快照说明的文本。确认时按捕获的服务实例、项目、来源会话和 Side 归属核对目标，在最新主草稿末尾追加并用本地 insertionId 去重；现有附件与模型选择保持原状。来源推进时显示旧快照提示，来源归档或目标改变时保留预览供复制。此操作只改本地草稿，不调用发送、排队或引导接口，也不会恢复归档。

`areal/conversation/list {view?,sourceThreadId?,includeArchived?,limit?,cursor?}` 按 `main`（默认）、`side` 或 `all` 分类，默认不含归档，`limit` 为 1–100（默认 30）。`main` 只含普通主会话和 Fork，不含委派 Worker 或 Side；`sourceThreadId` 仅适用于 `side`/`all`。按 `createdAt,id` 稳定排序，游标绑定身份与筛选条件，跨筛选使用会拒绝。旧 `thread/list` 合同不变；GUI 主任务列表使用新接口并显式包含归档以支持归档视图，相关讨论面板按来源分页读取，手动刷新可发现其他客户端新建的讨论。

认证连接中，仅有 observe 权限不能创建 Side；带 `threadIds` 的身份即使有来源读取和 interact 权限也不能创建派生会话，返回 `error.data.reason=SCOPED_PRINCIPAL_UNSUPPORTED`，不会自动扩展可见列表。列表、读取、证据、Blob 和按业务键查询的收据按目标 Thread 独立授权；目标可见不意味着来源或其他 Side 可见。Side 快照关联的媒体需以该 Side 的 `threadId` 请求 Blob，猜测摘要不能跨会话读取。`areal/thread/configure` 在 Side 空闲时只接受 `model` 或 `parameters` 搭配 `expectedRevision`，保持只读角色和工具范围；配置选项、Profile、Skill 和 resetModel 被拒绝。`areal/tool/acknowledge` 可为 Side 自有的 UNKNOWN 工具记录保存明确检查说明，保持 UNKNOWN 结果且不重放；不能借此确认来源或参考快照中的工具。其他旧执行入口按持久 Side 角色拒绝写入或提权；错误的 `data.reason` 和 `data.requestId` 经 GUI Core 客户端保留。

空闲 Side 可用 `areal/thread/archive {threadId}` 持久归档；活动轮次归档会拒绝。`areal/conversation/unarchive {requestId,threadId}` 幂等恢复已归档 Side 和完整历史，不自动发问。重放 Side 原创建键从持久历史返回原始首轮，包括重启后，不重新执行或恢复归档。读取或订阅归档 Side 不会恢复它，归档期间发送仍被拒绝。来源 Stop 或归档不级联停止或删除 Side；关闭相关讨论面板只隐藏视图。已发送内容由 Core 在 GUI 或 Core 重启后恢复，未发送草稿不承诺跨进程保存。
Side 首问与追问共用活跃额度：默认每来源 2、每部署 8；超额分别报 `SIDE_SOURCE_CAPACITY_REACHED`、`SIDE_DEPLOYMENT_CAPACITY_REACHED`。每个 Side Turn 默认最多 8 次模型轮、16 次工具调用、300 秒；全局限额仍可进一步收紧。Side 不自动或手动调用模型压缩，避免额度外请求；上下文过大时明确失败。模型许可不足时 `areal/side/capacity` 推送 `waiting`/`available`，活跃 Side 的 `thread/read` 与 `areal/thread/observe` / `thread/resume` 订阅快照在 `desktop.sideCapacityStatus` 投影当前状态，停止后快照不保留等待状态；停止只取消对应 Side。Side 请求计入自己的 Session 与部署真实用量，不继承来源 Goal 预算。

## 当前 GUI 复用入口

项目下的 Session 列表来自 `project.list` / `work.list`，不使用示例数据或 GUI 已打开列表。会话详情复用 GUI 消息与 Composer；附件入口不提供。模型与权限、目标创建/暂停/恢复/清除、运行中 Follow up 队列与引导均使用真实 Core；完整目标编辑与模型目录/凭据设置仍在桌面完成。

Turn 显示投影保留 Core 的 `goal.origin`、`goal.sequence` 与 `durationMs`，供同一 GUI 消息组件显示目标自动继续标签和权威耗时。不会按消息正文猜测续跑来源，也不传输 instructionSnapshot 或完整 Turn 配置。

正文、推理和工具文本通过 `session.body {threadId, turnId, itemId, cursor?}` 完整读取并交给同一 GUI 消息流渲染，长回复不再只显示预览。该只读入口要求当前项目的 observe 授权和已打开的精确会话订阅；每页重新校验设备授权、连接与 Core 代际。公共消息正文超过内联额度时按最多 32 KiB 的 UTF-8 页读取，每位观察者只保留一个有效期 45 秒、最多 4 MiB 的临时冻结正文版本；游标不能跨消息或订阅使用。媒体与 Core 已归档、不可访问的历史仍不提供。工具参数、文本输出和公开执行状态可以展开；modelContext、凭据、完整配置、instructionSnapshot、钩子负载和私有执行元数据不传输。浏览器仅缓存当前显示范围的正文，切换会话或断开后清空；读取失败可显式重试，不重放发送或工具操作。现有原生历史接收上限仍适用。

`session.send` 可附带 `enqueue: true, expectedTurnId`，映射 `areal/turn/enqueue`，要求 `turnEnqueueAdmissionGuard`；Core 在锁内确认普通归属与配置版本。`session.control {threadId, operation, expectedRevision, values}` 使用 submit 能力和既有 commandId journal，仅支持 configure、goalCreate/goalPause/goalResume/goalClear、queueUpdate/queueRemove/queueReorder/queuePause/queueResume/queueSteer、steer。字段严格限定；不接受路径、原生方法名、连接信息或凭据。Task 归属拒绝这些普通会话控制。

快照包含脱敏模型目录、配置、目标与队列显示投影；队列至多 128 项，每项文本 1024 UTF-8 字节，含附件或截断项不可在 Remote 编辑。模型目录至多 200 项。发送和控制共享 Session 未确认门；结果未知只查原 commandId，不重发。配置/目标/队列及 enqueue 使用原生持久收据核对。直接 `turn/steer` 无可查询原生请求键，回应丢失时保持 UNKNOWN，不将消息回显当作受理证明。

普通 Session 自建目标在 Core 标记为目标管理期间仍可按精确 goalId 和版本暂停、恢复或清除；TaskRun 管理的目标仍使用 Task 控制。

目标控制还要求已受理日志把当前 Host／设备／项目与精确 goalId 绑定到 goalCreate；其他设备创建的目标在此只读。

## Side 模型与清理恢复

`areal/side/start` 省略 `model` 和 `resetModel` 保持锚点模型继承；`resetModel: true` 显式使用部署默认模型；`model` 指定模型。二者不能同时提供。旧客户端保持继承语义，旧 Core 不支持 resetModel 时应拒绝而不是静默继承。首问与后续轮次使用同一持久配置。

旁路恢复按 owner/connectionGeneration 区分 idle/loading/ready/error。确定失败等待用户重试，切换目标或新连接可重新读取；旧结果不能更新新目标。未知提交仍只核对原回执，不自动重复首问。

MCP 清理失败保持 cleanupFailed，并持久保存 cleanupUnconfirmed。无连接记录的重复 disconnect 不构成清理证据，不能解除状态或启动第二宿主；目录提交失败的回滚也传播清理未确认。重启不自动消除此标记。当前没有以远端 RPC 声明清理成功的恢复入口，需操作者先独立核验本任务宿主退出，再通过维护流程修复记录。此状态不证明进程泄漏。

评价命令通过可信桌面后端执行；Renderer 不能指定接收端、归属或上下文。契约与限制见 [user feedback](../guides/user-feedback.md).

## 桌面轨迹开关

GUI 服务的窄命令 `trajectory` 支持 `{operation:"status"}`、`{operation:"retry"}` 和 `{operation:"setEnabled",enabled:boolean,expectedRevision:string}`。启停要求当前文件的 64 位小写 SHA-256，不接受配置路径、目的地址或认证覆盖；桌面适配器固定使用与 Core 相同的配置和凭据环境。状态读取不解密凭据，也不进入任务准入计数。启停立即应用上传控制；采集设置只在 Core 空闲、无排队任务且没有其它配置变化时，复用安全应用的 `ifIdle` 排空与重启。响应的可选 `capture_apply_pending` 和 `capture_apply_error` 分别表示等待应用及应用问题；客户端不能把它们显示为就绪开启。远端分析和归档状态不由该开关推断。
