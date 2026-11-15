# macOS 启动、凭证恢复与历史会话验收

以下命令使用隔离目录，不会读取或写入 `~/.areal` 或已安装 GUI 的真实数据。

## 前提检查

```bash
cd /Users/sailfish/CodeProject/AReaL-Harness
launchctl print "gui/$(id -u)" >/dev/null && echo "GUI session: ready"
launchctl print system/com.apple.WindowServer >/dev/null && echo "WindowServer: ready"
sw_vers
pnpm --dir clients/gui exec node -e 'console.log(require("electron/package.json").version)'
```

预期：GUI session、WindowServer 都显示 `ready`，Electron 版本与待验收构建一致。

## 启动页与真实历史会话

```bash
cd /Users/sailfish/CodeProject/AReaL-Harness
export AREAL_CORE_BIN="$PWD/.local/dev-bin/areal"
export AREAL_STARTUP_ROUNDS=1
export AREAL_GUI_USER_DATA="$(mktemp -d /tmp/areal-gui-user.XXXXXX)"
export AREAL_CORE_HOME="$(mktemp -d /tmp/areal-core-home.XXXXXX)"
export AREAL_HARNESS_SERVICE_HOME="$AREAL_CORE_HOME"
export AREAL_HARNESS_HOME="$AREAL_CORE_HOME"
pnpm --dir clients/gui run test:startup
```

预期：Electron 窗口能启动；首次可见窗口不会出现错误页闪烁；保存的会话首帧保持原会话标题和 thread id；历史正文最终出现 `STARTUP_HISTORY_OK`；退出后隔离目录中的 Host/Core 进程均有清理回执。

## 凭证恢复

在同一隔离用户目录运行：

```bash
cd /Users/sailfish/CodeProject/AReaL-Harness
export AREAL_CORE_BIN="$PWD/.local/dev-bin/areal"
pnpm --dir clients/gui run test:recovery-electron -- run
```

预期：恢复后的供应商仍引用 `AREAL_CREDENTIAL_<source-provider-id>`，模型目录不出现“模型服务登录或凭证有问题”；若系统安全存储不可用，页面应停在明确的凭证设置入口，而不是把恢复失败伪装成历史读取失败。

## 失败时收集

```bash
find "$AREAL_GUI_USER_DATA" "$AREAL_CORE_HOME" -maxdepth 3 -type f \
  \( -name 'electron*.log' -o -name 'host.log' -o -name 'service.log' -o -name '*startup*.json' \) \
  -print
```

不要把凭据、票据或完整模型配置贴入日志；只提交退出码、`signal`、`errorCode` 和阶段耗时。

