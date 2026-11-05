# GUI（Electron 外壳）

适用：`clients/gui/app/`（Main）：窗口与菜单、浏览器预览、电脑控制、系统加密、升级与退出、旧后台迁移、attach 到桌面后台。

只改界面逻辑时读 [web.md](web.md)，不用启动 GUI。

## 由小到大

1. Main 的单元测试与类型检查：`pnpm --dir clients/gui typecheck`，改 TS 时还要跑 Main 的 TS 构建。
2. 门禁：IPC 冻结检查禁止新增 desktop `commandDefinitions` 操作；新文件用 TS。
3. 不开窗口的进程测试：
   - 退出与交接：`test:host-quit`、`test:host-handoff`、`test:remote-gui-quit`
   - 浏览器预览：`test:browser-contracts`、`test:browser-attach`、`test:browser-loading` 等 `test:browser-*`
   - 电脑控制：`test:automation`
   - 后台与 Host：`test:workbench-backend`（见 [core.md](core.md)）
4. 真实 Electron：`make gui-smoke` 在隔离目录验证 Electron、Core 和本地模型。手动看用 `make build && make gui`，先设隔离数据目录。
5. 候选安装包：`make gui-package`（只在 Mac）。

## 只在 Mac 安装包上验

- 签名应用从 `Resources/areal-workbench` 拉起后台；关窗口后后台还在；`areal host stop` 后退出；崩溃按退避重启。
- 真实 safeStorage：旧 Cloud token 和旧密文能解开，新保存的能读回。
- 升级、签名、公证。
- OP-07：GUI 开着时手机会话能用浏览器工具；关 GUI 后报"不可用"，不卡住、不重发。

## 规则

- `~/Library/Application Support/AReaL Harness GUI` 和 `~/.areal` 只读可复制，不对它启动、不清理。
- 只结束自己启动时记下 PID 的进程，不按名字或路径匹配去杀。
