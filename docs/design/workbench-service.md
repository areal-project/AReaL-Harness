**中文** | [English](workbench-service.en.md)

# 工作台服务

A3 将桌面后台整体交给 Host 监督。Main 以客户端身份连接，窗口、系统加密、浏览器和电脑控制仍由 Electron 外壳提供。决策见 [ADR 0017](../adr/0017-one-protocol-one-ui.md)，工作包见[一套协议规格](../development/one-protocol-spec.md)。领域协议与原生能力接线尚未全部完成，不能据此宣称 A3 已验收。

## 所有权与迁移

Worktree、资料库、任务目录等共用项目连接、会话生命周期、写队列和 journal。逐领域重建这些依赖会复制后台。因此先复用 `CoreBackend` 与 `DesktopService`，由 `services/workbench/src/backend-main.cjs` 启动，再按需把单项目逻辑下沉 Core、跨项目逻辑改写进 Host。搬运与改写分开；对应路径验收后才删 Main 的旧实现。

公共客户端只连接 Host。后台保留已认证的私有 attach 监听供 Main 连接，它不是浏览器或手机的业务入口。后台暂时沿用原项目连接与监督契约；已经拆出的统计领域经 Host 的 `core.request` 读取，不另建项目连接。两种过渡路径不改变 Core 与 Runtime 的权威和清理责任。

`areal.oneProtocol.domains` 含 `backend` 时启用 Host 后台，切换需重开应用。Main 在初始化后台前读取开关；关闭时仍走原进程内路径。数据目录保持原 GUI 目录，Host 核对已登记的导航来源和 Core 路径，不搬数据。一个 Host 当前只接管一个后台配置；配置不一致拒绝复用，不静默切换来源。

`CoreBackend`、`DesktopService` 与运行时依赖闭包位于 `services/workbench/src/desktop`；轨迹与反馈位于 `src/domains`，资料库暂存写入器从 `src/host-library-store.ts` 构建为 CommonJS。后台通过 `@areal/workbench-service` 加载，Host 接管与 Main 回退共用唯一实现。Main 保留应用配置、连接客户端和原生生命周期客户端；部署身份包含服务源码、拆分协议与生成的写入器。服务包是 GUI 的显式 workspace 依赖，由现有依赖分发器连同资源和依赖闭包装入 `app.asar`，不依赖 `Resources/areal-workbench` 向兄弟归档隐式解析模块。

## 进程监督

Host 复用 `workbench_route.rs` 与 `workbench.rs` 的监督机制，分别监督统计服务与桌面后台：

- 本机认证控制方法 `backend.ensure` 启动或复用后台，`backend.status` 返回 Host 代次、PID 与后台身份，不返回私有连接令牌。浏览器不能调用这两个控制方法。
- 启动参数经私有管道传入；子进程清空环境后仅保留运行所需变量。后台使用原用户 home，数据目录以显式 options 为准。
- 发行布局从签名应用的 `Resources/areal-workbench` 发现入口，验证签名与清单，使用包内 Electron 的 Node 模式。源码 debug 布局可从相邻仓库发现服务并使用 PATH 中的 Node，无须构建 GUI 安装包；发行构建不接受此发现路径。
- 子进程以 `ready` 帧报告方法和身份；启动超时为 20 秒。异常退出按 1、2、4…秒退避，10 分钟内 5 次失败后不再自动重启。
- Main detach 不结束 Host 后台。Host 停止时关闭管道，后台等在途操作结束后退出；5 秒仍不退出则终止本次子进程。
- 重启前确认旧子进程结束。只清理 Host 明确记录的旧后台身份，不能覆盖其他后台的 `service.json`。恢复观察和快照，不重放写请求。

## 协议与回执

Host 与服务通过私有 Unix socket pair 传送逐行 JSON，带 `version: 1`，单帧上限 64 MiB。公共客户端仍受自己的协议帧上限限制。方法在 `schemas/areal-host-protocol-v1.json` 登记为 `x-owner: workbench`，还必须在 Host 白名单及服务 `ready` 中出现；没有通用后台 RPC。

`library.command` 接受有界的整理操作：重命名、置顶、分区、移动、排序、拖放、已读、隐藏项目及导航显示偏好。请求必须绑定 `sourceId` 并匹配当前后台，不能把另一个 GUI 来源的整理误写入当前资料库。成功回执返回与导航读模型同样过滤的资料库状态，不透传桌面配置或缓存正文。Host 在副作用前写入 journal，以主体和 `commandId` 隔离回执。相同语义的重复请求返回原回执；同 ID 不同语义报 `COMMAND_CONFLICT`。没有可信回复的操作保持 `submissionUnknown`，`command.read` 查询原 ID，不自动重发，也不退回 Main 重做。当前无法从后台补证的 UNKNOWN 会一直保留，不能显示为成功。

这些领域方法目前只经本机回环连接开放。普通浏览器须经本机认证的 `web.approve` 显式获得范围，旧授权默认只有 `observe`。共享界面单独按资料库能力开放整理入口，不因此打开发送、归档或原生入口。`manage` 才允许资料库整理和统计导入，不能因此获得提交或审批能力。浏览器回执按设备隔离，撤销授权后连接失效。远程 Noise 设备的跨项目领域授权尚未接通，不能复用本机授权绕过项目范围。

`worktree.read` 与 `worktree.command` 复用原 Worktree 的列举、设置、环境配置、创建、读取、打开、取消、动作和删除实现，保留领域 `requestId` 与既有生命周期记录；Host 写回执绑定方法、来源和参数，不能用相同 ID 改做其他操作。`tasks.read` 复用目录的 list、preview、observe、inbox；preview 保留 published/unobserved 语义，不因浏览目录启动已停止的 Core。当前两个领域在本机浏览器要求 manage，远程项目范围授权仍待接通。

`manage.read/command` 复用后台原实现，只开放有界的管理操作。读包含任务读取、调度上下文与预览、任务列表与收件箱、运行记录、插件（列表、详情、组件、hooks、MCP）、配置（服务状态、Profile、Skill）、进程列表与输出、执行与 Workgroup/Workflow。写包含任务编辑、暂停、恢复、取消、删除与停止在途 Run，线程归档、资源关闭、计划更新、权限撤销、空闲排空与 GC、执行应用与取消、Workgroup 取消、插件与 marketplace 管理、进程启动与终端写操作、上下文压缩。沿用后台查找执行 owner 及 Core 回执校验；客户端未提供领域 `requestId` 时用 Host `commandId`，保留原请求查询身份。终端写操作和上下文压缩属于提交行为，另需 `submit`；执行、Workgroup 取消与停止 Run 另需 `interrupt`。新建任务、回复问题、立即运行与新建会话要等 Host 工具中转落地后再开放；插件归档导入与归档选择属原生文件选择，插件凭据与连接、hook 与 tool 审批确认、MCP 表单与应用、GenUI 源、按路径或 URI 读取执行产物、供应商设置（独立 `providers` 域）和 Goal 编辑均不经 manage 提供。结果按结构联合校验，不能把它当作通用 RPC 入口。

`providers.read/command` 复用供应商列表、模型发现、探测、保存、应用、默认模型和删除，绑定本机浏览器的 manage 授权及来源。`revealKey` 不向浏览器开放。Host journal 只保存操作身份、语义摘要和结果，不保存原始参数；草稿 API Key 只经认证连接和后台私有管道传递，持久凭据仍由 HostVault 管理。

启用 `pages` 领域后，`pages.command` 与 `pages.resource` 复用原 MCP Apps/Gen-UI 宿主，页面会话归已鉴权的 Host 连接。连接身份由 Host 注入，页面 token 不能跨连接使用；页面事件只发给原 owner。断开先撤销现有请求，再结算迟到打开回执与页面工具租约，不登记原生 `computerHost`，不写含页面参数的 journal。重连只能重新打开来源，不能收养旧 token 或重放未知页面请求。

本机 `gui-write-v1` 及配对来源与后台一致的远程会话，在 send/enqueue 与 steer 受理前，经私有 `input.prepare` 复用后台 `genUiText` 的状态投影；只有 modelContent 进入有效输入，privateContent 保留在页面状态。Host 按原始请求去重，把准备后的输入冻结在原 journal 中；重复命令不重新读取状态。未绑定桌面后台的旧入口保持原行为，已绑定后台失联则明确失败。Host 项目 ID 先经已绑定 source 的权威绑定转为后台 alias，再由后台解析线程执行项目。

创建、send/enqueue 与 steer 的私有 `execution.prepare/dispatch` 复用后台 Core 连接。创建准备与原 `createThreadInProject` 共享实现，发送沿用 `ensureBrowserTools` 和 `browserEntrypoints`；Host 仍冻结原 Core requestId/参数并写 journal，后台只消费一次性句柄。句柄绑定原 Host 连接、项目/线程、Core 代际、client 与原生 owner；失败或断开不重放。浏览器发现和页面认领沿原 Main attach 回调，断开原 Host 连接会撤销其入口、发现计划与认领。原生窗口行为仍需桌面端验收。 远程普通新建、发送和引导使用相同执行路径，仍按原设备、项目和 submit 授权校验；仅凭项目别名相同不能取得其他来源的后台。连接结束会撤销后台入口，已发布客户端的请求形状与权限预设不变。工具宿主断开后的确定拒绝通过 Core 的 `TOOL_HOST_UNAVAILABLE` 原因映射为 Host `CAPABILITY_UNAVAILABLE`；保留原命令回执，不自动重发。

资源经认证 WebSocket 分块读取，每块最多 192 KiB、单资源最多 8 MiB。公开 `/host/pages/proxy` 仅含固定代理代码，外层与内层均为不带同源权限的 sandbox；页面 HTML 和资源不进入公开 HTTP 路由。Gen-UI 固定资源沿原白名单读取后内联，页面继续受原 CSP 限制。当前仅开放本机回环连接，要求 `gui-write-v1` 与 manage；手动打开 MCP App 与页面 JSON-RPC 请求另需 submit。这是保守的阶段授权，尚未覆盖仅有 submit 的普通设备或远程 Noise。原生文件选择和打开仍属外壳能力。

## 资料库与统计

后台由 Host 托管时，强制由 Host 单写原位置的 `library.json`。后台先生成同目录暂存文件，再经 `library.write` 按内容摘要比较替换；冲突后重读重算。Main 不能通过关闭 `library` 开关恢复第二个写者。未启用后台接管时，原 `library` 开关仍控制单写切换。

统计方法为 `analytics.read`、`analytics.sync`、`analytics.activity`、`analytics.import`。同步通过 Host 的共享 Core 连接白名单读取 `thread/list` 与 `thread/read`；Host 转发轮次事件但不为事件单独启动服务。客户端每 5 秒上报活跃状态，服务取并集；Main 旧活跃时间按天取较大值合并。未启用领域时保留旧统计路径。

## 原生能力与凭据

后台入口不依赖 Electron。Main 经原有连接提供原生能力，系统加密通过 `encryptionRequest/encryptionResult` 回调；请求绑定持有能力的连接，其他客户端不能结算，断开后请求失败且不重放。原加密文件格式不变，解密失败不能覆盖旧文件。运行所需的解密值只在内存使用，不写入日志、URL、argv 或明文文件。真实 macOS safeStorage 与既有密文兼容需要独立的本机验收。

`trajectory.read/command` 与 `feedback.read/command` 复用后台原实现，要求本机浏览器 manage 授权与来源匹配，写入沿用 Host 回执。轨迹状态不解密凭据，重试与反馈调用沿用后台的 HostVault 和供应商凭据环境；凭据不返回网页。统计服务的 `vault.read` 当前仍拒绝所有 slot，不能把它当作后台凭据通道。接收端鉴权和实际反馈提交仍需独立验收。后台 attach 与工具能力登记不能替代原生工具的真实桌面验收。

## 验证边界

共享业务以 Web 和真实 Host/Node 进程、隔离数据为主要验收环境，不以 GUI 打包为常规前置。`pnpm --dir clients/gui test:workbench-backend` 覆盖普通浏览器公钥配对、资料库写回执及后台崩溃、Main detach、Host stop 的进程边界；它不替代浏览器页面交互验收。只有窗口、系统加密、浏览器视图、电脑控制等 Electron 专属路径需要启动桌面端。发行资源发现、签名和升级仍需在对应发行任务中单独验证。
