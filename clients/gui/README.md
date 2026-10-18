**中文** | [English](README.en.md)

# AReaL Harness GUI

完整桌面客户端：React renderer、Electron 原生适配器与公开依赖。与 CLI/TUI/Web 同属 Clients 层；Core 持有会话、历史、模型循环和定时任务，Runtime 执行工具。移动端源码后续迁移，桌面侧配对入口保留。

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

## Composer

权限审批和 Ask User 共用固定在对话底部的交互卡片。审批默认显示拒绝与允许一次，Core 允许记住授权时才提供任务／项目范围菜单；原有授权条件和状态核对保持不变。问题支持选项、自由回答和逐题填写；“跳过”或关闭仅暂时收起，保留草稿和待回答入口，不提交空答案或停止任务。提问期间输入框保持紧凑，审批期间保留并隐藏普通输入草稿；回答回显来自 Core 已保存的工具历史。`pnpm --dir clients/gui run test:interactions` 使用隔离的真实 Electron/Core/Runtime 和确定性本地模型验证审批、回答及历史恢复，不替代真实供应商或安装包验收。

模型设置分别显示已保存的“已启用／未启用”、Core 的“环境变量凭据／已保存凭据／无需认证”及就绪状态和“待应用／已应用”；未保存修改另行提示。保存不改变运行中的项目，应用配置后刷新 Composer 的模型目录。保存或应用尚未完成时，设置返回与分类按钮暂时禁用，完成后恢复，避免导航点击被静默丢弃。状态与共享配置接口见[配置指南](../../docs/guides/configuration.md#gui-与-cli-共享模型目录)。

新草稿和已有聊天的 `+` 与 `/` 共用功能/Skills 分组目录和搜索；方向键选择，Enter 确认，Esc 关闭。Skill 附加到当前消息，发送前由 Core 读取正文；失败保留草稿和标签。已选可用模型的入口先显示强度，再进入真实模型目录；未选模型或所选模型不可用时直接显示目录。强度值与可用状态取自 Core，缺少凭据的模型保留名称并显示“缺少 API Key”，不可选择。菜单中的“配置模型”打开模型设置；空目录的“请先配置模型”也可点击。`pnpm --dir clients/gui run test:model-selection` 使用隔离 Electron/Core 验证目录、设置入口、凭据保存与应用后的模型执行；远端供应商支持须单独验证。

中文输入法组词期间只更新编辑器候选文字，确认或取消后同步最终草稿；候选确认的 Enter 不发送消息。输入光标沿用正文颜色。

新一次发送或调整方向会清除上一操作的界面错误提示；本次失败仍显示原因并保留草稿，受理结果未知的消息不会自动重发。

图片显示缩略图，UTF-8 文本附件可通过“在文本框中显示”追加到正文。超过 200 字符或至少 5 行的粘贴折叠为文本卡片，展开上限为 1 MiB；文件与技能删除不影响正文。目标模式在原输入区编写，创建目标只消费正文，其余附件继续保留。`pnpm --dir clients/gui run test:composer` 使用隔离 Electron/Core/Runtime 验证这些路径。

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

## 生命周期

设置中的“数据飞轮”页通过 `areal trajectory status/retry` 读取当前配置、上传进程、积压与最近上传记录，页面可见且连接正常时每 2.5 秒刷新，也可手动刷新和重试。记录分别显示 Turn、模型、Harness 版本、模型调用耗时、Agent 执行耗时与事件/创建/上传时间，汇总范围仅为最近 100 条记录；模型调用耗时包含网络与内部重试。会话可见时另以 15 秒间隔检查，在设置入口标记读取失败或导出异常，恢复后清除。轮询共享一个在途请求，隐藏、离开或断线后停止相应轮询并忽略过期响应，上传信息不进入聊天内容。状态读取不启动 Core 或上传器，也不解密 GUI 凭据；手动重试可能启动上传器，继承 Core 启动的凭据环境。使用 `scripts/configure-trajectory.py` 配置本页显示的文件；已有 Core 的采集参数需安全重启生效，本页不编辑地址或凭据。边界与耗时语义见[配置指南](../../docs/guides/configuration.md#持久轨迹导出)。

`pnpm --dir clients/gui run test:trajectory` 验证命令边界、凭据环境、状态投影，以及轮询时序、单一在途请求、可见性和过期结果隔离。`test:trajectory-config` 使用已构建 CLI，在隔离目录验证配置身份及跨项目一致性，不启动 Core 或上传器。构建 renderer 后，`test:trajectory-ui` 使用本机 Chrome 和隔离桌面服务 fixture 验证真实设置交互、自动刷新、耗时及异常恢复；`AREAL_GUI_TEST_BROWSER` 可指定浏览器。上述检查不替代 Electron/Core 集成验收。

macOS 桌面适配器通过系统 `/usr/bin/python3` 保留可信 Core 命令的父进程，与 Runtime 的原生启动方式一致。命令参数、环境和标准输入输出保持原样；超时、取消和强杀作用于真实 Core 子进程，适配器或桥退出时清理其仍运行的直接子进程。该路径不重放写入，也不终止 Core 已建立的持久服务。`pnpm --dir clients/gui run test:core-process` 验证信号退出、超时升级、取消、输出上限及进程清理。

Renderer 仅通过窄 preload IPC 访问桌面适配器。独立适配器使用 `areal service ensure/restart/stop --json` 连接 Core，不直接管理持久 Core 服务的 PID。退出 GUI 断开界面并结算 GUI 拥有的终端，Core Turn/Goal 和已配置的定时任务继续执行；重新打开按权威快照恢复，不自动重放提交。停止后台服务是显式操作，忙碌时拒绝安全停止。

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

Core 构建完成后再启动使用该二进制的桌面 smoke，验收期间不重新链接它。模型专项等待保存完成及 Core 的模型选择状态，再进行下一步操作；GUI CI 运行该专项并上传其日志、截图和 manifest。Core 模型配置子进程失败时，后台服务日志保留操作、退出码、signal 和超时分类，不记录密钥或完整环境。

`pnpm --dir clients/gui run test:connection` 验证真实 Core 断线恢复、并发操作、旧连接消息隔离及显式关闭；`pnpm --dir clients/gui run test:architecture` 通过真实 Electron IPC 验证契约拒绝、错误码透传及原生预览的驱逐、崩溃重建和归属释放。两者使用隔离目录并输出证据，不替代安装包验收。

第三方归属见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。运行时图标沿用源仓库版本；不迁入采集档案、开发 Skills/AGENTS 或来源 Git 历史。
