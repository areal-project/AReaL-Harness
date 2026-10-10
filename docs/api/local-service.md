**中文** | [English](local-service.en.md)

# 共享本地服务

TUI、Web 启动入口和可信 Desktop Main 共用 `areal service`，由独立 `areal service-host` 托管一组 Core/Runtime。窗口只拥有连接。运行平台沿用[Runtime 边界](../guides/runtime.md)，不是系统级、多用户或远程 daemon。

## 公共入口

```sh
target/debug/areal service ensure --workspace /absolute/workspace --json
target/debug/areal service list --json
target/debug/areal service status --json
target/debug/areal service restart --json
target/debug/areal service stop --json
# 显式取消当前工作并等待结算
target/debug/areal service stop --instance INSTANCE_ID --cancel --json
target/debug/areal web --workspace /absolute/workspace
# Desktop Main 获取同一描述，不打开浏览器
target/debug/areal web --workspace /absolute/workspace --json
```

`ensure`、`restart` 和 `web` 接受同一组本地参数：`--config`、`--workspace`、`--data-dir`、`--allow-write`、`--allow-network`、`--allow-concurrent-writes`、`--workgroup-policy`、`--workgroup-toolchain`、`--command-timeout-ms`、`--desktop-process-timeout-ms`、`--command-output-bytes`、`--runtime-max-processes`、`--model-endpoint`、`--model-protocol`、`--model`、`--model-provider`、`--api-key-env`、`--desktop-config`。`--agent id@revision` 是 TUI/headless/exec 创建 Thread 时的客户端选择项，也可与远程 `--endpoint` 同用，不改变本地服务身份。默认工作区是当前目录；服务监听随机 loopback 端口。未配置模型时可启动管理服务，运行模型任务仍需有效配置。

`--desktop-process-timeout-ms` 设置桌面 PTY 的超时（1..86400000 毫秒），与普通命令超时独立。该值纳入服务身份，配置变化需要安全重启；GUI 使用 24 小时上限。

`--runtime-max-processes` 设置此服务所有祖先/子 Scope 共享的 Runtime 活跃进程上限，默认 `4`，接受 `1..4294967295` 的整数。该值纳入服务配置身份；修改后 `ensure` 不会静默复用旧容量的服务，应在任务停稳后安全重启。它独立于 Core 的 `max_active_turns`，不增加 Goal 时间或用量预算。

无模型费用的进程容量回归可运行 `python3 scripts/runtime-capacity-smoke.py --bin-dir target/debug`：验证默认容量拒绝第 5 个并发进程，显式容量 32 允许 6 个子 Scope 同时执行并清理。测试默认原生沙箱；`--sandbox-profile` 可显式选择与待验证部署一致的 profile，不自动降级。

`--runtime-output-bytes` 独立设置部署及后代 Scope 的累计输出预算（须覆盖 `--command-output-bytes`，最多 16 GiB）；省略时保持与单命令额度相同的旧行为。它不扩大单个命令输出上限或保留输出窗口。`--runtime-max-operations` 设置 Runtime 生命周期保留操作数，默认 4096，接受正整数至 4294967295；已完成操作仍保留以支持去重/查询，不因子任务结束而回收。这两个值也纳入服务身份。例如长任务可显式设置 `--command-output-bytes 67108864 --runtime-output-bytes 1073741824 --runtime-max-operations 65536`，并监控累计用量。图片工具在 Core 缩放前读取完整原图，文件助手的 JSON/base64 stdout 计入累计输出；缩小模型所见图像不会消除这部分读取开销。

可用 `python3 scripts/runtime-output-smoke.py --bin-dir target/debug` 验证单进程限额保持、跨命令累计计量和重复读取不收费；沙箱参数与进程容量回归一致。

`status`、`stop` 默认定位当前工作区，可用 `--workspace`、`--data-dir` 或 `--instance` 消歧。`restart` 按当前工作区和与 `ensure` 相同的参数解析目标部署；使用自定义配置/权限时传入对应参数。重启保留历史，有未结算工作时拒绝，只有显式 `--cancel` 才取消任务。

服务命令 stdout 始终是 JSON，`--json` 显式声明机器调用；`web` 默认另打开浏览器，`--json` 只发现。ensure/restart/status/stop 返回一个描述，list 返回数组，bind 返回 `{dataDir}`。操作失败退出 1，stderr 为 `{error:{code:"localServiceError",message}}`；参数解析错误遵循 CLI 行为。启动诊断写 stderr 或私有日志，不把长期 token 放入命令、URL 或描述；自动登录的一次性 URL 仅交给浏览器打开程序，不打印。

描述字段见 [local-service-v1.json](../../schemas/local-service-v1.json)：

| 字段 | 含义 |
|---|---|
| `protocolVersion` | 发现与控制协议版本，当前 1 |
| `serviceId` | 规范 dataDir 路径 SHA-256 的前 24 个十六进制字符，重启保持 |
| `generation` | 每次启动的新 UUID；不是 Runtime epoch 或工具 Host generation |
| `workspace`, `dataDir` | 规范绝对路径 |
| `configFingerprint` | 部署配置、模型 CLI/环境覆盖、权限、部署文件与二进制内容的摘要；热更新模型值独立版本化 |
| `endpoint`, `webUrl` | Core WebSocket 与 `/ui` URL |
| `authFile`, `logFile` | 可信调用方读取的认证文件与宿主日志路径 |
| `hostPid`, `corePid` | 仅用于诊断，不能据此对旧 PID 发信号 |
| `state` | `ready`、`stopping`、`stopped` 或 `unavailable` |

## 实例、兼容性与历史

同一 dataDir 只允许一个 Core。`ensure` 串行化并发启动，发现运行实例后校验身份和配置；模型文件变更原地热更新；其他 TOML 配置和二进制更新在空闲时自动重启，有后台工作时拒绝自动重启。权限、Runtime、部署文件或模型 CLI/环境覆盖变化需执行 `areal service restart`。不会静默扩大写/网络权限，也不会杀掉未被托管的旧 Core。符号链接按规范路径识别。

开发版与 PATH 中的安装版在相同工作区、相同 dataDir 下会定位同一实例，但二进制内容及不同版本的默认配置可能不兼容。冲突诊断给出当前客户端二进制的绝对路径和已解析的部署参数；使用该命令并保持相同环境重启，避免裸 `areal` 重新启动另一版本。纯二进制/普通配置更新仍沿用空闲自动重启；Runtime、权限等边界变化仍需显式重启。

服务 home 由 `AREAL_HARNESS_SERVICE_HOME`（非空绝对路径）选择，省略时沿用 `AREAL_HARNESS_HOME` 或 `~/.areal`；它只决定服务登记、工作区映射与默认实例数据的位置，不改变 Core 配置查找。`ensure`、`restart`、`list`、`status`、`stop`、`bind` 和 `web` 使用同一服务 home。未显式配置 dataDir 时，共享入口使用 `<服务 home>/instances/<workspace-hash前24位>/state`。显式 CLI、环境变量或 TOML 中的 dataDir 保持配置优先级。独占 launcher、非交互 CLI 的默认目录保持原有规则。

旧 `~/.areal-harness/state` 不自动搬迁或混入新工作区。可显式指定 `--data-dir`，或停止旧 Core 后绑定默认目录：

```sh
target/debug/areal service bind --workspace /absolute/workspace \
  --data-dir /absolute/old-state --json
```

首次绑定会持有 Core 数据锁并检查历史 Thread 的 cwd 都位于该工作区，再写入 `service-workspace` 绑定文件；不复制历史。工作区默认映射保存在 home 的 `workspaces/`。已绑定的数据不能换工作区；混合历史需先单独整理。数据和服务登记须位于工作区外，写模式的可信二进制也须在工作区外。

兼容性将部署身份与默认模型版本分开。模型热更新完整校验 TOML，失败时保留旧配置。限额、权限、运行时预算、部署清单/工具扩展/Workgroup policy 和二进制内容仍保留重启边界。模型凭据值不写入摘要或登记；服务继承首次启动的环境。模型版本在等待热更新 3 秒后仍不一致时，客户端尝试安全重启；普通加载错误直接返回具体原因。旧服务缺失新凭据时会标记 `restartRequired=true`，客户端配置解析已校验当前环境的凭据后，可通过空闲重启继承它。忙碌服务保留原 generation 和任务，待结算后重试；不会自动取消。仅轮换同名凭据值或修改其他环境仍需显式重启。运行中的 Provider/Thread 配置仍由 Core 管理，不属于客户端窗口状态。

## 生命周期与恢复

关闭窗口只断开连接；活动 Turn/Goal 可继续，多个窗口可订阅同一 Thread。相同 Thread 的并发写入仍遵循 Core 的准入、CAS、队列及 requestId 规则。显式取消与关闭窗口是不同操作。

服务没有闲置退出计时器。模型文件更新保持 generation 和连接；其他 TOML 更新由 TUI 在后台工作结算后发起安全重启。Web 等客户端可运行 `areal service ensure` 或 `restart`；浏览器不拥有进程生命周期。默认 stop 检查 `restartSafe`、`activeGoals`、`pendingQueueItems`，再通过 `drain(strategy="ifIdle")` 在 Core 准入锁内复查；有工作或资源时拒绝且不暂停任务；`--cancel` 通过 Core drain 取消并结算，UNKNOWN 或未确认清理仍会阻止成功。受理停止后禁止新工作；清理失败应查日志/权威状态，不能推断任务未发生。状态检查和 drain 之间新受理的工作遵循 drain 的等待/暂停规则。

宿主控制 Core/Runtime 的启动和关闭；Rust launcher 持有独立进程与私有管道，Linux 不依赖 Python；macOS 使用可执行的 `/usr/bin/python3` 等待 Runtime，并在超时清理时终止二者的独立进程组。启动前检查解释器可用性；缺失时安装 Xcode Command Line Tools 后重试。Core 生命周期管道在 launcher 死亡后收到 EOF，Runtime 沿私有管道执行清理。宿主死亡由 launcher 的父进程检查触发清理；launcher 继承并持有实例锁，但不让 Core/Runtime 继承锁，即使宿主被强杀也会保持到 Core/Runtime 清理结束。旧 Core 锁未释放时不启动替代实例。`service.json` 是发现线索，客户端同时验证持锁状态、控制 socket 和经过认证的 Core 身份，不信任历史 PID 或端口。

TUI 断线会重新发现服务，故障清理完成后可启动新 generation；显式 stop 会留下停止标记，现有窗口不会自动撤销停止。新开窗口或手工 ensure 可重新启动。恢复使用 `thread/resume` 获取快照，不重放请求；Goal 重启后暂停，工具 UNKNOWN 保持原有检查要求。

## Web 与 Desktop 接入

- `areal web` 在可信本地客户端读取 authFile，校验服务身份后申请一次性登录码，打开 `/ui` 自动换取独立 HttpOnly Cookie；长期 token 不交给网页。浏览器不启动进程、不读 authFile，也不访问控制 socket。链接过期、会话过期、重启或端口变化后重新运行 `areal web`；手工 token 登录保留为兜底。`--json` 只发现、不签发登录码。Rust 调用方可用 `browser_login_url(&Service)` 获取一次性 URL，不得记录或转发到不可信页面。接口与有效期见[浏览器登录](desktop.md#browser-auth)。
- Desktop Main 用参数数组执行 `areal service ensure --json`，校验 `protocolVersion`，在 Main 读取 authFile 建立认证连接；只向 Renderer 暴露经过筛选的应用操作和状态。不要把完整服务描述或 token 交给 Renderer。
- 重连重新发现并比较 generation，然后 initialize/initialized 和 thread/resume。先查 request/read 或权威状态再决定重试，不自动重放已提交操作。
- 需要跨窗口的动态 ToolHost 应放在稳定 Main/独立宿主连接中。窗口上的动态工具不会自动转移；连接丢失仍按现有 Host generation 与 UNKNOWN 语义处理。

内部控制使用 home/services/INSTANCE_ID/control.sock 上的单行 JSON，目录 0700、登记与凭据 0600；请求 `{method:"status",version:1}` 或 `{method:"stop",version:1,generation,cancel}`，响应 `{result:"ok",service}` 或 `{result:"error",message}`。建议非 Rust 客户端使用 CLI，避免复制锁和恢复逻辑。Unix socket 路径过长时需缩短 AREAL_HARNESS_SERVICE_HOME。

认证 GET `/areal/service` 返回描述中的六个身份字段（protocolVersion/serviceId/generation/workspace/dataDir/configFingerprint），需要 observe 权限，拒绝不匹配的 Origin；无托管身份的已认证 Core 返回 404。业务协议仍见 [Core](core.md) 与[桌面 API](desktop.md)，无需另建 Agent loop。

LocalArgs 新增 permissions（YOLO/ASK_PERMISSIONS）与 scratch。生效权限策略和 scratch 参与部署兼容性摘要。本地 launcher 默认改为 full-access；旧共享服务需显式重启应用此默认变更，客户端连接不会静默扩权。见[权限配置](../guides/configuration.md#permissions)。

宿主 `host.log` 在运行期间每秒检查，超过 1 MiB 即清空；写入描述符使用 append，截断后不会按旧偏移形成稀疏大文件。launcher 当前日志同样有 1 MiB 检查阈值，已结束的 `launch-*.log` 最多保留 7 天、8 份、总计 8 MiB，启动、退出和运行期间每分钟检查。阈值按检查周期执行，并非每次写入的硬限制；检查之间可短暂超过。活跃 launcher 日志由文件锁租约保护，不按已结束日志回收。

launcher 握手临时目录放入 `data_dir/launcher-state/`，正常退出自动删除，下次启动按租约回收崩溃残留。宿主取得实例锁并确认 Store 没有旧所有者后，清理旧 UUID generation 目录与登记原子写临时文件；不会删除其他实例、用户 scratch 或权威状态。旧版本在系统临时目录中留下的无归属目录无法安全识别，不做全局扫描。模型/Core 诊断保留策略见 [Core API](core.md#recovery)。
