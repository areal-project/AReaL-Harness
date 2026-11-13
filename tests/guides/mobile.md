# 移动端

适用：`clients/gui/renderer/src/mobile/`（手机页面与客户端）、`clients/mobile/`（iOS/Android 原生壳）。

## 由小到大

1. 逻辑测试（不需要模拟器）：
   - `pnpm --dir clients/gui test:mobile-commands`、`test:mobile-workspace-state`、`test:mobile-storage`
   - 配对与握手：`test:mobile-pairing`、`test:mobile-handshake`
2. 浏览器里跑手机页面：`test:mobile-browser`（Playwright 窄屏）。共享界面在页面里设 `areal.oneProtocol.sharedUi=1` 后重开。
3. 构建：`mobile:typecheck`、`mobile:build`、`mobile:sync`（把 web 产物同步进原生壳）。
4. 模拟器（Mac）：
   - `mobile:dev` 加 `mobile:ios:live --target <模拟器 UDID>`
   - 或 `mobile:tools simulator build-and-run --simulator-id <UDID>`
   - Android：`test:mobile-android`，详见 `docs/development/android-development.md`。
5. 真机与 TestFlight：见 `docs/development/ios-development.md`。

## 共享界面要验的

配对并记住设备后显示与桌面同一份界面；窄屏能看项目和会话、发送、停止、审批；切后台回来自动重连；桌面撤销设备后回到"已撤销"。

## 要点

- 已发布的 iOS/PWA 保留原方法表，开关关着时旧页面照常工作。
- 跨项目领域（资料库、任务目录、manage）目前只开放本机连接，远程设备上应显示不可用，而不是报错卡住。
- `test:mobile-workspace-state` 第 7 条需要锁定的 `AREAL_CORE_BIN`，容器里跑不了。
