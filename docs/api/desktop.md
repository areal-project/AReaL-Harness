**中文** | [English](desktop.en.md)

# 桌面 API：areal.core.v1

本契约扩展 [Core WebSocket](core.md)，与 Runtime JSONL 和 [CLI stdio](claude-cli.md) 分开。完整请求、响应、通知和持久类型见 [areal-core-v1.json](../../schemas/areal-core-v1.json)；强类型 AReaL 请求拒绝未知字段，Codex 兼容方法保留固定版本的 wire 契约。

`make desktop-schemas` 从 Rust 类型导出插件和 Hook DTO，并纳入[固定 Codex 0.162.1 插件契约](../../upstream/schemas/codex-plugins-0.162.1/methods.json)，各契约来源见[溯源记录](../../upstream/schemas/codex-plugins-0.162.1/provenance.json)。生成时要求请求与响应 schema 成对且覆盖全部广告通知；示例客户端进一步对照运行中 Core 的 capabilities 检查覆盖率。每个方法和命名类型 schema 都可单独提取并编译。生成器保留递归定义，并将本地 `$ref` 绑定到该导出内的原始定义域；生成时拒绝无法解析的本地引用。

Web/PWA Remote 使用独立的受限 [areal.remote.v2 契约](remote-control.md)，由桌面后台代理并重新检查设备授权。它不向浏览器提供本契约的通用调用入口或本地 Bearer；Remote 的设计与已实现范围分别标注。

Thread 快照和 Item 通知支持可选 `agentMessage.phase`，生命周期、示例与旧数据兼容规则见 [Core 消息阶段](core.md#agent-message-phase)。此响应字段为兼容性新增，保持 `areal.core.v1` 版本。

## 桌面宿主任务目录兼容性

桌面后台的 `service.commandContract` 为 `areal.desktop-commands.v3` 时，支持带 `requestId`、`viewEpoch` 的 `tasks.preview` 与 `tasks.observe`。`preview` 只读已发布快照；`observe` 对已连接 owner 读取实时目录，对冷 owner 读取快照，不启动项目 Core。旧后台可以继续连接和承载已有任务，但 Main 不向缺失或不同命令契约的后台发送这两种查询，返回 `SERVICE_COMMAND_UNSUPPORTED`，不改用可能启动项目的 `list`。

任务中心发现命令契约不兼容时保留已加载任务，显示通过设置“后台服务”安全更新的提示，不逐项目重试或声称没有任务。更新仍需显式操作，并使用已有生命周期资源检查和结算流程，不自动停止运行中的工作。部署身份包含 `desktop-contract` 入口及其拆分目录的协议文件内容；修改拆分协议也会使旧后台显示待更新，而不是继续冒充同一部署。

## 桌面宿主 Worktree 契约

桌面宿主 `connect` 接受可选 `threadId`，用于优先恢复当前会话的只读观察。服务快照的 `selectedThreadObservation=true` 公布支持；Main 连接未公布该能力的旧 v3 后端时移除此提示，沿用原恢复请求。它不改变项目执行就绪资格，导航摘要在后台更新。Desktop snapshot 可附带 `subscription` 公开状态，沿用 `chatgpt.status` 的账号与模型字段，并增加 `availability: "checking" | "available" | "unavailable"` 和 `refreshing`。模型目录也可携带 `availability`。确认中不表示已失效，缓存不代替 Core 提交校验。新增响应字段可由旧消费者忽略，旧后端继续接受原 v3 请求；不新增 Rust RPC。

本节属于 `clients/gui` 的认证桌面宿主 `command` 合同，不新增 `areal.core.v1` Rust RPC。宿主继续通过现有 Core 方法管理每个执行目录，Core 仍持有线程和执行历史。共享桌面类型与校验位于 `clients/gui/packages/workbench/client/desktop-contract.cjs`。

`create` 接受逻辑 `projectId`、稳定 `requestId`、原模型与配置，以及可选 `worktree: {sourceRoot?,ref?,worktreeRoot?,branch?,branchPrefix?,mode?,environmentId?,environmentRevision?}`。`mode` 为 `source` 或 `worktree`，`environmentRevision` 为非负整数，其余字段为字符串。普通创建使用当前项目目录、分支和 Core；只有 `mode: "worktree"` 才创建独立 checkout。省略 `worktree`、省略 `mode` 或明确 `source` 均不自动隔离，已有会话不会触发新目录。成功返回 `{threadId,requestId}`，逻辑项目 ID 不变。隔离创建固定来源 SHA，确认独立 Core/Runtime、空线程绑定及所选 setup 成功后才就绪。

`workspace` 提供以下宿主操作。新增管理操作均通过原窄 `command` 边界，并核对逻辑项目归属。

| operation | 请求补充字段 | 返回与作用 |
|---|---|---|
| `worktreeOptions` | `sourceRoot?` | 返回同仓库来源、分支、settings、defaultRoot、项目 environments 和 environmentRevision。 |
| `worktreeSettings` | `worktreeRoot,branchPrefix,fetchBeforeCreate?,autoCleanup?,keepCount?,expectedRevision?` | 保存全局未来创建策略，已有目录不移动。空根使用用户 home 下 `.areal/worktrees`，其下按项目分组。 |
| `worktreeList` | 无 | 返回 `{settings,defaultRoot,revision,projects,worktrees}`。全局列表来自宿主登记，不为列举启动每个 Core。 |
| `worktreeEnvironmentSave` | `environment,expectedRevision` | 保存当前逻辑项目的环境，以 revision 防止覆盖并发修改。 |
| `worktreeEnvironmentDelete` | `environmentId,expectedRevision` | 删除环境配置，不改写已固定的创建环境。 |
| `worktreeRead` | `requestId` | 读取原创建与绑定记录，可能为 `missing`。不重新创建或重跑未知脚本。 |
| `worktreeCancel` | `requestId` | 请求取消原创建并返回当前记录。`cancelling` 不能当作终止，`cancelled` 才能明确开始新的原目录请求。 |
| `worktreeAction` | `requestId,worktreeRequestId,actionId` | 在原受管 Worktree 显式执行已固定环境的动作，使用独立请求回执和有界输出。 |
| `worktreeDelete` | `requestId,worktreeRequestId` | 核对受管目录、清理与服务停止回执，非 force 删除，保留分支、历史和归属 tombstone。失败或未知保留目录。 |
| `worktreeCreate` | `requestId,source?,sourceRoot?,ref?,worktreeRoot?,branch?,branchPrefix?` | 兼容的显式 checkout 入口，共用原 Git 生命周期，`working-tree` 来源拒绝。 |
| `worktreeOpen` | `requestId` | 为已确认 checkout 恢复或完成线程绑定，返回原逻辑项目和线程。 |

环境为 `{id,name,setup,cleanup,actions}`。`setup`、`cleanup` 和 action 的 `script` 使用 `{default,macos?,linux?}`，非空平台脚本覆盖 Default；`actions` 为 `{id,name,script}` 数组。创建时固定所选环境，之后的配置修改不改变旧目录。脚本经现有 Core 受管进程执行，cwd 为真实项目执行根，变量为 `AREAL_WORKTREE_PATH`、`AREAL_PROJECT_PATH`、`AREAL_WORKTREE_BRANCH`。

宿主状态包括 `creating`、`created`、`binding`、`settingUp`、`cancelled`、`ready`、`failed` 和 `unknown`。取消期间保留原阶段和 `intent: "cancel"`，界面显示正在取消。空线程绑定不是发送门槛；环境就绪才允许普通执行。项目快照通过 `worktreeOperations` 投影原日志；线程 `worktree`、`worktreeEvents` 和 `executionProjectId` 描述实际目录及宿主。事件不加入 Core 消息历史。同一请求的参数变化拒绝，未知写入不重放，部分成功不回退来源。删除后的原归属保留，不允许重连创建空目录或改用来源。

普通会话和 Fork 可共享当前目录，不再保留单一 Session 的永久独占作者。桌面仍核对线程身份、Side 只读限制和同 checkout 的定时任务目录；已预约的调度目录只允许原任务家庭执行。旧普通作者记录保留，不作为新会话自动创建 Worktree 或拒绝第二会话的依据。

后续请求继续使用逻辑 `projectId`，由 `threadId`、`sourceThreadId`、`parentThreadId`、任务归属或原请求收据定位执行宿主。跨宿主目标不能混在一次请求中。任务归属索引持久记录实际宿主及可选的 Core 线程锚点；无索引时查询同一逻辑项目的宿主，任何离线、超时或冲突均不能当作任务不存在而回退。宿主注入可信线程锚点，调用者提供不一致的 `threadId` 会被拒绝。无法确认归属时返回 `TASK_WORKSPACE_UNAVAILABLE`；`taskRunNow`、`taskResumeRun`、`taskReply` 和 `taskResume` 缺少锚点也不派发。

`manage.taskCreate` 的 `scheduled` 模式及 `manage.taskDraftConfirm` 使用专用调度准入。一个任务家庭须预约自动分配、非已有的项目外目录，共用目录作者登记；先预约，再创建或核对执行锚点和任务，并绑定原创建收据。只读规划和自动保存确认继续可用。宿主在 `areal/task/prepare` 的 `start` 与 `resume` 回调核对 Task、run、锚点和实际 cwd 后才放行。普通会话经 Core 工具创建的安排使用派生共享准入：核对桌面 owner、来源 Thread、执行锚点及同一实际 cwd 后，允许在当前项目或已选 Worktree 中执行，同一来源可有多个安排。它不创建或迁移独占预约。既无可核对普通来源身份、也无原预约的旧安排不能启用，返回 `SCHEDULE_WORKSPACE_REQUIRED` 或相应作者错误；暂停与取消保留。可信锚点的 foreground/background 操作继续沿普通准入。原生 Core 及已准备的旧自主调度不因此获得追溯保证。每次目录作者准入均分页读取同 checkout 的权威 Task 目录；未取消的旧独占 scheduled 任务即使暂停或休眠也不释放未来执行资格，仅原预约 token、绑定 Task 与锚点可匹配该家庭；普通来源安排须重新核对 Core 身份才能与目录内其他会话共享。读取失败或分页不完整时不派发。

`ScheduleAdmission.authorForSession` 只为 `respond` 和 `continue` 核对当前任务家庭，要求唯一活动 Run、精确 goal/Turn/cwd、已登记 worker 及有界父链。`respond` 还要求精确且未过期的 pending interaction（thread、Turn、requestId、回答种类）；其他 Session、旧请求、取消或暂停 Run 不映射。send、编辑及普通 manage 不能使用调度家庭作者映射，native Task Agent 的研究和工具限制不变，不授权递归委派。

| Run/交互状态 | 桌面行为 |
|---|---|
| 当前活动 Run 等待有效问题或审批 | `respond` 核对精确交互后由 Core 自动继续。 |
| goal 所有的定时线程 | 普通 Core Continue 仍不支持，宿主映射不扩大 Core 合同。 |
| paused 或 blocked Run | 使用 `taskResumeRun`，保留 Run 与线程，创建新 Turn。 |
| pending 时 Host 断开 | Run 暂停为 hostUnavailable；拒绝旧 requestId，恢复后回答新问题。 |
| 取消、已完成、错误 Session/锚点或过期交互 | 拒绝，不消费另一个有效 pending 交互。 |

`node clients/gui/scripts/worktree-schedule-interactions.mjs` 从仓库根验证真实 Core 协议，使用本地确定性模型而不启动 Electron。manifest 区分协议验证和 Runtime payload；原生文件执行未成功时不能据协议通过宣称写入已验证。目录、分支、旧快照兼容性、并发和隔离边界见[Worktree 指南](../guides/worktrees.md)。

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
| model/list | observe | providerId/modelId、解析后默认参数、isDefault、能力和可用状态 |
| turn/start/enqueue/submit, queue/list/update/remove/reorder/pause/resume | observe / interact | 持久提交、冻结配置与队列管理 |
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

### 聊天权限

`features.permissionPresets` 表示支持 `options.permissionPreset: "ask" | "autoReview" | "fullAccess"`。`areal/thread/start` 接受可选 `options` 并原子保存初始配置；`areal/thread/configure` 沿用 revision 与空闲条件。旧配置缺失 preset 时保留原语义。客户端不得在能力缺失时静默忽略新选择。

Core 返回可选 `EffectiveConfig.permissions: {resources:"workspace"|"deployment",reviewer:"human"|"model"|"none",fullAccessAvailable:boolean}`。`features.permissionFullAccess` 用于创建前的部署可用性判断。Ask 与 AutoReview 使用工作区和任务 scratch，命令网络关闭；FullAccess 使用部署允许的范围。只读、Profile、父任务与显式规则继续收窄权限。队列保存入队时的完整配置。

`run_command` 可携带 `permissionRequest:{readRoots:string[],writeRoots:string[],network:boolean,justification:string}`，显式申请单次附加权限。批准绑定最终参数摘要，只建立本操作 Scope；不改变后续命令的基础权限，不自动重试先前失败命令。自动审核使用独立的无工具模型请求，结果绑定摘要；拒绝不执行，审核失败或不确定时进入人工审批。审核记录随工具执行历史保存。

受管命令权限不等于 Core、插件、MCP 或浏览器宿主的整体隔离。浏览器继续使用独立的页面取控与精确计划校验。详见[权限架构](../design/permissions.md)。

<a id="submissions"></a>
## 提交、配置与恢复

Desktop 的 `reconcile` 接受 `{projectId, requestId?}`。携带原 `requestId` 时，现有请求归属路由选择实际执行宿主，再核对该宿主的收据；省略时保留项目级核对。核查不会重新提交创建或发送草稿。旧 Worktree 的独立创建保留在“设置 → 后台服务”的待核对记录中，不作为新草稿的操作提示；当前草稿独占本次创建的未知结果提示。缺少收据时保留原请求及资源，不推断成功或失败。

requestId 是持久业务键，RPC id 只关联响应。相同身份、方法、键和规范参数返回原结果；参数不同冲突。Thread 最多 1024 收据，管理日志 4096；容量满拒绝而不遗忘旧键。重启后 accepted 但无结果的管理记录为 UNKNOWN，不重新执行。

`features.taskRequestReceipts` 扩展 `areal/request/read`，统一查询当前身份的 Thread、管理和 Task 回执，仍保留旧字段。每条记录增加 `operation:{method,requestId,target}` 和 `status:admitted|completed|failed|unconfirmed`；完成时提供原始 `result` 或 `error`。Task 方法名统一为公开 RPC 名称，创建结果保留原始 Task ID。查询还检查 Task 及其所有 Run 的 Thread 可见范围。带 `threadId` 时限定 Thread 和 Task 回执，并兼容附带同身份、同请求键的部署管理回执；受限 principal 仍只能取得可见 Thread 的记录。`retention:threadAndDeploymentLifetime` 与 `capacities:{thread:1024,management:4096,task:8192}` 分别说明保留范围与容量。恢复需匹配方法、身份、目标和已有 digest，空结果仍是未确认。归档后的 Thread 仍可查询保留回执。

### 新建会话的受理日志与负证明

`features.threadCreationJournal = {version:1,binding:{identity,journalEpoch,coreInstanceId}}` 只覆盖 `areal/thread/start`。`identity` 绑定认证 principal；`journalEpoch` 标识同一 Store 连续保留的受理日志，`coreInstanceId` 标识这次 Engine 启动；它们不能由 Runtime epoch、服务 ID、进程号或时间推导。客户端在发送前将 `creationAdmission:binding`、原 requestId 和创建时间保存到 pending，并原样发送。Core 在创建入口校验绑定；原代际退出后，带旧绑定的迟到请求明确拒绝；客户端不得改绑或自动重发。

Core 复用 `desktop/submissions.json`：在创建会话、运行 SessionStart 或启动 Profile Workflow 前，先原子替换受理日志并同步文件与目录，随后才进入副作用。Thread 与创建回执沿原路径同快照提交；结算日志只保存原 Thread ID，不复制完整历史。读取优先采用同请求的 Thread 创建回执，核对本身不补跑 Workflow、Hook 或创建。受理后的错误和中断保留为已受理但完成未知。

`areal/request/read` 可额外携带原 `creationAdmission`，不能同时携带 threadId 或 taskId。在原身份下返回原 `data`，并增加 `creationAdmission:{method:"areal/thread/start",requestId,identity,journalEpoch,coreInstanceId,status}`；Thread 范围受限的 principal 不取得项目级证明。该方法保持只读，判定如下：

| 原请求证据 | status 与恢复 |
| --- | --- |
| 当前代际无记录，可能尚有排队请求 | `unconfirmed`，保留 UNKNOWN |
| 无受理或创建回执，且缺少绑定、身份/覆盖标识不同或日志重新建立 | 旧查询保持空结果；有绑定的查询为 `unconfirmed`，不能推断未受理 |
| 同一身份和覆盖标识、原代际已退役、日志和 Thread 回执都无原请求 | `notAdmitted`，旧绑定不能在当前代际执行 |
| 已有受理记录，无完整创建回执 | `admitted`；重启将 accepted 标为 unknown，不执行原请求 |
| 日志写入是否发布不确定 | `unconfirmed`；重启后按实际保留图像核对，不重试创建 |
| Thread 创建快照及回执存在，结算日志未写完或响应丢失 | `data` 返回原 Thread 的 `completed`，不创建第二个 Thread |

Desktop 仅在证明与原 requestId、方法、身份、覆盖标识和代际完全一致，当前能力确认原代际已退役且原查询无其它回执时，将结果先持久化为 `accepted:false, admissionState:"notAdmitted"`，再移除普通 pending；Remote 沿用其已有 rejected 终态。保留草稿，不自动创建或发送。时间仅用于记录，超时或记录年龄不参与判定。没有绑定的旧 pending 保留 UNKNOWN；不会因为升级、扫描结束或经过一段时间就清除。

日志共用 4096 个键和 8 MiB 预算，管理写入与新建会话都计入 `capacities.submissionJournal`；`management:4096` 字段保留兼容。容量或响应预留不足在副作用前拒绝，不淘汰旧键。Thread 的 1024 个回执和 Task 的 8192 个回执继续按原生命周期保留，归档不释放去重键。新日志封装为 `{version:1,epoch,entries}`，首次打开迁移旧管理日志并保留原键；损坏、未知版本或无法持久化覆盖标识会阻止启动。旧 Core 不保证读取此格式，回退应恢复升级前的完整备份。本证明依赖 Store 独占和日志连续持久化，不支持外部工具在运行中替换、回滚日志；日志丢失后重新建立的覆盖标识不会为旧 pending 生成负证明。

`features.atomicConfigureReceipt` 允许 `areal/thread/configure` 携带可选 `requestId`。Core 在 revision CAS 前查同身份、方法、键及请求 digest；同请求返回原配置，不同参数冲突。配置和回执在同一 Thread 快照提交。回执含原始配置结果、请求 digest、`expectedRevision`、`resultingRevision` 和 `configurationHash`。省略 `requestId` 的旧调用方仍可使用原有 CAS 行为。升级前已写入管理日志的配置请求优先按原身份、方法、请求键和移除 `requestId` 后的原始参数 digest 查询；已完成记录返回原配置，未知记录返回已受理且不重放。只有不存在旧记录的新请求写入 Thread 回执。

Desktop 在发送外层命令之前分配可恢复写入的原 `requestId`，复合命令的 `read|subscription|mutation` 效果与子操作声明集中在 `desktop-contract`。Core RPC 的效果和回执家族来自 Core `methodSemantics`。现有 pending 日志保存不可变原操作引用，outcomes 仅保存身份、受理及完成状态；普通会话结果不会复制完整历史。`status:failed` 仍可为 `accepted:true`，表示已经受理后的执行失败，不是未执行证明。创建返回原 `threadId` 和 `requestId`，本机日志或展示刷新故障不能推翻 Core 已确认结果。配置与所有 Task 写入沿用原请求键；旧 `localOnly` 配置记录只观察，不补造请求键或写 revision 屏障。

每个项目和客户端连接代际只有一个只读收据核对任务。按 0.5、1、2、4、8 秒间隔查询原 `areal/request/read`，单轮预算 30 秒；断连、生命周期操作或关闭时停止，重连、新 pending 或相关通知可以重新唤起。原响应仍在途时不抢先结算。缺失收据、单项查询失败或展示刷新失败不删除原 pending，也不阻止其它收据结算；不会重放任何未知写入。只有方法、请求键和已知目标一致的收据可以结算，创建类在同键同方法下绑定返回的新资源身份。

`openThread` 独占观察重试，包括连接仍健康时的读取超时；同一 Thread/连接共用一次有界恢复。权限、认证、大小和游标等确定性失败不自动重试。`observationErrors[threadId]` 使用独立 occurrence `id`、项目/Thread/连接代际、`reason`、`recovery` 与 `refreshPending` 描述读取故障，只在相应观察成功后清除；受理收据与读取故障分别投影。`pnpm --dir clients/gui run test:recovery` 验证真实 Core 上的创建刷新失败、晚到收据、健康连接超时、本机日志落盘失败及配置/Task 回执恢复。

`areal/turn/submit` 是普通会话的原子提交入口，使用 `{requestId,threadId,expectedConfigRevision,intent}`。`intent` 互斥取 `{type:"message",input}`、`{type:"continue",expectedTurnId}` 或 `{type:"edit",expectedTurnId,itemId,input}`，继续分支不接受文本。能力由 `features.ordinaryTurnSubmit=true` 和方法声明共同确认。Core 在 lifecycle、Thread、普通所有权锁内先查收据，再核验配置、归属、归档、压缩、取消结算及 UNKNOWN。Task、Goal、旧版只读 Side 和任务管理会话沿用其既有入口。可执行 Side v2 的新消息使用普通提交入口，编辑与继续仍受各自契约限制。

Edit 要求 `features.editLastMessage=true`，仅允许编辑空闲普通会话的最后一条用户消息，且队列无 pending/running 项。`expectedTurnId` 必须匹配最新轮次（包括继续轮次），`itemId` 必须匹配最后一条非继续用户消息。Core 展开归档历史，移除该消息及之后的条目/轮次，废弃上下文 checkpoint，并准备替代 Turn；校验、历史和收据一次持久化后才激活，拒绝时原历史保留。同轮追加指令之前的条目保留，已发生的文件和外部操作不回滚。提交后先发送 `areal/thread/edited {threadId,thread}`，明确替换客户端历史基线，再发送 `turn/started`；普通部分 Turn 事件仍按条目合并。掉响应核对原请求收据，不拆成撤回/发送两步，也不自动重发。

Message 保留输入原文。正常活动轮次存在时追加队尾；空闲且没有 pending 时直接创建 Turn。有 pending 时，Message 追加队尾并恢复队列，Continue 只恢复现有队列，均先处理当前权威 FIFO 顺序。没有 pending 的 Continue 在原 Thread 创建新 Turn，写 `continuedFromTurnId`，以可见继续意图承接历史和当前工作区。继续锚点必须是最后一个 `interrupted` Turn，或有明确中断事实、Core recovery UNKNOWN 证据的 `failed` Turn；普通模型失败与已完成轮次不符合条件。未经核查的工具、Hook、插件 UNKNOWN 或资源清理仍阻止执行。

直接执行返回 `{turn}`。排队返回 `{queueItemId,queueRevision,configRevision}`，其中 Continue 的 `queueItemId` 为 null，Message 的 ID 只指向本次新项。Turn、队列与收据在同一个快照提交后才激活或通知调度器。`areal/request/read {threadId,requestId}` 查询同一方法的收据；掉响应或客户端日志清理失败保留原键，不使用新键重放。基础 `turn/start` 和 durable `areal/turn/start` 拒绝越过 retained pending 或 running 项。

turn/start/enqueue 使用 `{requestId,threadId,input,expectedConfigRevision?,interactionMode?}`。队列最多 128 历史项，每项冻结配置；仅成功自动推进，Stop/失败/UNKNOWN/重启/drain 暂停，必须显式恢复。超时后先 request/read 或读权威状态，不能推断没发生副作用。

可选 `turn/start.admissionGuard: {configRevision,ordinarySession:true}` 在冻结配置和持久化 Turn 前原子检查配置版本与普通会话当前所有权。托管子会话、活动或结算中的 Goal、排队/运行/等待中的 Task Run 以及未结算 worker 均拒绝准入；完全结算的历史或仅未来调度不占有 Thread。已归档会话、暂停或未结算队列及既有 busy/UNKNOWN/工具宿主检查仍是准入屏障。Core 保持 Task 预留锁直到持久化激活完成。enqueue 不接受此 guard；`ordinarySession:false` 无效。能力由 `features.turnStartAdmissionGuard` 声明。

可选 `thread/start.admissionGuard: {ordinarySession:true}` 在创建 Thread 或启动 Workflow 前检查实际解析的显式/默认 Profile。绑定 Workflow 的 Profile 返回参数错误 `-32602`，消息以 `UNSUPPORTED_PROFILE:` 开头。已受理的 guarded 创建重放返回原 Thread，不再尝试启动 Workflow。能力由 `features.threadStartAdmissionGuard` 声明。省略 guard 保持既有本地行为；省略字段保持旧收据摘要不变。新 guard 检查之前先查询收据，同参数已受理请求返回记录结果，不重新判定变化后的状态。

`areal/thread/observe` 在 `thread` 旁返回 `ownership: {kind: "ordinary" | "task", taskId?, runId?}`。`features.atomicObserveOwnership=true` 保证所有权、快照与订阅在同一 Thread → Tasks 锁内捕获。判定与普通准入共用：活动/结算中 Goal、受管/子 Thread、排队/运行/等待 Run 或未结算 worker 属于 Task；已结算的暂停/阻塞 Run、历史和未来调度本身不构成所有权。Task/Run 标识遵循既有 Task 与协调会话可见性授权；隐藏或无对应 Task 的所有权仍返回不带标识的 `kind: "task"`。同一 Thread 有多个 Run 预留时，标识只指向当前活动/结算中 Goal 对应的唯一 Run；没有这类 Goal 时，仅唯一候选 Run 可提供标识。无法确定唯一归属时仍返回不带标识的 `kind: "task"`。该投影不持久化到 Thread。

普通 Turn 的 start/enqueue/submit 在原子提交前已知的参数、配置、容量或输入能力拒绝，返回 `outcome.kind=rejected`、`recovery.kind=none`，不创建受理回执。Fork/Side 已知的来源、锚点、目标 Profile 与请求键拒绝也保留原 `reason` 并标记 rejected。存储失败、已受理失败或传输未知不据数值错误码推断为未受理；客户端继续核对原请求，不自动重发。

停止轮次、同步交互回答和 Task 问题回复在所有者锁内明确校验失败时，也标记 `rejected`。这三种控制的容量与存储失败仍保留不确定性：可能已经取消执行或完成部分持久写入，不能作为未受理或重发依据。

新建 `areal/thread/start` 的配置解析在创建线程前被明确拒绝时，同样返回 `outcome.kind=rejected`，不创建线程或受理收据。线程写入开始后的失败仍按原请求核对。

`areal/queue/steer` 使用 `{requestId,threadId,expectedRevision,queueItemId,expectedTurnId}` 将 pending 项原子转为指定活动轮次的引导。Core 在同一 Thread 锁下预留引导容量、校验目标轮次与输入，并将消息、队列状态 `steered` 和请求收据一次持久化后通知执行器；失败保留 pending 项。成功返回 `{queueRevision,queueItemId,turnId,itemId}`。执行沿用活动轮次的模型和模式；队列更新仍保留加入时配置。相同身份、业务键和参数返回原结果，参数变化冲突；`areal/request/read` 带 threadId 查询该收据。未知结果只查询、不自动重发。

Composer 队列在主输入区编辑消息：确认暂停后加载内容，保存更新原位置及附件引用，保留原模型/模式；保存或取消恢复原草稿。只有队列版本与暂停原因仍属于该次编辑时才恢复先前的未暂停状态。外部更新、删除或 UNKNOWN 保留编辑草稿，不自动覆盖或恢复旧状态。现有未发送 File 草稿在当前 GUI 进程内跨任务切换保留，不新增磁盘附件缓存。`pnpm --dir clients/gui run test:queue` 使用隔离 Electron/Core/Runtime 和确定性 HTTP/SSE 模型验证队列路径。

`EffectiveConfig.defaultModelRevision` 是可选的不透明默认模型快照引用。桌面创建会话或显式重选隐式服务默认模型时固定该引用；后续参数、权限等配置更新保留它。没有桌面配置的通用会话仍在 Turn/队列项提交时固定默认版本。显式 Provider 选择保存自己的模型和 Provider 快照。模型版本归数据目录所有，不包含环境凭据值。

服务启动时，旧桌面会话的隐式模型若尚无版本引用，且最后一个已受理 Turn 保存了隐式默认版本，则将该引用恢复到会话并持久化。没有这些历史证据时保留未知。读取历史不重新配置或发送消息。`thread/inspect` 的可选 `modelName` 和 `resolvedParameters` 从已有模型归档投影隐式模型的安全名称与有效参数；缺少历史版本元数据时返回 null，不使用当前默认名称冒充历史。

thread/configure 使用 expectedRevision，仅空闲且不压缩时生效。resetModel=true 清除会话模型覆盖并回到 Profile/服务默认，不能与非空 model 同传；parameters 省略保留，`{}` 按模型默认、Provider 默认依次解析。`parameters.reasoningEffort:null` 清除强度覆盖；客户端需在同一 parameters 对象中带回其他参数才能保留它们，省略字段重新采用默认值。Composer 的“使用模型默认”会带回其他参数。若模型默认是 high，结果仍为 high。`selectedSkills` 可传 Skill 的 `{id,revision}` 列表，空数组清除会话覆盖并恢复 Profile；列表必须属于当前 Profile。features.modelReset 声明支持。

`areal/thread/start` 使用 `{requestId,agentProfile:{id,revision},cwd?,model?,parameters?,dynamicTools?}` 创建按指定 Profile 冻结配置的 Thread。客户端可以用 `--agent id@revision` 传入同一引用；不需要再指定 Workflow。Profile 的 `workflow` 字段是 Agent 属性，创建 Thread 时自动启动一次并在快照 `desktop.workflowRun` 中记录 Workgroup ID 与启动状态；实时状态通过 Workgroup API 查询。相同 requestId 重试和恢复 Thread 不会重复启动；绑定 Workflow 的 Profile 只能在创建 Thread 时选择，不能通过 `thread/configure` 切换。没有 Workflow 的 Profile 不要求 Workgroup policy，仍可使用其 `toolAllowlist` 允许的工具。

`areal/provider/upsert` 接受可选 `Provider.modelParameters`，以目录中的模型 ID 映射既有 `ModelParameters`。原 `models` 仍为字符串数组。未知映射键或无效参数拒绝整次更新。生成参数依次采用显式 Thread 配置、已配置模型默认、Provider 模型元数据、Provider 全局默认；上下文报告与用户预算按下文单独解析。选定的 Provider 快照保留该元数据；省略映射保持原契约。端点 `context_window` 表示默认容量，`max_context_window` 不会自动启用更大窗口。 `contextSource:"account"` 标明账号目录，其余报告默认为 `provider`。

自定义模型可声明可选 `capabilities:{tools,vision,reasoning,reasoningEffortOptions?}`，经 `Provider.modelCapabilities` 按模型 ID 传入；未知模型键或无效声明拒绝更新。省略声明保留原协议行为。关闭工具后不发送工具定义，也不受理返回的工具调用；关闭视觉后拒绝图片输入；关闭推理后不发送推理参数。`reasoningEffortOptions` 为不重复的允许值子集，可选 `none/minimal/low/medium/high/xhigh/max`。空列表或省略采用原有六档，关闭推理时目录选项为空。

`areal/model/list` 的每项 `parameters` 是 Core 按模型默认、Provider 默认合并的参数；`isDefault` 标识新会话的服务默认选择。显式 Profile 模型仍优先于全局默认。Composer 在发送前显示具体模型与有效思考强度，完全未设置强度时显示“供应商默认”，显式 `none` 显示“无”。“使用模型默认”只清除当前强度覆盖，不绕过模型或 Provider 已保存的默认值。新会话只保留本次未发送草稿的选择，创建成功后清除；历史使用会话当前已保存的选择，已有 Turn 快照不变。

`areal/model/list` 还返回本实例的 `lastAcceptedModel`（无记录时为 null）：`{acceptedAt,model,modelId,reasoningEffort}`。`acceptedAt` 为 Core 受理时间（Unix 微秒），`model` 为供应商模型引用或隐式服务默认的 null，`modelId` 为实际模型名；`reasoningEffort=null` 与显式 `"none"` 不同。用户主会话的 `areal/turn/submit` 及显式 `areal/turn/start|enqueue` 将记录与受理收据写入同一 Thread 快照，并在响应/原收据中返回该字段。重复查询不刷新时间，后台执行不更新。桌面服务按时间汇总各项目的记录，持久保存新会话偏好；它不是已有会话配置的所有者。

可选 `parameters.reasoningSummary` 接受 `auto` / `concise` / `detailed`，仅用于 Responses，按 Provider 默认 → Thread 参数合并；Provider/服务默认与 Thread 都未配置时不启用摘要请求。`areal/model/list.parameterCapabilities` 只在 Responses Provider 下包含 `reasoningSummary`，表示适配器支持传参，不保证供应商的每个模型都支持所选模式。`areal/model/list.reasoningEffortOptions` 返回自定义能力声明的允许值，未声明时返回现有 HTTP 适配器允许的 `none/minimal/low/medium/high/xhigh`（其他适配器为空），同样不保证远端每个模型都支持。Composer 从目录读取这些选项，通过原会话配置提交参数。事件与分段规则见 [Core 思考进度](core.md#思考进度)。

options.readOnly 收窄 Scope 写根和网络；toolAllowlist 收窄 Profile；preapprovedTools 不能取消部署强制审批，且只匹配当前工具名；预批准读取工具不会豁免它触发的 hook。maxModelRounds 为 1–1024，最后一轮仅交接，不等于团队请求预算。Profile/Workflow 定义使用不可变 id/revision；Skill 引用不冻结资源内容，见下文。

`features.automaticSessionName` 表示支持 `options.automaticSessionName: boolean`；`areal/thread/start` 与 `areal/thread/configure` 使用同一选项，省略或 true 保留自动命名，false 禁止后续命名请求。配置替换时客户端应保留已有选择；来源 Turn 的冻结配置、在途请求和恢复边界见 [Core 会话名称](core.md#会话名称)。

<a id="skills"></a>
### 有界历史显示

Desktop 在同步观察结果内一次安装会话内容、`thread.desktop.configuration`、队列与交互。显式模型不再重复读取三项元数据；历史隐式默认模型仍按其保存 revision 查询展示名称与有效参数。最新轮多页补全先累积页面，结束时合并到当时的实时模型，保留期间到达的增量，再发布内容。输入区加载占位沿用消息区和底部 Composer 的布局，提交与偏好提示不参与消息视口高度计算。

GUI 协商 `boundedObservation` 与 `boundedHistory` 后，普通、Side 和归档聊天统一使用 `areal/thread/observe {mode:"bounded",maxBytes:262144}` 建立显示基线。Core 明确返回 `HISTORY_BUDGET_TOO_SMALL` 时，仅增大一次到 1 MiB；仍失败则保留当前聊天的读取错误。`CoreClient` 对该次完整响应独立执行同样的字节上限，安装基线仍在同步 `onResult` 中完成。浏览器宿主恢复另须 `boundedResume`；不以附加工具替代原有宿主绑定。缺少新能力的 Core 保留完整历史兼容路径，不能提供分页容量保证。

Desktop 的只读 `history` 命令接受 `{projectId,threadId,viewId,operation:"acquire"|"loadOlder"|"loadItem"|"release",itemId?}`。仅 `loadItem` 接受 `itemId`；游标、预算与 Core 身份由 Desktop 持有。Messages 为每个阅读视图获取并释放独立 `viewId`，主聊天、Side 和子对话复用同一入口。加载旧页按 Turn/Item ID 合并到当前显示投影，保留读取期间的新事件。Fork 继承历史和 Side 参考快照继续保留原有来源契约。

显示缓存最多保留 8 个聊天窗口，每个保留最新基线和 4 个已加载旧页；更深翻页会释放靠近最新基线的旧页，并在消息流明确标出省略区间。最后一个阅读视图释放时删除旧页和显式展开内容；另一个 GUI 的同一聊天视图仍存在时不释放其内容，也不取消 Core 执行或删除持久历史。完整条目及正在拼接的条目共享 128 MiB 序列化字节预算。打开聊天不自动展开大型 `historyDeferred` 条目；用户点击“加载完整内容”后，Desktop 才按不超过 1 MiB 的响应分片校验 UTF-8 偏移、总长度和版本，完成后替换原占位项。显式展开会增加该条目的可见内存，预算不代表进程峰值内存上限。

旧页游标失效只重建对应聊天基线；条目版本变化丢弃已读片段并至多从 Core 提供的 `restartCursor` 重读一次。加载中保留真实占位项和进度，错误不伪装为 Agent 消息。自动文件变更摘要只读取已加载显示内容；大型工具记录尚未加载时明确提示先展开，不通过完整 `thread/read` 绕过预算。所有历史读取均不重放提交。

桌面 `workspace.turnReview` 使用不可变文件工具回执和前像构建历史比较。某个文件的版本链因格式化或其他外部编辑断开时，仅将该文件列入 `unavailableFiles: [{path,reason}]`，其余可验证文件继续返回 Diff 和行数。摘要明确标记部分统计；未验证文件不视为零改动，审查面板显式说明排除项。单次工具比较仍严格校验；不读取当前磁盘补齐历史，也不将版本链中间的外部修改归为工具修改。

Desktop 按已认证 socket 管理阅读视图，客户端断开会释放其全部引用；迟到的 acquire 不能恢复已关闭的视图，也不能释放另一客户端的同名视图。重建基线会让 Renderer 重新登记视图，不先释放。同一连接、未失效的重建保留已显示的上一轮边界条目，并在新基线补全追上之前沿用原显示边界，不在已显示内容上方重复出现恢复提示；“加载更早”读到的旧页仍随重建释放。会话内容与 `displayHistory` 同次发布。完成轮次后，如果显示历史超过 1 MiB，会重取有界基线，并释放旧页及显式展开内容，用户可再次按需读取；显式展开不能豁免后续完成历史的容量限制。

Desktop → Main 延续 256 MiB 单帧边界。发送端每连接最多一个正在发送的帧、一份合并后的待发状态，以及总序列化字节不超过 32 MiB 的有序普通回包队列。投影只在实际发送时编码；大条目状态等待发送回调后才发送下一帧，避免将合法大帧后的命令回包误判为慢消费者。发送错误、超时或队列超限关闭连接并释放缓存；现有请求超时仍生效。

### Core 崩溃后的受控恢复

Desktop 首先按相同 generation 查询状态并尝试重连。仅在 `status --recovery` 返回正向 Host 清理证明，且 applicationOwner、存活的客户端生命周期和新读取的配置均匹配时，才调用受控恢复；丢失回复后仍以原 generation 读取已记录的后继，不回退到 `ensure`。每个原 generation 最多两次受控 CLI 查询/恢复调用，每项目五分钟最多两个崩溃候选；`cleanupUnconfirmed` 读取等待最长 30 秒。派发和采纳前均复核生命周期、项目、客户端和退出状态。恢复后的 connect/reconcile 使用 `observeOnly`，Core 启动保留 UNKNOWN，不重放未知提交。权威证明和恢复接口见[本地共享服务](local-service.md)。

## 模型配置热应用

共享服务提供两个窄方法，能力以当前连接的 `areal/capabilities.methods` 为准。仅经过认证、具有 `manage` 和 `tools`、不受 Thread 范围限制的 `desktop-owner` 可以调用；观察者、普通模型客户端和独立无配置控制器的 Engine 不具有此能力。请求不能指定文件路径、Provider 元数据或任意进程环境。

| 方法 | 请求 | 作用 |
| --- | --- | --- |
| `areal/server/modelConfiguration/read` | `{requestId?,expectedGeneration?}` | 读取实际应用版本，或核查原请求。 |
| `areal/server/modelConfiguration/apply` | `{requestId,expectedGeneration,expectedApplied:{revision,sequence},targetRevision,credentials}` | 读取权威配置并在 Core 准入门内热应用。 |

`credentials` 是目标文件所引用的 `AREAL_CREDENTIAL_` 名称到秘密值的有界映射。只允许追加不可变引用，同引用异值拒绝；旧引用继续供已有任务使用。秘密只在可信请求与执行内存中存在，不写入配置、历史、摘要、日志或回执。普通启动环境变量不能通过此入口更新。

响应包含 `{serviceId,generation,applied:{revision,sequence},modelRevision,credentialStates,operation?}`。`applied.revision` 是实际提交的整个配置文件版本，`sequence` 在本代际成功应用后递增；它们不同于默认模型的 `modelRevision`。首次装配从序号 0 开始。Core 复用同一次受控文件快照进行版本与配置校验，拒绝过期目标、已变化的非模型部署、活动工作和凭据冲突，不调用 drain、不重启 Core 或 Runtime。现有 Thread、Turn 和队列保留原配置与凭据引用。

`operation` 使用原 `requestId`，状态为 `running`、`applied`、`rejected` 或 `unknown`，终态可带脱敏的 `result` 或 `error`。受理后的操作由 Core 持有，断线不取消提交。重复请求返回原结果，不重复发布配置；响应丢失先读取原请求。进程内回执有容量边界，代际改变或记录不可用不证明原请求失败，不能自动重发。客户端可核对新实例的当前就绪状态，但不能将其当成旧请求的回执。

多个 Core 各自应用并确认。GUI 的供应商“保存”使用已有持久化命令，按文件 CAS 保存后即可完成；运行中的任务不阻止保存，应用失败也不撤销已经保存的修改。桌面服务在任务结束或重连后尝试应用，忙碌时每两秒核对一次；明确的非忙碌失败停止自动重试，结果未知时只查询原请求。页面区分保存和生效状态，并保留新草稿的原始 CAS 版本。备用默认模型和删除供应商继续使用严格协调操作；已知部分失败可按文件 CAS 补偿，再应用恢复产生的实际版本，未知请求未查清前不得回滚。外部写入或新任务可能阻止补偿，此时保留实际应用版本与待应用状态。文件监听与显式应用共享已应用基线，非模型配置继续遵循安全重启边界。

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

文本及源码上传使用严格 UTF-8，拒绝 NUL、二进制控制字符与已知容器签名。空 MIME 或 `application/octet-stream` 先识别已支持的媒体签名，再校验文本；常见文本、JSON、YAML、CSV、Markdown 与源码 MIME 规范为 `text/plain`。空文件继续被拒绝。权威 `Input::File` 保留文件名、Blob URI 和原始字节；Core 用上传登记的 MIME 与字节投影为带文件名的文本，不能信任调用方的 `mime_type`。Chat Completions 与 Responses 共用该投影。新提交、steer、排队和队列编辑按投影后的正文及标签共同执行 1 MiB 文本预算与模型能力校验，超过则明确拒绝，不截断。历史回放与 fork 使用相同文本投影和有效输入能力，既有 Blob 仍保留 16 MiB 上限，历史上下文由原有模型预算管理。已受理请求的收据先于新校验返回。

contentItems 按顺序保存 inputText 或 arealMedia，实际字节进入模型。认证 RPC 拒绝宿主 localImage/localAudio 路径，使用上传返回的 areal://blob URI。不支持的模态明确失败。

`DynamicToolCall.execution.fileBefore` 是可选的 `MediaRef`，保存条件写入 `workspace://repo/` 文件之前的完整字节。Core 在 hooks 与文件版本别名解析后，通过 Runtime 每页读取最多 64 KiB，验证各页的完整 SHA-256、文件大小、连续偏移与最终内容摘要。完整前像最多 8 MiB，MIME 为 `application/octet-stream`，允许空文件和二进制。Core 先保存 Blob 和工具记录中的引用，再提交原 CAS 写入。捕获失败返回 `FILE_BEFORE_CAPTURE_FAILED`，并保留 `dispatch:"not_sent"` 与原始原因；捕获中断不表示文件写入结果未知。提交后的 UNKNOWN 继续禁止自动重放。

前像通过原 Thread 授权的 Blob GET 读取，归档、fork 与 GC 保留其直接历史引用。fork 验证摘要、字节数与 MIME。只有已确认成功的文件写入可以使用此证据重建历史 Diff，后像仍需匹配成功回执的摘要和大小。创建文件无需前像；旧记录缺少该字段时继续使用可验证的完整历史读取，证据不足则显示历史版本不可用，不读取当前磁盘冒充历史。

## 进程与保留

process/start 默认 lifetime=turn；thread 生命周期需 Profile allowThreadProcesses，写服务还需部署 allow-concurrent-writes。根 Thread 的受管服务使用 Runtime 已授予的桌面进程时长，普通 Turn 进程保留命令时长限制；只有可信命令 Scope 与 Runtime 根权限及其他预算一致时才分离两种时长。子任务、hooks 的任务 Scope 及额外收窄的 Scope 保留原祖先，不通过服务接口扩大授权。GUI 终端与手动启动的 GUI 进程默认继承父 Runtime 限额；显式 `timeoutMs` 只能收窄相应父限额，已知超额在持久受理前拒绝，不生成未知启动回执。受理后的 UNKNOWN 仍查询原记录，不自动重放。输入归因到认证身份，输出游标与清理沿用 Runtime。PTY resize 为实际 ioctl；pipe EOF 关闭 FD，canonical PTY 使用 VEOF，raw mode 不支持。

GUI 终端选择账户中可执行的登录 shell，缺失时依次尝试 `SHELL` 和 `/bin/sh`。桌面适配器提交交互登录会话的具体 argv，并通过字面 `/usr/bin/env` 参数设置 `SHELL`、`USER`、`LOGNAME` 和 `TERM=xterm-256color`。登录和交互初始化文件负责建立用户工具链环境。Runtime 保留现有环境过滤与权限。恢复读取原托管进程 argv。运行中的终端隐藏常规清理诊断，已退出或状态不确定的进程继续显示退出与清理事实。

面向模型的 `development_service_inspect` 只列出当前 Thread 的受管记录，或返回单条记录的 Runtime 当前状态与最多 16 KiB 输出。`development_service_start` 通过同一持久 process/start 所有者提交 thread 生命周期进程，请求身份由可信的 Core Thread、Turn 和工具调用 ID 生成。省略 `timeoutMs` 时继承已授权的服务父限额，不另申请固定 24 小时。Core 审批、Profile 权限和 Runtime 写入序列化检查仍然生效。启动结果未知时检查原记录，不自动重发。这两个工具不另建进程执行器，也不推断监听端口。

显式配置较长 `--desktop-process-timeout-ms` 时，已获 Profile 授权的根 Thread 服务使用部署生命周期 Scope，普通命令继续使用 `--command-timeout-ms` 的收窄 Scope。服务省略 `timeoutMs` 时继承父 Scope 的上限；显式值仍只能收窄。子 Thread 服务必须继承仍可确认的父 Turn Scope，父边界不可用时拒绝启动。命令与服务的 hook 参与 Scope 分别保留身份和 UNKNOWN 回执，关闭 Thread 时全部收尾。

旧 epoch 句柄为 STALE_HANDLE，不恢复活进程。Thread 进程清理未确认、活动组或压缩阻止 restartSafe。纯历史工具或 Hook UNKNOWN 不阻止停止服务，但原 Thread 继续前仍需检查。归档需空闲且队列/资源结算，释放热历史并保留磁盘和去重键；GC 在 drain 完成后扫描冷热引用，不能删除历史仍引用的 Blob。

事件使用 areal/ 前缀，包括 thread/configured/archived、plan/updated、queue/updated、goal/updated/cleared、interaction/requested/resolved、process/updated、server/draining。各自 revision 不可与输出 cursor 混用。未知模型窗口/usage 保留 null 或缺失，不猜测。示例见[直接协议验收](../examples/desktop-api.md)。

features.goals=true 表示服务支持 Goal，无需单独配置开关；Goal 事件遵循相同的权限与原子订阅边界。drain 关闭自动续轮准入并暂停目标；归档和显式上下文压缩要求先停止 Goal 并等待资源结算。

本地服务发现、独立于窗口的生命周期和 Desktop Main 接入使用[本地服务契约](local-service.md)。`server/status` 与 `server/drain` 新增返回 `activeGoals`（Thread ID 数组）和 `pendingQueueItems`（pending/running 队列项数量）。这是响应字段的向后增量扩展；restartSafe 仍描述执行清理，不代表没有待调度工作。

`server/status` 与 `server/drain` 还返回 `lifecycle={version:1,admission:"open"|"draining"|"closed",ifIdle:{allowed,reasons},settled:{allowed,reasons},executionOutcomes:{uninspectedUnknown}}`。结果摘要是 version 1 的增量字段，统计需要检查的历史工具调用或 Hook 调用，与物理资源结算相互独立。`unresolvedTools` 保留原有检查条目。`restartSafe` 等于 `settled.allowed`。

`reasons` 为 `{code,count}` 数组，code 包括 `activeTurn`、`resource`、`compaction`、`workgroup`、`activeGoal`、`queuedMessage`、`activeTask`。Core 共用观察和准入锁内的操作判定；观察不是停止授权。`ifIdle` 要求没有工作且执行已结算，`settled` 仅描述 cancel 的执行/资源结算后置条件。cancel 保留暂停 Queue 中的输入，不重新套用 pending 必须为零的前提。未检查的历史结果仍保留在 journal 中，并继续阻止原 Thread 续轮，但不阻止服务退出。Hook task scope 不确定、Runtime 观察不可用、活跃 Runtime 进程及未确认清理仍是资源阻塞。超时可能返回 draining，RPC 成功不证明进程已退出。未知版本、原因或缺失许可字段不能推断为允许。

共享服务的 `server/status.configuration` 返回 `{modelRevision,applied,appliedRevision,applySequence,currentFileRevision,credentialStates,pendingApply,restartRequired,error}`，其他部署为 null。`applied={revision,sequence}` 是 Core 已确认的文件版本。GUI 模型配置使用上面的显式热应用接口；普通 CLI 模型热更新缺失环境凭据时可同时返回 `restartRequired=true` 和 `error`，表示需要由持有有效凭据的本地客户端安全重启；其他加载错误不触发自动重启。`areal/server/configurationChanged` 向已订阅会话发布 `{threadId,configuration}`。`server/drain` 增加 `strategy="ifIdle"`：在同一准入锁内检查空闲并关闭准入，忙碌拒绝时保留任务运行。见[配置热更新](../guides/configuration.md)。

### Desktop 适配器生命周期

这是 GUI 适配器协议，独立于 `areal.core.v1`。认证 snapshot 的 `service.lifecycle` 声明 `{version:2,desktopGeneration,capabilities:{request,read,reconcile,kinds},activeRequestId}`，支持 stopDesktop、updateDesktop、stopProject、updateProject、interruptTurn。

`lifecycleRequest` 携带 `{protocol,requestId,kind,mode,expectedDesktopGeneration,expectedTargets,threadId?,turnId?}`；mode 为 ifIdle 或 cancel；targets 每项绑定 projectId/serviceId/generation。interruptTurn 必须指定原 threadId/turnId。`lifecycleRead` 与 `lifecycleReconcile` 只携带 protocol/requestId，后者仅核查原 Host 或原轮次，不调用 ensure、drain 或 cancel。

工作树聊天中，Main 在准备 interruptTurn 前，将所选逻辑项目和聊天解析到当前执行项目及 Core 实例。Main 的持久引用保留原逻辑项目，用于重复请求身份及界面阻断；请求 targets 保留实际 Core 代际。同一请求 ID 不能改绑其他项目。

Desktop owner 在副作用前保存持久回执，记录逐目标 Host requestId 与状态。整体 phase 为 acceptedPending、blocked、partial、admissionUnconfirmed、settlementIncomplete 或 completed。Desktop 停止的目标全部完成后，仅记录 desktopExit=requested；Main 核验原 Desktop 确实退出才显示完成。Main 在写入前持久保存原请求引用，不维护另一份执行权威。响应丢失或换代后读取原回执，已完成目标不重做；未知目标限制相关项目，其他项目保留可用。

应用退出前的资源观察使用 `purpose="quit"`。Desktop 保留完整所属目标范围，状态读取共享 5 秒预算，断连目标不先重连。连接不可用或读取超时的目标返回 `observation="unavailable"`，不填充空闲状态或空任务列表，并要求原生确认后提交原代际的 cancel 请求。确认后再次核对目标、代际和影响，观察可用性变化也会使确认失效。登记、归属、Core 明确返回的 RPC 错误和无效结果结构仍阻止操作。连接关闭仅表示观察不可用；Host 仍独立核验原身份和清理回执。更新与资源管理保留严格观察。

所有 Host 目标完成后，Desktop 等待库与配置写入并保存 `desktopExit=requested`，再关闭连接。Desktop 的 `before-quit`、SIGTERM、SIGINT 和已完成生命周期共用一个 5 秒收尾期限，覆盖连接关闭和连接元数据清理。超时记录退出原因与阶段，以非零状态退出并关闭所属生命期管道，不改写 Host 清理回执。外部退出和 owner 丢失只触发既有监督清理，不证明资源已完成结算。

普通启动只连接；GUI Main 的 serviceLifecycle 入口只接受 `{operation:update|stop|check}`。check 不改变执行状态。显式 update 先结算原目标并确认原 Desktop 退出，再启动替代部署；失败保留引用。旧适配器缺少上述能力时只读观察，不探测新写入、不跨层代取消。

## Task Mode 接入

GUI 的 `tasks` 只读命令支持 `operation: list | inbox`、可选 `projectId`、`limit`（1 至 1024）、UUID `requestId` 和非负整数 `viewEpoch`。省略 `projectId` 时仍汇总全部已保存所有者。指定时只读取该所有者，响应回传身份与 `owners` 终态；旧后台缺少这些身份时，GUI 要求安全更新后台，不将全局数据当作单所有者结果。每所有者从请求开始计时的 5 秒期限包含启动与全部分页。期限只结束目录读取，底层启动仍由既有生命周期管理；未结束读取跨重试复用，迟到结果不得继续分页或更新投影，失败保留上次完整结果。每页固定并检查 client 与连接 generation，重复游标视为失败。`[operation]` 日志记录 requestId、viewEpoch、projectId、阶段、耗时、页数、行数和终态；renderer 的 `[task-catalog]` 记录接收、提交或视图放弃，不记录任务正文或凭据。taskWatch 回执继续独立决定任务管理是否可用。

`task/create/list/read/pause/resume/cancel/subscribe/unsubscribe`、`channel/read/reply`、`inbox/list` 构成独立于 Thread 的任务控制与通信 API，详见 [Task 契约](tasks.md)。task/updated 通知携带 Task 投影和 channelSequence；客户端通过分页频道读取维护消息。server/status 与 drain 的 activeTasks 统计需要结算的任务工作：定时任务只在 Run 排队、执行、等待输入或子任务时计入，不计仅等待下一次触发的安排；暂停后仍在运行的定时 Run 继续计入。空闲定时安排可安全重启，保留时间、启用状态和历史。GUI/TUI/WebUI 可共享同一 Inbox；现有会话交互面板仍处理同步问题和审批。

可选 `parameters.contextWindowTokens`（1–2000000）设置用户工作预算。Provider 模型元数据保留服务报告窗口，实际工作窗口取两者较小值。上下文 budget 返回 `windowTokens`、`outputReserveTokens`、`inputLimitTokens`、`windowSource`，以及可选的 `reportedWindowTokens`、`reportedWindowSource`、`userBudgetTokens`。实际来源为 `account/provider/user/modelDefault/fallback`；报告来源仅为 `account/provider`。用户预算较小时仍保留原报告来源。订阅缺少报告时使用系统兜底，不采用公开 API 型号默认值。旧记录缺少新增字段时仍可读取。模型配置或凭据不可用时仍可查看上下文，budget 返回 null。这些值控制本地预检，不扩大供应商能力。

<a id="turn-fork-开发预览"></a>

## Turn Fork

`areal/capabilities` 默认声明 `conversationDerivationV1`，`preview:false`，并公布六个派生会话方法。Fork 支持主会话或 Fork 中已持久化 Turn 的 `before` / `after` 锚点，以及 `sharedCurrent` 工作区模式。创建、列表、恢复、历史与证据读取均执行现有身份、角色与准入校验；客户端按当前连接公布的方法及能力启用入口。

`areal/thread/fork` 接受 `{requestId,sourceThreadId,anchor:{turnId,boundary:"before"|"after"},workspaceMode:"sharedCurrent",target?}`。可选 `target` 使用 `agentProfile?`、`model?` 和 `parameters?` 选择普通配置；`{}` 使用当前部署默认配置，省略时冻结最后一轮继承历史的配置。`before` 不包含锚点 Turn；`after` 要求锚点已终结。前缀中的工具、Hook 与插件操作必须结算；UNKNOWN 须经来源检查。Core 从已提交来源记录与固定冷段读取锚点前缀；来源也是 Fork 时先扁平化其继承快照。Core 持久化目标自有快照、逐轮来源 ID 和创建收据，再公开一个空闲的独立 Thread/Session；目标本地 `turns` 起初为空，来源 Goal、队列、审批和执行宿主均不继承。创建不启动模型或工具，不修改工作区文件。相同业务键和参数返回同一目标，参数冲突的 `error.data.reason` 是 `REQUEST_CONFLICT`。创建和同键重试仅返回 `turns=[]` 的 Thread 摘要；当前历史通过目标的 read/observe 恢复。目标 `conversation.kind=fork`、`origin` 和 `historySeed` 是内容来源，不是 `parentThreadId` 委派关系。

`areal/conversation/history {threadId,view:"inherited"|"reference",cursor?,maxBytes?}` 按目标授权读取 Fork 继承项或 Side 参考快照，默认页预算 64 KiB、最大 256 KiB（包括整个序列化结果）。游标绑定目标、快照、历史层和位置，跨目标或层复用被拒绝。不存在对应历史层时返回空 data、snapshotId=null 和 complete=true。超大 Item 按 UTF-8 边界分页，fragment.text 是完整条目 JSON 的连续片段，带 offsetUtf8、nextOffsetUtf8、totalBytes；客户端拼接后解析，不产生执行事件。每个完整条目的 `turn` 保存原轮次的状态、错误、耗时与 Goal 展示信息（不含 items）；GUI 按轮次重组后直接复用主消息流，不增加继承历史折叠层。分支与轮次菜单仅在回复结束后和复制按钮一起展示。`areal/context/read` 和目标后续模型请求从持久快照与本地 Turn 构造逻辑历史，不读取来源实时会话。快照上限为配置的历史上限与 64 MiB 中较小者。工具批次、已结算回执、媒体和原始结果引用按历史事实保存，不登记为目标新执行或用量；目标只可读取其快照实际引用的 Blob。目标模型必须支持继承模态与 Provider 原生上下文格式；不支持时创建返回 `MODEL_MODALITY_INCOMPATIBLE` 或 `MODEL_CONTEXT_INCOMPATIBLE`，自动 Workflow Profile 返回 `PROFILE_NOT_SUPPORTED`。旧记录缺少 `conversation` 时仍按普通主会话读取；未知 kind 或不支持的版本拒绝恢复。

<a id="side-chat-开发预览"></a>

## Side Chat

### 可执行辅助对话

客户端同时确认 `features.sideExecutableV2=true` 与 `areal/side/create`、`areal/side/close` 方法后启用新入口。

新 GUI 使用 `areal/side/create {requestId,sourceThreadId,firstInput?}` 创建辅助对话。`firstInput` 是可选的普通输入数组；省略时创建空会话，不创建用户 Turn，也不请求模型。提供首条输入时，Core 将子会话、冻结历史、首轮和原始请求收据一起持久化，再启动执行。相同身份、请求键和参数返回同一子会话及可选首轮；结果未知时查询原收据，不重建会话或重发首问。Desktop 的 `side` 命令使用 `operation:"create"`，文字命令参数通过 `firstInput:{text}` 传入。

新会话保存 `conversation.kind=side`、`version=2` 和 `policy.kind=sideExecutableV2`。Core 继承来源当前已生效的模型、模式与权限配置，创建独立队列、交互、执行状态和收据。模型使用完整的稳定来源历史，界面只显示子会话自己的消息。来源正在生成时，只保留当前轮已提交的用户输入，排除其后尚未完成的助手与工具增量。来源继续推进不改变该快照，也不自动推进子会话。继承历史不复制 Goal、活动工具、审批或后台任务。后续输入、附件、工具、权限交互和压缩复用普通会话路径与限额。Goal、编辑重试和 fork 仍被拒绝。旧的只读 Side 不自动升级。

每个辅助对话有独立临时标签。划词只追加到同一来源当前激活的辅助标签；其他资源标签激活时创建新的辅助对话。主、辅 Composer 共享结构化引用，按来源与原文去重，单条最多 8,000 个 JavaScript 字符、每份草稿最多 8 条、总计最多 16,000 个字符。超限原子拒绝，已有正文与附件保留。发送只包含 `# userselect:` 和 `userselect` 代码块中的 `{text}` 数组，来源标识留在发送前 UI。裸 `/side` 与 `/btw` 创建空标签，带纯文字参数时创建并发送首问；含附件或结构化上下文时按主会话原路径提交。辅助对话不提供再次创建辅助对话的命令。

`areal/side/close {requestId,threadId}` 关闭可执行辅助对话。Core 在停止前持久阻止后续受理，取消该会话工作并等待结算和资源清理。关闭结果与原收据关联；清理未知不视为成功，也不自动重放。单关、关闭其他和全部关闭复用该入口。隐藏面板或切换来源任务不关闭会话；应用重启不恢复这些临时标签或草稿。历史和收据仍由 Core 保留。Esc 按键盘事件所属会话停止；侧栏打开时对话外 Esc 不停止任务，侧栏关闭后由主会话接收默认停止入口。弹窗、输入建议和已消费的 Esc 优先。

### 旧版只读 Side

下述 `areal/side/start`、`sideReadOnlyV1`、选区锚点及只读额度描述旧版记录和兼容入口。

`areal/side/start` 请求 `{requestId,sourceThreadId,anchor?,selection?,workspaceAccess:"none"|"readOnly",input:[{type:"text",text}]}`；`anchor` 可为 `latestCommitted` 或 `{kind:"turn",turnId,boundary:"before"|"after"}`，省略时选取首问受理时最后一个已提交 Turn。`selection` 可为 `{kind:"itemRange",turnId,itemId,startUtf8,endUtf8,textSha256}`，在冻结前缀的单个文本 Item 上按 UTF-8 字节范围及 SHA-256 摘要验证；重复原文按位置区分，边界、范围或摘要失效返回 `STALE_SELECTION`，首问未提交。对尚未落盘或无法精确映射的文本使用 `{kind:"userQuote",text,claimedTurnId?,claimedItemId?}`，持久标记为未确认用户引文，声明的 ID 不证明来源。`turn/after` 接受完成、失败和中断轮次，活动轮次返回 `TURN_NOT_TERMINAL`。空面板不创建 Thread。首问将目标独立 Session、不可变参考快照、首个 Turn 和业务收据一起提交，然后启动模型；同键重复请求在归档、历史移入冷段或重启后仍返回同一个目标与原首轮，不启动执行或取消归档。创建和同键重试返回 `thread.turns=[]`、`turn.items=[]` 的摘要，保留目标与首轮身份、状态和配置；完整历史从目标的 read/observe 恢复。提交后响应丢失时用 `areal/request/read {requestId}` 查找，不能改键重试。重启时已提交但尚未完成的轮次明确中断，不会重发首问。

Side 的 `conversation.kind=side` 与 `policy.kind=sideReadOnlyV1` 是持久角色，`none` 允许 Core 固定的 `side_context_read`，以及部署启用时的受保护回答发布工具 `gen_ui_publish`；`readOnly` 在创建时来源当前配置的工具允许集、身份授权、部署权限与受信任 Runtime 原生 `fs_read`、`fs_list`、`fs_stat` 和 `search_files` 的交集中读取当前工作区。历史锚点配置不扩大此授权；冻结后的工具子集跨模型配置、归档与重启保持不变。`areal/capabilities.features.conversationDerivationV1.sideWorkspaceAccess` 仅在原生路径沙箱、文件助手及搜索能力可验证且无命令 Hook 时公布 `readOnly`；否则创建明确返回 `WORKSPACE_READ_UNAVAILABLE`，用户可另选 `none`。Side Runtime Scope 仅在冻结子集包含文件工具时具有工作区读取根，否则读取根也为空；写入根为空且网络被拒绝；命令、MCP、插件、动态工具、Goal、自动 Workflow 与委派不能获得执行权限。文件读取返回 `source:"currentWorkspace"`、当前 SHA-256 与范围；同一轮次再次读取同路径时若 SHA 改变则返回 `changedSincePreviousPage:true`。目录和搜索也标记为当前工作区观察，不保证跨页原子快照。历史中的指令和工具输出都是参考数据。模型上下文只含有界最近摘录、证据引用和省略数量；追问仍使用创建时快照。`areal/side/context/read {threadId,evidenceRef?,cursor?,maxBytes?}` 受目标身份授权分页读取冻结证据，默认 8192 字节、最大 16 KiB；`evidenceRef` 与 `cursor` 不能同时传。GUI 证据阅读标明快照和确认状态，来源推进或无法查询当前状态时不会声称引用为最新。旧执行入口不能改变 Side 角色或扩权，`thread/list` 默认任务列表排除 Side。`turn/start` 和 `areal/turn/start` 仅接受文本追问，`turn/interrupt` 只停止 Side 当前 Turn；关闭 GUI 面板不发送中断。

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


## 插件包管理

以下部署级方法要求无限制的 `manage` 身份；限制到 Thread 的身份不能调用。Core 持有工作区、安装状态和范围选择，客户端不得自行改写安装文件。固定格式和阶段边界见[插件指南](../guides/plugins.md)与[实施计划](../development/codex-plugins-plan.md)。

| 方法 | 参数 | 结果/约束 |
|---|---|---|
| `areal/plugin/list` | `{}` | `revision/data/marketplaces/errors`；条目错误隔离 |
| `areal/plugin/read` | `id` | 包详情；候选版本/摘要与已安装版本/摘要/Skills 分开 |
| `areal/marketplace/add` | `root, expectedRevision, requestId` | 添加本地目录，更新安装目录版本 |
| `areal/plugin/importArchive` | `path, expectedRevision, requestId` | 导入本机 ZIP 为候选来源；返回包详情，不安装或执行 |
| `areal/plugin/install` | `id, scope, expectedRevision, source, expectedDigest, requestId` | `scope=user/project`；摘要必须匹配用户选中的来源快照 |
| `areal/plugin/configure` | `id, scope, enabled, expectedRevision, requestId` | 项目明确选择覆盖用户默认；停用撤销后续读取 |
| `areal/plugin/component/configure` | `id, component, enabled, expectedRevision, expectedDigest, requestId` | 当前项目的独立 Skill/MCP 选择；摘要绑定已安装副本，版本 CAS；返回包详情 |
| `areal/plugin/uninstall` | `id, expectedRevision, requestId` | 撤权；保留历史缓存 |
| `areal/plugin/setup` | `id, threadId?, requestId` | `{thread,turn,requestId}`；仅普通会话；显式选择已安装 onboarding Skill |

目录条目的 `version/sourceDigest/admissionDigest/skills/onboardingSkill` 描述当前候选；`installedVersion/installedDigest/installedSourceDigest/installedSkills/installedOnboardingSkill` 描述持久安装副本。`sourceDigest` 与 `installedSourceDigest` 是原包字节摘要。可空 `admissionDigest` 绑定已消费的市场条目定义和原包；候选审阅身份取 `admissionDigest ?? sourceDigest`。`installedDigest` 是已安装有效定义身份。安装必须同时提交选中 `source` 和审阅身份作为 64 位十六进制 `expectedDigest`。上下文候选拒绝仅提交原包摘要的旧客户端，不降级审阅。范围变更采用目录 `revision` 的 CAS；冲突或来源变化后重新读取，不隐式重试写入。

`component` 是 `{kind:"skill",id}` 或 `{kind:"mcpServer",id}`。Skill 使用现有稳定 ID；MCP 使用 `areal/plugin/mcp/list` 的命名空间 `serverId`。`componentChoices.disabledSkills/disabledMcpServers` 投影当前项目的关闭选择，缺省为空。选择按稳定身份跨更新保留，卸载清除。它们只收窄包声明、插件启用与 Profile 权限，不能授予额外访问。关闭 Skill 同时拒绝目录发现、保留版本读取和 onboarding。

`installedMetadata` 提供安装副本的 `name/displayName/description/version/interface/components`，供详情展示；候选来源审核仍使用候选字段。MCP 行的 `projectEnabled` 是项目选择，`config.enabled` 是结合声明后的有效配置。改变 MCP 选择撤销该插件的全部连接代与自动重连信任，启用的兄弟服务也须显式重连。旧工具与 App/资源请求在调用时检查当前关闭选择；普通包更新仍允许已受理旧代排空。持久关闭与 `cleanupUnknown` 可同时存在，失败回执不表示写入回滚，也不能重放未知写入。

写操作复用现有部署管理提交账本。同身份、同 `requestId`、同方法和参数返回原结果，异参数拒绝；结果未知通过 `areal/request/read {requestId}` 查询对应 `method` 的 completed `response`，不带 `threadId`，不重放。setup 另通过普通 Turn 准入固定权威 Skill 引用；包正文不能制造其他显式 Skill 选择。未支持组件只报告能力诊断，安装不启动 MCP/hooks/apps。AReaL 管理方法与已实现的实验 Codex 管理 wire adapter 共用 Store/Engine；两者保留各自的 wire 契约。

`areal/marketplace/add`、`areal/marketplace/addGit`、`areal/marketplace/remove`、`areal/marketplace/update` 和 `areal/plugin/uninstall` 在完整 `{"result":catalog}` 回执不超过 256 KiB 时返回原完整目录。超限的成功返回 `{"revision":N,"catalogRefreshRequired":true}`，表示变更已在目录版本 N 完成。相同请求重试和回执查询保留这个原始结果，即使目录随后变化或 Core 重启。`areal/plugin/list` 另行读取完整当前目录，版本可能晚于 N；它不替换历史回执。失败仍返回原错误。

### 组件支持报告

可移植 manifest 的 `extensions.org.areal.hostRequirements` 接受严格对象 `{"version":1,"tools":["browser_v1"]}`。未知字段、未知版本或无效工具名拒绝。工具要求投影为 `PluginDetail.requiredTools` 与每个 `InstalledSkill.requiredTools`，旧记录默认空列表。它们只限制实际会话 Skill 的准入和读取，不注册或授予工具。静态支持报告的 `declaredHostTools` 只表示尚需核对实际部署；桌面只读 readiness 使用已安装身份和当前部署工具，不证明 OS 权限。

`PluginDetail.componentSupport` 对应候选 `admissionDigest ?? sourceDigest`，`installedComponentSupport` 对应准确的 `installedDigest`。可空报告包含 `digest`、`manifestFormat`、`components`、`compatibility` 和 `validation`。尚未解析或来源不可读的候选没有报告；经校验且没有声明的包返回空组件列表。旧安装 State 缺少字段时，Core 从通过完整性校验的安装缓存重算。候选变化不会替换安装报告。

逐项记录包含 `kind`、包内 `sourceField`、`status`、`reasonCodes`、可空 `supportedSchema`、`required` 和 `activationRequirements`。kind 为 `skills`、`mcp`、`hooks`、`apps`、`commands`、`agents`、`uiSurfaces`。status 为 `supported`、`partial`、`unsupported`。Commands、agents 与 UI surfaces 保留独立声明记录，不导出命令、prompt、环境或凭据值。声明键限制为 256 字节，隐式路径限制为 1024 字节，报告最多 4096 项。超限拒绝候选，不静默丢项。

`supportedSchema` 只标识实际验证的解析契约。MCP 与 Hook 声明结构支持不证明运行配置、宿主策略、认证、平台行为或发行包已经通过验收。`validation.scope` 为 `staticParserContract`，provider、platform、distribution 保留 `unverified`。前提指向既有安装、启用、目标 Thread Profile、摘要信任、连接、认证、Connector 映射及 Hook 授权边界，不授予权限。通过 `areal/plugin/mcp/list` 和 `areal/plugin/hooks/list` 读取当前事实，同时匹配 `pluginId` 和 `installedDigest`。查看报告不会解析远端来源、启动代码或连接、认证、信任或调用模型。固定 Codex adapter 保持原有返回结构。

只有已识别的 portable 1.0.0 manifest 可以声明 `extensions.org.areal.componentRequirements`，严格结构为 `{"version":1,"requiredKinds":["skills"]}`，两个成员都必需。未知成员、版本、kind、重复、错误类型或超过七个 kind 均拒绝解析。兼容格式同名字段、MCP `required`、Skill dependencies 不具有包级必需语义。必需 kind 至少有一项声明，且该 kind 全部记录都须为 `supported`。缺失、partial 或 unsupported 返回 `compatibility.state=blocked`，原因分别为 `requiredKindMissing:<kind>` 或 `requiredKindUnsupported:<kind>`，否则为 `allowed`。

安装可以保留 blocked 包供检查，`enabled` 仍表示配置范围的意图。Store 既有有效选择从 Skills、组件、版本发布及执行检查中排除 blocked 包。历史 Skill 引用同时受当前包有效状态及其自身不可变包摘要的兼容性约束。允许的新版本不能放行曾被阻止的旧版本；兼容的历史引用仍可在更新后使用，停用、卸载或当前包被阻止会撤销使用资格。可选 unsupported 声明不阻止有效 Skill。动态信任或连接前提独立于静态门禁。

Hook 报告复用运行时声明选择与强类型文档解析，`mcp_tool` 是受识别的 MCP handler 类型。无效声明仍显示 partial 记录；已有规则选择的默认文档另列记录。Hook 的 `supportedSchema` 仅表示文档和 handler 字段结构，不证明 matcher 行为、平台命令、信任或执行结果。Apps 报告先按组件加载规则解析 manifest 路径数组，再识别文档中的单个字符串 `id` 对象、按 id 索引的对象映射和声明数组。静态连接器声明不证明映射、认证或连接已完成。

## 生成式交互回答

启用 `genUi` 的部署向主会话和 Side 提供原生工具 `gen_ui_publish {name,html}`。`name` 为最多 80 字符的小写连字符名称，`html` 为最多 48 KiB 的 UTF-8 HTML 片段。工具将制品存入受保护的不可变输出目录，返回 `{artifactId,path,digest}`。它不授予工作区写入、命令、网络或 MCP 工具权限。助手通过 `::visualize` 指令引用返回的精确路径。

只读方法 `areal/genUi/source {threadId,turnId,itemId,path?}` 返回已完成助手消息的 `{text,artifacts,readOnly}`。不传 `path` 时只读取消息，制品列表为空。Main 使用移植的解析器按指令偏移解码路径，再传入精确 `path` 读取至多一个制品。制品包含身份、来源 Turn 和调用、摘要、路径及 HTML。Core 从该 Thread 的成功发布记录核对来源、托管路径和 SHA-256。用户消息、代码片段、未完成回复或未发布的文件引用不能获得执行权限。 请求与响应契约均纳入生成的桌面 schema。电脑操作准备与外部 CUA Turn 结算的服务端请求/响应也纳入该 schema；能力发现与生成器复用同一服务端请求目录。

Desktop 在同一配置目录内保存 `{modelContent,privateContent}`，按真实执行工作区、Thread 和制品隔离；Worktree 的 GUI 保存与 Core 后续读取使用同一物理身份。单项序列化状态最多 16 KiB，会话最多保留 100 项，超出时淘汰最早更新的状态。页面通过 `window.zcode.widgetState` 读取初值，`setWidgetState({modelContent,privateContent})` 等待保存确认，`sendFollowUpMessage({prompt,title?})` 提出后续问题。主会话和 Side 的实际发送入口将最多 64 KiB 的 `modelContent` 列表附加为 `<untrusted_gen_ui_state>`，不附加 `privateContent`。状态保存本身不创建模型 Turn。页面后续问题等待状态保存，再交给宿主确认与原会话发送入口。未知受理只核对原收据，不自动重发。

生成页使用现有 MCP Apps token、代理与每窗口 8 页额度，不能访问 Node、任意文件、工具或网络。状态恢复限于同一 Desktop 配置，不提供跨设备同步。

## 插件来源、MCP 与桌面 Apps

新增方法保留无限制 `manage` 授权要求，参数类型见生成 schema。来源变更使用目录 CAS 与管理回执：`areal/plugin/resolve {id,expectedRevision,requestId}`；`areal/marketplace/addGit {url,refName?,sparsePaths?,expectedRevision,requestId}`；`areal/marketplace/remove {root,expectedRevision,requestId}`；`areal/marketplace/update {expectedRevision,requestId}`。

`areal/plugin/connection {id,expectedDigest,connect,requestId}` 明确信任/断开已安装版本；`areal/plugin/mcp/list` 区分连接、认证、可选失败与清理状态。`areal/plugin/auth {id,server,operation}` 的操作为 `start/status/cancel`，返回瞬时认证状态，不是管理回执。`areal/plugin/connector/configure {id,connectorId,provider,credentialRef,expectedDigest,requestId}` 仅支持显式 GitHub 映射；凭据值只由可信启动器注入。

`areal/plugin/auth/configure {id,server,expectedDigest,configuration,requestId}` 仅持久化宿主凭据引用，要求已断开且摘要匹配，使用持久管理回执。configuration 支持 clientSecretRef/privateKeyRef/privateKeyId/clientMetadataUrl/apiKeyRef/callbackUrl；秘密值只通过可信启动输入注入。配置 revision 隔离替代/取消的认证流程。

`areal/mcp/apps/list {threadId?}` 返回完整工具元信息。`areal/mcp/app/open/request/close` 绑定 `threadId/serverId/instanceId/generation`；工具请求还绑定 `requestId`。`areal/mcp/extension/call` 的 kind 为 `settingsRead/settingsUpdate/settingsAction/mentionsSearch`。`areal/mcp/forms/list`、`areal/mcp/form/respond/preview` 验证完整待回复请求与来源服务器。`areal/mcp/tool/result {threadId,callId}` 读取已持久保存的原始 MCP 结果，模型只用剔除 `_meta` 的投影。

`areal/mcp/app/openFromResult {threadId,turnId,itemId,requestId}` 只接受精确 Core 记录身份，要求无限制 manage 授权。`areal/mcp/apps/list` 的 `requestEpoch` 用于组成 `result-v1.<requestEpoch>.<UUID>`。响应是 `{status:"open",instance}`、`{status:"closed"}` 或 `{status:"unavailable",reason}`；Main 将 open 映射为不透明页面描述符 `app`。Renderer 不提供 HTML、资源 URI、参数或来源证明。

Core 按 turnId 再按 itemId 读取成功完成的 MCP 记录，核对原始快照的长度与 SHA，再使用保存的有效参数和原始 MCP 结果。来源证明在原 MCP 调用时绑定插件摘要、连接世代、Thread、cwd 和 Apps 进程 epoch；发布页面前再次检查当前启用状态与原连接。页面准备只读声明资源，不再次调用原业务工具，也不新增工具 Turn。后续页面调用仍受原有 App 可见性和授权限制。

结果打开回执与实例共同保存在版本化 `mcp-apps.json`，一次原子提交；每个进程 epoch 最多 1024 条、每条最多 1 KiB、整文件最多 8 MiB，回执不逐出。满额后仍可重试旧请求、关闭和撤权。相同请求不同来源冲突，同来源并发共享实例；关闭原子终结全部别名，旧请求只返回 closed。新 UUID 才表示显式重开。旧 epoch 总是失效。UNKNOWN 保留原请求；未知关闭立即撤销页面 token，并保留原关闭意图直至核对完成。

文件授权只来自可信 Main。已认证的非 `desktop-owner` 不能提交 `fileResource` 或私有 `ui/host-file`；App bridge 不暴露这个私有方法。实际写入回执的方法名为 `areal/mcp/app/file/write`，通过既有 `areal/request/read {requestId}` 查询。通知新增 `areal/mcp/app/notification`、`areal/mcp/tool/result`、`areal/mcp/form/requested`；桌面共享服务保留实例和连接版本，旧窗口不得接收其他实例事件。

原生 Main 使用 `areal/mcp/form/resource/prepare {threadId,requestId,fieldName}`、`stage {selectionToken,requestId,paths}` 和 `release {threadId,requestId,fieldName,uri}`。prepare/stage 要求带认证的 desktop-owner，通用 Renderer 命令不能调用；stage 按 UUID/参数进入已有管理账本，UNKNOWN 只查原收据。路径和 selection token 留在 Main/Core，Renderer 只见不透明 URI。现代 discovery 协商 MRTR，逐轮保留参数并将 requestState 留在私有层。

固定 Codex0.162.1 的 `plugin/list/installed/read/install/uninstall/reconcile/search` 与 `marketplace/add/remove/upgrade` 共享包所有者。只有 `plugin/search` 需要 initialize 的 `experimentalApi:true`。没有配置私有托管服务时，share/remote catalog 返回 `-32004` 与 capability；不返回伪空成功。`marketplace/add {source,refName?,sparsePaths?}` 已支持顶层 sparse cone 路径和更新保留；完整 hooks 与其余边界见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

### 有限页面工具

`areal/mcp/app/tools/register`、`revoke`、`claim` 和 `resolve` 要求无限制的 `manage` 与 `tools` 授权。参数与响应由 `core/protocol` 类型生成。页内工具不能通过通用 Renderer 管理转发调用这些接口。

注册是可信 Main 对原页面已完成 SDK initialize 的证明。声明仅包含 `version:1`、`documentId` 和唯一的 `getSelection`、`applyPatch` kind，不接受自定义名称、schema、描述或执行代码。Core 生成带 registration 命名空间的工具名与 schemaDigest，并在普通 Turn 准入时冻结。工具只进入原 Thread 的有效目录，沿用普通权限、hooks、结果预算和 ToolCall 历史。只读 Side、研究任务和未获授权的受限 worker 不继承这些工具。readOnly 声明不授予权限。

| 操作 | 输入中的身份 | 结果 |
| --- | --- | --- |
| `register` | `threadId,instanceId,generation,ownerId,declaration` | `registrationId,documentId,tools`，每项包含 kind、name 和 schemaDigest |
| `revoke` | `threadId,instanceId,generation,registrationId,ownerId` | `revoked:true`，先撤销目录与新 claim，再结算在途调用 |
| `claim` | `threadId,turnId,callId,registrationId,ownerId,schemaDigest` | `granted` 带 claimId、kind、documentId 和有效 arguments，或 `notGranted` 带 reason |
| `resolve` | 同一调用身份、可选 claimId 和 reply | 持久提交后返回 `accepted` |

`reply` 只接受 `completed` 加规定结果、`noEffect` 加 `cancelled/closed/unavailable` 原因，或 `unknown`。`getSelection` 返回文档 revision、anchor、head、有界 selectedText、truncated 和 dirty。`applyPatch` 接受 `expectedDocumentRevision` 与 `{from,to,insert}`。成功证据包含前后 revision、原始范围、插入长度和 dirty；冲突或拒绝明确表示未修改。所有偏移与长度使用 UTF-16 单位，LF 占一个单位。拒绝 CR 插入与截断代理对的偏移。

Core 绑定原始实际 ToolHost、App epoch、Thread、实例、MCP generation、插件摘要、registration 与 schema。Desktop 服务在打开响应返回前绑定原 Main socket；ownerId 只是服务生成的句柄。相同 principal 或已知 ID 不能转移归属。Main 再验证原窗口、token、epoch 和初始化 mount。`pending` 与 `cancelled` 通知仅发往原 socket，只含关联身份，不授予执行。

Core 先保存普通调用意图、运行审批及 hooks，再发布待领取调用。claim 必须持久保存后才能返回唯一执行许可。单次 invocation 串行处理领取与结算，端点不独立写历史。相同终态内容重复提交只查询原收据，异内容冲突。已确认终态及结果快照不受后续 hook 错误、反馈或通用 finalizer 覆盖。

领取前取消是确定未执行。领取后仅有效完成证据或原执行端的 `noEffect` 可确定结果，超时、abort 或连接丢失不能证明未修改。取消排空一秒后无证据则保存 UNKNOWN，重启与重开均不重放。任一原连接替换都会撤销工具执行，保留未保存页面。安装包摘要变化同样撤销旧页面工具的目录与新领取许可，旧实例不能重新登记；保留页面不表示恢复执行权限。只有显式新打开的实例可以重新登记，隐藏但有效的页面仍可执行。

Desktop 在撤销后保留原归属 32 秒，供已领取调用结算。确认撤销或关闭后释放记录；无法确认时仅保留不含连接引用的身份标记。归属记录总计最多 128 条，达到上限时拒绝新绑定。注册不能使当前 Thread 的有效工具目录超过现有 128 工具上限；终态 resolve、revoke 与关闭使用保留控制容量。

v1 每实例一份登记、每 Main 八份、每 Core Host 32 份、每 runtime 128 份。每页最多两个在途调用、每 Host 16 个，Host 参数合计最多 128 KiB。声明最多 1 KiB，documentId 最多 64 字节，单次输入和输出各最多 32 KiB。文档最多 65,536 UTF-16 单位，替换和返回选区最多 4,096 单位，截断必须标记。领取期限十秒，领取后执行期限三十秒，取消排空一秒。既有页面请求预算和 2 MiB 资源限制保持有效。该能力不提供 sampling、跨设备编辑或任意页面执行平台。

## 插件 Hooks

以下管理方法要求无限制 manage 身份；使用已有部署提交账本。

| 方法 | 参数 | 结果 |
|---|---|---|
| `areal/plugin/hooks/list` | `{}` | `data` 中逐来源列出 installedDigest、definitionDigest、definitions、诊断与信任；配置来源还有 sourceKind/origin/enabled |
| `areal/plugin/hooks/configure` | `requestId,id,expectedDigest,definitionDigest,enabled,trusted,allowReadOnlyCommands?` | 核对当前安装/来源和整份计划摘要后保存独立定义信任；失配拒绝；禁用/撤信任取消已受理调用 |
| `areal/hook/acknowledge` | `requestId,threadId,invocationId,inspection` | 空闲目标自有 UNKNOWN 的有界检查说明；保留 UNKNOWN，不重放 |

显式 `AgentProfile` 可声明 `allowPluginSkills:true`；省略或 false 维持既有排除。它允许该 Profile 参与普通会话的插件 Skills/MCP/hooks，仍要求当前包与定义的独立信任。子任务必须同时继承父任务的插件范围，不能以 Profile 选项恢复父任务已禁用的能力；只读 command hooks 仍需单独的 `allowReadOnlyCommands` 同意，Side、研究和 nativeTaskAgent 不因此开放。角色输入 `agent_type` 使用已受理 Profile 的 id，未选角色及内部自动 Skill 发现 Profile 使用 `default`；SubagentStart/Stop matcher 与输入共用该身份，子任务 Pre/PostCompact 同样携带 `agent_id`/`agent_type`。

`allowReadOnlyCommands` 省略时默认为 false，已有信任元数据也默认 false。它只独立授予普通只读子会话的 command handler，仍绑定当前包/来源和定义摘要。每份定义返回 `readOnlyCommandTrusted`，MCP handler 始终为 false。Side、研究任务、nativeTaskAgent、只读根会话和禁止插件 Skills 的 Profile 继续排除。Core 过滤继承计划并在执行前检查当前权限。限定 hooks 要求 Runtime 确认 `restrictedScopeIsolation`：工作区/包只读，仅私有子任务 scratch 和本插件 data 可写，禁止网络和 provider 秘密继承；data 父目录/叶目录被重定向时拒绝，授权保留固定路径身份。配置来源不获得包根/data 授权。省略或清除此选项移除该能力，并保守取消该包/来源全部在途调用，包括可写 hooks；撤信任/停用移除两项同意并取消已受理调用。

`desktop.hookRuns` 保存每次 invocation 的包/定义摘要、event、turnId/toolUseId、Runtime operationId、outcome、asynchronous、delivered、output 和 inspection。`areal/hook/completed` 是刷新提示，权威恢复仍读 Thread 快照。未知结果未检查时新轮次被拒绝；关闭中的 Session 也拒绝新执行。

`turn/steer` 新增可选 `requestId`；提供时与 `areal/queue/steer` 一样把 hook 与提交结果包含在持久去重边界。相同身份/方法/key/参数等待原执行或返回已存结果；不同参数拒绝。`areal/request/read {requestId}` 查询部署收据，带 threadId 的查询也附带该身份同 key 的部署记录。旧客户端省略 key 可继续调用，但不能保证丢失响应后的单次重试。并行管理操作按 key 排队，日志总预算 8 MiB，为每个 accepted 操作预留最多 256 KiB 响应及记录余量；无法预留时在执行前拒绝，不截断旧收据。schema 的相应方法与投影由 `make desktop-schemas` 生成。

评价命令通过可信桌面后端执行；Renderer 不能指定接收端、归属或上下文。契约与限制见 [user feedback](../guides/user-feedback.md).

## 桌面轨迹开关

GUI 服务的窄命令 `trajectory` 支持 `{operation:"status"}`、`{operation:"retry"}` 和 `{operation:"setEnabled",enabled:boolean,expectedRevision:string}`。启停要求当前文件的 64 位小写 SHA-256，不接受配置路径、目的地址或认证覆盖；桌面适配器固定使用与 Core 相同的配置和凭据环境。状态读取不解密凭据，也不进入任务准入计数。启停立即应用上传控制；采集设置只在 Core 空闲、无排队任务且没有其它配置变化时，复用安全应用的 `ifIdle` 排空与重启。响应的可选 `capture_apply_pending` 和 `capture_apply_error` 分别表示等待应用及应用问题；客户端不能把它们显示为就绪开启。远端分析和归档状态不由该开关推断。

## 桌面供应商连接诊断

桌面 `providers` 命令的 `discover` 与 `probe` 在网络初始化或请求失败时返回固定的 `error.code` 和操作提示。

| `error.code` | 诊断 |
| --- | --- |
| `PROVIDER_NETWORK_DNS` | 域名解析失败 |
| `PROVIDER_NETWORK_REFUSED` | 服务或代理连接被拒绝 |
| `PROVIDER_NETWORK_TLS` | TLS 证书验证失败 |
| `PROVIDER_NETWORK_TIMEOUT` | 请求超时或取消 |
| `PROVIDER_NETWORK_PROXY` | 代理设置不可用 |
| `PROVIDER_NETWORK_REDIRECT` | 服务返回被禁止的重定向 |
| `PROVIDER_NETWORK_UNAVAILABLE` | 其他网络或初始化失败 |

诊断不包含原始异常、上游文本、地址查询参数或凭据。HTTP 401/403 继续返回认证提示，其他 HTTP 错误保留状态码；无效流式回复继续返回模型与协议提示。Responses 探测仍向已保存端点发送 `input`、`store:false` 和 `stream:true`，并要求有效文本及成功终态。

模型设置的 API Key 默认依据 `credentialStates` 显示固定掩码。点击眼睛通过认证的本机桌面入口请求 `providers {operation:"revealKey",id,expectedRevision}`；后台校验供应商和当前配置版本，只返回该供应商的 `{apiKey}`，不接受凭据引用或路径。远程控制不支持此操作。查看值只在当前表单短暂显示，隐藏、切换供应商、配置版本变化或离开页面后清除；迟到响应不能恢复显示。查看不产生草稿或写入，保存只包含用户新输入的替换值，成功保存后清空。目录、状态广播和持久化回执不包含查看明文，读取失败只返回固定提示。留空保留现有凭据，输入新值替换。保存成功后按实际回执显示已保存、等待生效或已保存并应用；连接成功仍由单独的探测确认。

`providers` 的 `discover` 支持尚未保存的 `connection:{protocol,baseUrl,credential}`。`credential` 可以是 `{kind:"none"}`、`{kind:"draft",value}` 或 `{kind:"saved",providerId,expectedRevision}`。已保存凭据按供应商与当前文件版本解析，草稿密钥仅用于该次请求；获取模型不写配置或凭据，原有按供应商 ID 获取的入口保留。

供应商目录返回整体及各项目的 `application`，其 `kind` 为 `saved`、`applied`、`deferred`、`unknown` 或 `failed`，并携带目标 `revision`。`deferred.reason` 区分 `busy` 与 `disconnected`；`failed.message` 是脱敏错误。`pendingApply` 继续表示尚有项目未确认当前保存版本。明确失败按目标版本及服务代际保留，显式重试、新版本或新服务代际才能再次尝试。

## Desktop 后台命令兼容

共享 Desktop 的 `areal.desktop-service.v1` 认证快照新增 `service.commandContract: "areal.desktop-commands.v2"`。这项声明来自驻留 Desktop 代码，与 Rust Core 的能力独立。Main 将精确匹配结果投影为顶层及每个项目的 `desktopCapabilities.currentCommands`，不采用旧快照自行声明的同名投影。

缺失或未知命令声明不阻止只读接入；停止原后台另需独立的 lifecycle version 2 能力。Main 对需要当前语义的 `send`、`continue`、`prepareCreator`、`feedback`、携带 MCP 内容的 steer/队列更新、新增插件管理操作、`providers.defaultAndApply` 和 `trajectory.setEnabled` 在发出前返回 `SERVICE_COMMAND_UNSUPPORTED`。这是已知未提交，不带未知提交标记或伪造的请求 ID。兼容的队列操作继续使用原业务请求键；不退回另一种写操作。评价草稿读取、偏好及 MCP Apps/表单轮询按这项可用性降级，保留本地草稿。

命令 version 2 还要求创建、配置和 Task 写入保留原调用者身份及规范化的受理/执行结果。Main 在旧 version 1 上分配业务请求 ID 之前拒绝这些写入；已有只读观察和旧队列/追加指令核查仍保留。

## 外部 CUA 客户端结果

Core 的 `externalCua` 能力表示支持原始 CUA 工具结果与轮次清理。受信任工具宿主可在动态工具响应中提供可选 `rawMcpResult`，值是原始 MCP CallToolResult。Core 使用已有 MCP 投影器和媒体物化，将原始包保存在持久结果的 `mcpResult` 字段；`structuredContent` 保持原始 schema 校验目标。媒体结果沿 MCP 的 8 MiB 持久接收预算，而不是一般混合 client 结果的 16 KiB 预算。投影、媒体或持久化失败属于 UNKNOWN，不能据此重发工具。

`ClientOptions.externalCua` 默认 false。GUI 仅为手动新建的 LCU 聊天设置 true；Core 据此为 js/js_reset 增加可信身份与轮次清理。普通动态宿主使用相同工具名不会改变原有行为。

## Cloud 配置与会话生命周期

Cloud 设置只接受 `status` 和 `save`，不提供会分配资源的 `check`。固定地址为 `/openapi/v1/app-server/`；桌面可信适配器用持久化的 Cloud Session UUID 派生 workspace endpoint。打开新 Cloud 聊天只编辑本地草稿，首次发送才提交 `cloudSession/create`、建立原生 thread 并投影真实连接状态，query 直接使用该连接。创建请求 ID 必须符合 UUID 的 8-4-4-4-12 十六进制布局，在保存或派生 workspace 前校验。服务端回收后的断线不自动重连；下一条用户消息或显式“恢复连接”恢复原 endpoint、thread 和 UPFS；断线前仍显示运行中时可显式恢复并读取权威历史，避免旧状态阻塞发送。已提交但结果未知的 Turn 不自动重发。旧会话 endpoint 保持绑定，不因修改服务地址而迁移到新工作区。
