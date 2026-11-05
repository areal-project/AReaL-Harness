# Web 界面

适用：`clients/gui/renderer/`（React 界面，桌面窗口、本机浏览器、手机与远程网页共用一份）、`clients/gui/packages/`（client、remote-client 等共享包）。

界面逻辑大多在这一层测完，不用启动 Electron。

## 由小到大

1. 单元测试：在 renderer 或包目录运行 `vp test run <文件>`。传输、状态和读写服务（如 `paired-transport.test.ts`）写成纯逻辑测试。
2. 类型与格式：`pnpm --dir clients/gui typecheck`（或改动包的 typecheck）、lint、fmt。
3. 真实 Host 提供的页面：
   - `pnpm --dir clients/gui test:shared-host-consumers`
   - 用 Playwright 打开 Host 提供的 App（本机 WebSocket，gui-read-v1/gui-write-v1）。环境已预装 Chromium，`require('playwright')` 可直接用。
4. 远程网页：
   - `test:remote-static`、`test:remote-relay`、`test:remote-pairing-e2e`、`test:remote-session-e2e`、`test:remote-gui-e2e`
   - 共享界面开关：在 `remote.html` 里设 `localStorage areal.oneProtocol.sharedUi=1` 后重开。连上后旧页面隐藏，断线时旧页面负责重连。

## 规则

- 本机 WebSocket 地址和端口不写进构建产物，凭据和配对票据不进 URL、日志或截图。
- 断言用 `expect.element` 或 `vi.waitFor`，不等动画帧和固定时长。
- 只改视觉时给前后截图，不补 UI 测试。

## Linux 容器的限制

经 Relay 的用例要 Node ≥ 24.2；容器里起不来时记进本机待跑清单。
