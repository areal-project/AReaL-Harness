# CLI

适用：`clients/cli/`（二进制 `areal`）：`exec`、`-p`、`host`、`service`、`plugins`、`config`、`upgrade` 等子命令。

## 由小到大

1. 单元与集成测试：`cargo test -p areal-cli`。改参数解析看 `src/run_tests.rs`，配置看 `tests/config.rs`，模型共享看 `tests/shared_models.rs`。
2. 先 `make build`，再用真实二进制冒烟：
   - `node scripts/smoke.mjs`（`make smoke` 的一部分）：HTTP 模型流、持久化、强杀恢复。
   - `node scripts/shared-host-client-smoke.mjs`：`exec`、`-p`、headless 与 PTY 客户端强退后原 Turn 继续，resume 与 Web 复用。用 `AREAL_TEST_BIN_DIR=target/debug` 指向本次构建。
   - 插件命令：`node scripts/plugin-cli-p1-smoke.mjs`。
   - 权限：`permission-modes-smoke.mjs`、`permission-presets-smoke.mjs`（Linux Core 不支持权限模式，留给 Mac）。
3. 升级与安装：`make upgrade-smoke`、`python3 scripts/install-smoke.py`。Homebrew 和签名包只在 Mac 跑。

## 要点

- `exec` 的 `--output-format stream-json` 是对外协议，改它要补 `run_tests.rs` 里对应断言。
- `areal host` 管理命令改动同时跑 [core.md](core.md) 的 Host 冒烟。
- 本轮 CLI 仍由 Host 拉起 Core 后直接说 Core 协议，不经 Host 网关。改走 Host 协议是后续待办。

## 规则

- 一律用隔离 `AREAL_HARNESS_HOME`，不对 `~/.areal` 启动服务。
- 凭据不进命令行参数和日志；测试用确定性本地模型。
