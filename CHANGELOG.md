**中文** | [English](CHANGELOG.en.md)

# 更新日志

## GUI 0.1.15

### 修复

- 自动更新安装前准确识别本会话的崩溃报告进程，保留对其他应用会话、独立 CLI 和未知占用的阻拦。
- 先完成安全停止和安装占用检查，再准备 Squirrel 安装；被拒绝的安装不会提前安排在普通退出时替换应用。
- 原生安装准备失败后明确提示后台已停止、结果待核对，要求退出重开检查版本，避免自动重复安装。

### 升级

0.1.13 和 0.1.14 的旧安装前检查可能阻断自动升级，需要一次性使用 DMG 迁移到本版本。后续正式版通过产品更新频道分发。

## GUI 0.1.14

### 修复

- 自动更新完成并确认原后台退出后，新版本继续启动后台，避免重开时停在加载失败页面。
- 保留未确认和未完成操作的恢复保护；用户明确停止后台后仍需主动重连。

## GUI 0.1.13

### 变更

- 为 GPT 订阅和 API 连接提供按具体型号区分的上下文默认值，覆盖 Claude、DeepSeek、Qwen、Kimi 和 GLM。用户显式配置优先，清空后恢复默认。
- 模型菜单显示配置的供应商名称，修正 OpenAI 授权连接的 Fast 请求编码。
- 查看执行耗时及委派活动，在对话中使用工作区文件引用和媒体预览。
- 重连后恢复已保存的 API 凭据和订阅模型选择；暂停后保留工具记录，移除重复的暂停标题。
- 展示更新检查错误，原生更新校验超时时保留后台；后台停止结果未知时阻止重复安装。

### 安装与已知限制

本次 macOS Apple Silicon 版本以 Developer ID 签名、Apple 公证的 DMG 提供手动安装。升级前备份配置和历史，旧版可能无法读取新版保存的数据。等待任务结束并安全停止对应后台后，退出并替换应用；重新启动后在“关于 AReaL Harness”核对 0.1.13。既有自动更新频道独立维护。

Side 面板很窄时，模型控件可能超出面板；遇到此情况可加宽面板。

## CLI / TUI 0.1.7

### 变化

- 独立安装升级先更新命令入口，保留完整旧包与运行中的后台；空闲后可显式重启后台。Homebrew 稳定版与 beta 分别跟踪各自渠道。
- 改善 TUI 断线后的会话恢复；CLI 与单次输入模式可用 `--no-session-name` 关闭自动命名，同时保留历史与恢复。
- 修复网络恢复与子任务交接中的状态保留，以及命令退出码和文件工具结果的呈现。

### macOS 下载与使用（Apple Silicon）

需要 macOS 15+、Xcode Command Line Tools 和可用的 `/usr/bin/python3`。使用公开 Homebrew tap 安装完整 CLI/TUI 与 Runtime：

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
```

`areal --version` 应显示 `areal 0.1.7`。已有 Homebrew 安装先完成任务，运行 `areal service list`，逐工作区用 `areal service stop --workspace /absolute/workspace` 安全停服，再执行 `brew update` 和 `brew upgrade --formula areal-project/tap/areal`。macOS CLI 为 ad-hoc 签名，未经 Developer ID 签名或 Apple 公证。

[macOS arm64 完整归档](https://github.com/areal-project/AReaL-Harness/releases/download/v0.1.7/areal-harness-v0.1.7-aarch64-apple-darwin.tar.gz)供离线分发，须按[安装指南](docs/guides/installation.md)核验并安装完整包。

### Linux 下载与使用（x86_64）

需要 glibc 2.35+（如 Ubuntu 22.04+）及 Python 3.9+；受限或只读运行另需系统 Bubblewrap 与可用 user namespace。下载同一 Release 的安装器与校验清单，校验后安装；安装器自动下载并验证 [Linux x86_64 完整归档](https://github.com/areal-project/AReaL-Harness/releases/download/v0.1.7/areal-harness-v0.1.7-x86_64-unknown-linux-gnu.tar.gz)：

```sh
(
set -eu
download_dir=$(mktemp -d)
cd "$download_dir"
base=https://github.com/areal-project/AReaL-Harness/releases/download/v0.1.7
curl -fL "$base/install.py" -o install.py
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
python3 - <<'VERIFY'
import hashlib
from pathlib import Path
entries = [line.split() for line in Path('SHA256SUMS').read_text().splitlines()]
expected = [digest for digest, name in entries if name == 'install.py']
assert len(expected) == 1
assert hashlib.sha256(Path('install.py').read_bytes()).hexdigest() == expected[0]
VERIFY
python3 install.py --version 0.1.7 --prefix "$HOME/.local"
"$HOME/.local/bin/areal" --version
)
```

成功后执行 `export PATH="$HOME/.local/bin:$PATH"`；新终端也需相同 PATH。已有独立安装使用相同 `--prefix`。从旧正式版首次升级可使用上面的已校验安装器；之后可用 `areal upgrade --check` 查询、`areal upgrade` 更新入口。后台空闲后，用新入口执行 `areal service restart --workspace /absolute/workspace` 显式激活，保留原配置参数。

### 配置与启动（两平台通用）

按[模型配置指南](docs/guides/configuration.md)在 `~/.areal/config.toml` 配置供应商、模型及认证，然后进入项目目录：

```sh
areal config validate
areal             # 启动交互式 TUI
# 或执行一次 CLI 任务
areal exec "概述当前项目的结构"
```

升级前备份配置和历史（默认 `~/.areal`，以及自定义 data-dir）。本版写入状态格式 15，保留旧程序不等于保留兼容的数据备份。独立安装的入口版本与后台版本分别核对；Homebrew 升级前需安全停服。完整说明见[安装与升级指南](docs/guides/installation.md)。

安装、升级与验证命令见[CLI 指南](docs/guides/installation.md)及[GUI 指南](clients/gui/README.md#安装与更新)。
