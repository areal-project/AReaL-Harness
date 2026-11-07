**中文** | [English](workbench-service.en.md)

# 工作台服务

A3 将桌面后台整体交给 Host 监督。Main 以客户端身份连接，窗口、系统加密、浏览器和电脑控制仍由 Electron 外壳提供。决策见 [ADR 0017](../adr/0017-one-protocol-one-ui.md)，工作包见[一套协议规格](../development/one-protocol-spec.md)。领域协议与原生能力接线尚未全部完成，不能据此宣称 A3 已验收。

## 所有权与迁移

Worktree、资料库、任务目录等共用项目连接、会话生命周期、写队列和 journal。逐领域重建这些依赖会复制后台。因此先复用 `CoreBackend` 与 `DesktopService`，由 `services/workbench/src/backend-main.cjs` 启动，再按需把单项目逻辑下沉 Core、跨项目逻辑改写进 Host。搬运与改写分开；对应路径验收后才删 Main 的旧实现。

公共客户端只连接 Host。后台保留已认证的私有 attach 监听供 Main 连接，它不是浏览器或手机的业务入口。项目连接与监督统一归 Host，后台经有限的 `core.request` 白名单读写 Core。Main 的领域回退也使用绑定原附件的 Host 连接；观察与终端使用独立租约，断开不会关闭其它客户端的项目连接。Core 与 Runtime 的权威和清理责任保持不变。

`areal.oneProtocol.domains` 含 `backend` 时启用 Host 后台，切换需重开应用。Main 在初始化后台前读取开关；关闭时仍走原进程内路径。数据目录保持原 GUI 目录，Host 核对已登记的导航来源和 Core 路径，不搬数据。一个 Host 当前只接管一个后台配置；配置不一致拒绝复用，不静默切换来源。

`CoreBackend`、`DesktopService` 与运行时依赖闭包位于 `services/workbench/src/desktop`；轨迹与反馈位于 `src/domains`，资料库暂存写入器从 `src/host-library-store.ts` 构建为 CommonJS。后台通过 `@areal/workbench-service` 加载，Host 接管与 Main 回退共用唯一实现。Main 保留应用配置、连接客户端和原生生命周期客户端；部署身份包含服务源码、拆分协议与生成的写入器。服务包是 GUI 的显式 workspace 依赖，由现有依赖分发器连同资源和依赖闭包装入 `app.asar`，不依赖 `Resources/areal-workbench` 向兄弟归档隐式解析模块。

## 进程监督

Host 复用 `workbench_route.rs` 与 `workbench.rs` 的监督机制，分别监督统计服务与桌面后台：

- 本机认证控制方法 `backend.ensure` 启动或复用后台，`backend.status` 返回 Host 代次、PID 与后台身份，不返回私有连接令牌。浏览器不能调用这两个控制方法。
- 启动参数经私有管道传入；子进程清空环境后仅保留运行所需变量。后台使用原用户 home，数据目录以显式 options 为准。
- 发行布局从签名应用的 `Resources/areal-workbench` 发现入口，验证签名与清单，使用包内 Electron 的 Node 模式。源码 debug 布局可从相邻仓库发现服务并使用 PATH 中的 Node，无须构建 GUI 安装包；发行构建不接受此发现路径。
- 子进程以 `ready` 帧报告方法和身份；启动超时为 20 秒。首次观察到的异常退出允许立即恢复，10 分钟窗口内的后续失败按 1、2、4…秒退避，累计 5 次失败后不再自动重启。
- Main detach 不结束 Host 后台。Host 停止时关闭管道，后台等在途操作结束后退出；5 秒仍不退出则终止本次子进程。
- 重启前确认旧子进程结束。只清理 Host 明确记录的旧后台身份，不能覆盖其他后台的 `service.json`。恢复观察和快照，不重放写请求。

## 协议与回执

Host 与服务通过私有 Unix socket pair 传送逐行 JSON，带 `version: 1`，单帧上限 64 MiB。公共客户端仍受自己的协议帧上限限制。方法在 `schemas/areal-host-protocol-v1.json` 登记为 `x-owner: workbench`，还必须在 Host 白名单及服务 `ready` 中出现；没有通用后台 RPC。`lifecycle.dependencies.lifecycleGeneration` 只读投影当前生命周期代次；Worktree 删除把原 Host 停止回执嵌入既有桌面生命周期回执，不改变停止或恢复语义。

`library.command` 接受有界的整理操作：重命名、置顶、分区、移动、排序、拖放、已读、隐藏项目及导航显示偏好。请求必须绑定 `sourceId` 并匹配当前后台，不能把另一个 GUI 来源的整理误写入当前资料库。成功回执返回与导航读模型同样过滤的资料库状态，不透传桌面配置或缓存正文。Host 在副作用前写入 journal，以主体和 `commandId` 隔离回执。相同语义的重复请求返回原回执；同 ID 不同语义报 `COMMAND_CONFLICT`。没有可信回复的操作保持 `submissionUnknown`，`command.read` 查询原 ID，不自动重发，也不退回 Main 重做。当前无法从后台补证的 UNKNOWN 会一直保留，不能显示为成功。

这些领域方法目前只经本机回环连接开放。普通浏览器须经本机认证的 `web.approve` 显式获得范围，旧授权默认只有 `observe`。共享界面单独按资料库能力开放整理入口，不因此打开发送、归档或原生入口。`manage` 才允许资料库整理和统计导入，不能因此获得提交或审批能力。浏览器回执按设备隔离，撤销授权后连接失效。远程 Noise 设备的跨项目领域授权尚未接通，不能复用本机授权绕过项目范围。

`worktree.read` 与 `worktree.command` 复用原 Worktree 的列举、设置、环境配置、创建、读取、打开、取消、动作和删除实现，保留领域 `requestId` 与既有生命周期记录；Host 写回执绑定方法、来源和参数，不能用相同 ID 改做其他操作。`tasks.read` 复用目录的 list、preview、observe、inbox；preview 保留 published/unobserved 语义，不因浏览目录启动已停止的 Core。当前两个领域在本机浏览器要求 manage，远程项目范围授权仍待接通。

`manage.read/command` 复用后台原实现，只开放有界的管理操作。读包含任务读取、调度上下文与预览、任务列表与收件箱、运行记录、插件（列表、详情、组件、hooks、MCP）、配置（服务状态、Profile、Skill）、进程列表与输出、执行与 Workgroup/Workflow。写包含任务编辑、暂停、恢复、取消、删除与停止在途 Run，线程归档、资源关闭、计划更新、权限撤销、空闲排空与 GC、执行应用与取消、Workgroup 取消、插件与 marketplace 管理、进程启动与终端写操作、上下文压缩。沿用后台查找执行 owner 及 Core 回执校验；客户端未提供领域 `requestId` 时用 Host `commandId`，保留原请求查询身份。终端写操作和上下文压缩属于提交行为，另需 `submit`；执行、Workgroup 取消与停止 Run 另需 `interrupt`。新建任务、回复问题、立即运行与新建会话要等 Host 工具中转落地后再开放；插件归档导入与归档选择属原生文件选择，插件凭据与连接、hook 与 tool 审批确认、MCP 表单与应用、GenUI 源、按路径或 URI 读取执行产物、供应商设置（独立 `providers` 域）和 Goal 编辑均不经 manage 提供。结果按结构联合校验，不能把它当作通用 RPC 入口。

`providers.read/command` 复用供应商列表、模型发现、探测、保存、应用、默认模型和删除，绑定本机浏览器的 manage 授权及来源。`revealKey` 不向浏览器开放。Host journal 只保存操作身份、语义摘要和结果，不保存原始参数；草稿 API Key 只经认证连接和后台私有管道传递，持久凭据仍由 HostVault 管理。

启用 `pages` 领域后，`pages.command` 与 `pages.resource` 复用原 MCP Apps/Gen-UI 宿主，页面会话归已鉴权的 Host 连接。连接身份由 Host 注入，页面 token 不能跨连接使用；页面事件只发给原 owner。断开先撤销现有请求，再结算迟到打开回执与页面工具租约，不登记原生 `computerHost`，不写含页面参数的 journal。重连只能重新打开来源，不能收养旧 token 或重放未知页面请求。

本机 `gui-write-v1` 及配对来源与后台一致的远程会话，在 send/enqueue 与 steer 受理前，经私有 `input.prepare` 复用后台 `genUiText` 的状态投影；只有 modelContent 进入有效输入，privateContent 保留在页面状态。Host 按原始请求去重，把准备后的输入冻结在原 journal 中；重复命令不重新读取状态。未绑定桌面后台的旧入口保持原行为，已绑定后台失联则明确失败。Host 项目 ID 先经已绑定 source 的权威绑定转为后台 alias，再由后台解析线程执行项目。

私有 `execution.prepare` 复用页面宿主的供应商与工具准备，send/enqueue 与 steer 的 Core 派发由 Host 共享连接执行。带 Worktree 的创建仍经后台薄适配衔接 Host 原生准备与绑定；后台的 Core 请求同样经过 Host。创建准备与原 `createThreadInProject` 共享实现，发送沿用 `ensureBrowserTools` 和 `browserEntrypoints`；Host 冻结原 Core requestId/参数并写 journal，后台只消费一次性页面宿主句柄。句柄绑定原 Host 连接、项目/线程、Core 代际、client 与原生 owner；失败或断开不重放。浏览器发现和页面认领沿原 Main attach 回调，断开原 Host 连接会撤销其入口、发现计划与认领。原生窗口行为仍需桌面端验收。 远程普通新建、发送和引导使用相同执行路径，仍按原设备、项目和 submit 授权校验；仅凭项目别名相同不能取得其他来源的后台。连接结束会撤销后台入口，已发布客户端的请求形状与权限预设不变。工具宿主断开后的确定拒绝通过 Core 的 `TOOL_HOST_UNAVAILABLE` 原因映射为 Host `CAPABILITY_UNAVAILABLE`；保留原命令回执，不自动重发。

资源经认证 WebSocket 分块读取，每块最多 192 KiB、单资源最多 8 MiB。公开 `/host/pages/proxy` 仅含固定代理代码，外层与内层均为不带同源权限的 sandbox；页面 HTML 和资源不进入公开 HTTP 路由。Gen-UI 固定资源沿原白名单读取后内联，页面继续受原 CSP 限制。当前仅开放本机回环连接，要求 `gui-write-v1` 与 manage；手动打开 MCP App 与页面 JSON-RPC 请求另需 submit。这是保守的阶段授权，尚未覆盖仅有 submit 的普通设备或远程 Noise。原生文件选择和打开仍属外壳能力。

## Rust 领域实现与回退

桌面后台启动参数 `rustDomains` 来自 `areal.oneProtocol.domains`，接受 `library-rust`、`execution-rust`、`tasks-rust`、`worktree-rust`。这些选项用于选择领域实现，改变后需要重启后台；原 `backend` 接管开关与原领域入口保留。关闭某领域的 Rust 选项使用原路径，不重放该路径上已有的 UNKNOWN 请求。新路径仍需完成对应环境验收，不能仅以编译通过视为退役条件。

本表描述启用 Rust 领域时的所有权。旧 JS 领域实现保留供关闭开关时回退；Core 连接与进程监督不随领域开关回退。

| 领域 | Rust 权威 | JS 保留的职责 |
| --- | --- | --- |
| 资料库 | Host 同步事务执行导航整理，由 Core 通知与同代已观察进度的权威快照更新未读和导航摘要；保留未知桌面设置 | 设置校验和页面投影；只读云会话归属及尚未提交状态 |
| 执行与恢复 | Host 持有 Core 连接与租约，Core 核对原请求回执；Host 汇总生命周期回执 | 阅读窗口、页面工具和输入状态准备 |
| 定时任务 | Core 管理任务与配置草稿，Host 聚合目录、published 预览、收件箱及观察状态 | 已选供应商输入准备和目录展示 |
| Worktree | Core 执行 Git 与进程操作，Host 管理跨项目归属、环境配置与生命周期记录 | 页面工具准备与结果投影 |

Host 的资料库事务从原位置读取完整 JSON，在同一同步段中校验、修改并原子写回；导航公开回执仍经同一过滤器。桌面设置仅在有界字段上按原值比较替换，Host 不解释代理、硬件加速等设置。Worktree 设置与环境配置复用同一资料库事务，不能另建文件写者。

Core 通过 `features.taskPrepareCreate` 声明创建前预约能力，Host 仅为声明能力的 GUI 来源 Core 以 `areal/task/host/ready {prepareCreate:true}` 登记支持；CLI 来源沿用原准入。能力绑定原 Host 连接；Core 在定时任务校验后、持久化和调度发布前，经原 `areal/task/prepare` 的 `intent:create` 请求 Host 核对目录作者并保存原创建请求与执行锚点的预约。原请求已完成时直接返回既有回执；创建结果丢失时只按原 Core 回执绑定 Task，不重发。旧空 readiness 请求仍使用原语义。

固定共享 Scratch 保留一个 Core 登记根，每个定时任务占用一个真实直接子目录；省略 `cwd` 时使用原创建 requestId 的规范 UUID 子目录。Host 严格核对来源登记与分配根，按子目录保存原请求、摘要和锚点作者记录。已有任务仅凭唯一匹配的 Core 创建回执恢复，缺证时不重发。其他子目录的活动只有在有界完整快照可归属且前后状态一致时才不阻塞当前目录；目录重叠、未知归属或快照变化均拒绝执行。

`worktree.thread.prepare` 从原 Core 保存的部署中返回已应用的资源 profile 与 revision，后台仅据此恢复可重建投影。原创建绑定期间，资源检查仍比较当前选择与该部署；发生变化时保留原请求并拒绝继续，不隐式重启 Core 或把原绑定换到新代次。

`areal tasks` 与 `areal worktree` 经本机 Host 协议提供原生目录入口，不依赖 GUI 或 Node。CLI 默认使用 Host 原生来源 `host`；项目先经 `areal host` 登记。读取停止项目的任务预览使用 published 目录并保留 unobserved，显式 observe 才请求实时状态；私有任务观察只使用既有连接，不重新启动已停止项目。写操作保留领域 requestId，Host commandId 与创建 Worktree 的 requestId 分开，避免取消或打开原工作树时与创建回执冲突。

CLI 打开带环境脚本的 Worktree 时，通过 `worktree open --agent id@revision` 显式选择已部署、允许线程进程的 Profile，执行项目仍受原并发写授权和进程预算约束；不由 Host 自动提权。`worktree --command-id <原 ID>` 可重复原参数核对已受理命令，不能换 ID 重放 UNKNOWN。 本机 CLI 的 `--source <已登记 GUI 来源>` 同样支持显式 Profile，但仍要求当前后台绑定该来源且启用 `worktree-rust`；关闭该 Rust 域时在准入前拒绝此参数。浏览器与远程继续使用不含 `agentProfile` 的公共合同。

收口预算 `workbenchConvergeLines` 只统计待迁移资料库、提交恢复、历史观察、生命周期、服务协议、任务目录、任务草稿和 Worktree 模块。既有其余 JS 按精确路径保留；新文件和改名文件默认计入，基线不得增长，也不得新增排除路径掩盖迁移代码。协议方法仍必须同时登记 schema、Host 白名单和服务 ready；私有反向调用不成为公共 RPC。

## 资料库与统计

后台由 Host 托管时，强制由 Host 单写原位置的 `library.json`。关闭 `library-rust` 时，后台生成同目录暂存文件，再经 `library.write` 按内容摘要比较替换；冲突后重读重算。启用后导航整理直接在 Host 事务中执行，不由后台生成暂存文件。Main 不能通过关闭 `library` 开关恢复第二个写者。未启用后台接管时，原 `library` 开关仍控制单写切换。

统计方法为 `analytics.read`、`analytics.sync`、`analytics.activity`、`analytics.import`。同步通过 Host 的共享 Core 连接白名单读取 `thread/list` 与 `thread/read`；Host 转发轮次事件但不为事件单独启动服务。客户端每 5 秒上报活跃状态，服务取并集；Main 旧活跃时间按天取较大值合并。未启用领域时保留旧统计路径。

## 原生能力与凭据

后台入口不依赖 Electron。Main 经原有连接提供原生能力，系统加密通过 `encryptionRequest/encryptionResult` 回调；请求绑定持有能力的连接，其他客户端不能结算，断开后请求失败且不重放。原加密文件格式不变，解密失败不能覆盖旧文件。运行所需的解密值只在内存使用，不写入日志、URL、argv 或明文文件。真实 macOS safeStorage 与既有密文兼容需要独立的本机验收。

`trajectory.read/command` 与 `feedback.read/command` 复用后台原实现，要求本机浏览器 manage 授权与来源匹配，写入沿用 Host 回执。轨迹状态不解密凭据，重试与反馈调用沿用后台的 HostVault 和供应商凭据环境；凭据不返回网页。统计服务的 `vault.read` 当前仍拒绝所有 slot，不能把它当作后台凭据通道。接收端鉴权和实际反馈提交仍需独立验收。后台 attach 与工具能力登记不能替代原生工具的真实桌面验收。

## 验证边界

共享业务以 Web 和真实 Host/Node 进程、隔离数据为主要验收环境，不以 GUI 打包为常规前置。`pnpm --dir clients/gui test:workbench-backend` 覆盖普通浏览器公钥配对、资料库写回执及后台崩溃、Main detach、Host stop 的进程边界；它不替代浏览器页面交互验收。只有窗口、系统加密、浏览器视图、电脑控制等 Electron 专属路径需要启动桌面端。发行资源发现、签名和升级仍需在对应发行任务中单独验证。
