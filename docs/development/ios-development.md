**中文** | [English](ios-development.en.md)

# 开发和验证 iOS App

移动壳使用 Capacitor 8.5.3 和 Swift Package Manager。`clients/mobile/ios/` 是受控 Xcode 工程，原生部署目标为 iOS 17.4。iOS 17.5 已通过真实 WKWebView 门禁，iOS 17.4 尚需在相应运行时复验。移动入口提供扫码或粘贴 Relay 链接、电脑确认等待页、连接状态与清除设备设置。设备身份由本地 Swift 插件保存到 iOS Keychain。项目页、30 条分页会话列表和共享 Messages 只读会话页已接入 Remote API。会话创建、发送、运行中排队、停止与模型配置使用同一命令恢复状态；审批、提问和 App 推送仍待后续切片。iOS 17.0 的真实 WKWebView 门禁因生产依赖缺少 `Promise.withResolvers` 而在 Noise 阶段失败。最低版本采用已提供该标准 API 的 iOS 17.4。

## 准备环境

安装 Xcode 26 或更高版本、iOS Simulator，以及符合 `clients/gui/package.json` 的 Node 和 pnpm。Capacitor 的要求见[官方环境说明](https://capacitorjs.com/docs/getting-started/environment-setup)。本机只有较新运行时不表示最低系统版本已验收。

GUI 构建遵循 GUI 的 Node engines，Relay CLI 固定使用 Node 24.2.0。两者不同时，测试夹具可通过 `AREAL_RELAY_NODE` 指定 Relay 的 Node 可执行文件；主 runner 和 pnpm 仍使用当前支持的 GUI Node。此变量不跳过 Relay 自身的版本检查，证据记录两种版本。

从仓库根运行依赖安装。移动包属于 GUI workspace，依赖统一写入 `clients/gui/pnpm-lock.yaml`。

```sh
pnpm --dir clients/gui install --frozen-lockfile
pnpm --dir clients/gui mobile:sync
pnpm --dir clients/gui --filter @areal/mobile open
```

`mobile:sync` 先构建 `clients/gui/renderer/mobile/index.html`，再运行 `cap sync ios`。官方生成的 SPM 库平台声明为 iOS 17，App 的部署下限为 iOS 17.4。库的较低下限不扩大 App 的可安装系统范围。构建产物只进入 `clients/gui/dist/mobile/`，Capacitor 的 `webDir` 指向这个目录。普通桌面和 Web Remote 构建不参与移动壳入口。修改 Web 源码后重新运行同步命令，再从 Xcode 或 `pnpm --dir clients/gui --filter @areal/mobile exec cap run ios` 启动。顺序遵循[官方开发工作流](https://capacitorjs.com/docs/basics/workflow)。

默认 Bundle ID 是开发占位值 `com.example.arealharness`。门禁脚本支持 `AREAL_MOBILE_BUNDLE_ID`，并把值作为仅 App 使用的 Xcode `AREAL_MOBILE_BUNDLE_ID` 设置传入。准备设备签名时，在 Xcode 工程和 Capacitor 配置中选定自己拥有的 Bundle ID，再配置开发团队。

## 日常开发快速循环

先使用符合 GUI engines 的 Node；Relay 夹具仍使用独立的 Node 24.2.0。移动命令会先构建共享 UI 包，适用于新 worktree。

```sh
pnpm --dir clients/gui mobile:dev
# 第二个终端；只选择自己的模拟器，不选择真机。
pnpm --dir clients/gui mobile:ios:live --target <simulator-udid>
```

开发服务器固定监听 `127.0.0.1:5174`，端口占用时直接失败，避免连接到另一个 worktree。浏览器打开服务器地址即可修改移动页面。CSS 使用热更新；脚本更新整页重载，重建连接和订阅所有者。离开页面时关闭连接并停止重连。原生模式继续使用 Keychain；浏览器开发替身只在页面内存保存身份，刷新后重新配对，扫码路径使用粘贴代替。它不提供原生密钥存储、权限或后台行为的验收证据。

`mobile:ios:live` 先确认服务器来自当前 worktree，再同步本地资源，临时设置生成配置的开发 URL，使用 MobileBuildMCP 构建并启动专用 Debug App；命令完成或失败后恢复生成配置。开发服务器继续提供更新。该入口避开 `native-run` 对旧 `Simulator.app` 路径的依赖。协议门禁、archive 或发布验证仍先运行 `mobile:sync`，使用本地打包资源。Live Reload 只面向本机模拟器页面开发；连接 Relay 时仍需符合 HTTPS origin 白名单、证书和 WSS 契约。浏览器门禁使用一次性 HTTPS 夹具完成该链路，不代表普通 HTTP 开发地址已获生产 Relay 授权。

以下命令运行生产移动 React 页面，在 Chromium 和 WebKit 中检查未配对、无效链接、真实 Noise 配对与夹具批准、连接成功、脚本更新后的重载，以及浅色和深色截图。平台存储使用浏览器内存替身，Host 使用现有夹具。最后检查发布资源不包含浏览器替身或开发 CSP。它不启动 Rust Core，也不代替原生门禁。

```sh
npm --prefix services/remote-relay ci --ignore-scripts
pnpm --dir clients/gui/app exec playwright-core install chromium webkit
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node pnpm --dir clients/gui test:mobile-browser
```

每次尝试保存到 `.scratch/ios-development/browser/<attempt>/`，包含源码 SHA、dirty 路径、运行时版本、截图与哈希、耗时、结果及清理错误。浏览器上下文仅在隔离的 TLS 夹具中忽略证书错误；生产连接实现和 Relay origin 检查沿用原契约。

本流程参考 t3code 的移动开发生命周期、可重复场景与设备证据组织：脚本热更要处理连接所有者，原生变化需要重建，截图要绑定设备和场景。其 Expo/React Native、Effect runtime 与设备池实现不作为本工程依赖。我们使用 Vite 整页重载与既有 Remote 门禁完成这些职责。

相关 GUI、移动端和 Relay 改动由 `GUI checks` 的 `Linux mobile browser contracts` 检查移动类型、双浏览器路径和生产资源。该 job 执行共享计划的 `mobile` 组，上传报告与证据，并由 `GUI gate` 核对完整结果。原生构建与系统版本门禁使用上述本机入口；该 CI 不声明 iOS 原生或真机验收。浏览器门禁使用独立 Vite 缓存，结束后回收，避免与日常开发服务器共用预打包结果。

## Agent 模拟器工具

`mobile:tools` 固定使用 MobileBuildMCP 2.7.1，在仓库根读取 `.mobilebuildmcp/config.yaml`。配置只启用模拟器、UI 自动化和调试工具，默认工程和 scheme 已设置；模拟器 ID 由调用者指定，避免选中其他任务的设备。

```sh
pnpm --dir clients/gui mobile:sync
pnpm --dir clients/gui mobile:tools simulator list --output json
pnpm --dir clients/gui mobile:tools simulator build-and-run --simulator-id <simulator-udid>
pnpm --dir clients/gui mobile:tools simulator snapshot-ui --simulator-id <simulator-udid>
pnpm --dir clients/gui mobile:tools ui-automation type-text --help
pnpm --dir clients/gui mobile:tools daemon stop
```

CLI 与 MCP 共用工具实现，Agent 可直接使用 CLI，不需要修改全局助手配置。需要 MCP 时，从仓库根以 `pnpm dlx mobilebuildmcp@2.7.1 mcp` 启动。具体参数以该固定版本的 `--help` 为准；构建成功、截图成功和 WebView 控件可操作分别取证。现有 `xcodebuild`／`simctl` 门禁继续负责确定性协议与恢复验收。

## 运行 WKWebView 握手门禁

先通过 `xcrun simctl list runtimes` 查看安装的运行时。默认使用 iOS 17.5，可以指定其他已安装版本。

```sh
pnpm --dir clients/gui test:mobile-handshake
AREAL_IOS_RUNTIME=17.4 pnpm --dir clients/gui test:mobile-handshake
```

脚本创建自己的 iPhone 模拟器，信任一次性夹具 CA，构建并安装 Debug App。App 在真实 `capacitor://localhost` WKWebView 中导入生产 `channel.mjs` 和 `wire.mjs`，经过严格 WSS、Relay、Noise Host pin、现有 `hello`、夹具 Observer 批准、内层 `ready` 和 `project.list`。它还运行错误 Host pin、错误证书名称和未信任 CA 的拒绝检查。脚本结束时停止夹具，并删除自己创建的模拟器。

结果默认保存在 `.scratch/ios-remote-v1/mobile-gate/`。每个系统版本有 JSON、构建日志和截图。`AREAL_MOBILE_EVIDENCE` 可以指定另一个证据目录。`AREAL_MOBILE_CASES=handshake` 可以只运行正向路径。缺失随机数、`crypto.subtle`、`AbortSignal.timeout` 或 `Promise.withResolvers` 会使兼容性门禁失败。握手仍尝试原有实现，以区分实际协议失败和运行时能力缺口。脚本不注入加密替代或兼容性 polyfill。

Debug 原生桥只在收到启动环境变量 `AREAL_MOBILE_PROBE` 时注入临时配对参数。参数和设备私钥只存在进程内存。桥向 App 容器写入公开 Peer ID 和脱敏结果，runner 读取后完成夹具批准。Release 编译不包含这个桥。夹具批准不代替桌面人工配对验收。

这个门禁只证明所运行系统上的移动壳与当前协议链路。它不证明真实供应商、Rust Core 执行、设备密钥存储、后台恢复、真机安装或 TestFlight 可用。

## 验证配对和设备存储

App 使用官方 `@capacitor/app` 8.1.2 处理前后台，使用官方 `@capacitor/barcode-scanner` 3.1.3 扫描 QR。相机权限说明在原生 `Info.plist`。扫码需要实际 iPhone 验证，模拟器的粘贴路径不能替代。

本地 `ArealKeychain` 插件只保存一台电脑的设备身份、Host pin、Relay origin、room、授权 revision 和待核对命令定位信息。单条 Keychain item 使用 `AfterFirstUnlockThisDeviceOnly` 并关闭同步。更新通过 `SecItemUpdate` 原子替换，首次写入使用 `SecItemAdd`。写入失败会提示本次连接可用但下次需重新配对。邀请秘密和输入草稿只保存在内存。Capacitor 的 `loggingBehavior` 设置为 `none`，避免原生插件响应中的身份记录进入调试日志。

进入后台会关闭连接并释放订阅，前台重新读 Keychain 并通过相同 Host pin 重连。清除设备先断开连接，再删除 Keychain 项；用户还需在电脑撤销原授权。撤销或协议不兼容会停止自动重连。

```sh
node --test clients/gui/scripts/mobile-device-store.test.mjs
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node node clients/gui/scripts/mobile-pairing-smoke.mjs
```

配对 runner 使用独立模拟器、严格 TLS 的本地 Relay 和生产 RemoteControl。DEBUG driver 只操作真实 DOM 输入与按钮，经过实际协议授权和原生 Keychain，依次检查配对、杀掉后重开恢复、进入系统设置再回到 App 的前后台切换、电脑撤销授权、清除确认、再次重开未配对和深色页面。观察结果只含状态、Keychain 是否存在、授权 revision 和公开设备指纹。证据保存在 `.scratch/ios-remote-v1/mobile-pairing/`，`AREAL_MOBILE_EVIDENCE` 可覆盖位置。该 driver 的原生入口只在 DEBUG 构建提供。

这些门禁是开发检查。真机扫码、iOS 17.4、真实桌面人工确认、相机权限拒绝后的恢复、VoiceOver 与 TestFlight 仍需各自验收。视觉检查应与五屏参考稿逐态对照；顶部使用本地化“电脑”，因为现有 Host 契约不返回电脑显示名。截图不能替代 VoiceOver、真机键盘和最小系统版本检查。

## 验证项目和只读会话

`MobileWorkspace` 管理项目、会话列表与单个前台会话。在线项目摘要读取 `work.list` 第一页，会话列表每页 30 条，支持刷新和读取更早会话。列表轮询更新第一页时保留用户已展开的范围。Task 行使用 `task.read` 显示实际执行详情。

会话使用共享 `Messages`，通过 `session.open` 原子基线与 `acceptSessionMessage` 接收实时更新。新观察窗口清除旧分页状态。滚出实时窗口的消息进入有界历史页；最多保留三页历史正文，驱逐范围留下可再次读取的占位。历史游标只描述 Core 当前可访问范围，不能据此声称归档历史完整。`SessionBodyReader` 复用共享正文读取与身份校验，离开会话释放订阅。

```sh
node --test clients/gui/scripts/mobile-workspace.test.mjs
AREAL_CORE_BIN=/path/to/locked-slot/areal \
AREAL_RUNTIME_BIN=/path/to/locked-slot/areal-runtime \
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node \
node clients/gui/scripts/mobile-workspace-smoke.mjs
```

真实 Core 门禁必须在 `scripts/verification.py` 的 `slot_lock` 上下文中运行，锁覆盖整个 runner 生命周期。先按[测试指南](testing.md)部署源码匹配的固定槽，包括私有 shell。runner 使用严格 TLS Relay、真实 Core/Runtime、确定性本地模型和原生 WKWebView。它创建两个项目和超过首屏预算的历史，检查首次读取、向上分页、桌面产生的新消息、旧边界消息保留及返回时订阅释放。DEBUG driver 只点击生产 DOM 和滚动消息视图。向上自动分页门禁使用合成 `PointerEvent(pointerType: touch)` 和实际 scroll；实体触摸手势仍需真机检查。证据写入 `.scratch/ios-remote-v1/mobile-workspace/`，包含源码版本、未提交路径、Core/Runtime 文件哈希与清理结果。它不证明真实供应商响应。

## 验证会话命令

新会话通过 `project.models` 读取电脑目录，初始模型显示“电脑默认”，未指定权限时显示“电脑权限”并继承电脑配置。模型、推理强度与权限选择先保留为内存意图。首发依次创建会话、读取 `session.open` 基线、按实际配置 revision 应用选择，再发送消息。配置不可用或被拒绝时保留草稿与已创建会话。运行中发送使用 `enqueue` 和精确 Turn ID；停止针对当前 Turn，Task 会话需要专属控制入口。

移动页面复用 `ConversationComposer`、`ComposerQueue` 和共享 Dialog。输入器工具栏左侧显示权限，右侧显示模型与推理强度。两个入口分别打开独立底部面板，顶部“完成”确认后应用选择；关闭面板丢弃面板内未确认的改动。模型面板支持按目录档位快速选择推理强度，并通过高级设置分别选择模型和推理档位。权限面板复用 GUI 的请求审批、帮我审批和完全访问语义、图标与说明；已有只读或自定义等状态按实际配置显示，受电脑能力与固定只读 Profile 限制。运行中只能查看设置。草稿只保存在内存。每次写入前，同一设备身份必须成功保存到 Keychain，再保存共享 `ClientState` 定位信息。定位信息不含正文或模型选择。回包丢失、断线或重启后只通过 `command.read` 核对原 commandId；核对创建成功不会继续自动发送。未知停止保留原精确记录，但 Core 已确认空闲后可以发送新消息。

```sh
node --test clients/gui/scripts/mobile-commands.test.mjs
AREAL_CORE_BIN=/path/to/locked-slot/areal \
AREAL_RUNTIME_BIN=/path/to/locked-slot/areal-runtime \
AREAL_RELAY_NODE=/path/to/node-24.2.0/bin/node \
node clients/gui/scripts/mobile-command-smoke.mjs
```

命令门禁同样需要 `slot_lock` 覆盖全程。runner 使用真实 Core、两个确定性本地模型、真实 DOM 输入与原生 Keychain，检查非默认模型首发、运行中排队、停止、受理后丢回包与重启核对。结果按独立 attempt 目录保存在 `.scratch/ios-remote-v1/mobile-commands/`，包括可见按钮的实际 CSS 触控尺寸。`AREAL_MOBILE_DERIVED` 可指定共享 DerivedData 缓存；证据目录不复用旧尝试。DOM 输入检查不替代实体键盘或触摸验收。

移动项目和会话列表使用内容自适应高度的无阴影卡片；项目名、会话名和顶部标题限制为可用宽度内的单行，超长时显示省略号，完整值保留在 DOM 和 `title` 属性。列表刷新只更新无障碍状态与原位控件，不插入会推移内容的加载行。消息正文继续完整显示。

触摸形态的 Composer 输入使用现有 16px 字号 token，避免 iOS 聚焦时自动放大；消息复制、统计和执行过程折叠入口使用 44pt 最小触控区域。当前构建不包含审批、同步或 Task 提问回复、Task 暂停、边缘滑返和推送；Task 详情仍只读。

## 选择后续验证工具

先使用原生 `xcodebuild`、`simctl` 和结构化结果重跑门禁。需要 Agent 统一构建、启动和日志工具时，可评估社区 [MobileBuildMCP](https://github.com/getsentry/MobileBuildMCP)。本工程不依赖它。

业务页面形成后，采用 [Appium XCUITest 的 hybrid contexts](https://appium.github.io/appium-xcuitest-driver/latest/guides/hybrid/) 验证原生壳与 Web DOM 的切换。Debug 壳开启 `WKWebView.isInspectable`。评估 Maestro 时，先确认其[已知问题](https://docs.maestro.dev/extra-materials/troubleshooting/known-issues)中的 WebView 可访问性限制。

## 准备 Release archive 和 TestFlight

完成 Web 同步后，在 Xcode 配置拥有的 Bundle ID、版本号和开发团队，选择真实 iOS 设备目标并执行 Product → Archive。也可使用以下工程入口，签名配置由发行者提供。

```sh
xcodebuild -project clients/mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath .scratch/ios-remote-v1/AReaL.xcarchive archive
```

手动签名时，向命令传入 `AREAL_MOBILE_BUNDLE_ID`、`DEVELOPMENT_TEAM`、`CODE_SIGN_STYLE=Manual`、`CODE_SIGN_IDENTITY` 和 `AREAL_MOBILE_PROVISIONING_PROFILE`。描述文件设置只应用到 App target。证书、描述文件和私钥放在 Git 之外。iOS 图标沿用桌面原图并合成到不透明黑色背景；启动页使用系统背景。

在 Archives organizer 选择 archive，使用 Distribute App → App Store Connect → Upload，检查签名证书、描述文件和 entitlements 后上传，按 [Apple 上传说明](https://help.apple.com/xcode/mac/current/en.lproj/dev442d7f2ca.html)继续 TestFlight 分发。上传需要明确的发行授权和凭据。内部测试包导出使用 `method=app-store-connect`、`testFlightInternalTestingOnly=true` 和拥有的签名描述文件，并在 App Store Connect 确认处理完成且已分配到目标内部组。包内 Noise 实现使用 Apple OS API 之外的标准加密算法，出口合规问题应据此如实填写。

结构检查可以另加 `CODE_SIGNING_ALLOWED=NO` 生成未签名 archive。它不代表可安装或可上传的发行包。Release 必须排除 DEBUG 配对诊断桥。当前本地门禁未完成真机扫码、锁屏推送或 TestFlight 验收。
