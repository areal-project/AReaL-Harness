**中文** | [English](architecture.en.md)

# 架构与目录

AReaL-Harness 采用 **Clients → Core → Runtime** 分层。Core 是会话、Turn、模型循环与 Agent 状态的唯一所有者；Runtime 只处理执行权限、操作事实和资源生命周期。客户端不维护另一套权威历史。

![架构](diagrams/architecture.svg)

[draw.io 源文件](diagrams/architecture.drawio) · [PNG](diagrams/architecture.png) · [图表规范](STYLE_GUIDE.md)

Renderer 界面语言由已有 application preferences 保存，仅允许 zh-CN 与 en。React Intl 从随包词条派生显示文案、数字与日期，不改变 Core 状态、配置或会话身份。持续显示的本地提示保存消息描述与原始参数，在渲染时翻译；原始诊断与第三方正文保持原文。开发合同见[GUI 语言说明](../../clients/gui/README.md#界面语言与文案开发)。

GUI Renderer 只在 `main.tsx` 读取 preload 对象，由 `createDesktopServices` 将现有 `PlatformServices` 注入应用。MCP Apps、原生资源选择和图标加载通过该接口传递能力；缺少能力时不建立桌面订阅或原生资源入口。React 组件不另行读取全局 bridge。Main 继续校验 IPC 来源并持有窗口、App token 和原生授权，Core/Runtime 保持执行与历史权威。

## 模块职责

| 模块 | 职责 |
|---|---|
| `clients/cli`, `clients/tui`, `clients/web` | CLI、终端和本地 Web；初始化连接、显示投影与提交请求 |
| `clients/gui` | React/Electron 桌面客户端；窄 IPC、原生资源、公开服务发现与可重建投影 |
| `clients/mobile` | Capacitor iOS Remote 客户端；复用 GUI mobile 入口、共享 Remote 协议与会话组件，原生适配负责钥匙串、扫码与生命周期；能力与验收边界见 [iOS 开发指南](../development/ios-development.md) |
| `core/config` | 解析用户配置、来源、凭据引用和 Skill 目录，定义工具宿主的代理环境白名单；不依赖 Engine 或 Runtime |
| `core/protocol` | 客户端协议投影和共享类型 |
| `core/engine` | 模型、工具、历史、持久化、父子任务和 Workgroup |
| `core/app-server` | WebSocket、认证、订阅、回调关联；不拥有另一份历史 |
| `core/local-service` | 共享服务发现、配置兼容性和控制客户端，只依赖 config/protocol |
| `core/service-host` | Rust 可信 launcher 和独立本地服务宿主，管理 Core/Runtime 生命周期与私有管道 |
| `core/server` | 装配配置、模型、MCP、Host、Runtime 和关闭流程 |
| `core/plugins` | Codex 兼容插件包解析、本地 marketplace、摘要缓存与安装/启用事务；不执行包代码 |
| `core/mcp` | 官方 rmcp 客户端与结果适配，不拥有 Turn |
| `core/sdk-typescript` | 选定 DSH 工具/文件服务适配和独立 Node Host |
| `runtime/protocol`, `runtime/client` | 独立执行契约与 Rust 私有管道客户端 |
| `runtime/supervisor` | Scope、权限收窄、祖先预算、去重与清理 |
| `runtime/host-tools` | Core 与原生后端共用的可信宿主工具发现；不执行任务、不授予权限 |
| `runtime/exec-native`, `runtime/fs-helper` | OS 沙箱、进程/PTY 与描述符文件操作 |
| `runtime/daemon` | 二进制、Cordis 装配与私有 RPC |
| `runtime/sdk-typescript` | 可信宿主独占连接的底层 Node.js SDK |

`supervisor` 依赖 `protocol`，`exec-native` 实现 Supervisor 后端接口，daemon 负责装配。Engine 不依赖 app-server 或客户端；配置由 server 解析并注入，SDK 不自行寻找用户配置。

Linux `exec-native` 为每次执行启动同 crate 提供的独立 Rust 二进制 `areal-runtime-reaper`，由它作为 subreaper 拥有实际命令及被收养后代的等待与回收；Runtime 等待 helper 并核验私有退出/清理回执。helper 与 daemon、文件助手一同发布在 `libexec/areal`，不依赖 Python。macOS 在进程组清理之外，使用 `libproc` 跟踪和清退已观察到的后代。这些职责不放入 Core 模型循环，也不替代外层服务管理器或容器 init；平台差异与保证边界见 [Runtime 清理契约](../api/runtime.md#输出与清理)。

Engine 的 `session_name` 模块拥有会话名称的单次异步总结、持久化领取与当前状态合并，复用共享模型容量和关闭生命周期。客户端仅投影 Core 名称与本地手动覆盖，不调度命名推理；字段与失败边界见 [Core 会话名称契约](../api/core.md#会话名称)。

Engine 的 `catalog` 模块维护内存中的 UUID 与创建顺序索引，注册和回滚同时更新两者。索引仅持有会话句柄与不可变排序键，动态元数据仍来自当前会话；查询只投影当前页，授权 ID 集合先与索引求交。桌面视图复用 Core 的类型化过滤；冷目录按轻量字段预过滤，已加载会话检查当前状态。任意 Rust 过滤闭包仍检查候选投影。目录锁在等待会话锁前释放。

默认使用内存目录；`sqlite` 模式仅持久索引不可变 `(id,created_at)`，由一个有界批量写入线程和两个读取线程访问 WAL 数据库。查询在相同代际下接回当前会话，索引落后时回退到内存；故障或写队列溢出则在本次实例中停用 SQLite。内存索引继续保留用于回退，启动核对全部索引键；全量模式完整恢复文件。`store::lazy` 提供基于 JSON 清单或 SQLite 的可重建元数据缓存，验证事实身份后由 `dormant` 保存紧凑目录；完整历史、工具绑定和事件窗口在首次使用时恢复。`memory-lazy` 与 `sqlite-lazy` 均直接使用内存排序目录查询；后者用 SQLite 持久化元数据，减少大 JSON 清单的整体编解码与重写。复杂所有权与未结算执行仍走原完整恢复，缓存不决定执行事实。所有模式仍枚举文件；未提供自动历史淘汰或全文检索。文件记录继续承担事实与恢复，写入顺序、同步落盘和状态版本不变。配置见[会话目录后端](../guides/configuration.md#会话目录后端)，接口边界见 [Core API](../api/core.md#传输与会话)。

Engine 的 `trajectory` 模块记录模型和工具的执行内容，通过 `tracing` 暴露轨迹；server 的 `telemetry` 模块装配标准 OpenTelemetry Traces/Logs SDK 和 OTLP 导出。Engine 不读取遥测环境变量，也不依赖上报后端；配置见[轨迹上报](../guides/configuration.md#opentelemetry-轨迹上报)。

server 在安装遥测时为 Engine 注入共享采集预算；Engine 用借用序列化与有界流式缓冲保存逻辑消息和最终模型请求，容量不足只丢弃遥测副本。持久事件桥接层负责 Turn 序号和终态清单，接收端据此区分执行完成与完整送达；协议见[Core 轨迹契约](../api/core.md#持久轨迹协议)。

可选持久轨迹导出由 `core/config` 解析 `[trajectory]`，`core/server/trajectory` 管理有界内存缓冲、磁盘队列与独立上传进程。队列默认位于用户 home，按配置文件身份隔离，同一配置的共享服务和独占 CLI run 共用；网络上传不进入 Turn 结算或 Runtime 生命周期。CLI/TUI 通过可取消后台检查报告一次异常，GUI 按可见性轮询状态；客户端只读取导出状态，并通过 Core 的公开控制入口切换启停或请求重试，远端按标准 OTLP Logs 接收，平台分析登记属于接收端集成。配置、容量与失败边界见[持久轨迹导出](../guides/configuration.md#持久轨迹导出)。

Skill 发现由 `core/config` 根据可信启动参数执行，只返回元信息和独立告警；其无状态文件头解析器由 Engine 的显式部署登记复用。Engine 不自行查找用户配置。`core/engine/src/desktop/skills.rs` 保存登记目录描述符，异步、有界地读取当前资源，不持有 Skill 内容快照。配置与读取契约见 [Skill 指南](../guides/skills.md)。

Codex 兼容包由 `core/plugins` 持有本地安装与范围选择；Engine 登记不可变插件 Skill 根，并在 Turn 提交时固定引用、读取时检查当前撤权。普通会话可以发现新安装，显式 Profile、旧版只读 Side 和隔离 worker 不自动扩权。onboarding 使用已有普通 Turn 入口；客户端通过现有管理收据恢复 UNKNOWN。独立 Skills 保持动态描述符读取契约。当前支持及限制见[插件指南](../guides/plugins.md)，后续完整兼容任务见[实施计划](../development/codex-plugins-plan.md)。

组件支持报告归同一包解析器，候选报告绑定 `admissionDigest ?? sourceDigest`，安装报告绑定 `installedDigest`。Store 将当前启用意图与准确包摘要的静态兼容组合为有效选择；历史 Skill 以自身不可变包检查，Engine 按精确 id/revision 投影准入。Hook 声明和 Apps 文档复用原解析所有者，报告读取不执行包代码，认证、连接与信任仍归现有运行所有者。

### 多格式插件导入决策

插件按格式及其支持版本导入，再接入同一套 AReaL 原生组件与执行所有者。新包优先使用 Agent Plugins 1.0.0 的 Skills/MCP 结构；Codex、Claude、Cursor 和 ZCode 的发现顺序、默认目录、marketplace 合并及扩展规则由兼容导入边界解释。可读取 manifest 不代表支持该宿主的全部运行语义。未知 Portable schema 不回退为另一格式。

导入结果保留包身份、组件名称、声明位置及所需语义。包发现与有效定义仍归 `core/plugins`；MCP 配置校验、认证与连接仍归 `core/mcp`。支持报告、预览与执行复用同一声明解释，管理结果仅输出脱敏投影。来源格式不授予 Hook、工具、网络或文件权限。可选组件失败按其边界隔离，必需组件或包级要求不满足时阻止有效激活。

首个 MCP 切片由现有 `core/mcp` 持有文档声明解释，`core/plugins` 单向依赖该库并保存带来源的声明。接受包工具扩大到 MCP 库的编译依赖，换取一个解释入口，以及现有 MCP 调用接口和每服务校验的复用。该依赖不授予包发现网络或进程执行权，也不把连接状态写入 Store。

`PluginDeclaration` 私有保留原文、文档包装与延迟校验错误，公开安全的 envelope 投影和归一化配置。`McpComponentDocument` 关联原声明来源。Claude 按服务器保留最后定义后，再检查服务器数量及当前文档引用。原始 JSON 调用入口也经同一声明解释，静态报告不因完整运行校验而提前改变安装准入。

兼容证据分为格式识别、组件语义支持、当前环境可用和真实路径验收。当前 MCP 静态报告只承诺 `areal-mcp-document-envelope-v1`，不代表服务配置已通过运行时校验、已经认证或能够连接。用户配置值与秘密由配置所有者持有；插件依赖属于安装图，不与 MCP 连接状态合并。

选择这一结构是为了集中来源差异并复用现有权威。每个生态独立运行时会重复授权、取消和恢复逻辑；把所有字段压成通用 JSON 会丢失覆盖与执行语义，因此均不采用。原始安装包、来源与准入摘要、Store 事务、Turn 版本、撤权及 UNKNOWN 不重放保持原契约。以后导入规则若改变有效执行含义，必须定义重新审阅与旧引用策略，不能静默继承旧信任。分阶段范围与完成条件见[插件实施计划](../development/codex-plugins-plan.md#多格式导入演进)。

插件来源解析仍归 `core/plugins`，Git/npm 不执行安装脚本。`core/mcp` 持有认证、资源与连接版本，Engine 固定 Turn 的 schema/调用对象并拥有撤权、受理和清理。Apps 绑定 Core 进程 epoch、Thread 与包摘要；Electron 的独立沙箱只持窄能力。Main 为每个 App 实例记录原窗口 owner，普通导航保留活 iframe；销毁和撤权按实例归属回收，不依赖原生窗口仍然存活。异步打开返回时复核 owner 与 epoch，旧 token 不随活动窗口转移。文件实际读写复用 Runtime 的目录描述符助手，模型投影剔除 `_meta`。原始 Connector ID 通过明确映射接到 GitHub；客户端凭据仅由可信启动环境注入。

成功 MCP 结果的交互入口只提交原 Thread、Turn、Core item 和打开请求身份。Core 校验原始快照的完整性及调用时保存的来源，再用原连接准备资源；挂载不重新执行业务工具。结果打开操作与 App 实例由同一 Manager 原子保存，关闭事实独立于活页面保留，旧进程 epoch 请求不能重开。Main 按原窗口和 Core instance 复用 token，Workspace 保留 iframe。缺来源、摘要改变、撤权或页面失败时保留普通可读结果。

有限页面工具沿用普通 Core 工具目录、审批和 ToolCall 历史。注册只声明固定的选区读取与 revision 条件修改。Core 固定原始 ToolHost、App epoch、包摘要和登记版本；Desktop 服务固定打开实例的 Main socket，Main 固定窗口、token 与已初始化的 bridge。通知仅唤醒原执行端，持久 claim 才授予一次执行。单次调用拥有 claim 与结算写入，已确认终态不能被后续 hook 或通用 finalizer 覆盖。断线撤销工具执行，保留未保存页面；UNKNOWN 不自动重放。协议和预算见[桌面 API](../api/desktop.md#有限页面工具)。

生成式交互回答复用同一个 MCP Apps 页面宿主，不创建插件或第二套沙箱。Core 的 `gen_ui_publish` 原生工具发布不可变 HTML 制品，`areal/genUi/source` 按已完成的助手消息读取来源与制品。Main 使用移植的 ZCode 指令解析器核对 `::visualize` 引用与 Core 返回的制品，不能凭 Renderer 提供的文件路径打开任意 HTML。页面与 MCP Apps 共用窗口 token、资源代理和 8 页额度。

Core 持有执行、历史与 HTML 来源，Desktop 持有当前用户配置目录下的视图状态。移植的 `packages/gen-ui` 状态存储按项目、Thread 和制品路径隔离，原子保存 `{modelContent,privateContent}`。每项最多 16 KiB，每个会话最多保留 100 项。普通主会话和 Side 提交只将有界 `modelContent` 作为不可信上下文附加到下一次输入，`privateContent` 不进入模型请求。该状态可在同一 Desktop 配置下恢复，不提供跨设备同步。生成页没有 Node、文件、工具或网络访问权，生成页不会改变宿主会话权限；旧版只读 Side 保留只读权限。

插件下载与准备不持有 Engine 目录刷新锁；Store 的跨进程锁和 revision CAS 负责提交，随后从同一安装状态快照在刷新锁内发布目录，连接排空在锁外执行。MCP 清理未确认以类型化错误进入 `cleanupUnknown`，不能按普通失败重连；没有清理凭据的后续断开操作也不能清除此状态。跨实例共享启用状态与本实例受审阅定义分开：hook 调用前读取当前启用状态，后台协调取消已停用包的在途 hooks（包括升级后新版已删除定义的旧调用）；固定 Turn 版本不会固定启用权限。显式 Profile 默认排除插件，仅部署定义的 `allowPluginSkills` 可选择加入，且子任务继续受父任务插件范围约束；hook 角色与 matcher 使用已受理 Profile 身份，压缩保留子任务归属。状态轮询只读安装状态，不枚举包。组件解析按包身份、摘要和政策缓存，每次使用通过 NOFOLLOW 描述符检查文件/目录身份、权限、大小、mtime/ctime；变化后重新校验完整摘要。MCP 调用只验证所属包。该缓存不增加对任意同 UID 并发目录替换的隔离承诺。

插件 MRTR 在 `core/mcp` 通过现代 discovery/协商运行，Engine 绑定同一逻辑调用、逐轮权限和取消；opaque requestState 不进入 Renderer。原生文件选择归 Main，Core 校验字段/世代并委托 Runtime 以 NOFOLLOW 描述符导入受限快照，Renderer 只见不透明资源 URI。认证配置仅持安全存储引用；认证挑战与实际发送 token 的拒绝归 MCP 私有连接。App 订阅按实例/URI/世代共享首订阅、末退订，关闭与通知使用同一生命周期边界。

Goal 模式由 `core/engine/src/goals` 管理持久目标、请求账本与跨 Turn 续轮；用户队列与自动续轮共用准入入口。Clients 只维护投影，Runtime 沿用原执行边界。接口见 [Core API](../api/core.md#goals)。

交互式 TUI 与 Web 启动入口连接到同一部署服务；宿主独立于窗口存活，Store 保持单写者锁。Desktop Main 可直接复用发现与控制入口，见[本地服务契约](../api/local-service.md)。

Core 的生命周期判定区分普通停止准入与取消后的执行结算。Desktop 仅叠加自身连接和在途操作条件，可信 Main 的共用生命周期入口负责观察、确认范围及原实例退出核验；启动恢复、更新和菜单停止复用此入口。取消意图贯穿公共服务宿主，Queue 输入持久保留；部分停止和未知回执保持恢复状态，不由客户端推断全局回滚。接口见[桌面 API](../api/desktop.md)。

Task Mode 由 `core/engine/src/task_mode` 管理 Task/TaskRun、定时触发、独立 Channel 和 worker。它复用 Goal 账本与 Thread 准入，通信状态由 Core 持有；Inbox 是授权问题的查询投影。TaskRun worker 可跨协调 Turn，在独立 Session 中执行，仍由 Core 负责取消和结算。接口见 [Task 契约](../api/tasks.md)。

手动 Run Now 复用 Task 的原子提交、总预算与 queued Run 执行链。Core 持久保存 Run、目标快照和收据后才调用 Host 准备；客户端通过原请求的只读收据核对恢复，不改写计划或重放未知提交。

Task 持久化的唯一提交点为版本 6 的 `desktop/task-mode.json`。紧凑根引用不可变热 Task、按 Task 链接的历史与固定桶头的压缩 radix 收据/归属索引，索引深度受 256 位键宽限制，终止叶最多 64 行、普通打包 128 KiB，合法大单条仍受 256 MiB 硬上限约束。控制不触发历史扫描，只发布变更 Task、原始收据与根；普通保留检查有界，无法确认的历史继续留热。冷 Run 用量与计数同根提交，旧 Goal 身份不因归档变成普通 Goal。完整 Task 与历史读取继续在捕获快照上完成授权和投影；可信 Desktop 的轻量目录单独读取最近成功发布的有界视图，不等待 Task 写锁或克隆完整 Snapshot。文件先同步，根最后原子替换并同步目录；结果不明时冻结写入，重启校验、同步全部可达引用后再恢复。版本 1 至 5 的原字节先备份，原根引用的不可变文件保留；版本 6 阻止旧二进制忽略新摘要约束，迁移不依赖孤儿扫描。

可信本机的任务目录预览由 Core 读取一次原子发布根及其不可变定时摘要包，不打开 Store 或执行恢复。摘要与 Task、收据和归属索引同根提交，不另设可变索引。版本 5 保留原可信读取路径，用于升级前展示和发现启用安排，Core 合法启动后原子迁移。预览不证明实时运行状态或未知提交结果，也不能提供控制修订。Desktop 每个执行 owner 只维护一个目录缓存和 watch，任务中心、来源侧栏与通知共同消费；缺号、换代和背压后保留旧展示并重建基线。执行激活由现有共享 Desktop 后端独立协调，Core 仍独占触发、漏执行与重叠准入。App 退出后不再调度；显式停止抑制自动激活，普通窗口关闭沿用后台生命周期。边界见[本地服务 API](../api/local-service.md#已发布任务目录预览)与[Task API](../api/tasks.md#轻量目录与-owner-更新)。

普通可写桌面会话通过 Core 的 `scheduled_task_*` 工具创建和管理定时任务。工具上下文绑定当前已注册 Host 的身份与连接、来源 Thread 及 cwd，冻结的权限和工具 allowlist 继续生效。`sourceThreadId` 仅负责来源关联，`threadId` 保留独立执行锚点，每次 Run 另建 Thread。写入键来自持久 tool-call 身份，回执核对保留 UNKNOWN，修订冲突不能静默覆盖。`deletedAt` 墓碑复用取消与停止结算路径，保留历史、回执和容量占用。来源对话中的持久任务卡、右上角列表和全局中心读取同一 Task。新建独立任务也使用普通会话工具链路，不依赖 Renderer 轮询确认。

历史 task-draft 定时任务管理界面复用普通 Messages 与 Composer，直接复用普通会话的 TaskResourcesPopover；ConversationStatusCard 增加任务描述与状态概要，不建立固定右栏。宿主 task-draft 在同一管理 Thread 中解释 Agent 回复并校验保存；Core 历史保持原样，界面只读取解码后的显示投影。创建收据和逐轮修改收据阻止重复处理；执行限制不由 Renderer 的权限菜单解除。新建自动准备独立工作目录和管理 Thread，目录归 ProjectlessWorkspaces 分配；已有任务保留原归属，宿主和 Core 校验目录边界。管理 Thread 与执行 Thread 分离，执行锚点继承管理 Thread 的 cwd。提案摘要绑定原始结构化时间意图；Core 先重放原收据，再按一次捕获的时钟解析新提交。日历规则与固定间隔由同一 Core 计算器验证、预览和推进，宿主只格式化展示。旧固定间隔保持秒数和原游标，日历按保存时区处理缺日和夏令时。最近触发决定与游标原子提交；新 Run 保存已受理规则，后续修改不改写其规则、目标或准备事实。安排与控制消息的成功状态仅来自匹配宿主收据。定时 Task 的根 Thread 只定位执行环境；每个 Run 新建会话并冻结配置。Core 持有触发、离线补执行和忙碌跳过，经认证桌面 Host 通过 prepare/ready 提供配置及工具。暂停安排只影响后续触发，停止或恢复通过 Run 控制，审批超时保留受阻执行。

![Task Mode](diagrams/task-mode-mailbox-architecture.svg)

[draw.io 源文件](diagrams/task-mode-mailbox-architecture.drawio) · [异步交互流程](diagrams/task-mode-mailbox-flow.svg) · [流程源文件](diagrams/task-mode-mailbox-flow.drawio)

`clients/cli` 提供 Rust 命令入口 `areal`，分派到 TUI、非交互客户端、Core server 和服务宿主的库入口；Core 不依赖客户端。`core/service-host` 的 Rust launcher 持有独立 Core/Runtime 进程与私有生命周期管道，Linux 不依赖 Python；macOS 的可信 service-host、launcher、Core 和 Runtime 由 `/usr/bin/python3` 作为实际父进程启动，以满足本地可执行文件的启动约束；`core/local-service/native_process` 只适配服务链的进程身份、显式描述符与生命周期，不参与 Runtime sandbox 或权限决策。`scripts/launch.py` 保留用于开发脚本与独立评测入口。发行目录 `bin` 只含 `areal`，Runtime daemon/file helper 放在 `libexec/areal`，不并入客户端进程。命令契约见[客户端指南](../guides/clients.md)。

历史记录只证实直接 Rust 启动曾收到 SIGKILL、Python 路径成功，以及后续直接启动也曾成功。发送信号的一方仍未归因，不能据此认定 AMFI、TCC、隔离属性或某个安全产品是根因。GUI 的依赖预检只在启动新后台前检查所选开发工具及系统 Python，不改变父进程身份、描述符、信号、退出回执或 Runtime 权限。

macOS Runtime 还随包提供独立 Bash，作为受限命令的私有 shell 资源，并在进入沙箱前解析系统 Git 的真实工具链路径；这些适配只解决工具启动与临时目录兼容，不改变 Core 的任务执行循环或 Scope 隔离。资源布局、第三方许可证与边界见 [Runtime 契约](../api/runtime.md#macos-受限命令的系统工具)。

## 状态与执行

GUI 首次展示与后台就绪分别判定。Renderer 在主题和图标加载页可绘制后，通过现有窄 IPC 通知 Main；Main 结合原生绘制事件，只消费一次自动展示机会。关闭窗口取消尚未发生的自动展示，后续恢复不能重新打开或抢焦点。后台、项目及原会话沿现有观察链恢复。初始恢复成功前只显示图标与加载状态，不挂载首页、侧栏、新会话或 Projectless 准备入口；成功后一次性挂载完整工作台。失败留在加载页，通过现有所有者恢复。执行入口继续受连接、会话恢复及 Core 准入约束。恢复失败保留原选择和草稿，并使用现有重试、后台详情及退出路径。

Renderer 的 `state/` 所有者分别管理启动、导航、工作区、任务、外观与通知的界面状态，领域 store 通过 `useSyncExternalStore` 订阅；持久化沿用原偏好键和所有者。`App.tsx` 保留读取与写入跨领域状态的编排 effect，不能把 Core 收据、历史或 UNKNOWN 恢复变成 store 内的重发逻辑。视图组合归 `app-shell/`，原生预览的 Electron 适配归 `app/src/core/preview-native/`，不依赖 Electron 的 URL、坐标、观察与计划逻辑归 `preview/`。窗口、WebContentsView 与后台焦点仍由 Main 的既有所有者管理。

GUI 的 Desktop 服务和 Main 使用 `workbench/client/state-projection` 编码可重建状态。每条连接先发送当前显示窗口的基线，之后按 Project、Thread、Turn、Item 身份发送变化和顺序；未变化的正文不重复传输。Main 只编码筛选后的桌面状态，Renderer 在 contextBridge 之后重组显示快照。缺失基线或序号不连续时重新读取状态，不重发执行请求。支持有界历史的 Core 通过 `areal/thread/observe` 提供近期窗口，较早历史和超大条目由分页与分片读取；Renderer 只在主动向上阅读时自动读取一页，保留按钮供重试及键盘访问，并在合并后恢复阅读锚点。Desktop 每个窗口最多缓存 4 页较早正文；卸载页只保留当前快照内的轻量游标记录，在原位置提供可回读占位，回读仍受相同正文缓存上限约束。重新观察或游标失效会重建窗口与占位；显示窗口不包含另一份完整权威历史。正在变化的单个 Item 通知仍整体替换，单条记录解析与活动条目增长的限制见 [Core 历史契约](../api/core.md)。

Renderer 文档重载或崩溃不拥有后台执行生命周期。显式刷新后，新文档从新的投影基线挂接原应用会话，不能重放已受理输入。`test:service-reopen` 用原模型连接上的新增片段和生产 App 的显示验证挂接，并区分文档恢复与应用重启后的新 owner、代际。

同一 Thread 的变更串行，不同 Thread 可并发。模型请求、工具等待及子任务等待不跨等待持有会话锁。模型许可不跨工具执行持有，活动 Turn、模型请求和 OS 进程是独立限额。

工具先持久化意图，再提交 Runtime 或外部宿主，确认后记录结果。Store 的热快照与不可变 SHA-256 历史分段共同保存权威历史；先同步冷分段再提交快照引用，模型仅使用有界 checkpoint 与近期原文。媒体和大工具结果原文存入按 SHA-256 寻址的 Blob；工具结果引用由所属 Thread 的调用记录授权，首次工具结果视图只生成一次并随历史持久化；显式启用的实验观察投影只影响模型请求，不回写权威历史。重启将未完成执行标为 UNKNOWN；不自动重放。归档释放热历史，drain 后 GC 按引用回收 Blob。

Engine 的 `context` 与 `history` 模块统一规划完整模型请求，校验压缩候选后交由 Store 原子保存；Clients 只显示预算与压缩结果。分配与失败规则见[上下文管理](context-management.md)。

Workgroup 的 `handoff` 模块投影隔离 worker 已提交的阶段与最终报告；报告的来源与分页沿用共享子任务契约，执行、清理、验证和交付状态仍由各自所有者确认。可信启动工具链发现归 `runtime/host-tools`，只读程序资源范围由 Runtime 执行，不依赖任务内容；接口见 [Runtime](../api/runtime.md#macos-受限命令的系统工具)。

普通[Agent 委派](multi-agent.md)共享工作区、独立上下文；[Workgroup](workgroups.md)使用隔离写工作区并验证制品。Core 管调度，Runtime 不选择并行宽度。插件、stdio MCP 与 Core 仍是可信宿主；broker 权限不等于 Host OS 隔离，见[插件边界](plugins.md)。

可选[研究 Agent](../guides/tools.md#research-agents)由 Core 管理只读源码、私有 scratch 与共享预算，默认异步派发，是否委派由模型决定。短句柄缓存属于活动 Turn，压缩保留、结束失效；Store 继续保留原始执行历史。模型 HTTP 层记录脱敏参数与用量，未完成响应恢复不重放已执行工具，见 [Core API](../api/core.md#recovery)。

订阅转发器只持有有界、易失的账号/Thread/Turn 路由亲和性，Core 提供可信请求所有者；路由状态不进入模型历史，也不承担恢复或工具调度。

`core/engine/src/model/tool_calls.rs` 统一请求级工具缓冲预算与脱敏诊断；Engine 提供执行额度，模型适配器在积累响应时约束资源。媒体自动无损压缩应由模态预处理负责，并单独验证还原一致性；当前工具缓冲预算按原始 UTF-8 字节计量，不触发媒体压缩。

Engine 的 `diagnostics` 模块对非权威排障制品执行有界保留，server 装配启动与周期清理；service-host 管理宿主/launcher 日志与握手临时目录的租约回收。诊断回收不改变历史与 Goal 账本的恢复语义，策略见 [Core API](../api/core.md#recovery) 和 [本地服务契约](../api/local-service.md)。

Fork 与 Side 复用 Core/Runtime 的会话、历史和执行所有者。`conversation.origin` 记录内容来源，不承担 Agent 委派或取消归属。Fork 在当前共享工作区分支对话。新建 Side 保存版本 2 和 `sideExecutableV2` 策略，继承来源当前配置并复用普通会话的提交、工具、权限和压缩路径。稳定来源历史仅供模型参考，活动轮次只复制用户输入，子会话界面与执行账本从空白开始。旧版 `sideReadOnlyV1` 在存储校验、工具目录、指令和 Runtime Scope 中保持只读。Renderer 用完整 `Composer` 与 `Messages` 展示每个子会话，以项目、来源和子会话 ID 管理临时标签、草稿与引用。Core 持有创建及关闭收据；关闭先建立持久准入屏障，再停止并结算资源，UNKNOWN 不重放。隐藏面板和切换来源保留活动会话，关闭标签释放该子会话，重启不恢复新标签。Esc 按面板 DOM 归属路由。接口见[桌面 API](../api/desktop.md#side-chat)。源码、确定性本地模型、真实供应商与安装包分别验证。

桌面目录准入核对 Core 保存的 V2 来源与相同物理 cwd，将 Side 及其委派子任务映射到来源 Session 作者；原子首问同样先准入。文件与浏览器结果沿子会话的执行 Core/root 路由。首轮只继承来源已挂载的固定电脑工具定义，旧版 Side 不扩权。

提示词预测复用这两个 Composer。只有已显示且开启该功能的 GUI 请求最新成功轮次的候选；Core 保留该轮实际模型实例，独立发送无工具 `promptPrediction` 请求。一个持久化的 `DesktopState.promptPrediction` 标签槽负责来源、去重、恢复与失效；专用通知只更新该槽，Thread 快照负责恢复。待定尝试在重启后不可重试，已有候选原样恢复。预测不创建 Turn/Item、不进入 Solve 上下文。Lexical 在真实文档外显示候选，裸 Tab 仅接受到草稿；新输入暂时隐藏而不删除候选。模型容量、取消和最终发布验证归 Core；设置、需求与呈现归 GUI。详见[Core API](../api/core.md#下一条提示词预测)。

共享 Browser 的普通网络加载使用 Chromium 的系统代理、DNS 与站点策略；Main 只隔离活动控制端口，网页不取得产品 bridge。适配器把用户新发送绑定到确切 Turn 和 GUI 连接，首次经 Core 审批的工具发现才懒绑定当前原生页；不以 `thread/resume` 抢宿主。人工键鼠事件由 Main 在派发前撤销页面读取与动作代次，排空在途输入后交付首个用户事件。Core 的读取和动作许可绑定页面、控制代次及具体计划，UNKNOWN 不重放。产品流程及局限见 [Browser 契约](../api/browser.md)。

客户端设计规则与页面模式归 [`clients/gui/design-system/`](../../clients/gui/design-system/README.md)。首批基础值、纯调色板、基础控件，以及Composer表面/工具栏和设置页面/分区/组/行的纯布局由私有 workspace 包 [`@areal/ui`](../../clients/gui/packages/ui/README.md)承接，原 renderer 保留其余控件、命名主题、偏好与开发预览；规则目录不承载业务执行或第二份可编辑值。迁移边界见 [D-004](../../design/decisions/004-local-ui-package.md)。[设计系统架构](../../clients/gui/design-system/architecture.md)明确架构、Base、独立题目与反馈的阶段准入；包构建和目录生成不代表完整 Base 或视觉验收完成。

有限浏览器动作仍由 Main 的原生预览所有者执行。观察持有独立视口及原生 OPTION 身份，准备和执行复核同一目标；状态等待只读原生事实。scroll/hover 后失效观察保留批量确认前缀与调用去重，固定 select 语义不开放任意脚本入口。

## 客户端恢复与用户感知

GUI 订阅展示状态由 Desktop 的 `AppProviders` 统一投影，设置分组读取活动账号的本地授权事实，公开模型 JSON 缓存仅用于显示。目录确认中与已确认失效分开，Renderer 不以目录可用性阻止提交，执行资格由提交路径和 Core 判断。当前会话观察在连接后优先恢复，导航摘要后台更新。Core 原子观察结果中的配置、队列、交互和历史由同一模型安装操作发布，最新轮分页完成后基于实时模型合并。Main 合并同一事件循环内的投影通知，原生视图归属校验仍即时执行。

连接、显示同步、请求受理和执行结果是四个独立事实。连接中断不证明请求未受理；刷新失败不能推翻已知成功；收到受理收据也不代表执行成功。Core 持有方法的读写语义、受理结果和原始请求收据；Desktop 持有复合命令语义、原请求身份与可重建显示缓存；Renderer 持有草稿和提示的展示范围。Host 管理服务代际，Runtime 证明执行资源清理。恢复沿这些所有者进行，不增加通用工作流账本或客户端执行循环。

| 情况 | 系统行为 | 用户感知 |
|---|---|---|
| 短暂断连或可重试读取失败 | 有界退避、重新订阅并安装权威基线 | 自动重连和读取重试保持安静；停止自动恢复后才显示失败与重试入口 |
| 修改请求结果未知 | 保留原 requestId，只查询原收据 | 保留草稿，说明正在核对；不自动重复提交 |
| 原操作成功、列表或视图刷新失败 | 返回已知身份或结果，单独重试读取 | 原操作保持成功，提示仅归属未恢复的视图 |
| 权限、凭据或配置需要修改 | 保留结构化原因与操作范围 | 显示可执行的中文提示和对应入口 |
| 自动恢复耗尽或执行结果仍未知 | 停止自动尝试，保留原请求与诊断 | 显示受影响操作、当前事实和下一步；技术详情按需展开 |

错误的 `outcome` 与 `recovery` 表达可证明的事实；仅明确拒绝或 `noMutation` 才能说明未执行。未知收据、普通异常文本或断开的 socket 都不能据此重发修改。新的 Desktop 命令契约通过版本协商启用可对账的创建、配置和 Task 操作。提示绑定原 Project、Thread、requestId 和发生实例，只有匹配的权威结果才能结算对应提示，其他操作成功不会清除它。协议与兼容边界见 [Core API](../api/core.md) 和 [Desktop API](../api/desktop.md)。

服务崩溃后的自动换代必须经过现有本地服务所有者：原 Host 对意外 Core 退出和 Runtime 清理发布正向证明，在启动锁内复核原代际、同一 GUI owner、存活期、部署配置和二进制，并排除已受理或结算未知的显式停止。恢复预留与原代际到后继代际的回执只允许一个后继，丢失回复也不能启动第二个。缺少证明、Host 丢失、配置变化或明确停止均不自动换代。换代后只恢复观察和原请求核查，Core 的启动恢复负责将未完成执行标为 UNKNOWN，不重放未完成任务的模型请求、工具或外部效果；已授权且尚未开始的定时安排沿用其原有规则。详细保证见 [本地服务契约](../api/local-service.md)。

桌面 Worktree 由 `clients/gui/app/src/core/worktrees.cjs` 持有创建与线程绑定日志，`worktree-admission.cjs` 核对线程身份与定时任务目录的持久作者预约，`task-workspace-owners.cjs` 持久记录任务的实际宿主及可信线程锚点，`schedule-admission.cjs` 从 Core Task、桌面 owner、来源与执行锚点的同一 cwd 派生普通来源安排的共享资格，并保留自动分配项目外目录的旧任务家庭预约、执行准备和精确交互作者映射核查，`packages/workspace-git` 持有受控 Git 创建与事实核查。逻辑项目和物理执行目录分别登记。普通新会话使用当前目录与 Core；只有当前创建明确选择 Worktree 才分配新 checkout，不根据会话数量或旧偏好自动隔离。每个隔离 checkout 通过原服务入口启动独立 Core/Runtime，客户端仅聚合线程投影，不迁移 Core 历史。线程、子线程及请求收据定位原执行宿主，文件、进程和浏览器回调沿同一归属路由。接口和保证范围见[桌面宿主契约](../api/desktop.md#桌面宿主-worktree-契约)及[Worktree 指南](../guides/worktrees.md)。 环境配置归现有 library 的逻辑项目元数据，创建时冻结脚本；`worktree-environment.cjs` 仅适配 Core 受管进程回执。空线程绑定不代表环境就绪，首条 Prompt 需等待 setup 成功。取消和删除保留原创建身份，删除 tombstone 阻止旧 owner 重连或回退来源。

GUI 的 `history-observation` 按项目、连接和代际合并目录读取：最多一批在途与一批待办，初次加载及显式刷新读取完整分页目录，生命周期通知只回读受影响会话的元数据。完整目录才交给 Worktree 所有者判断绑定；旧连接结果不发布，持续通知不延长已经完成批次的等待。导航缓存仍是可重建投影。

## 仓库目录

桌面客户端归属见[迁移决策](../adr/0001-desktop-client-module.md)。`clients/gui` 的独立 Electron 适配器保留系统凭据与订阅转发，通过共享服务公共入口连接 Core；退出 GUI 不终止 Core 任务。macOS 安装包中，前台与后台适配器使用不同的应用身份，后台共享主包资源与原有数据目录，避免 Finder 将重开前台的请求交给无窗口后台。GUI 构建、数据隔离与本地包见 [GUI 指南](../../clients/gui/README.md)。iOS Remote 客户端位于 `clients/mobile`，Web 与 iOS 通过 `@areal/remote-client` 共享协议、命令核对与会话状态；平台分别提供 IndexedDB 与 Keychain 持久化适配。执行和历史权威仍在电脑端 Core/Runtime。

GUI的混合消息采用可重建展示投影：Markdown沿Streamdown，严格版本化`areal-ui`数据由共享UI目录校验并以只读React组件展示，Gen UI/MCP仍由原隔离宿主处理。Core保留原始消息和制品权威，复制可使用同一文字投影；这不是持久历史迁移或可执行组件协议。审批和Ask User共享展示外壳，合法动作、草稿、提交锁与UNKNOWN核对仍归原请求控制器。

桌面适配器的项目连接所有者管理退避、连接身份和快照重订；先连接兼容的运行中服务，仅对满足上述正向证明与代际约束的 Core 崩溃请求受控恢复，不重放未知提交。Main 初始化只连接原后台，部署变化展示显式更新入口，不自动换代。Desktop 生命周期 owner 在副作用前持久化绑定目标代际的意图，逐项目通过 Host 回执结算；Main 只保存引用与连接投影并核验原 Desktop 退出。受理未确认只核查原请求，已完成目标不重做；Core 的配置与权限重启边界继续生效。Workbench 共享桌面能力契约，Main 和服务入口校验各自允许的能力并保留结构化错误；Core 仍拥有配置和执行的最终校验。原生预览归 Electron Main，按项目/Thread 释放并有界缓存页面；界面从 Main 的权威快照投影每页一个顶层标签，与文件和终端共用标签栏；页面列表订阅归当前项目/Thread 的窗口投影，标签使用 `pageId` 定位，不建立另一套 Browser 生命周期或执行权限。具体恢复、类型覆盖及页面状态丢失边界见 GUI 指南的生命周期章节。

新建会话的跨重启受理证据由 Core 的既有 submissions 日志拥有：Core 在创建副作用前持久受理，发送参数绑定日志覆盖标识和 Engine 启动代际。只有原代际退役、连续日志中无受理且无 Thread 创建回执时，Core 才能给出明确未受理；Desktop 先保存该结果再移除 pending，Renderer 保留草稿。旧记录、日志覆盖缺失和已受理但未结算的记录继续 UNKNOWN，不自动重发。保留、迁移与崩溃窗口见[提交与恢复契约](../api/desktop.md#submissions)。

Desktop 后台在同一进程内按职责装配三个模块：`project-connections.cjs` 管理连接身份、只读等待器、退避与受约束重连；`history-observation.cjs` 管理历史观察、分页、显示窗口和读取恢复，不获得写命令入口；`submission-recovery.cjs` 串行写入 pending/outcomes 并核对原请求收据，空收据和断线继续保持 UNKNOWN，不重发修改。`CoreBackend` 保留项目登记、部署、业务命令编排和既有调用入口，只注入显式依赖；模块共用原项目对象，不复制业务状态。历史窗口归观察模块，连接与核对计时器受原连接身份约束；重试时序、持久文件和 Core/Runtime 所有权不变，不新增进程。 历史纯投影由 `history-projection.cjs` 负责，回执身份校验归 `receipt-contract.cjs`。供应商目录投影与网络探测分别归 `provider-model-catalog.cjs`、`provider-probe.cjs`；订阅公开缓存与审计序列化归 `subscription.cjs`。这些模块复用原状态与请求身份。

[Remote v2](remote-control.md) 的 Gateway 归现有桌面后台适配器，浏览器只持有受限投影；Core 与 Runtime 继续拥有执行和历史。Direct 与 Relay 共用 RemoteControl 拥有的 session acceptor、观察器和授权预算，传输适配器只提供字节/存活/背压。Direct 使用独立低权限入口，Relay 仅拥有连接路由与登记元数据；两者都不转发高权限本地接口。契约与实施状态见 [Remote API](../api/remote-control.md)，决策见 [Host 所有权](../adr/0008-remote-host-ownership.md)。

Remote 的 React Workbench 直接复用桌面 `Messages`、`ConversationComposer`、模型/权限菜单、`ComposerQueue` 与 `GoalCard`。浏览器控制器仍拥有配对、代际、草稿与 commandId 核对；项目/Session 来自授权 Core 概览，详情使用有界原子订阅。`session.control` 只接收模型/权限、目标与文本队列意图，Gateway 校验后经现有 journal 派发；不提供通用 Core RPC 或凭据访问。普通 Session 的排队提交使用 Core 原子归属/配置准入检查，工具执行与历史权威不迁入浏览器。

```text
core/                       配置、协议、Engine、server、MCP、插件 SDK
clients/                    CLI、TUI、本地 Web、GUI
runtime/                    协议、监督器、OS 后端、文件助手、SDK
schemas/                    固定上游与 AReaL 机器契约
examples/desktop-api/        直接 API、CLI 与发行验收
scripts/                    构建、检查、启动与 smoke
upstream/pins.json          上游来源与固定版本
tests/fixtures/             确定性工具、hooks、MCP
tests/e2e/docker/           Linux 受控执行镜像
tests/perf/                 lite/pro、runner、grader 与统计
tests/perf/suites/pro/cases/*/environment/  公开 Dockerfile、原始输入与运行库校验
docs/guides/               使用与配置
docs/api/                  接口契约
docs/design/               分层、机制及 diagrams/ 源文件与预览
docs/development/          开发、测试与依赖维护
docs/examples/             示例说明
docs/benchmarks/           运行方法与 reports/ 历史报告
```

接口细节见 [Core](../api/core.md)、[Runtime](../api/runtime.md) 与 [SDK](../api/typescript-sdk.md)。当前范围见[功能清单](../features.md)，验证入口见[测试](../development/testing.md)。

Core server 负责配置监听与模型装配，Engine 在提交时固定模型版本并保留队列快照；本地服务客户端负责安全重启与发现，Runtime 权限仍属于部署边界。见[配置指南](../guides/configuration.md)。

Core `permissions` 负责审批模式、规则优先级与精确请求记忆；Clients 展示并回答请求。Runtime 独立执行部署上限及 Scope 收窄，本地 full-access 由可信 launcher 选择。见[权限配置](../guides/configuration.md#permissions)。

[权限架构](permissions.md)定义聊天的请求审批、帮我审批和完全访问预设。Core 将审批方式与执行范围分别解析，在 Turn 受理时固定结果；额外能力只授予具体操作，并继续受部署、Profile 与父任务上限约束。旧聊天未选择预设时保留原契约。

外部评测平台通过公开契约消费原生 CLI 和标准发布包。输入适配、终态结果投影、产物收集和平台部署由消费平台维护；Core、Runtime、SDK 和独立发行包不依赖平台适配器，见 [CLI 契约](../api/claude-cli.md)。

模型目录的解析、校验、凭据状态诊断和受控文件写入归 `core/config`。`core/server` 在启动和显式热应用时装配 Engine 执行投影，并让文件监听与热应用共用版本状态；Engine 在生命周期准入门内提交配置，保留旧任务的 Provider、参数和凭据引用。Clients 使用公开配置命令，不复制 TOML 解析或凭据规则；桌面安全存储只在可信适配器中提供密钥，由经过认证的本机控制入口追加不可变凭据。Renderer 默认只接收脱敏状态；用户点击模型设置的眼睛时，经认证本机入口按供应商与配置版本临时读取该 AK。查看值不进入配置草稿、状态广播或持久化，隐藏、切换或离开页面即清除；远程控制不提供此能力。“无需认证”复用共享文件中不配置凭据引用的语义，不建立另一份供应商配置。GUI 默认与 CLI 共用用户配置文件；独立服务登记目录由 `core/local-service` 选择，不改变配置查找，运行数据仍按 GUI 部署隔离。普通模型保存通过 Core 版本回执确认，不重启 Core 或 Runtime；非模型部署更新保留安全重启边界。契约见[配置指南](../guides/configuration.md#gui-与-cli-共享模型目录)。

macOS 系统静态代理由 GUI 可信后台适配器读取，转换成标准代理环境后注入 Core；模型设置与订阅的 Node HTTP 请求使用同一快照。SOCKS 的固定上游 TCP 转接由此后台持有，持久监听端口用于后台恢复，不解释模型协议或保存请求内容。Core 和 Runtime 不依赖 Electron 或 GUI 的系统命令适配，运行中的服务保留启动环境；规则与限制见[代理配置](../guides/configuration.md#proxies)。

历史回取分页读取原始记录。Goal 计量同样把已结算请求滚入分段，保留累计用量与未结算预留。这些存储职责位于 Core，不改变 Runtime 的执行所有权。

`core/engine/src/delegation.rs` 是统一委派与执行投影门面，记录身份、所有权和后端引用；原 Thread/Turn 与 Workgroup 保留各自执行状态。共享作者租约（含继承权限分析者的延迟写租约）、隔离快照和交付由 Core 协调，Runtime 不选择策略。`workgroup/delivery.rs` 组合候选、调用可信验收并持久化逐项交付回执，`runtime/fs-helper/src/delivery.rs` 实现受控分块提交与条件删除。Clients 只显示统一子任务与交付投影，高级历史入口保持兼容。接口见 [统一委派](../api/core.md#agent-tools)。

平台公开输入物化与清单属于外部消费端；只读目录身份、文件操作拒绝及 OS 挂载保护属于 Runtime。Core 的媒体工具生成有界派生图与动画视图，模型适配器计量最终请求字节；外部消费端不维护 Core 的模型循环。契约见[工具](../guides/tools.md)、[Runtime](../api/runtime.md)和[评测](../benchmarks/README.md)。

共享 Browser 沿用 Core 会话、审批与历史所有权，独立桌面适配器负责认证工具回调，Electron Main 拥有原生页面，Renderer 投影状态。已实现能力通过 Host 发现；所有项目共用 Main 拥有的持久 Browser Profile；Page 和控制权继续按聊天隔离。云浏览器仍未提供。契约和限制见[Browser 规格](browser.md)、[Browser API](../api/browser.md)及[所有权决策](../adr/0002-shared-browser-ownership.md)。人工独立 Frame 授权与逐 Frame 截图隐私检查也归 Main，绑定当前 Human Page，不授予 Agent 跨源权限，复用既有 ThreadBlob/MediaRef。源码实现不等于安装版或真人验收通过。

`core/engine/src/observations.rs` 在显式启用实验策略时，于模型历史投影层实施旧工具观察的软预算，原文由 Store 保留，不改变 Runtime 操作。配置与兼容性见[配置指南](../guides/configuration.md)。

Core 可通过默认关闭的实验配置，在请求投影与检查点证据中有界保留完整文件参考；执行等待仍由 Runtime 管理。参考回取、非交互 stdin 和连续失败上限见[配置指南](../guides/configuration.md#参考保留与有界工具恢复)。

`core/plugins` 持有不可变插件包与当前项目组件选择；稳定 Skill/MCP 关闭身份跨安装更新保留。Engine 统一执行目录、保留 Skill 读取、onboarding 与 MCP 旧代调用检查，组件变更复用管理回执。Renderer 的插件详情、设置与 Composer 只消费投影；插件标签复用精确 Skill 引用和现有发送路径，旧版只读 Side 保留只读意图边界；可执行 Side 使用继承的普通会话权限。接口和重连语义见[桌面契约](../api/desktop.md#插件包管理)。

## 插件 Hooks 所有者

`core/plugins/{hooks,hook_sources}` 只解析原包和受控用户/项目来源、matcher、模板与摘要。`core/engine/src/plugin_hooks` 拥有独立定义信任、Session/Turn 布点、持久受理与结果投影；同步任务同时登记在 Session 与当前 Turn，后台任务由 Session 持有。Runtime 沿用路径授权、进程预算、有界任务组写入调度和确认清理，hook 不继承任务 provider 秘密。Main 仅转发管理与恢复收据，Renderer 审阅当前定义；安装和 MCP 信任不能替代 hook 信任。

MCP hook 绑定原工具 generation 与真实 Turn/compaction owner，取消旧 owner 不得移除新 owner。`core/mcp/active_timeout` 在同一逻辑请求的全部 MRTR rounds 中扣减活跃预算，broker 的人工等待守卫暂停该预算；取消/撤权不暂停。管理提交按业务键跨执行去重，日志发布短时串行并为每个在途响应预留空间，因此等待表单不挡住上传或撤销。Core 持有 epoch 绑定的 Session Task Scope；Runtime 校验 Hook 类型参与及有界组 FIFO，不扩大各进程授权。同任务 Hook/Ordinary 可重叠，ordinary/ordinary 与跨任务冲突仍独占；关闭先等待任务再关闭 anchor，UNKNOWN 不重放。普通只读子任务 command hooks 需要另行同意并绑定摘要，准入与实时检查使用同一条件，继承计划也须过滤。Runtime 确认受限隔离，只授予工作区/包读取和私有 scratch/本插件 data 写入，禁止网络和 provider 秘密继承；data 根固定身份，重定向拒绝。旧版只读 Side/研究任务/nativeTaskAgent/受限 Profile/只读根会话/MCP 继续排除，见 [P2 矩阵](../development/codex-plugins-p2-acceptance.md)。

用户评价在 Clients 层冻结公开历史并复用独立 Side；Core Server 仅适配既有轨迹接收端。边界见 [user feedback](../guides/user-feedback.md).

`core/engine/src/workspace.rs` 在已确认的受管副作用结算边界管理共享作者租约；工具调用并发由 `tools/scheduling.rs` 按可信后端和顺序屏障控制。Runtime 仍拥有进程与清理事实，Core 不通过 shell 文本推断只读或资源已释放。

电脑控制采用独立原生 Helper，Main 拥有生命周期、系统授权与停止，Core 保留准备计划、审批与历史权威。设置只发起用户明确点击的系统授权；观察与模型请求不会弹出授权。原生 AX、截图与输入结果经认证桌面通道返回，未知输入不自动重放。边界与构建见[电脑控制](../api/computer.md)。

外部 LCU 是显式选择的电脑控制方式。Main 持有固定版本原始 CUA client 与每聊天 JS 会话，沿现有 computerHost 认证连接提供原始工具与原生应用授权。Core 向手动新建聊天注入完整初始化指令，产生可信调用身份，复用 MCP 结果投影与媒体持久化，并在权威 turn 结算前等待清理。旧聊天不迁移工具表；provider 切换在执行准入再次校验。LCU 不承载内置浏览器，Preview/browser_v1 的所有者保持不变。
