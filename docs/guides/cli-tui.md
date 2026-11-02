**中文** | [English](cli-tui.en.md)

# CLI 与 TUI 使用指南

本指南适用于 GitHub 公开稳定版 [v0.1.7](https://github.com/areal-project/AReaL-Harness/releases/tag/v0.1.7)，对应源码提交 `3dca3434a3cd8b6d1a2ce6f68e0f043a35b62d12`。这里介绍终端交互、脚本执行和恢复；Web 及更多客户端功能见[客户端指南](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/guides/clients.md)。

## 1. 下载安装与升级

GitHub 最新公开稳定版为 `v0.1.7`，Homebrew stable formula 使用同一 Release 的完整包。支持 macOS arm64（macOS 15+、Xcode Command Line Tools）和 Linux x86_64（兼容 glibc 2.35+）。Linux 还需 `/usr/bin/bwrap`（Ubuntu 可安装 `bubblewrap`）；macOS 运行时需要可用的 `/usr/bin/python3`。不提供 Windows、Intel macOS、Linux arm64 或 musl 包。

### 安装

先安装 [Homebrew](https://brew.sh/)，然后执行：

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
```

Homebrew 自动下载和校验完整包，并安装 CLI、TUI 和 Runtime。确认命令入口可用后，即可配置模型。Beta 使用独立的 `areal-project/tap/areal-beta` formula，不自动替换稳定版。

### 升级

先备份 `~/.areal` 和自定义数据目录。完成任务后，用 `areal service list` 查看共享服务，并按工作区逐个停止。忙碌服务默认拒绝停止；先等待任务完成或暂停。

```sh
areal service list
areal service stop --workspace /absolute/path/to/project
brew update
brew upgrade --formula areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
```

将示例路径替换为实际工作区，并对每个共享服务执行停止命令。使用自定义数据目录时，可加 `--data-dir /absolute/core-data`；也可改用 `--instance INSTANCE_ID` 精确选择列表中的实例，但不能与 `--workspace` 或 `--data-dir` 混用。`service stop/status` 不接受 `--config` 等启动参数。Homebrew 可能清理旧版本，因此升级前需停服；升级不会自动停止任务或服务。`areal upgrade --check` 可检查本机 tap 中的版本，需先运行 `brew update` 获取最新定义。其他安装渠道及完整平台要求见[安装指南](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/guides/installation.md)。

### 配置模型

配置支持 SSE 和 function tools 的模型服务。例如，Chat Completions endpoint 是完整请求 URL：

```sh
export AREAL_HARNESS_MODEL_ENDPOINT='https://model.example.com/v1/chat/completions'
export AREAL_HARNESS_MODEL='your-model-id'
export AREAL_HARNESS_MODEL_PROTOCOL='chat-completions'
export AREAL_HARNESS_API_KEY_ENV='AREAL_API_KEY'
# 输入密钥后回车；输入不会显示在终端。
read -r -s AREAL_API_KEY
export AREAL_API_KEY
areal config validate
```

无认证的本地模型可省略密钥相关设置。不要将密钥值放入命令参数或 TOML；模型配置、Responses 和供应商配置见[配置指南](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/guides/configuration.md)。GUI 保存的密钥不会自动传给独立终端启动的 Core。

v0.1.7 本地启动默认采用 YOLO 权限，允许工作区外写入和工具联网。需要工具审批时，在启动服务前设置 `export ASK_PERMISSIONS=1`，或按[权限配置](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/guides/configuration.md#permissions)设置。无交互应答通道的任务无法等待人工审批；需要人工参与时使用交互式 TUI。

## 2. 交互式 TUI

```sh
# 在指定工作区打开；请替换为自己的绝对路径。
areal --workspace /absolute/path/to/project
# 可选：界面就绪后提交首条消息。
areal --workspace /absolute/path/to/project '概览这个项目'
```

输入任务后按 Enter。任务运行时再次输入并按 Enter，可追加指令。主要操作：

| 操作 | 用途 |
| --- | --- |
| `Ctrl-C` | 暂停活动 Goal 或中断当前 Turn；空闲时退出 |
| `Ctrl-Q`、`/quit` | 退出界面 |
| `Ctrl-R` | 重连并恢复快照，不重发请求 |
| `F5`、`/sessions` | 查找和切换会话 |
| `/new`、`/open ID` | 新建会话或打开已有会话 |
| `F6`、`/model` | 空闲时选择会话模型 |
| `/skills`、`/skill NAME` | 选择 Skill |
| `/permissions` | 查看当前权限和已记住的审批 |
| `F4`、`/executions` | 查看子任务进度、检查和交付 |
| `F3`、`/topology` | 查看会话树 |
| `Ctrl-O`、`/details` | 切换紧凑和详细历史 |
| `/restore-input` | 恢复提交失败或结果未确认时保留的输入 |
| `/help` | 查看快捷键 |

输入 `/` 查看命令候选，Tab 补全，Esc 关闭。审批界面用上下方向键选择，Enter 确认，Esc 拒绝；初始选择为拒绝。使用 `areal --mouse=false` 可关闭鼠标捕获，以便使用终端原生拖选和复制。

默认交互式 TUI 连接按工作区复用的共享 Core/Runtime。关闭界面不会停止共享服务或后台任务。需要更换启动环境中的密钥时，先等待任务结算，再以相同工作区及部署参数执行 `areal service restart`；`Ctrl-R` 不会把新环境注入已运行的 Core。

### 持续目标

在 TUI 中输入 `/goal 完成迁移并运行相关测试` 创建目标；输入 `/goal` 查看状态。`/goal-pause` 暂停，结算后可用 `/goal-resume` 恢复；`/goal-edit 新目标` 和 `/goal-budget 200000` 编辑已停止的目标，`/goal-clear` 清除已停止且资源已结算的目标。Goal 可跨多个 Turn 继续，普通最终回复不等于目标完成。

## 3. 非交互 CLI

脚本应使用 `exec`，而不是依赖无参数启动的交互界面：

```sh
areal exec --workspace /absolute/path/to/project '概览工作区'
printf '%s\n' '概览工作区' | areal exec --workspace /absolute/path/to/project
areal exec --output-format json '概览工作区'
areal exec --output-format stream-json --verbose '概览工作区'
areal exec --resume SESSION_ID '继续刚才的任务'
```

`text` 是默认输出；`json` 输出最终结果，`stream-json` 输出逐事件记录。日志写入 stderr；成功退出码为 0，失败为非零。恢复时使用返回的 session ID；缺失会话或存在未确认结果时不会静默创建新会话。`areal -p` 是兼容入口，参数与 `exec` 对应。

常用选项包括 `--model`、`--effort`、`--max-turns`、`--permission-mode`、`--tools` 和 `--no-session-name`。`--permission-mode` 不能扩大服务端或 Runtime 授权。输入格式、双向 stream-json、工具过滤及限制见 [CLI 契约](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/api/claude-cli.md)，可运行 `areal exec --help` 查看选项。

v0.1.7 本地 `exec` 拥有独立 Core/Runtime 生命周期，退出时等待清理；外部 endpoint 的服务不由 CLI 关闭。非交互模式没有双向应答通道时，用户问题不可用，必须人工批准的工具会被拒绝；模型可以继续其他工作或报告阻碍。

## 4. Headless TUI 与媒体

`--prompt` 是通过 TUI 协议执行单次任务的入口，与 `exec` 的输出协议不同；本次 Turn 的文本写 stdout，Thread ID 写 stderr。`--goal` 跨 Turn 等待目标终态，只有 completed 返回成功。

```sh
areal --workspace /absolute/path/to/project --prompt '概览工作区'
areal --workspace /absolute/path/to/project --goal '完成迁移并运行测试' --goal-token-budget 200000
```

`--input-file` 可提交 Core Input JSON 数组，最大 2 MiB；它与 `--prompt`、`--goal` 互斥。图片路径在运行服务所在环境中解析。

```json
[{"type":"text","text":"Describe this image"},{"type":"localImage","path":"/absolute/path/to/image.png"}]
```

将数组写入文件后运行 `areal --input-file /absolute/path/to/input.json`。`--prompt`、`--goal` 和 `--input-file` 默认使用 owned 本地服务并在退出时清理；`--local-mode shared` 可使用共享服务。完整媒体字段见 [Core API](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/api/core.md)。

## 5. 连接与恢复

```sh
# 使用服务数据目录中的认证文件；替换地址和路径。
areal --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json
areal exec --endpoint ws://127.0.0.1:4500 --auth-file /absolute/core-data/security/auth.json '检查工作区'
# 查询按工作区定位服务；restart 使用与启动时相同的配置和部署参数。
areal service list --json
areal service status --workspace /absolute/path/to/project --json
areal service restart --workspace /absolute/path/to/project --json
```

`--endpoint`（TUI 别名 `--remote`）连接现有服务，不能与本地部署参数混用；远程 Core 的凭据和权限由其启动环境决定。认证文件使用 Core `security/auth.json` 格式，不要提交或公开。

断线后先重连并检查服务端快照，不要自动重发未确认的提交。若重启后工具结果为 UNKNOWN，检查实际文件和进程，再按 [Core API](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/api/core.md) 记录核查；这不会重放工具。共享服务、旧数据迁移和停止命令的详细行为见[本地服务契约](https://github.com/areal-project/AReaL-Harness/blob/v0.1.7/docs/api/local-service.md)。
