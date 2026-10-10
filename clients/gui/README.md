**中文** | [English](README.en.md)

# AReaL Harness GUI

完整桌面客户端：React renderer、Electron 原生适配器与公开依赖。与 CLI/TUI/Web 同属 Clients 层；Core 持有会话、历史、模型循环和定时任务，Runtime 执行工具。移动端源码后续迁移，桌面侧配对入口保留。

## 开发

从仓库根执行，需 Node.js 22.19+、pnpm 11.7.0 及仓库 Rust 工具链：

```sh
make build
make gui-install
make gui
```

`make gui-build` 只构建 renderer。`pnpm --dir clients/gui typecheck` 检查界面类型及共享桌面契约的 JSDoc 类型（尚未覆盖整个 Electron CJS 实现），`pnpm --dir clients/gui run verify` 检查公开文件边界。此模块单独锁定 pnpm 依赖，不改变仓库 SDK 的 npm 工具链。依赖来自公开 npm registry；Electron 和 Core 工具首次安装需网络。

`make gui-install` 按锁文件安装依赖后，显式运行 Electron 官方安装器下载固定版本的原生运行时。

`AREAL_CORE_BIN` 可指定可信 Core 的绝对路径；开发默认使用仓库 `target/debug/areal`。默认使用独立的 `AReaL Harness GUI Dev/<工作树摘要>` 数据目录；安装版使用 `AReaL Harness GUI`。不导入或替换旧桌面安装与数据。`AREAL_GUI_USER_DATA`、`AREAL_CORE_HOME`、`AREAL_HARNESS_SERVICE_HOME` 可显式设置隔离目录。模型配置默认与 CLI 共用 `~/.areal/config.toml`，由 Core 统一解析、校验和保存；`AREAL_HARNESS_HOME` 可修改 Core 配置 home，`AREAL_CORE_CONFIG` 可显式选择其他文件。首次读取不创建配置，首次保存由 Core 创建默认文件；旧 GUI 隔离目录中的配置不会自动合并。

macOS 开发和安装版均需要可执行的 `/usr/bin/python3`，供 Runtime 及可信工具助手启动中转；可通过 `xcode-select --install` 安装 Xcode Command Line Tools。该解释器不随应用打包；共享服务在启动前检查可用性并返回明确错误。

## Composer

模型设置分别显示已保存的“已启用／未启用”、Core 的“环境变量凭据／已保存凭据／无需认证”及就绪状态和“待应用／已应用”；未保存修改另行提示。保存不改变运行中的项目，应用配置后刷新 Composer 的模型目录。状态与共享配置接口见[配置指南](../../docs/guides/configuration.md#gui-与-cli-共享模型目录)。

新草稿和已有聊天的 `+` 与 `/` 共用功能/Skills 分组目录和搜索；方向键选择，Enter 确认，Esc 关闭。Skill 附加到当前消息，发送前由 Core 读取正文；失败保留草稿和标签。已选可用模型的入口先显示强度，再进入真实模型目录；未选模型或所选模型不可用时直接显示目录。强度值与可用状态取自 Core，缺少凭据的模型保留名称并显示“缺少 API Key”，不可选择。菜单中的“配置模型”打开模型设置；空目录的“请先配置模型”也可点击。`pnpm --dir clients/gui run test:model-selection` 使用隔离 Electron/Core 验证目录、设置入口、凭据保存与应用后的模型执行；远端供应商支持须单独验证。

中文输入法组词期间只更新编辑器候选文字，确认或取消后同步最终草稿；候选确认的 Enter 不发送消息。输入光标沿用正文颜色。

新一次发送或调整方向会清除上一操作的界面错误提示；本次失败仍显示原因并保留草稿，受理结果未知的消息不会自动重发。

图片显示缩略图，UTF-8 文本附件可通过“在文本框中显示”追加到正文。超过 200 字符或至少 5 行的粘贴折叠为文本卡片，展开上限为 1 MiB；文件与技能删除不影响正文。目标模式在原输入区编写，创建目标只消费正文，其余附件继续保留。`pnpm --dir clients/gui run test:composer` 使用隔离 Electron/Core/Runtime 验证这些路径。

## 对话资源

对话顶部的“任务资源”在顶部图标下方的紧凑浮层展示当前工作区变更、Core 直接子智能体、受管后台进程及用户附件和已验证的文件读取来源；Git 工作区保留变更数量为 0 的审查入口；其他没有资源的分组不显示。变更和进程入口复用现有审查、进程面板。

信息流中的子智能体创建记录和资源列表都可打开右侧子对话，使用同一消息与工具组件读取真实历史。头像按 Core Thread ID 在本地固定生成，不请求外部图片服务。子对话标签支持切换与关闭，关闭阅读视图不停止子任务；重新打开从 Core 恢复。主对话和输入草稿保持原来的所有者。普通子对话与 Workgroup 隔离写任务各自沿用现有入口。

## 生命周期

Renderer 仅通过窄 preload IPC 访问桌面适配器。独立适配器使用 `areal service ensure/restart/stop --json` 连接 Core，不直接管理 Core PID。退出 GUI 断开界面并结算 GUI 拥有的终端，Core Turn/Goal 和已配置的定时任务继续执行；重新打开按权威快照恢复，不自动重放提交。停止后台服务是显式操作，忙碌时拒绝安全停止。

Core 观察连接意外关闭时，项目连接所有者以 500ms 起步、最长 30s 的退避重试，通过 `service status --instance` 发现兼容的运行中实例，恢复 Thread/Task 快照、订阅和通知基线。`thread/resume` 同时重建工具宿主绑定；恢复不重新提交任务、不同步 Provider/MCP 配置，也不执行配置 revision 屏障。旧连接的消息与异步结果失去投影写入资格。显式停止、适配器关闭、停止中的 Core 或部署指纹不兼容会阻止自动恢复；重新连接需显式操作。

桌面命令名、作用域、入口参数外形与错误字段由 `@areal/workbench/desktop-contract` 共享；会话配置具有具体参数类型，其他命令仍依赖运行时作用域校验。Main 保留 IPC 来源验证。嵌套配置和执行规则归 Core；字符串或数字 `code`、`submissionUnknown`、`requestId` 穿过适配器和 Main，供界面核对未知结果。

原生预览由 Main 按项目/Thread 归属管理，最多缓存 8 个页面，优先释放最久未访问的非当前页面。隐藏面板保留页面；归档任务、隐藏项目和窗口退出释放对应 WebContents，迟到的 show 请求不能复活已失效归属。驱逐后按界面保存的 URL 重建，崩溃后按页面 URL 重建；导航历史、页面内存及驱逐前的 Session 状态不保证恢复。该上限约束原生页面数量，不是整个 Electron 进程内存或 Session 对象数量的配额。预览仍使用独立临时 Session，不暴露 preload、Node 或产品 bridge。

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

`make gui-smoke` 使用真实 Electron/Core/Runtime 和确定性本地 HTTP 模型，原生沙箱保持启用；项目选择对话框注入临时工作区，测试目录隔离，截图及 `manifest.json` 留在命令打印的临时目录。安装包测试可设置 `AREAL_GUI_EXECUTABLE=/absolute/App.app/Contents/MacOS/AReaL\ Harness\ GUI`，此时不使用外部 Core 路径。实际账号登录、付费模型、其他操作系统和签名安装分发须单独验收。

Core 构建完成后再启动使用该二进制的桌面 smoke，验收期间不重新链接它。模型专项等待保存完成及 Core 的模型选择状态，再进行下一步操作；GUI CI 运行该专项并上传其日志、截图和 manifest。Core 模型配置子进程失败时，后台服务日志保留操作、退出码、signal 和超时分类，不记录密钥或完整环境。

`pnpm --dir clients/gui run test:connection` 验证真实 Core 断线恢复、并发操作、旧连接消息隔离及显式关闭；`pnpm --dir clients/gui run test:architecture` 通过真实 Electron IPC 验证契约拒绝、错误码透传及原生预览的驱逐、崩溃重建和归属释放。两者使用隔离目录并输出证据，不替代安装包验收。

第三方归属见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。运行时图标沿用源仓库版本；不迁入采集档案、开发 Skills/AGENTS 或来源 Git 历史。
