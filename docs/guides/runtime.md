**中文** | [English](runtime.en.md)

# Runtime 部署

`areal-runtime` 是独立执行服务，通过 launcher 继承的 stdin/stdout 私有管道连接一个可信调用方，拒绝 TTY/普通文件。Core 的日常使用见[快速开始](quickstart.md)，wire 见 [Runtime API](../api/runtime.md)。

| 部署参数 | 默认与含义 |
|---|---|
| `--workspace` | 必填，映射 `workspace://repo` |
| `--allow-write`, `--allow-network` | 默认关闭；子 Scope 只能收窄 |
| `--allow-concurrent-writes` | 默认关闭；显式开启后命令绕过路径协调，文件助手仍协调 |
| `--file-helper` | 默认 daemon 同目录 `areal-runtime-fs`，必须为可信文件 |
| `--max-processes` | 4，统计后代 Scope 中登记的命令及启动/清理占额，不统计命令内部 fork 数量 |
| `--wall-time-ms` | 30000，单进程期限，含排队与启动 |
| `--output-bytes` | 8 MiB，整个连接累计输出，不在进程退出时返还 |
| `--output-window-bytes` | 64 KiB/进程，最大 8 MiB；另有 1024 片段限制 |
| `--sandbox-profile` | native；Linux 受控容器显式 outer-container-perf |

launcher 的 `--command-timeout-ms` 默认 300000，与独立 daemon 默认不同。Root 只读/网络拒绝；模型、owner 字符串和审批不能扩大部署授权。命令不继承模型凭据，只接受 PATH/LANG/LC_ALL/TERM/CI/RUST_BACKTRACE。

`--scratch <directory>` 添加已存在且与 workspace 不重叠的任务临时目录。`scripts/launch.py --scratch` 同时配置 Runtime 权限与 Core TMPDIR；可信二进制和 Core data 必须在所有可写根之外。

## 平台与信任

macOS 使用固定 `/usr/bin/sandbox-exec` 和默认拒绝 Seatbelt 策略；失败不回退到无沙箱。授权是路径子树权限，设备/inode 重验发现旧绑定，但不保证目录对象隔离。系统读取范围见 [sandbox.rs](../../runtime/exec-native/src/sandbox.rs)，不默认开放 Homebrew 或共享临时目录写入。

Linux 的 outer-container-perf 组合 Bubblewrap、Runtime seccomp 和外层只读容器/cgroup。容器为内层 namespace 创建放宽外层 seccomp/systempaths，工具仍受 Runtime 过滤；仅支持[固定评测流程](../benchmarks/README.md)，不代表通用 Linux 支持。

Core、Node Host、stdio MCP 不在 Runtime 沙箱内。进程组终止与输出关闭不证明所有逃逸后代结束；Runtime SIGKILL 后完整清理、宿主隔离和可靠 sandboxDenied 归因未验证。

Linux profile 在派生 Bubblewrap 时建立会话，namespace init 保留在受管进程组内，取消同时覆盖 init 与其 PID namespace；这不将全平台 processTreeCleanupVerified 改为 true。当前没有每 Scope 的 cgroup pids/memory 限额，内部 fork 与内存需由部署层约束。内部命令被信号终止时 launcher 可能正常返回 `128 + signal`；Runtime 保留实际 launcher 的 exitCode/signal，不推断内部信号或 OOM。清理仍需回执确认。

## 生命周期

EOF、SIGINT/SIGTERM 或显式 close 关闭准入并等待资源。丢弃 RPC 等待者不取消操作；用 revoke/terminate 后继续 wait。后端事实丢失或清理失败保留 UNKNOWN 与预算占用，封闭新操作，返回 CLEANUP_FAILED。

每 epoch 最多 256 Scope、4096 operation，保留去重记录至实例关闭；耗尽后需正常 drain/重启，不能删除记录复用 epoch。默认 helper 按目标文件、命令按写根协调冲突；其他 Runtime/宿主编辑器不参与，不能承诺外部 CAS。

验证使用 `make verify-runtime`；组件关闭见 [Cordis](../development/cordis.md)。
