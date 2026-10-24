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

启动 GUI 前可显式设置 `AREAL_CORE_SANDBOX_PROFILE=native`，或在 `areal service ensure/restart` 使用 `--sandbox-profile native`，请求原生 Runtime 沙箱。默认仍为 `full-access`。此选择纳入部署兼容性；切换时需先停止活动任务并显式重启服务。只有 Core 验证原生隔离能力后，Side 对话才提供只读访问当前工作区文件的选项。原生隔离不可用时启动失败，不降级为 full-access。

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

## 已发布任务目录预览

可信本机调用方可以先读取已发布的定时任务目录，再连接原执行 Core 更新实时状态：

```sh
areal service task-catalog --workspace /absolute/workspace \
  --data-dir /absolute/state --limit 30 --json
```

该命令不启动 Engine、Runtime、模型或插件，不恢复运行状态、不迁移旧格式，也不重放操作。它验证规范工作区、数据目录和 `service-workspace` 绑定，由 Core 读取同一份原子发布根及内容哈希校验的不可变 Task 文件。入口仅供可信本机用户使用，不向 HTTP/WS 或受限 Thread principal 开放；`--source-thread-id` 是来源筛选，不是授权参数。

响应包含 `version: 1`、`target: {workspace, dataDir, instanceId}`、`source: "published"`、`executionState: "unobserved"` 和 `catalog`。`catalog.kind` 为 `snapshot` 时包含 `rootDigest`、`data` 和 `hasMore`；绑定有效但根不存在时为 `empty`，只表示尚未观察到已发布目录。未绑定、已知旧格式或超出 32 MiB 热状态读取预算时返回 `requiresCore`，其 `reason` 分别为 `unbound`、`legacyFormat` 或 `readBudgetExceeded`。损坏、未知格式、身份不符和读取错误不返回空目录。`--limit` 默认为 30，范围 1–1024；只列定时任务，先按来源筛选并排除已结算的删除任务，再按任务 ID 排序截断；仍有非终态 Run 或未结算 worker 的删除任务保留。同一次读取只使用一份根，不拼接不同发布版本。

已发布目录不证明执行活性、完整存储可恢复或某个未知提交已成功。它不运行恢复逻辑，保存的运行状态和修订可能与随后启动的 Core 不同。GUI 先显示任务名称并提示正在更新状态，同时保留原 Core 启动和实时目录读取；预览不写入实时任务模型、不提供管理操作的修订。实时结果覆盖预览，迟到预览不能覆盖实时结果；实时读取失败保留未确认提示和重试入口。

## 可核查的停止操作

`status` 在原实例仍持锁但控制端点已关闭或断开时报告 `unavailable`，不将 socket 消失或响应丢失当作停止；协议、权限和超时错误仍显式失败。`ensure` 不接管这类仍有 owner 的实例。Store 启动仅为派生进程继承描述符的短暂交接等待约 100 ms，未取得独占锁前不清理临时写入，仍拒绝持续持锁的 owner。

可信 GUI 使用 `service ensure --no-auto-restart`：相同 GUI 应用 owner 的兼容实例可以复用，不存在时可以在原有锁下启动；需要替换运行实例时返回冲突，不能在 ensure 内隐式停止。普通 CLI ensure 和 TUI 重连仍可为空闲服务应用同一二进制的配置变化，但二进制摘要变化必须显式 `service restart` 或通过 GUI 生命周期更新激活，不能隐式升级或降级。

```sh
areal service capabilities --instance INSTANCE --expected-generation GENERATION --json
areal service stop --instance INSTANCE --expected-generation GENERATION --request-id UUID --cancel --json
areal service operation --instance INSTANCE --expected-generation GENERATION --request-id UUID --json
```

能力查询返回 `{version:1,stopOperations:1}`；不支持时停止新写入，不用 Stop 探测。带 request-id 的 stop 返回 `{version:1,requestId,serviceId,generation,cancel,state,message?,lifecycle?}`。operation 返回 `{operation:<原回执或null>}`。同一 ID 永远绑定同一目标代际和 cancel 策略，参数变化拒绝。当前 CLI 省略 request-id 时也创建持久停止操作，确认原实例退出后仍返回 Service 描述；失败保留原 request-id 和 generation 供查询。新 Host 拒绝旧控制协议中的无回执 `Stop`，不 drain 或取消任务，避免已运行的旧 TUI 在重连时停止新版后台。0.1.5 Host 支持持久停止操作；0.1.4 等不支持该能力的 Host 须先用原版本 CLI 显式停止，再启动新版，不因能力查询失败自动回退到旧 Stop。

Host 在 drain 前原子保存并 fsync 回执，目录位于私有 registry 的 `operations/`，不随 generation 清理。状态为 `acceptedPending`、`blocked`、`admissionUnknown`、`settlementIncomplete` 或 `completed`。已知忙碌拒绝与已受理但未结算分开；查询不重新 drain 或 cancel，null 不证明原请求未受理。显式新意图可以在已知拒绝或结算不完整后重新观察并使用新 ID；受理未知必须先核对。

`completed` 来自公共 operation 查询：Host 已确认 launcher/Runtime 清理且原实例的服务锁和 Store 锁释放，或锁保护的新代际已接管。Core PID 消失、socket 断开或清理登记缺失都不够。Host 在确认清理前崩溃保留未知状态。私有 socket 的重复请求返回原持久快照，物理退出状态由公共 operation 投影核验。


## CLI 与 GUI 的默认隔离边界

模型配置默认共用 `~/.areal/config.toml`，共享文件不代表共享执行实例、历史或全部认证状态。不带 `--endpoint` 的 `areal exec` 为每个 run 使用 `<home>/cli/runs/<runId>/state`，会话映射位于 `<home>/cli/sessions/`，`--resume` 复用原 run；其中 home 为 `AREAL_HARNESS_HOME` 或 `~/.areal`。直接使用独占 `serve`／launcher 时，通用配置的数据默认值才是配置 home 的 `state/`。公共 `areal service` 默认 registry 为 `~/.areal`（可由 `AREAL_HARNESS_SERVICE_HOME` 选择），默认 dataDir 为 `<registry>/instances/<workspace-hash>/state`，已有 bind 映射及显式配置优先。

GUI 的 registry 默认是 `~/.areal/gui/<GUI Core home 摘要>`，每项目 dataDir 是 `<GUI Core home>/<projectId>/state`。GUI Core home 默认为 GUI userData 下的 `areal-core`；开发 userData 按源码工作树隔离，安装版、显式 profile/worktree 可有不同数据目录。每次 GUI 应用运行以 `{kind:"gui", appRunId, profile}` 标记 owner，`profile` 是规范绝对 userData 路径。服务描述的可选 `owner` 字段记录这个身份；独立 CLI 持久服务没有 GUI owner。GUI 退出／停止只处理这个 owner 已登记并核实身份的全部实例，包括已隐藏、断连项目和启动尚未完成的实例。恢复的历史项目沿用项目索引中的 ID；所属服务匹配同时核对已登记工作区与数据目录，不按路径重新散列替换原 ID。不停止默认 CLI registry 或其他 profile。旧版独立 Desktop 和其他 appRunId 不能被新 GUI 静默认领，须先核对原代际并显式安全迁移。

显式连接同一服务（例如 CLI 的 `--endpoint` 和 `--auth-file`）才共享该实例的执行与历史；仅使用相同模型配置、同一源码目录，甚至仅指定相同 registry 都不等价。同一 dataDir 的 Store 单写锁始终有效，不能以另一个进程或入口绕过。不同 dataDir 也不会隔离同一源码工作区的文件修改：多个入口仍可读到彼此修改，写入需要协调，或选择不同 Git worktree。

## 实例、兼容性与历史

同一 dataDir 只允许一个 Core。`ensure` 串行化并发启动，发现运行实例后校验身份和配置；模型文件变更原地热更新；同一二进制的其他 TOML 配置在空闲时自动重启，有后台工作时拒绝自动重启。二进制、权限、Runtime、部署文件或模型 CLI/环境覆盖变化需执行 `areal service restart`。不会静默扩大写/网络权限，也不会杀掉未被托管的旧 Core。符号链接按规范路径识别。

开发版与 PATH 中的安装版在相同工作区、相同 dataDir 下会定位同一实例，但二进制内容及不同版本的默认配置可能不兼容。冲突诊断给出当前客户端二进制的绝对路径和已解析的部署参数；使用该命令并保持相同环境重启，避免裸 `areal` 重新启动另一版本。同一二进制的普通配置更新沿用空闲自动重启；二进制、Runtime、权限等边界变化需显式重启。

服务 home 由 `AREAL_HARNESS_SERVICE_HOME`（非空绝对路径）选择，省略时沿用 `AREAL_HARNESS_HOME` 或 `~/.areal`；它只决定服务登记、工作区映射与默认实例数据的位置，不改变 Core 配置查找。`ensure`、`restart`、`list`、`status`、`stop`、`bind` 和 `web` 使用同一服务 home。未显式配置 dataDir 时，共享入口使用 `<服务 home>/instances/<workspace-hash前24位>/state`。显式 CLI、环境变量或 TOML 中的 dataDir 保持配置优先级。独占 launcher、非交互 CLI 的默认目录保持原有规则。

旧 `~/.areal-harness/state` 不自动搬迁或混入新工作区。可显式指定 `--data-dir`，或停止旧 Core 后绑定默认目录：

```sh
target/debug/areal service bind --workspace /absolute/workspace \
  --data-dir /absolute/old-state --json
```

首次绑定会持有 Core 数据锁并检查历史 Thread 的 cwd 都位于该工作区，再写入 `service-workspace` 绑定文件；不复制历史。工作区默认映射保存在 home 的 `workspaces/`。已绑定的数据不能换工作区；混合历史需先单独整理。数据和服务登记须位于工作区外，写模式的可信二进制也须在工作区外。

兼容性将部署身份与默认模型版本分开。模型热更新完整校验 TOML，失败时保留旧配置。限额、权限、运行时预算、部署清单/工具扩展/Workgroup policy 和二进制内容仍保留重启边界。模型凭据值不写入摘要或登记；服务继承首次启动的环境。模型版本在等待热更新 3 秒后仍不一致时，客户端尝试安全重启；普通加载错误直接返回具体原因。旧服务缺失新凭据时会标记 `restartRequired=true`，客户端在当前环境中提供凭据后，可通过空闲重启继承它。忙碌服务保留原 generation 和任务，待结算后重试；不会自动取消。仅轮换同名凭据值或修改其他环境仍需显式重启。运行中的 Provider/Thread 配置仍由 Core 管理，不属于客户端窗口状态。

共享服务使用管理模式启动：默认模型凭据缺失、为空或不满足 HTTP header 格式时，Core 仍可连接，模型目录将其标记为不可用。该模型的执行返回 `MODEL_CREDENTIAL_UNAVAILABLE`，不发送匿名请求、不切换模型。GUI 可进入设置补填密钥并保存应用；支持热应用的 Core 通过[受保护的模型配置接口](desktop.md#模型配置热应用)追加安全存储引用并确认文件版本，不重启 Core 或 Runtime。启动环境中的普通凭据和非模型部署变化继续遵循原重启规则。配置语法、模型地址和协议等其他校验仍然保留。

### 派生会话与数据兼容性

`areal/capabilities.features.conversationDerivationV1` 默认返回 `preview:false`、实际方法集合、Fork 边界、`sharedCurrent`、可用的 Side `workspaceAccess` 和有效限额，无需开发环境开关。客户端按当前连接的公开能力启用创建入口。

该 feature 的 `historyBytes` 是 Engine 的派生快照上限（配置 `max_history_bytes` 与 64 MiB 的较小值，配置为 0 时使用 64 MiB）。`limits` 返回 `maxThreads`、`maxActiveTurns`、`maxSideTurnsPerSource`、`maxSideTurnsPerDeployment`、`maxSideModelRounds`、`maxSideToolCalls`、`maxSideTurnSeconds`；值来自此服务实际 Engine 配置，Side 工具上限还取非零全局工具预算的较小值。它们是部署上限而非当前可用余量，单轮配置仍可进一步收窄；共享 Core 对全部窗口统一准入。`readOnly` 仅在当前 Runtime 满足原生只读边界时公布，客户端不得静默替换为 `none`。完整方法及恢复契约见[桌面 API](desktop.md#side-chat)。

实验插件构建写入的 `hookRuns`、`allowPluginSkills` 和 `pluginSkills` 仅作为不执行的历史字段保留。读取空闲会话不会为兼容处理改写文件；后续正常保存保留这些字段的值，不恢复 Hook、加载插件 Skill 或授予插件权限。其他未知字段继续严格校验。

Store 当前写入版本、`areal/server/status.stateVersion` 与发行 `manifest.json.stateVersion` 均为 15；API 仍为 `areal.core.v1`，服务发现协议仍为 1。版本 15 增加主会话最后受理的模型偏好，继续读取版本 1–14 的旧记录；旧 Core 不保证读取新记录，回退应恢复升级前备份。无派生元数据的旧记录可读取并在下一次写入升级；Fork/Side 记录必须具有受支持的会话版本和版本 14 的权限语义，不能仅降低记录版本来交给旧二进制。服务重启不重放创建或首问，结果不确定时先查 `areal/request/read`。能力声明不替代各平台原生权限验证、安装包或真实供应商的独立验收。

macOS 的 owned TUI 与 Core/Runtime 一样通过可信系统父进程启动，交接真实 PID、退出状态和清理回执。交互启动在 TUI 读取前将控制终端交给其独立进程组，结算后恢复原前台组与终端属性；无终端输入不执行交接，Linux 保留原生直启。该适配只处理可信客户端生命周期，不执行模型命令、不改变 Runtime 权限或沙箱。

## 生命周期与恢复

关闭窗口不结束 GUI 应用会话，活动 Turn/Goal 可继续，多个窗口可订阅同一 Thread。退出应用或 ⌘Q 则停止本应用全部 Desktop、Host、Core 和 Runtime；活动任务需要确认停止或取消退出，结算未完成时 Main 保持恢复入口。相同 Thread 的并发写入仍遵循 Core 的准入、CAS、队列及 requestId 规则。显式取消与关闭窗口是不同操作。

服务没有闲置退出计时器。模型文件更新保持 generation 和连接；其他 TOML 更新由 TUI 在后台工作结算后发起安全重启。Web 等客户端可运行 `areal service ensure` 或 `restart`；浏览器不拥有进程生命周期。默认 stop 检查 `restartSafe`、`activeGoals`、`pendingQueueItems`、`activeTasks`，再通过 `drain(strategy="ifIdle")` 在 Core 准入锁内复查；有工作或资源时拒绝且不暂停任务。仅等待触发的定时安排不阻止安全重启，安排保持启用。GUI 对旧后台同时检查显式任务、目标和队列计数；旧后台将空闲安排计为忙碌时，显式停止或更新恢复可在用户再次确认后暂停这些安排，保留历史，重启后需手动恢复。`--cancel` 通过 Core drain 取消并结算。历史工具/Hook UNKNOWN 保留在 `lifecycle.executionOutcomes.uninspectedUnknown` 与 `unresolvedTools` 中，仍阻止原 Thread 继续，但不阻止已完成物理结算的服务停止。Runtime 观察失败、活跃进程、Hook task scope 不确定及未确认清理仍会阻止成功。受理停止后禁止新工作；清理失败应查日志/权威状态，不能推断任务未发生。状态检查和 drain 之间新受理的工作遵循 drain 的等待/暂停规则。

宿主控制 Core/Runtime 的启动和关闭；Rust launcher 持有独立进程与私有管道，Linux 不依赖 Python；macOS 使用可执行的 `/usr/bin/python3` 作为 service-host、launcher、Core 和 Runtime 的实际父进程。可信服务链只转交明确的租约/生命周期描述符，记录实际子 PID，并核对 wait/reap 退出回执；没有回执不会报告成功清理。PID 握手限时 10 秒，握手失败或取消清退本次独立组。握手后常规信号发给实际子进程；受监督桥在原宿主死亡时发送 TERM，45 秒后仍未退出则 KILL 并回收，覆盖 launcher 的 Core/Runtime 清理时间。独立 CLI 的持久 service-host 脱离首次客户端，不因 CLI 退出而停止。GUI Main 独占 Desktop 生命期管道写端，Desktop 独占每个 GUI Host 的写端。短命管理 CLI 只转交读端，Host 在启动前和服务期间监视 EOF。读端在非可信子进程创建前恢复 CLOEXEC，GUI owner 环境不传给 Core、Runtime 或模型工具。Main 或 Desktop 被强退时，EOF 启动已有有界清理链；中断和 UNKNOWN 不标成成功。配置预检也使用可信启动与退出回执，stdin 关闭，stdout/stderr 并发读取且每路最多 2 MiB，总时限 15 秒；超时、输出超限或调用取消后继续有界回收临时进程，取消清理等待者不会撤销回收。Runtime 保留原独立进程组超时清理。启动前检查解释器可用性；缺失时安装 Xcode Command Line Tools 后重试。Core 生命周期管道在 launcher 死亡后收到 EOF，Runtime 沿私有管道执行清理。宿主死亡由 launcher 的父进程检查触发清理；launcher 继承并持有实例锁，但不让 Core/Runtime 继承锁，即使宿主被强杀也会保持到 Core/Runtime 清理结束。旧 Core 锁未释放时不启动替代实例。`service.json` 是发现线索，客户端同时验证持锁状态、控制 socket 和经过认证的 Core 身份，不信任历史 PID 或端口。

TUI 断线会重新发现服务，故障清理完成后可启动新 generation；显式 stop 会留下停止标记，现有窗口不会自动撤销停止。新开窗口或手工 ensure 可重新启动。恢复使用 `thread/resume` 获取快照，不重放请求；Goal 重启后暂停，工具 UNKNOWN 保持原有检查要求。

### GUI 崩溃后的受保护替代

`service status --instance ID --recovery --json` 是显式只读入口，返回 `{service,recovery:{version:1,generation,eligible,reason}}`。默认 status 仍返回严格 v1 Service；Capabilities 仍为 `{version:1,stopOperations:1}`。`eligible:true`、reason 为 `confirmedCoreCrash` 仅表示候选：存活 Host 已在 Core 意外退出后发布绑定原代际的正向清理证明，两把锁均释放，且原代际没有已受理停止意图。缺失、格式错误、过期或旧版证明均不可恢复。锁释放、PID 消失和非零退出码本身不证明清理成功。

可信 GUI 适配器可携带原 LocalArgs、GUI owner 与继承的 lifetime 描述符调用 `service recover --instance ID --expected-generation GENERATION --json`。恢复在原 `start.lock` 下重新核对规范 workspace/data、完整配置与组件/二进制摘要、owner、存活 lifetime、两把租约及持久停止回执；Host 在启动前再次校验授权及最新配置。Runtime 在 shutdown 与请求结算完成后独立报告资源清理成功；输出传输失败不覆盖该事实，也不能单独证明清理。launcher 将证明绑定到自己已回收的 Core/Runtime 子句柄，Host 将其发布到可回收 generation 目录之外。Host/launcher 在发布前死亡、owner 关闭及 Runtime 清理未确认均不能授权替代。

私有单次替代回执在 spawn 前持久化，Host 再将其绑定到 successor 代际。CLI 响应丢失后重复同一原代际请求，只能返回回执记录的兼容 Ready successor；启动未知或 successor 再次崩溃不能从原回执启动第二次替代。已受理、受理未知、结算不完整或已完成的停止回执均阻止恢复，包括控制处理器只落盘受理、尚未更新内存 stopping 标记便退出的情况。明确 blocked、未受理的停止不阻止恢复。这是受理意图顺序：仍在等待 `start.lock` 的后发 stop 尚未受理，继续遵守正常代际检查。

Desktop 还必须在派发前及发布替代结果前检查自身生命周期意图、项目/客户端归属及 closing 状态。恢复读取权威快照与原请求回执，不重放中断的模型、工具或 Turn。现有 Core 启动恢复继续暂停中断 Goal、队列与 worker，并将不确定副作用标为 UNKNOWN；已获授权但尚未启动的 schedule 及未来配置触发保持原有语义。普通 ensure/restart 契约不变。

确定性跨进程回归入口为 `AREAL_TEST_BIN_DIR=/absolute/bin node scripts/local-service-recovery-smoke.mjs`，使用隔离状态与本地模型夹具，不使用用户 profile 或真实供应商。

## Web 与 Desktop 接入

`areal service stop --expected-generation <generation>` 在启动锁内核对目标换代身份，失配时拒绝停止替代实例。GUI 的取消确认绑定原 Desktop、项目范围和 Core generation；最终公共宿主停止保持同一 cancel 意图。部分停止或未知回执保持恢复状态，不报告全局回滚、不自动重发；客户端须确认原实例登记撤回和进程退出。

- `areal web` 在可信本地客户端读取 authFile，校验服务身份后申请一次性登录码，打开 `/ui` 自动换取独立 HttpOnly Cookie；长期 token 不交给网页。浏览器不启动进程、不读 authFile，也不访问控制 socket。链接过期、会话过期、重启或端口变化后重新运行 `areal web`；手工 token 登录保留为兜底。`--json` 只发现、不签发登录码。Rust 调用方可用 `browser_login_url(&Service)` 获取一次性 URL，不得记录或转发到不可信页面。接口与有效期见[浏览器登录](desktop.md#browser-auth)。
- Desktop Main 用参数数组执行 `areal service ensure --json`，校验 `protocolVersion`，在 Main 读取 authFile 建立认证连接；只向 Renderer 暴露经过筛选的应用操作和状态。不要把完整服务描述或 token 交给 Renderer。
- 重连重新发现并比较 generation，然后 initialize/initialized 和 thread/resume。先查 request/read 或权威状态再决定重试，不自动重放已提交操作。
- 需要跨窗口的动态 ToolHost 应放在稳定 Main/独立宿主连接中。窗口上的动态工具不会自动转移；连接丢失仍按现有 Host generation 与 UNKNOWN 语义处理。

内部控制使用 Unix socket 上的单行 JSON，目录 0700、登记与凭据 0600。`home/services/INSTANCE_ID/control.sock` 的编码字节长度小于 104 时保留此地址。更长的地址使用 `/tmp/areal-<effective-uid>/<sha256>.sock`，摘要输入为规范化登记目录的完整路径字节。Host 与客户端使用相同的派生规则，并验证 socket 父目录属于当前用户、不是符号链接且无 group/other 权限。登记、锁、历史与操作回执仍保留在原位置。Host 退出只删除本实例 socket，不删除共享的 UID 目录。socket 消失不证明后台已经停止。

请求为 `{method:"status",version:1}` 或 `{method:"stop",version:1,generation,cancel}`，响应为 `{result:"ok",service}` 或 `{result:"error",message}`。建议非 Rust 客户端使用 CLI，避免复制地址派生、锁和恢复逻辑。

认证 GET `/areal/service` 返回描述中的六个身份字段（protocolVersion/serviceId/generation/workspace/dataDir/configFingerprint），需要 observe 权限，拒绝不匹配的 Origin；无托管身份的已认证 Core 返回 404。业务协议仍见 [Core](core.md) 与[桌面 API](desktop.md)，无需另建 Agent loop。

LocalArgs 新增 permissions（YOLO/ASK_PERMISSIONS）与 scratch。生效权限策略和 scratch 参与部署兼容性摘要。本地 launcher 默认改为 full-access；旧共享服务需显式重启应用此默认变更，客户端连接不会静默扩权。见[权限配置](../guides/configuration.md#permissions)。

宿主 `host.log` 在运行期间每秒检查，超过 1 MiB 即清空；写入描述符使用 append，截断后不会按旧偏移形成稀疏大文件。launcher 当前日志同样有 1 MiB 检查阈值，已结束的 `launch-*.log` 最多保留 7 天、8 份、总计 8 MiB，启动、退出和运行期间每分钟检查。阈值按检查周期执行，并非每次写入的硬限制；检查之间可短暂超过。活跃 launcher 日志由文件锁租约保护，不按已结束日志回收。

launcher 握手临时目录放入 `data_dir/launcher-state/`，正常退出自动删除，下次启动按租约回收崩溃残留。宿主取得实例锁并确认 Store 没有旧所有者后，清理旧 UUID generation 目录与登记原子写临时文件；不会删除其他实例、用户 scratch 或权威状态。旧版本在系统临时目录中留下的无归属目录无法安全识别，不做全局扫描。模型/Core 诊断保留策略见 [Core API](core.md#recovery)。
