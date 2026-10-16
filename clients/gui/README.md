**中文** | [English](README.en.md)

# AReaL Harness GUI

完整桌面客户端：React renderer、Electron 原生适配器与公开依赖。与 CLI/TUI/Web 同属 Clients 层；Core 持有会话、历史、模型循环和定时任务，Runtime 执行工具。移动端源码后续迁移，桌面侧配对入口保留。

Web/PWA Remote v2 的实施边界见[架构](../../docs/design/remote-control.md)、[API](../../docs/api/remote-control.md)、[连接与部署](../../docs/guides/remote-control.md)及[验收计划](../../docs/development/remote-control-testing.md)。RC-01/RC-02/RC-03 提供默认关闭的本机只读入口、浏览器申请与桌面确认、显式项目范围和设备撤销；有效能力包括 Host/项目观察及有界 Core 工作/待处理概览，覆盖 GUI 从未打开的会话；尚不声明详情和写方法。Relay、手机真机与公网部署仍为后续设计和验收。

## 开发

从仓库根执行，需 Node.js 22.19+、pnpm 11.7.0 及仓库 Rust 工具链；建议构建和验收均使用与 CI 一致的 Node.js 22 LTS：

```sh
make build
make gui-install
make gui
```

`make gui-build` 只构建 renderer。`pnpm --dir clients/gui typecheck` 检查界面类型及共享桌面契约的 JSDoc 类型（尚未覆盖整个 Electron CJS 实现），`pnpm --dir clients/gui run verify` 检查公开文件边界。此模块单独锁定 pnpm 依赖，不改变仓库 SDK 的 npm 工具链。依赖来自公开 npm registry；Electron 和 Core 工具首次安装需网络。

`make gui-install` 按锁文件安装依赖后，显式运行 Electron 官方安装器下载固定版本的原生运行时。

`AREAL_CORE_BIN` 可指定可信 Core 的绝对路径；开发默认使用仓库 `target/debug/areal`。默认使用独立的 `AReaL Harness GUI Dev/<工作树摘要>` 数据目录；安装版使用 `AReaL Harness GUI`。不导入或替换旧桌面安装与数据。`AREAL_GUI_USER_DATA`、`AREAL_CORE_HOME`、`AREAL_HARNESS_SERVICE_HOME` 可显式设置隔离目录。模型配置默认与 CLI 共用 `~/.areal/config.toml`，由 Core 统一解析、校验和保存；`AREAL_HARNESS_HOME` 可修改 Core 配置 home，`AREAL_CORE_CONFIG` 可显式选择其他文件。首次读取不创建配置，首次保存由 Core 创建默认文件；旧 GUI 隔离目录中的配置不会自动合并。

启动 GUI 前可显式设置 `AREAL_CORE_SANDBOX_PROFILE=native`，或在 `areal service ensure/restart` 使用 `--sandbox-profile native`，请求原生 Runtime 沙箱。默认仍为 `full-access`。此选择纳入部署兼容性；切换时需先停止活动任务并显式重启服务。只有 Core 验证原生隔离能力后，Side 对话才提供只读访问当前工作区文件的选项。原生隔离不可用时启动失败，不降级为 full-access。

配置文件按 `AREAL_CORE_CONFIG`、`AREAL_HARNESS_CONFIG`、Core 配置 home 下的 `config.toml` 顺序选择。配置 home 优先使用 `AREAL_HARNESS_HOME`，否则使用 `AREAL_CORE_USER_HOME` 指定的用户目录（省略时为当前用户 home）下的 `.areal`。显式文件的相对路径在 GUI 启动目录解析；实际配置路径和配置 home 均参与后台身份校验，即使服务登记目录相同，切换配置 home 也不会误接旧后台。尚未创建的默认文件首次保存不改变后台身份。同一 GUI 后台的不同项目沿用这份配置，设置页不随项目切换选择另一份上传配置。

macOS 开发和安装版均需要可执行的 `/usr/bin/python3`，供 Runtime 及可信工具助手启动中转；可通过 `xcode-select --install` 安装 Xcode Command Line Tools。该解释器不随应用打包；共享服务在启动前检查可用性并返回明确错误。

macOS GUI 后台自动读取系统静态 HTTP、HTTPS 和 SOCKS 代理，供 Core、模型连接测试与订阅请求使用；显式环境变量优先。绕过规则、重启生效和限制见[代理配置](../../docs/guides/configuration.md#proxies)。`pnpm --dir clients/gui run test:proxy` 验证实际 HTTP 转发、HTTPS CONNECT、SOCKS5 远端 DNS、后台 TCP 转接和本机直连。设置 `AREAL_TEST_MODEL_PROXY_BIN` 为已编译的 `core/engine/tests/model_proxy.rs` 测试可执行文件，可同时验证真实 Core 的 HTTP/HTTPS 流式回复。

## Composer

权限审批和 Ask User 共用固定在对话底部的交互卡片。审批默认显示拒绝与允许一次，Core 允许记住授权时才提供任务／项目范围菜单；原有授权条件和状态核对保持不变。问题支持选项、自由回答和逐题填写；“跳过”或关闭仅暂时收起，保留草稿和待回答入口，不提交空答案或停止任务。提问期间输入框保持紧凑，审批期间保留并隐藏普通输入草稿；回答回显来自 Core 已保存的工具历史。`pnpm --dir clients/gui run test:interactions` 使用隔离的真实 Electron/Core/Runtime 和确定性本地模型验证审批、回答及历史恢复，不替代真实供应商或安装包验收。

模型设置采用供应商列表与配置表单两栏布局：地址与协议默认展示，模型列表仅显示名称与启用开关；连接测试、编辑、排序和删除保留在“更多”菜单中。凭据来源与常驻保存说明不再展示，凭据留空保留和无需认证的保存行为不变。供应商状态仍来自 Core 已保存的目录与凭据诊断；保存完成后刷新 Composer 的模型目录。保存或应用尚未完成时，设置返回与分类按钮暂时禁用，完成后恢复。手机访问配置通过“私人网络／公网／组织网络”切换，只展示当前方式的字段；详情、Relay 与恢复操作按需展开。Serve 方案确认、公网双重确认、组织来源确认及设备指纹、项目范围和权限批准均保留。共享配置接口见[配置指南](../../docs/guides/configuration.md#gui-与-cli-共享模型目录)。

新草稿和已有聊天的 `+` 与 `/` 共用功能/Skills 分组目录和搜索；方向键选择，Enter 确认，Esc 关闭。Skill 附加到当前消息，发送前由 Core 读取正文；失败保留草稿和标签。已选可用模型的入口先显示强度，再进入真实模型目录；未选模型或所选模型不可用时直接显示目录。强度值与可用状态取自 Core，缺少凭据的模型保留名称并显示“缺少 API Key”，不可选择。菜单中的“配置模型”打开模型设置；空目录的“请先配置模型”也可点击。`pnpm --dir clients/gui run test:model-selection` 使用隔离 Electron/Core 验证目录、设置入口、凭据保存与应用后的模型执行；远端供应商支持须单独验证。

中文输入法组词期间只更新编辑器候选文字，确认或取消后同步最终草稿；候选确认的 Enter 不发送消息。输入光标沿用当前主题的正文颜色，换行与空行沿用编辑器字号和行高。

流式回复的新文字逐字淡入，中文与英文共用同一呈现方式；完成后的历史直接显示。等待状态使用随主题变化的连续文字高光。设置中的“减少动态效果”同时关闭这两类动效；可在[设计系统预览](DESIGN_SYSTEM.md#开发预览)中切换明暗、字号和动效检查。

新一次发送或调整方向会清除上一操作的界面错误提示；本次失败仍显示原因并保留草稿，受理结果未知的消息不会自动重发。

图片显示缩略图，UTF-8 文本附件可通过“在文本框中显示”追加到正文。超过 200 字符或至少 5 行的粘贴折叠为文本卡片，展开上限为 1 MiB。折叠仅改变展示，直接发送或保存排队消息时仍按正文处理，不上传为文件；通过选择器或剪贴板附加的真实文件仍按文件处理。文件与技能删除不影响正文。目标模式在原输入区编写，创建目标消费正文及折叠文本，其余附件继续保留。`pnpm --dir clients/gui run test:composer` 使用隔离 Electron/Core/Runtime 验证这些路径。

右侧 Panel 的网页、终端和文件共用顶层标签栏；每个网页标签绑定一个原生 Page，可通过 `+ → 浏览器` 或 `⌘T`（Windows/Linux 为 `Ctrl+T`）继续新建。切换标签保留各页的网址、历史与控制状态；关闭网页标签释放该页，隐藏 Panel 不关闭网页。页面列表由 Main 的权威快照同步，Agent 新建或弹出的页面也显示为独立标签；browser use 仍按 `pageId` 和原有审批／人工接管规则执行。此布局不提升原有每 Workspace 4 页、每窗口 8 个原生页面的资源上限。

内置浏览器工具栏的“批注”位于导航按钮和地址栏之间。点击后冻结经过隐私检查的原生页面截图，可点选元素或框选区域；就地填写说明并确认，加入当前聊天 Composer 的标注附件。可连续确认多条，展开附件逐条编辑或删除，发送时经既有 Core 媒体通道提交选区裁图和说明。正文保持独立；未确认标注、空白说明或结果待核对的提交不能发送。上传失败保留草稿，不自动重试。已发送消息从 Core 历史关联原图片与说明；未发送图片和标注随当前窗口附件草稿存活，不跨窗口重启保存。`pnpm --dir clients/gui run test:browser-annotations` 使用隔离 Electron/Core 与本地模型验证同页、多条、跨聊天隔离、上传拒绝和历史回取，不替代真人输入或安装包验收。

Browser 工具在每次新用户请求中先 `describe`，再重新观察，拒绝跨轮次使用旧 Ref/快照。导航后的 `documentReady` 等待不依赖元素观察，可跨越同一已授权 Origin 的文档加载；页面变化导致的在途观察失效返回 `plan_stale`，人工接管返回 `human_control`。`node clients/gui/scripts/browser-google-smoke.mjs` 从仓库根运行隔离的真实 Electron/Core 与 Google 页面，使用确定性本地模型验证打开、搜索 `AI Agent`、读取结果及旧 Ref/撤权拒绝，并保留 GUI/原生截图与历史；不替代真实供应商或安装包验收。 Google 触发验证码时不算结果读取通过；本地回归可设置 `AREAL_BROWSER_LOCAL_SEARCH=1`，证据明确标为合成搜索页面。

## Fork 与侧边聊天

每轮完成回复下方的“分支”打开紧凑浮层，在当前工作树中创建独立聊天并保留所选历史边界；文件保持当前状态，不提供新工作树选项。更多轮次操作仍提供之前/之后的边界检查。未知创建结果先核对受理状态，不重发。

在主输入框使用 `/side` 打开右侧聊天。两侧复用 `Messages` 和 `ConversationComposer`（Lexical 输入框、工具栏、`ComposerModelMenu`），各自保留草稿与提交状态。Side 首问可选择 Core 目录中的模型和思考强度，后续配置只作用于该 Side；文件访问与只读策略继续由 Core/Runtime 约束。相关讨论、冻结证据与草稿恢复仍可通过侧栏入口访问；带回回复先预览，再追加到主草稿，不自动发送。

## 子任务与交付

普通输入区直接描述目标，Core 自动安排子任务。侧面板的“子任务”统一显示执行进度、检查证据与交付状态；点击“查看过程”读取子任务历史，等待或停止操作继续由 Core 管理。检查通过但尚未应用、应用冲突、部分应用和结果未知会分别显示。 候选交付可分页预览文件并一次性应用全部改动；应用由 Core 统一管理。若原任务已不活跃，继续原任务后承接交付，界面不会把尚未应用的候选显示为成功。

“高级：兼容委派与工作组历史”保留旧手工只读委派、显式计划和历史检查入口，不是普通任务的前置配置。旧 Core 未提供统一执行接口时，界面明确提示并保留兼容历史访问。

## 对话资源

对话顶部的“任务资源”在顶部图标下方的紧凑浮层展示当前工作区变更、Core 直接子智能体、受管后台进程及用户附件和已验证的文件读取来源；Git 工作区保留变更数量为 0 的审查入口；其他没有资源的分组不显示。变更和进程入口复用现有审查、进程面板。

信息流中的子智能体创建记录和资源列表都可打开右侧子对话，使用同一消息与工具组件读取真实历史。头像按 Core Thread ID 在本地固定生成，不请求外部图片服务。子对话标签支持切换与关闭，关闭阅读视图不停止子任务；重新打开从 Core 恢复。主对话和输入草稿保持原来的所有者。统一子任务面板继续展示执行、检查与交付状态，高级区域保留兼容历史入口。

“定时任务”支持一次、每天和固定间隔。通过会话说明任务与时间；在任务目录选择项目范围后创建，全部任务范围默认使用独立工作目录。新建任务与后续修改复用普通会话的消息区和完整 Composer，Agent 澄清缺失信息并提出安排，宿主校验后自动保存。创建后保留同一管理会话；右上角复用普通会话的任务资源按钮与弹出卡片，点击打开、再次点击关闭；概要只展示最新任务描述和状态，运行记录按需展开，沿用浅色／深色主题。管理会话禁止执行任务目标，消息只展示已解码回复，保存成功以宿主收据为准；未知提交不自动重发。每次运行新建会话，读取当前环境配置，结果关联回同一安排。桌面 Host 离线时不启动，恢复后补执行一次；上一轮未结束时跳过触发。暂停安排只影响后续触发，停止和继续本次运行独立控制。需要审批时在普通会话处理；超时保留受阻记录，继续时重新审批。保存解释时间所用时区，不随设备时区变化重解释固定间隔。仅工作日、月度日历规则仍不支持，Agent 会询问可支持的替代安排。`pnpm --dir clients/gui run test:task-conversation` 使用隔离真实 Electron/Core 与本地确定性模型验证澄清、创建、修改描述、无效提案、暂停／恢复、会话身份及历史保留、浅深色截图和独立执行会话；不替代真实供应商、物理输入或安装包验收。

## 生命周期

主聊天、Side 与子对话按 Core 的稳定消息 ID 展示历史。上下文压缩及正常完成、停止或失败不会移除较早的用户消息、追加指令、附件或 Agent 回复；流式 Turn 事件按条目合并，重新打开和断线恢复使用 Core 还原的完整历史。[历史合并契约](../../docs/api/core.md#传输与会话)区分事件更新与权威快照。`verify` 包含历史投影回归；构建 renderer 后运行 `pnpm --dir clients/gui run test:history`，使用 Chrome、真实桌面 backend/Core/Runtime 和确定性本地模型验证同轮压缩、steer、停止、失败、切换聊天及重载后的气泡内容。该检查使用 preload 传输夹具，不替代 Electron IPC 或安装包验收。

设置中的“数据飞轮”页通过 `areal trajectory status/retry/set-enabled` 读取当前配置、上传进程、积压与最近上传记录，页面可见且连接正常时每 2.5 秒刷新，也可手动刷新和重试。记录分别显示 Turn、模型、Harness 版本、模型调用耗时、Agent 执行耗时与事件/创建/上传时间，汇总范围仅为最近 100 条记录；模型调用耗时包含网络与内部重试。会话可见时另以 15 秒间隔检查，在设置入口标记读取失败或导出异常，恢复后清除。轮询共享一个在途请求，隐藏、离开或断线后停止相应轮询并忽略过期响应，上传信息不进入聊天内容。状态读取不启动 Core 或上传器，也不解密 GUI 凭据；手动重试可能启动上传器，继承 Core 启动的凭据环境。编辑本页显示的配置文件中的 `[trajectory]`，通过 `areal trajectory sync-config` 应用本地上传控制；本页提供启停开关，就绪开启浅绿，关闭或待处理浅橙；只修改 enabled，保留其它配置。已有 Core 的采集参数在空闲后自动安全应用，不取消任务；其它配置变化或失败交由后台服务安全应用，本页不编辑地址或凭据。边界与耗时语义见[配置指南](../../docs/guides/configuration.md#持久轨迹导出)。

`pnpm --dir clients/gui run test:trajectory` 验证命令边界、凭据环境、状态投影，以及轮询时序、单一在途请求、可见性和过期结果隔离。`test:trajectory-config` 使用已构建 CLI，在隔离目录验证配置身份及跨项目一致性，不启动 Core 或上传器。构建 renderer 后，`test:trajectory-ui` 使用本机 Chrome 和隔离桌面服务 fixture 验证真实设置交互、自动刷新、耗时及异常恢复；`AREAL_GUI_TEST_BROWSER` 可指定浏览器。上述检查不替代 Electron/Core 集成验收。 `test:trajectory-native` 使用真实桌面后端、Core、Runtime 和本地模型/接收器，验证关闭启动、运行中启用、空闲安全重启、停用保留与失败副本自动补传，不替代正式远端或 Electron IPC 验收。

macOS 桌面适配器通过系统 `/usr/bin/python3` 保留可信 Core 命令的父进程，与 Runtime 的原生启动方式一致。命令参数、环境和标准输入输出保持原样；超时、取消和强杀作用于真实 Core 子进程，适配器或桥退出时清理其仍运行的直接子进程。该路径不重放写入，也不终止 Core 已建立的持久服务。`pnpm --dir clients/gui run test:core-process` 验证信号退出、超时升级、取消、输出上限及进程清理。

Renderer 仅通过窄 preload IPC 访问桌面适配器。独立适配器使用 `areal service ensure/restart/stop --json` 连接 Core，不直接管理持久 Core 服务的 PID。退出 GUI 断开界面并结算 GUI 拥有的终端，Core Turn/Goal 和已配置的定时任务继续执行；重新打开按权威快照恢复，不自动重放提交。

停止后台服务是显式操作，忙碌时拒绝安全停止；启动恢复对话框提供“取消任务并重启”，即使没有活动轮次，只要仍有活动目标、后台任务或排队消息，也可使用此入口。二次确认后通过公共 `areal service stop --cancel` 完成 Core 取消、执行资源结算和宿主退出，保留待发输入。旧后台尚不支持取消参数时，Main 使用旧后台仍持有的本机 Core 管理连接完成取消，再请求旧后台安全退出；多个 GUI 连接或后台操作未完成时仍拒绝，结果未确认时不自动重发。

macOS 安装包将后台放在独立应用身份的 `AReaL Harness Service.app` 中，前台退出后 Finder 重开只启动前台并复用原后台与 Core；后台通知使用主应用入口打开界面。前后台共享同一安装包资源、配置、凭据名称和数据目录。`verify` 包含身份与路径回归；指定 `AREAL_GUI_EXECUTABLE` 运行 `node --test clients/gui/scripts/macos-service.test.mjs` 可额外检查包内后台入口的真实启动与安全停止，Finder 重开仍需原生安装验收。

Core 观察连接意外关闭时，项目连接所有者以 500ms 起步、最长 30s 的退避重试，通过 `service status --instance` 发现兼容的运行中实例，并用原子 `areal/thread/observe` 恢复 Thread/Task 快照、订阅和通知基线。观察恢复不重绑工具宿主；用户显式认领原生页时，才读取权威状态并在 Thread 空闲时尝试 `thread/resume` 绑定，仍受 Core 宿主冲突检查约束。恢复不重新提交任务、不同步 Provider/MCP 配置，也不执行配置 revision 屏障。旧连接的消息与异步结果失去投影写入资格。显式停止、适配器关闭、停止中的 Core 或部署指纹不兼容会阻止自动恢复；重新连接需显式操作。

桌面命令名、作用域、入口参数外形与错误字段由 `@areal/workbench/desktop-contract` 共享；会话配置具有具体参数类型，其他命令仍依赖运行时作用域校验。Main 保留 IPC 来源验证。嵌套配置和执行规则归 Core；字符串或数字 `code`、`submissionUnknown`、`requestId` 穿过适配器和 Main，供界面核对未知结果。

原生预览由 Main 按项目/Thread 归属管理，每窗口最多 8 个原生页面、每 Workspace 最多 4 个逻辑页面。空闲 LRU 驱逐排除执行中、控制交接中、可见人工页、准备计划和文件交接页；没有候选时拒绝新页。隐藏面板保留页面；归档任务、隐藏项目和窗口退出释放对应 WebContents，迟到的 show 请求不能复活已失效归属。驱逐保留同一 Page shell 的 URL/标题并报告状态损失，重开提升 pageGeneration；导航历史和页面内存不保证恢复，未知操作不会自动重放。同 Workspace 的兄弟页共享临时 Session，最后引用释放后清除临时状态；不同 Workspace 隔离。上限约束原生页面数量，不是整个 Electron 进程内存配额。预览不暴露 preload、Node 或产品 bridge。

适配器保留已有凭据加密、订阅转发和手机配对职责，不运行另一套 Agent 循环。订阅转发的本地能力令牌和固定 loopback 端口在私有目录的 0600 文件中持久化；上游账号/API 凭据继续使用系统安全存储。适配器退出会中断当时的转发 HTTP 响应；稳定地址允许后续请求恢复，不保证崩溃中的流继续。GUI 正常退出保留适配器。

服务注册默认位于 `~/.areal/gui/<GUI 数据目录摘要>`，避免 macOS Unix socket 路径过长；GUI 通过 `AREAL_HARNESS_SERVICE_HOME` 隔离注册，不改变 Core 的默认配置位置。CLI 如需连接相同实例，应显式使用 GUI 的 `AREAL_HARNESS_SERVICE_HOME` 与实例描述；共享配置不代表共享运行数据。认证描述不交给 Renderer。契约见[共享本地服务](../../docs/api/local-service.md)。

## 候选构建与安装包验收

```sh
make release
AREAL_CORE_PROFILE=release AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
```

`gui-package` 只构建 macOS arm64 候选应用，默认使用已构建的 debug Core；安装包使用上面的 release Core。候选输出包含 `.app`、ad-hoc ZIP、依赖清单与 Core 完整性清单，不能作为安装包验收完成结果。`sign:mac` 在独立副本中完成 Developer ID 签名、app/DMG Apple 公证、stapling、Gatekeeper 和通用桌面及模型专项验收；通过后交付其最终 ZIP/DMG。使用全新输出目录，并将包内 Core revision 与最终修复提交绑定。候选包不配置自动更新，签名和公证不执行发布。正式发布与更新频道见[发行流程](../../docs/development/releasing.md#gui-发布)。

构建候选包时，可用 `AREAL_GUI_CORE_BUNDLE=/absolute/core-bundle` 复用已冻结的 Core bundle；打包仍校验内嵌组件哈希，正式发布只接受 `release` Core。该设置仅影响打包输入。

`make gui-smoke` 使用真实 Electron/Core/Runtime 和确定性本地 HTTP 模型，原生沙箱保持启用；项目选择对话框注入临时工作区，测试目录隔离。本地模型请求直连 loopback，测试保留并合并已有 `NO_PROXY` / `no_proxy` 条目。截图及 `manifest.json` 留在命令打印的临时目录，清单记录运行前后的 Core 二进制校验和及失败原因。安装包测试可设置 `AREAL_GUI_EXECUTABLE=/absolute/App.app/Contents/MacOS/AReaL\ Harness\ GUI`，此时不使用外部 Core 路径。实际账号登录、付费模型、其他操作系统和签名安装分发须单独验收。

启动恢复、更新恢复与菜单停止共用生命周期观察和停止流程。普通停止仍保护包含 pending 输入的暂停 Queue；明确取消会保留输入与安排，并将 cancel 意图传到最终公共服务宿主。确认后项目范围或 Core generation 变化会要求重新确认；多项目部分退出或未知结果不会显示成恢复正常。`pnpm --dir clients/gui run test:lifecycle` 验证真实 Core 的 Queue 保留、安全退出，以及隔离 Electron 的菜单取消、重开和不兼容启动恢复；原生对话框由 fixture 应答，不进行更新下载或安装。

缺少 `cancelStop` 的旧后台只在明确 busy 拒绝后使用兼容取消。取消前，可信 Main 将原启用安排的工作区、任务、时间与运行身份写入私有 `legacy-schedule-recovery.json`；旧 Core 自行暂停或安全停止前临时暂停安排后，新后台先确认旧进程退出，再核对任务修订号，仅恢复安排，不恢复已暂停 Run。未知提交不自动重发，任务变化或恢复失败保留记录并提示人工核对。专项 `test:lifecycle:legacy` 需要 `AREAL_CORE_BIN` 和 `AREAL_LEGACY_CORE_BIN` 分别指向已核对的新旧 Core；使用归档旧 adapter 源码、当前 renderer/依赖与隔离数据，不安装或发布版本。可用 `AREAL_LEGACY_PAUSE_UNKNOWN=1` 注入暂停回执丢失。

Core 构建完成后再启动使用该二进制的桌面 smoke，验收期间不重新链接它。模型专项等待保存完成及 Core 的模型选择状态，再进行下一步操作；GUI CI 运行该专项并上传其日志、截图和 manifest。Core 模型配置子进程失败时，后台服务日志保留操作、退出码、signal 和超时分类，不记录密钥或完整环境。

`pnpm --dir clients/gui run test:conversation-derivation` 保留完整 RPC 记录，并在草稿回传的测量区间主动执行一次真实 `trajectory/status` 查询。回传断言只排除该精确只读后台查询；`retry`、发送、配置、排队和 steer 等命令仍使检查失败，相关讨论导航仅另允许 `side/list`。

`pnpm --dir clients/gui run test:connection` 验证真实 Core 断线恢复、并发操作、旧连接消息隔离及显式关闭；`pnpm --dir clients/gui run test:architecture` 通过真实 Electron IPC 验证契约拒绝、错误码透传及原生预览的驱逐、崩溃重建和归属释放。两者使用隔离目录并输出证据，不替代安装包验收。

第三方归属见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。运行时图标沿用源仓库版本；不迁入采集档案、开发 Skills/AGENTS 或来源 Git 历史。
