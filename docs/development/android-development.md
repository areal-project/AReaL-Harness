**中文** | [English](android-development.en.md)

# 开发和验证 Android App

Android 与 iOS 共用 `clients/gui/renderer/mobile/index.html`、`MobileClient`、`MobileWorkspace`、`MobileCommands`、Messages 和 Composer。`clients/mobile/android/` 是 Capacitor 8.5.3 官方生成的受控原生工程，业务适配与 instrumentation 使用 Kotlin 2.2.20/Gradle，使用同一 `clients/gui/dist/mobile/`。扫码插件要求最低 Android 8.0（API 26），编译和目标 SDK 为 36。系统版本不代表 WebView 能力已验收。入口在加载业务模块前检查安全上下文、WebCrypto、`AbortSignal.timeout` 和 `Promise.withResolvers`，缺失时显示更新提示；最低可用 WebView 版本仍需对应版本的真实门禁验证。

当前范围与 [iOS 开发指南](ios-development.md)一致。支持扫码和粘贴配对、电脑批准、身份恢复、前后台重连、项目和会话浏览、历史和实时消息、普通会话创建、模型与权限选择、发送、排队和停止，以及 UNKNOWN 命令核对。Task 详情只读；审批、提问回复、文件/Diff 打开和 App 推送尚未接入。配对入口为扫码和粘贴，没有 App Links 或自定义深链入口。

## 环境与构建

安装符合 GUI engines 的 Node/pnpm、JDK 21、Android SDK Platform 36、Build Tools 35.0.0（AGP 默认要求） 和 Android Studio 或独立 emulator。Gradle wrapper 由官方 `cap add android` 生成，使用工程内版本。设置 `JAVA_HOME`、`ANDROID_HOME`，把 SDK 的 `platform-tools` 加入 PATH。从仓库根运行。

```sh
pnpm --dir clients/gui install --frozen-lockfile
pnpm --dir clients/gui mobile:typecheck
pnpm --dir clients/gui mobile:android:build
pnpm --dir clients/gui mobile:android:open
pnpm --dir clients/gui mobile:android:run --target <device-id>
```

`mobile:android:sync` 先构建移动 Web 入口，再 `cap sync android`。`mobile:android:build` 生成 `clients/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。Debug application ID 为 `com.example.arealharness.debug`，Release 为开发占位值 `com.example.arealharness`。正式发布前需选择自己的 application ID 并配置签名。此流程不发布 APK，也不配置外部服务。iOS 的 `mobile:sync`、`mobile:ios:live` 和原有脚本继续独立使用。

日常 Live Reload 使用隔离 emulator。

```sh
pnpm --dir clients/gui mobile:dev
# 第二个终端。
pnpm --dir clients/gui mobile:android:live --target emulator-5554
```

脚本核对当前 worktree 的 `127.0.0.1:5174` 开发服务器，调用官方 `cap run android --live-reload --host 127.0.0.1 --port 5174 --forwardPorts 5174:5174` 构建和部署到 emulator。退出时恢复生成配置和 Android Manifest，并删除转发。开发服务器继续运行时修改源码可刷新。Debug 仅为本机 `127.0.0.1` 允许 HTTP，Release 仍使用本地 HTTPS Origin。连接 Relay 时还需允许实际开发 Origin；生产的 `https://localhost` 白名单不包含这个 HTTP 开发地址。

## 平台边界

`ArealKeychain` 的 `load/save/clear/deviceName` 与 iOS 契约相同。Android Keystore 保存 AES-256-GCM 密钥；`noBackupFilesDir/remote-device.enc` 只保存加密信封，由 `AtomicFile` 原子替换。解密后仍是 DeviceStore 既有完整 `schema: 1` 字符串，包括 UNKNOWN locator。原生层不解析业务记录。明文 UTF-8 上限 262144 字节。不存在的记录返回 null；损坏、密钥丢失或解密失败会拒绝读取和覆盖，必须由用户显式清除后重新配对。应用备份关闭，密钥和身份不跨设备迁移。

Android hello 使用 `clientKind: "android"`，需配套支持该值的桌面版本。旧 Host 会拒绝 Android hello，旧版配置解析器也不能读取含 Android grant 的配置；批准 Android 设备后不支持直接降级到旧桌面版本。该字段只用于展示，不扩大权限。桌面设置显示 Android 手机图标和名称。

Android 本地 Origin 是 `https://localhost`。Relay 部署者需把该精确值加入已有 `allowedClientOrigins`，iOS 的 `capacitor://localhost` 仍属于 `allowedAppOrigins`。HTTPS 不放入 `allowedAppOrigins`。这项本地实现不修改任何现有 Relay 部署。Release 使用系统 TLS 信任链，保留主机名、有效期和链校验。Debug 支持系统及用户 CA；验收 runner 的临时测试 CA 仅进入当次 Debug APK。

系统先处理可见键盘。App 返回键按顺序取消 Composer 模型/权限面板、清除确认、设置、粘贴输入，再沿会话/新建/Task → 工作列表 → 项目列表返回。取消面板不提交配置。根页面最小化 App；扫码原生活动的返回由扫码插件处理。键盘、相机权限和厂商返回手势需真机验收。

## 可重复门禁

首次在新 worktree 运行产品门禁前，执行 `npm ci --prefix services/remote-relay --ignore-scripts` 和 `pnpm --dir clients/gui --filter @areal/gen-ui build`，准备 Relay 及桌面夹具依赖。workspace/commands 另需指向同一完整固定槽的 `AREAL_CORE_BIN` 与 `AREAL_RUNTIME_BIN`。macOS 测试环境须允许 Runtime 的 Seatbelt 预检。

只使用本任务新建的隔离 emulator，显式指定 serial。runner 不选择真机或修改系统 CA。Relay 夹具仍有独立 Node 版本要求，可用 `AREAL_RELAY_NODE` 指向兼容版本。

```sh
AREAL_ANDROID_SERIAL=emulator-5554 pnpm --dir clients/gui test:mobile-android-storage
AREAL_ANDROID_SERIAL=emulator-5554 pnpm --dir clients/gui test:mobile-android
AREAL_ANDROID_SERIAL=emulator-5554 AREAL_MOBILE_SCENARIO=workspace pnpm --dir clients/gui test:mobile-android
AREAL_ANDROID_SERIAL=emulator-5554 AREAL_MOBILE_SCENARIO=commands pnpm --dir clients/gui test:mobile-android
```

workspace/commands 场景需设置绝对路径 `AREAL_CORE_BIN` 和同一已部署固定槽中的 `AREAL_RUNTIME_BIN`。runner 使用 `scripts/verification.py` 的 `slot_lock` 覆盖整个夹具生命周期。先按[测试指南](testing.md)部署与源码匹配的组件，再设置这两个环境变量运行场景。

存储门禁通过 instrumentation 跨杀进程检查保存、读取、清除、损坏拒绝、密钥丢失拒绝、大小限制和密文无身份明文。产品门禁复用真实 Relay 和共享 `product-driver.ts`，通过 debug-only `DebugActivity` 注入场景并回收脱敏结果。Release 源集没有诊断 Activity、消息桥或测试 CA。workspace/commands 使用已有真实 Core 和确定性本地模型夹具。每轮产品门禁在首次配对前仅清除指定隔离 emulator 上的专属 Debug App 数据，各恢复场景之间保留身份。runner 为 Relay 做临时 adb reverse，退出时关闭本次 App、服务并删除转发。成功报告保存在 `.scratch/android/product/`，可用 `AREAL_MOBILE_EVIDENCE` 覆盖；包含源码版本、Android/WebView 环境、结果与截图，失败另存阶段和 logcat。

设置 `AREAL_ANDROID_HOLD=1` 会在首次配对成功后保留 App 和夹具最多十分钟，供真实键盘与返回键检查；删除证据目录中的 `hold.json` 继续自动场景，退出仍执行清理。

构建、instrumentation、真实 WebView、Core/Runtime、真实供应商、真机相机/键盘和 Release 安装包分别验收。iOS simctl 结果不能作为 Android 证据。测试夹具不验证真实供应商或外部 Relay 配置。
