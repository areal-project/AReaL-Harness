**中文** | [English](desktop.en.md)

# 桌面 API：areal.core.v1

本契约扩展 [Core WebSocket](core.md)，与 Runtime JSONL 和 [CLI stdio](claude-cli.md) 分开。完整请求、响应、通知和持久类型见 [areal-core-v1.json](../../schemas/areal-core-v1.json)；请求拒绝未知字段。

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

旧 epoch 句柄为 STALE_HANDLE，不恢复活进程。Thread 进程、UNKNOWN、活动组或压缩阻止 restartSafe。归档需空闲且队列/资源结算，释放热历史并保留磁盘和去重键；GC 在 drain 完成后扫描冷热引用，不能删除历史仍引用的 Blob。

事件使用 areal/ 前缀，包括 thread/configured/archived、plan/updated、queue/updated、goal/updated/cleared、interaction/requested/resolved、process/updated、server/draining。各自 revision 不可与输出 cursor 混用。未知模型窗口/usage 保留 null 或缺失，不猜测。示例见[直接协议验收](../examples/desktop-api.md)。

features.goals=true 表示服务支持 Goal，无需单独配置开关；Goal 事件遵循相同的权限与原子订阅边界。drain 关闭自动续轮准入并暂停目标；归档和显式上下文压缩要求先停止 Goal 并等待资源结算。

本地服务发现、独立于窗口的生命周期和 Desktop Main 接入使用[本地服务契约](local-service.md)。`server/status` 与 `server/drain` 新增返回 `activeGoals`（Thread ID 数组）和 `pendingQueueItems`（pending/running 队列项数量）。这是响应字段的向后增量扩展；restartSafe 仍描述执行清理，不代表没有待调度工作。

共享服务的 `server/status.configuration` 返回 `{modelRevision,restartRequired,error}`，其他部署为 null。模型热更新缺失环境凭据时可同时返回 `restartRequired=true` 和 `error`，表示需要由持有有效凭据的本地客户端安全重启；其他加载错误不触发自动重启。`areal/server/configurationChanged` 向已订阅会话发布 `{threadId,configuration}`。`server/drain` 增加 `strategy="ifIdle"`：在同一准入锁内检查空闲并关闭准入，忙碌拒绝时保留任务运行。见[配置热更新](../guides/configuration.md)。

## Task Mode 接入

`task/create/list/read/pause/resume/cancel/subscribe/unsubscribe`、`channel/read/reply`、`inbox/list` 构成独立于 Thread 的任务控制与通信 API，详见 [Task 契约](tasks.md)。task/updated 通知携带 Task 投影和 channelSequence；客户端通过分页频道读取维护消息。server/status 与 drain 增加 activeTasks，包含尚未到时的任务。GUI/TUI/WebUI 可共享同一 Inbox；现有会话交互面板仍处理同步问题和审批。

可选 `parameters.contextWindowTokens`（1–2000000）声明模型容量，保存在模型默认参数与 Thread 覆盖中。`areal/model/list.contextWindowTokens` 未声明时仍为 null，`effectiveContextWindowTokens` 包含全局兜底。上下文检查增加 budget 字段 windowTokens、outputReserveTokens、inputLimitTokens、targetTokens、windowSource（model/fallback）。模型配置或凭据不可用时仍可查看上下文，budget 返回 null。这些元数据控制本地预检，不改变供应商模型容量。
