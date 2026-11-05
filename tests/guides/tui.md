# TUI

适用：`clients/tui/`（全屏界面、按键、历史、输入文件、本地启动、恢复）。

## 由小到大

1. 单元测试：`cargo test -p areal-tui`。渲染与按键逻辑优先在这里测，不靠终端截图。
2. 先 `make build`，再用真实终端：
   - `node scripts/smoke.mjs` 内含 `scripts/tui-pty-smoke.py`，经真实 PTY 驱动全屏 TUI，用 `terminal_screen.py` 断言屏幕内容。
   - `python3 scripts/tui-local-smoke.py`：本地 TUI + 真实 Runtime + 确定性模型。
   - `node scripts/shared-host-client-smoke.mjs` 的 PTY 场景：客户端强退后原 Turn 继续、resume。
3. 只在 Mac 本机：
   - `python3 scripts/tui-recovery-smoke.py`：凭据恢复与退出键，需 `AREAL_TEST_BIN` 指向完整构建。
   - `make tui-upgrade-smoke`：两套固定产物验证新旧 TUI 共存。

## 手动看一眼

`make tui ARGS='--prompt hello'` 会起本地 Core + Runtime + TUI。手动验证前设隔离 home，不要连到正在用的本地服务。

## 要点

- TUI 和 CLI 共用 `areal-cli` 的入口，改共享启动路径时两份指南都看。
- 本轮 TUI 仍直接说 Core 协议；改走 Host 协议是后续待办。
