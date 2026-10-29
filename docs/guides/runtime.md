**中文** | [English](runtime.en.md)

# Runtime 部署

`areal-runtime` 是独立执行服务，通过 launcher 继承的 stdin/stdout 私有管道连接一个可信调用方，拒绝 TTY/普通文件。Core 的日常使用见[快速开始](quickstart.md)，wire 见 [Runtime API](../api/runtime.md)。

| 部署参数 | 默认与含义 |
|---|---|
| `--workspace` | 必填，映射 `workspace://repo` |
| `--allow-write`, `--allow-network` | 独立 native daemon 默认关闭；full-access 同时开启；子 Scope 只能收窄 |
| `--allow-concurrent-writes` | 默认关闭；显式开启后命令绕过路径协调，文件助手仍协调 |
| `--file-helper` | 默认 daemon 同目录 `areal-runtime-fs`，必须为可信文件 |
| `--max-processes` | 4，统计后代 Scope 中登记的命令及启动/清理占额，不统计命令内部 fork 数量 |
| `--wall-time-ms` | 30000，单进程期限，含排队与启动 |
| `--output-bytes` | 8 MiB，整个连接累计输出，不在进程退出时返还 |
| `--output-window-bytes` | 64 KiB/进程，最大 8 MiB；另有 1024 片段限制 |
| `--sandbox-profile` | 独立 daemon 默认 native；产品 launcher 默认 full-access；Linux 受控容器显式 outer-container-perf |

launcher 的 `--command-timeout-ms` 默认 300000，与独立 daemon 默认不同。桌面模式可设置 `--desktop-process-timeout-ms`（1–86400000）；根 Thread 的受管服务可使用 Runtime 桌面额度，普通命令工具和 Turn 进程仍受 `--command-timeout-ms` 限制。子任务、hooks 及额外收窄的 Scope 始终受相应祖先约束；桌面额度不扩大其权限与预算。显式进程时长超过父限额时在受理前拒绝。本地 TUI/Web/CLI 和 launcher 默认 full-access：YOLO 直接开放宿主文件与网络，ASK_PERMISSIONS 在 Core 增加审批。全开放命令以当前用户身份执行，不经过 OS 沙箱；显式只读、研究 Agent 和插件收窄的 Scope 仍使用 native 隔离。模型和审批不能扩大显式受限 Runtime 的授权，见[权限模式](configuration.md#permissions)。

命令不继承模型凭据。未收窄且无固定只读输入、继承网络的 full-access 命令继承宿主 PATH/HOME/TMPDIR/LANG/LC_ALL/TERM/SSH_AUTH_SOCK，其中 Core 将 TMPDIR 改为 Thread scratch。SSH_AUTH_SOCK 只引用可信启动会话已有的 agent，不读取、复制私钥或透传 Git token；显式任务凭据仍只传给指定 executable。收窄命令保留受限环境，不继承宿主 SSH agent。process.start.env 接受 PATH/LANG/LC_ALL/TERM/CI/RUST_BACKTRACE/TMPDIR/PYTHONDONTWRITEBYTECODE；TMPDIR 只改变临时文件位置，不扩大路径授权。

launcher 自动创建与 dataDir 同级的 `scratch/`，每个 Thread 使用 `agent-<threadId>/`。`--scratch <directory>` 可选择与工作区/dataDir 不重叠的现有目录。仓库只读时 scratch 仍可写，数据保留至人工清理。显式 `--sandbox-profile native` 下，可信二进制和 Core data 必须位于可写 workspace/scratch 之外；full-access 允许二进制位于工作区，便于开发。

## Git 身份与远端认证

- **提交身份**由 Git 的有效配置决定。执行已授权的 commit 前，用 `git var GIT_AUTHOR_IDENT` 和 `git var GIT_COMMITTER_IDENT` 核对当前环境中的身份；不要仅检查仓库级 `user.name`，也不要替用户编造姓名或邮箱。受限 HOME 或配置访问被拒绝时，只能说明当前执行环境无法解析身份，不能断言宿主未配置。需要临时指定身份时先取得用户提供或确认的值，不擅改全局配置。
- **HTTPS 认证**依赖已有 credential helper 及其宿主权限。macOS 受限 Scope 不默认开放 Keychain；`osxkeychain: failed to get: -50` 等错误不能单独证明密码错误。先区分沙箱限制、登录会话/钥匙串状态和远端拒绝，不自动关闭 helper、改 remote 或导出凭据。网络授权本身不授予 Keychain：显式 native、收窄的文件/网络权限或固定只读输入仍会保留原生隔离。需要宿主认证时，须由用户明确允许未收窄且无固定只读输入的 full-access 执行，或在有权限的终端完成；不自动放宽受限任务或解锁钥匙串。
- **SSH 认证**在完整授权下复用启动 AReaL 时已有的 `SSH_AUTH_SOCK`。启动时没有 agent、socket 已失效、钥匙未解锁或远端未授权仍会失败；环境改变后需重启所属 Core/Runtime 服务。传递 socket 不会加载私钥、修改 SSH 配置、允许受限子 Scope 访问 agent，或保证 push 成功。
- 认证检查使用有界、非交互的命令，并遵循网络和文件审批。不要输出 `git credential fill` 的结果、token、私钥或完整凭据配置。切换 HTTPS/SSH、commit 和 push 是独立操作；不以换分支修复认证，不自动重试结果不明的 push。报告本地 commit 和远端 push 的各自实际状态。

## 平台与信任

macOS native profile 使用固定 `/usr/bin/sandbox-exec` 和默认拒绝 Seatbelt 策略；失败不回退到无沙箱。授权是路径子树权限，设备/inode 重验发现旧绑定，但不保证目录对象隔离。系统读取范围见 [sandbox.rs](../../runtime/exec-native/src/sandbox.rs)，native 不默认开放 Homebrew 或共享临时目录写入；full-access 开放。Linux 的 launcher full-access 直接继承宿主执行；未收窄根 Scope 的只读操作也沿用该部署级执行能力，避免误进入仅 macOS 可用的 native Seatbelt。显式收窄的 Scope 仍需要 native 或 outer-container-perf，不能用 full-access 绕过路径隔离。

Linux native profile 使用 Bubblewrap 创建空 mount namespace、显式系统只读绑定和 Scope 读写绑定，并叠加 Runtime seccomp；要求 `/usr/bin/bwrap` 和可用的 user namespace。启动检查在同样的系统只读绑定中执行 `/bin/true`，兼容 BusyBox 布局；失败保留 Bubblewrap 退出状态与 stderr，避免把命令缺失误报为 namespace 不可用。所有 Linux profile 还要求同目录的 `areal-runtime-reaper` 和可读 `/proc`，回收路径不依赖 Python；`make build` 与完整发行包均包含该 Rust helper。`outer-container-perf` 另外依赖受控外层只读容器/cgroup，容器为内层 namespace 创建放宽外层 seccomp/systempaths/AppArmor；它仅支持[固定评测流程](../benchmarks/README.md)。

Core、Node Host、stdio MCP 不在 Runtime 沙箱内。进程组终止与输出关闭不证明所有逃逸后代结束；Runtime SIGKILL 后完整清理、宿主隔离和可靠 sandboxDenied 归因未验证。

如果外层容器禁止在内层 PID namespace 挂载 proc，启动检查改用空的只读 `/proc`，仍保留 Bubblewrap namespace、Scope 挂载和 seccomp；不会绑定外层 `/proc`，也不会降级为直接执行。此时依赖 proc 内容的命令和 `/dev/fd` 路径不可用；宿主侧进程回收仍使用外层 `/proc`。两种检查均失败时拒绝执行并保留诊断。

Linux profile 在派生 Bubblewrap 时建立会话，namespace init 保留在受管进程组内，取消同时覆盖 init 与其 PID namespace；这不将全平台 processTreeCleanupVerified 改为 true。当前没有每 Scope 的 cgroup pids/memory 限额，内部 fork 与内存需由部署层约束。内部命令被信号终止时 launcher 可能正常返回 `128 + signal`；Runtime 保留实际 launcher 的 exitCode/signal，不推断内部信号或 OOM。清理仍需回执确认。

native macOS profile 的默认 Xcode、`/Applications/Xcode_<数字版本>.app`（例如 `Xcode_16.4.app`）及 Command Line Tools Python 由 Core 与 Runtime 共用 `runtime/host-tools`，在可信宿主侧调用 `/usr/bin/xcrun --find python3` 并解析、校验真实文件后进入原有沙箱；不依赖 `/var/select/developer_dir` 链接；直接 `/usr/bin/python3` 和默认 PATH 中的 `python3` 使用实际解释器，避免 xcode-select shim。仅开放系统 Python framework 的读取和执行，工作区外文件和共享 `/tmp` 写入仍被拒绝。自定义 Xcode 位置、Homebrew Node/Python 不会自动获得权限，需要显式准备工具链。

产品 launcher 自动提供 scratch 和 `verify_command`；直接嵌入 Core 时若未配置 command scratch，仍不向模型提供此工具，需显式配置 Runtime scratch 授权。

## 生命周期

EOF、SIGINT/SIGTERM 或显式 close 关闭准入并等待资源。丢弃 RPC 等待者不取消操作；用 revoke/terminate 后继续 wait。后端事实丢失或清理失败保留 UNKNOWN 与预算占用，封闭新操作，返回 CLEANUP_FAILED。

每 epoch 最多 256 Scope、4096 operation，保留去重记录至实例关闭；耗尽后需正常 drain/重启，不能删除记录复用 epoch。默认 helper 按目标文件、命令按写根协调冲突；其他 Runtime/宿主编辑器不参与，不能承诺外部 CAS。

验证使用 `make verify-runtime`；组件关闭见 [Cordis](../development/cordis.md)。

启动器取消或启动失败时先回收 Core/Runtime 子进程，再删除内部就绪文件目录，避免子进程晚到的写入与目录清理竞争。
