**中文** | [English](runtime.en.md)

# Runtime API：areal.runtime.v0

私有执行协议的类型见 [runtime/protocol](../../runtime/protocol/src/lib.rs)；部署见[Runtime 指南](../guides/runtime.md)。它不带 jsonrpc 字段，不是公共网络 JSON-RPC 服务。

## 握手与传输

UTF-8 JSONL 请求 `{id,method,params}`，响应回显 id 和 result/error，诊断写 stderr。id 为整数或 1–128 字节字符串，在途不得复用。一个 Runtime 仅服务一组继承管道，无重连/认领。

```json
{"id":1,"method":"connection.open","params":{"protocolVersion":"areal.runtime.v0"}}
```

握手返回 protocolVersion、connectionId、runtimeEpoch、rootScopeId、capabilities，版本必须精确匹配。初始化前其他方法 UNAUTHENTICATED。帧最多 128 KiB，规范载荷通常 64 KiB；fs.execute/process.write 编码后最多 124 KiB。

Runtime 装配失败时，完成启动回滚后通过 `connection.open` 返回原始错误，`error.details` 包含 `initializationFailed=true` 和 `cleanupConfirmed`。仅明确确认回滚且进程正常退出的失败可视为隔离不可用；`CLEANUP_FAILED`、无回执 EOF 或异常退出不能用于安全降级。该失败握手最多等待 4 秒，不接受任务请求。Rust Client 在系统拒绝创建进程、尚未启动 Runtime 时也返回已确认无资源的初始化失败；普通运行中的关闭与 UNKNOWN 语义不变。

capabilities 描述实际 sandbox、fullAccess、rootNetwork、方法和 processLimits；不授予新权限。coreHostIsolated/processTreeCleanupVerified/directoryObjectIsolation/sandboxDenialAttribution 为 false。旧 Runtime 缺少 rootNetwork 时 Core 保守视为无网络。

`restrictedScopes` 返回 `{available:true}` 或 `{available:false,error}`，表示当前部署的受限执行先决条件是否通过探测。full-access 父 Scope 可运行不代表只读子 Scope 可运行：收窄后仍需实际 OS 沙箱。Linux 探测 Bubblewrap namespaces，macOS 探测 Seatbelt；结果按 Runtime 进程缓存，环境能力改变后需要重新启动 Runtime。该字段不证明任意程序、路径或副作用必然成功。旧 `restrictedScopeIsolation` 标志也要求这项实测通过，不能只依据部署名称宣告可用。

原生后端根据有效 Scope 选择准入、命令沙箱和 syscall 策略。full-access 部署下的受限 Scope 或固定只读输入使用 native 策略，Linux 不因父部署标记而跳过 seccomp；未收窄且无只读输入的完整授权仍保留 full-access 行为。

标准部署的 capabilities.builtinTools.searchFiles 返回可信文件助手路径。Runtime 文件助手直接链接 ripgrep 搜索库，不读取宿主 rg 配置。Core 的 search_files 在现有 Runtime Scope 内调用该助手；旧外部 Runtime 未提供该能力时返回 UNSUPPORTED 并要求升级。

macOS 的内置搜索助手与 fs.execute 复用系统 Python 启动桥接，再执行原有沙箱命令。process.start 仅在首个命令参数与部署配置的助手绝对路径完全一致时选择该桥接；这不会扩大 Scope 或助手所在目录的访问权限。

## macOS 受限命令的系统工具

完整 macOS Runtime 包含私有 `shells/bash` 和 `shells/sh`。受限执行的标准 Bash/sh 入口及 PATH 使用该程序，`sh` 保留 POSIX 启动方式；源码根、网络和 scratch 权限不变。系统 Bash 3.2 的 here-document 不使用 TMPDIR，不能通过设置环境变量获得私有临时目录保证；私有 Bash 使用已授权的 scratch，不开放共享 `/tmp`。缺失完整程序包时，标准 shell 入口返回 UNSUPPORTED，不回退到不受限执行。嵌套脚本硬编码系统 `/bin/bash` 仍调用系统版本；需依赖私有临时目录的脚本应通过 Runtime 标准入口或 `env bash` 执行。

Runtime 在可信宿主解析 Apple Git shim，受限任务只读取/执行选定系统 Git 及其固定资源。它不为此开放开发工具链选择状态、宿主配置或整个工具链目录；默认不导入宿主 Git system/global 配置和系统 attributes，仓库配置仍按原路径权限读取。任务显式覆盖 Git 环境后仍受相同 OS 沙箱约束。Git 的索引、配置和源码写入在只读 Scope 中继续被拒绝。

可信启动 PATH 保留绝对目录的显式顺序，但 PATH 本身不授予文件权限。macOS 桌面启动缺少标准路径时，补齐 `/opt/homebrew`、`/usr/local` 中实际存在的 bin/sbin；这些前缀不得重定向到用户目录。仅增加程序和动态库的只读资源，etc 下仅接入 OpenSSL 公共配置和 CA（openssl.cnf、cert.pem、certs），不开放 private、其他服务配置或 var。macOS 系统 LibreSSL 使用同样的规则逐项接入 `/private/etc/ssl` 的公共配置和证书，供 Cargo 等程序启动；不开放整个 `/etc`。

用户级工具发现与系统工具使用同一个 Runtime 启动边界：

| 安装方式 | 受限命令使用的资源与版本选择 |
|---|---|
| nvm | `NVM_DIR` 或默认安装树；解析 default/用户别名/LTS 别名，选择已安装的匹配版本 |
| fnm | `FNM_DIR`、标准数据目录；解析 default 或已激活的 multishell 链接 |
| mise、asdf | 数据/安装目录中的具体工具版本；读取全局配置的字面量版本，不求值模板、env、hooks 或插件 |
| pyenv、rbenv | 已安装版本与全局 version 文件，保留显式部署版本提示 |
| rustup / Cargo | 已选 toolchain 的真实 bin、lib 等安装资源；Cargo 自装命令只接入 bin，不读取 credentials.toml |
| Volta | 已安装的默认 Node/npm/pnpm/Yarn 镜像；保留默认包管理器在 Node 附带 npm 之前的顺序 |
| uv、pipx、Bun、Deno、独立 pnpm 等 CLI | 已存在的用户 bin；uv/pipx 链接只接入对应 venv 与已识别的解释器，不开放整个用户数据目录 |

显式激活的具体安装路径优先于全局默认。没有默认时，仅在安装集合唯一时补齐；有多个版本、配置无效或版本缺失时不随意切换到最新版。发现只读取有界文件和固定层级目录，不执行 shell 配置、manager hooks，不安装或下载工具。受限路径将已识别 shim 替换为具体安装目录，避免独立 HOME 破坏工具启动；完整授权且继承网络时保留原始 shim 顺序与宿主项目选择语义。受限执行使用启动时的版本快照，不自动解释工作区版本文件、复杂 manager 配置或安装未存在的项目版本；需要其他版本时使用已获授权的显式工具路径，或在可信启动环境激活后重启 Runtime。

Rust 默认版本依次采用显式启动版本、用户 rustup 默认值和 Homebrew rustup 默认值。Homebrew 的默认配置仅在可信标准安装前缀下读取，不因此向任务开放配置文件。受限 PATH 同时识别 Homebrew rustup 的 opt 与 Cellar shim，替换为已安装工具链。

桌面服务、Rust Client、独立 worker 和开发 launcher 透传同一组发现提示：HOME、XDG_DATA_HOME/XDG_CONFIG_HOME、NVM_DIR、FNM_DIR、VOLTA_HOME、MISE_DATA_DIR/MISE_CONFIG_DIR/MISE_INSTALLS_DIR、ASDF_DATA_DIR、PYENV_ROOT、RBENV_ROOT、RUSTUP_HOME、CARGO_HOME、PNPM_HOME、BUN_INSTALL、DENO_INSTALL，以及 RUSTUP_TOOLCHAIN/PYENV_VERSION/RBENV_VERSION。这些值用于可信启动发现，不直接注入受限任务。配置内容、宿主 home、凭据和 manager 状态目录不因此获得读取权限。具体安装根须解析到已识别安装树内，执行前再次拒绝被重定向或移除的根。模型进程自行设置 PATH 或 manager 变量不能增加授权根；源码写入、网络、只读输入和清理仍受原 Scope 约束。

握手的 `commandEnvironment` 给出受限 `path`、完整授权 `unrestrictedPath`、`readOnlyToolchains` 和未能确定默认版本等 `notices`。发现按 Runtime 生命周期执行，不在每次工具调用时启动 shell 或重新扫描用户目录；更换工具安装或默认版本后重启服务。

受限 macOS 命令默认设置 `CARGO_NET_GIT_FETCH_WITH_CLI=true`，让 Cargo 的 Git 获取复用系统 Git 的隔离配置。命令显式设置的值优先。系统 Git 配置文件只允许必要的元数据检查，不开放正文读取；宿主 Cargo 缓存仍需要显式目录授权。

受限命令不会继承宿主 HOME。Runtime 在既有读取权限内选择 HOME：优先采用有效的 TMPDIR（Core 的每线程 scratch），未提供时尝试 Scope 可读的部署 scratch 或其已授权子目录，均不可用时退回当前工作目录；缺失的 TMPDIR 同步使用该目录。目录必须是已存在的绝对目录，解析符号链接后仍在 Scope 读取范围内；不增加读写根或网络权限。没有可写 scratch 的只读调用仍不能写缓存，应由可信调用方提供 scratch。完整授权且继承网络的宿主模式保留原有 HOME/TMPDIR 继承规则。

Rust Client 的 `launch_with_limits` 投影可信 PATH 并向 Runtime 传递上述发现提示，不继承其他环境；`launch_with_command_path` 供可信部署显式接入已物化工具链，要求有界的绝对目录列表。NativeExecutor 为显式工具链把私有 .toolchain/bin 加在系统路径前。它不扩大源文件写集合。`launch_with_environment` 另接受可信调用方已授权的网络上限；已有 launch 入口仍默认禁网，子 Scope 可继续收窄为 deny。

私有 Bash 是单独执行的 GPL-3.0-or-later 组件，完整包同时携带许可证、锁定对应源码和构建信息；不静态链接进 Rust。构建和升级须使用完整 bundle，见[开发指南](../development/README.md)和[发行流程](../development/releasing.md)。

## 方法

| 方法 | params |
|---|---|
| connection.open / close | `{protocolVersion}` / `{}` |
| scope.check | `{parentScopeId,permissions?}`；成功返回 `{available:true}` |
| scope.create | `{operationId,parentScopeId,owner,permissions?,limits?}` |
| scope.createParticipant | `{authorityScopeId,scope,participation}` |
| scope.get / revoke / waitClosed | `{scopeId}` |
| owner.revoke | `{pluginInstanceId}` |
| process.start / startQueued | `{operationId,scopeId,argv,cwd,env?,tty?,pipeStdin?,limits?}` |
| process.get / terminate / wait | `{processId}` |
| process.write | `{operationId,processId,dataBase64}` |
| process.resize / closeStdin | `{operationId,processId,cols,rows}` / `{operationId,processId}` |
| fs.execute | `{operationId,scopeId,command}` |
| output.read | `{processId,after?,maxBytes,waitMs?}` |
| operation.get | `{operationId}` |
| runtime.status | `{}` |

最多 32 个长请求等待，撤销、终止和同步查询保留控制通道。connection.close 仅在清理确认后返回 closed=true，否则错误。Scope 状态 active/revoking/closed；操作 accepted/running/succeeded/failed/cancelled/unknown；进程 starting/running/exited/unknown。

## 权限与去重

`scope.check` 根据父权限校验路径、读写根和网络收窄，并调用后端的实际执行先决条件探测；不创建 Scope、操作记录或任务进程，不占用累计配额。不能满足时返回 `UNSUPPORTED` 或原权限错误。检查结果不是授权或执行承诺；`scope.create` 再次校验。Core 在子任务的首个模型请求前使用此查询；Rust `Client::check_scope`、TypeScript `client.scopes.check` 使用同一契约。旧 Runtime 未宣告此方法时拒绝新子任务并提示升级，原有父任务和控制请求不因此中断。

路径使用未编码 `workspace://repo[/path]`，拒绝百分号、问号、井号、反斜线、NUL 和 . / .. 段。子根须在父授权内，写根在读根内；network=inherit 继承父策略，deny 后不能恢复。owner 仅归因。argv 为 1–256 项，环境白名单见[部署](../guides/runtime.md)。

配置独立 scratch 根后，文件与进程 cwd 可使用 `workspace://scratch[/path]`；未配置时拒绝。它与 repo 不重叠，scratch 根可写且独立于 repo 的 allow-write，子 Scope 仍只能收窄。目录身份检查、路径遍历和符号链接限制同样适用。Core 的短句柄在调用 Runtime 前解析，不改变 ProcessId、游标或 ExpectedFile wire 类型。

`fullAccess=true` 时新增 `workspace://host[/绝对路径去掉前导斜线]`，根映射 `/`；普通部署拒绝此命名空间。Core 将工作区外绝对路径规范化为 host URI，文件助手继续拒绝符号链接遍历。只读/研究 Scope 不包含 host 根。

有副作用的方法使用 `${runtimeEpoch}:op:${UUID}` operationId。相同键和规范请求摘要共享同次操作，不同摘要 CONFLICT。记录保留至 epoch 结束，容量满拒绝；旧 epoch 为 STALE_HANDLE。进程 start 的 succeeded 仅表示获得句柄，不表示命令成功；丢失响应不能换新键重放。

默认每进程期限 30 秒，整个 Scope 后代累计 8 MiB 输出、4 个并发进程；连接保留 256 Scope/4096 操作。期限含写路径排队和启动，清理前不释放进程额度。部署可以配置，子 Scope 只能收窄。

`fs.execute` 的内部文件进程和显式 `process.startQueued` 在祖先并发名额耗尽时等待释放；排队计入原进程期限，预留名额与检查在同一临界区完成，不提高并发上限。等待前登记并保留本 epoch 的操作回执；重复 ID 复用同一等待与结果，撤销 Scope 会终止等待。累计输出、权限或操作记录容量耗尽仍立即拒绝，不重试已有副作用。`process.start` 保持立即准入或拒绝的行为。Core 的短文件读取与搜索协商使用排队入口；旧 Runtime 未公布该方法时仍使用原入口，不在失败后重放。

Runtime daemon 可用 `--cumulative-output-bytes` 独立设置部署及 Scope 后代累计输出上限；省略时等于 `--output-bytes`，且不得小于单进程上限。进程仍受 `--output-bytes` 限制，输出窗口另由 `--output-window-bytes` 约束。stdout/stderr 的真实接受字节对每个祖先累计一次；重复读取保留输出不再收费。文件助手的 JSON/base64 响应也是进程输出。

Core 使用 `readForHistory` 捕获条件编辑的历史前像。仅这一经过校验的文件助手使用独立的 `MAX_FRAME_BYTES - 4096` 响应上限，不消耗命令或祖先输出额度。读取权限、文件大小、进程容量、时限和操作保留上限继续适用。普通 `read` 与 `process.start` 保留原有输出计量。

## 有界 hook 写入组

`scope.createParticipant` 仅供连接所有者受理。`authorityScopeId` 必须等于当前 epoch 的不透明 connection root；`scope` 使用既有 `scope.create` 字段。`participation` 为 `{kind:"task",admissionWindowMs}` 或 `{kind:"hook",taskScopeId}`。Task 只能在现有组之外创建；Hook 的 parent 必须已属于指定且验证过的 Task Scope。普通子 Scope 继承参与身份；复制 owner metadata 不构成授权。旧 `scope.create` 与 `ScopeInfo` 不变；不支持的新方法明确拒绝，不使用放宽权限的 fallback。

受理窗口为 1–min(task 进程 wall limit,60000) 毫秒。第一次写入受理固定 generation 截止，后续成员不能延长。已占有覆盖路径上，同组至少一方为 Hook 时可重叠；ordinary/ordinary 仍串行，跨组冲突继续独占。路径扩张须完整申请新的预约并排在已有外组等待者之后。封口后新成员进入下一 generation 的 FIFO 位置，旧进程保留各自期限与 lease，直到确认清理。UNKNOWN 关闭准入，不把未确认副作用当成已释放。显式类型参与者始终采用此调度，即使开启旧 concurrent-write 选项；未分组的旧行为不变。

公平性单位因此改为有界组，同任务 hook/工具可以实际并发写入。它不授予新路径、不保证事务隔离，也不保证封口后的任意依赖链可重入。Core 持有每个 Session 的 Task Scope，普通工具与 hook 从其派生，等待 hook 任务与 SessionEnd 后关闭。每进程权限收窄与 hook 秘密排除继续生效。

## 输出与清理

output.read 的 maxBytes 为 1–65536，waitMs 为 0–1000，每页最多 128 chunks。响应 `{chunks,nextCursor,gap,truncated,closed}`；chunk 含 cursor/stream/dataBase64，stream 为 stdout/stderr/pty。UTF-8 可跨页切开，需持续解码。

gap 表示旧前缀淘汰；truncated 表示预算/故障丢失；closed 表示输出结束且本页读到末尾，不表示命令成功。保留窗口默认 64 KiB/1024 chunks。必须继续读取 cursor，不以未满页判 EOF。

revoke 先关闭后代准入再请求取消；waitClosed 只能在 revoke 后调用。terminate 的 accepted 不等于清理；process.wait 确认退出和输出关闭。进程结果与资源清理独立：`ProcessInfo.cleanupConfirmed` 仅表示当前平台受管资源已确认清理，`failureReason` 保留原始执行错误。旧 Runtime 缺少这些字段时，客户端不得推断已清理。

握手的 `failureIsolationV1=true` 声明分级故障语义。后端已确认进程及平台跟踪资源退出，但输出读取或交付失败时，仅撤销该执行所属 Scope、释放其资源占额，保留进程 UNKNOWN 与原操作收据；其他 Scope 继续接受工作。不确定是否启动、清理未确认、无错误回执 EOF 或事件顺序违规时，封闭根 Scope 并收尾整个后端。只有后端 shutdown 的可信成功回执才能释放这些 UNKNOWN 的资源占额；根准入保持关闭，结果仍未知，不能重放。

`runtime.status` 增加 `admissionOpen` 和可空的 `recovery`。故障包含 `state=restartRequired|inspectionRequired`、`reason`、`cleanupConfirmed`、可空的 `cleanupFailure`、最多 16 条未确认 `processes` 与总数 `unconfirmedProcesses`。原始故障与后端清理失败/超时分别保留，关闭等待受部署清理期限约束。前者允许可信宿主在资源及持久状态结算后更换 Runtime epoch，后者需人工核查；都不恢复旧句柄。Rust `backend::Event::Failed {error,cleanup_confirmed}` 替代单值失败事件，嵌入宿主须更新穷尽匹配，并仅在清理事实已知时传 true；`ProcessInfo` 的 Rust 结构体初始化需补充新字段。RPC 为增量字段扩展，TypeScript 对旧字段缺省保持兼容。

Linux native 每次执行由独立的可信 Rust 二进制 `areal-runtime-reaper` 托管；部署须将它与 Runtime 放在同一目录，并提供可读的 `/proc`。嵌入 `NativeBackend` 的宿主也须在宿主可执行文件旁部署该 helper。回收器不依赖 Python，项目 launcher 和自定义工具的解释器要求另行适用。helper 在启动命令前成为 subreaper，独占其子进程的 wait，持续回收被收养的孤儿。命令正常退出、取消或私有生命周期管道 EOF 时，它清退并回收该执行的残留后代，包括调用 `setsid` 改变进程组的后代。Runtime 只等待自己的 helper，实际命令退出状态与清理结果由私有回执传回；helper 退出本身不能替代该回执和输出关闭确认。

Runtime 通过密封的匿名内存文件描述符传递实际命令参数，helper 的进程命令行仅含私有描述符编号和模式。helper 在启动 payload 前读入并关闭参数描述符，不让按工作负载命令行匹配的进程清理误杀回收器。该私有启动协议要求 daemon 与 helper 同版本部署；不防止 full-access 代码显式按 helper 身份发信号，原 UNKNOWN 与清理失败规则保持不变。

启动握手最多等待 3 秒；确认未创建命令且 helper 已回收的启动失败，只拒绝本次执行并释放登记。后端启动返回 `UNAVAILABLE` 或 `CLEANUP_FAILED` 时，Supervisor 将执行及操作保留为 UNKNOWN、封闭连接准入，在可信后端清理回执前保留占额，不能按确定未启动释放资源。已启动执行的清理超时会报告失败；helper 继续收养并等待尚未退出的后代，Runtime 保留其 waiter，不以强杀回收器替代回收完成。

macOS 保留进程组清理，并在执行期间使用 `libproc` 约每 10 ms 发现后代，最多跟踪 4096 个进程身份。已发现后代即使调用 `setsid` 或重新归属，仍按 PID 与内核唯一进程 ID 核对后清退；确认这些身份消失后才完成输出收尾。唯一身份查询也适用于执行 setuid 程序的后代，避免因读取受限 BSD 进程信息而错误关闭后端；父身份同样使用内核唯一 ID 校验。发现、信号或退出观察失败会报告清理失败。它不具备 Linux subreaper 的收养能力：两次观察之间快速 fork、父进程退出和重新归属仍可能漏掉后代；身份检查与发信号也不是内核原子操作。该跟踪不提供任意进程树的完整清理保证，也不覆盖 Runtime 被强杀后的清理。

仍归属活着的中间父进程的 zombie，必须由该父进程 wait；helper 在父进程退出、后代被收养后才能代为回收。

此回收边界属于单次 Runtime 执行，不是 cgroup 资源隔离，不覆盖 Core、MCP、插件 Host、Studio 自行启动的进程或主机上已有的 zombie。它依赖可信 helper 存活并持有子进程归属；恶意同 UID 的 full-access 代码或外部 `SIGKILL` 终止 helper 时，后代仍可能交给外层 init，外层部署必须自行回收。因此 `processTreeCleanupVerified` 保持 false，不能据单次清理成功宣称任意逃逸或宿主故障下的全树回收保证。

stdin 单次 1–65536 原始字节；resize 尺寸 1–65535。closeStdin 对 pipe 关闭 FD，对 canonical PTY 发送 VEOF，raw PTY 拒绝。空写不等于 EOF。owner.revoke 永久封闭当前 generation 并撤销后代，各 Scope 仍需 waitClosed。

## 文件

fs.execute 仅在配置可信 helper 时可用；command.kind：

| kind | 其他字段 | 结果字段 |
|---|---|---|
| read | `path,offset?=0,maxBytes` | `dataBase64,sha256,size,nextOffset,eof` |
| readForHistory | `path,offset?=0,maxBytes` | 与 `read` 相同，仅用于内部历史证据 |
| stat | `path` | `kind,size` |
| list | `path,after?,limit` | `entries,nextCursor` |
| search | `path,pattern,glob?,context,limit` | `matches[{path,line,text,kind}],limited,guidance` |
| write | `path,dataBase64,expected` | `sha256,size` |
| applyPatch | `path,oldText,newText,expectedSha256` | `sha256,size` |
| applyPatches | `path,patches[{oldText,newText}],expectedSha256` | `sha256,size` |

交付大文件时可使用 `stageFileChunk {path,uploadId,offset,dataBase64}`（每块最多 64 KiB，总计最多 8 MiB），再调用 `commitFile {path,uploadId,expected,expectedExecutable,sha256,executable}`。`uploadId` 为 UUID；首块 offset=0 创建私有 staging，后续 offset 必须匹配已存字节数。staging 位于目标目录，缺失父目录按 0755 创建；目标文件在 commit 之前不变。commit 核对完整内容摘要、原文件摘要与可执行位，再条件替换。新文件使用 0644/0755；现有文件保留读写权限，保持可执行时保留原执行位，新增执行时按已有读位设置并至少允许 owner 执行；不复制特殊权限位。提交前再次核对完整原权限，拒绝并发 chmod。新建文件的 expectedExecutable 为 null。`removeFile {path,expectedSha256,expectedExecutable}` 只删除摘要与可执行位匹配的普通文件。三种操作均要求目标路径写授权；路径遍历继续拒绝链接。`read` 额外返回 executable；握手 filesystem.artifactDelivery=true 表示支持这些命令。

staging 和 commit 是独立、可审计操作，不是跨文件事务。断连、未知结果和提交后清理失败不能换 operationId 重放；遗留 staging 保留供核查。条件替换与删除不保证对不参与 Runtime 锁的外部进程进行原子 CAS。

expected 为 `{kind:"absent"}` 或 `{kind:"sha256",value:"digest"}`。read 的 sha256 总是完整文件摘要，offset 为字节；单文件最多 8 MiB，read/write 最多 64 KiB，patch 旧/新文本合计 64 KiB 且旧文本非空唯一匹配。applyPatch 是保留的单条兼容入口，与单元素 applyPatches 共用实现。applyPatches 一次最多 32 个替换，所有替换均唯一匹配后才条件写入；陈旧摘要/已存在/歧义返回 CONFLICT。

list 每页最多 256 项/约 32 KiB，扫描最多 4096 UTF-8 名称；目录变化时不是快照。helper 使用目录描述符与 NOFOLLOW，普通读写拒绝符号链接、硬链接和特殊文件，条件替换 fsync。

打开已有根目录、路径中间目录和只读文件时，helper 在原描述符边界重试 `EINTR`，保留 `NOFOLLOW` 等标志，不重放整个操作或消耗新的模型轮次。权限拒绝不重试；创建、写入、替换和删除不因 `EINTR` 自动重放，未恢复的中断返回 `UNAVAILABLE` 并保留未知结果语义。系统权限审批或存储服务持续不可用时，重试不能使其恢复；已有 Scope 的 wall-time 和取消、清理仍约束助手进程。

`search` 是只读的原生 `FileCommand`，在当前 Scope 授权的文件或目录中按正则表达式 `pattern` 搜索，可选 `glob` 过滤路径。`context` 必填且为 0–20，`limit` 必填且为 1–1000，只计匹配行，不计上下文行。结果行的 `path` 是宿主文件路径，`line` 为行号或 null，`text` 为 UTF-8 文本或 null，`kind` 为 `match` 或 `context`。匹配超限、单行超过 64 KiB、返回行累计超过 8 MiB 或序列化结果行超过 13000 字节时，`limited=true`；此时应按 `guidance` 缩小路径或模式，只有 `limited=false` 时空结果才表示没有匹配。搜索遵循工作区内 ignore 规则，不读取宿主 rg 配置，不跟随符号链接。此分支扩展了既有 `fs.execute` 命令联合类型；旧 Runtime 不认识 `search` 时会拒绝请求，SDK 不自动降级或重试。

默认 helper 按文件、命令按写根协调冲突（writeSerialization=conflictingPaths）；显式绕过命令协调为 filePaths。外部进程不参与，不保证外部 CAS/跨文件事务。helper 结果丢失或提交后清理失败为 UNKNOWN，不能重放。

只读文件助手确定因输出额度截断、进程已退出且清理已确认时，返回 `RESOURCE_EXHAUSTED`，details.reason 为 `FILE_OUTPUT_LIMIT_EXCEEDED`，操作记为 Failed。它不表示写入未知，也不自动重放读取。写入可能发生而确认丢失、后端失联或清理未确认时仍保留 UNKNOWN；不改变累计输出硬上限。

错误包括 INVALID_REQUEST、INVALID_ARGUMENT、UNAUTHENTICATED、PERMISSION_DENIED、SCOPE_CLOSED、STALE_HANDLE、NOT_FOUND、CONFLICT、RESOURCE_EXHAUSTED、UNSUPPORTED、UNAVAILABLE、CLEANUP_FAILED。signal 为 POSIX 数字字符串；sandboxDenied=false 不能证明无沙箱拒绝。

内置工具相对 Runtime 可执行文件定位：开发构建在 `target/<profile>/tools/`，发行包在 `libexec/areal/tools/`；与公开的 `bin/areal` 分开。

可信 launcher 和 Runtime daemon 可重复传入 `--read-only-path <规范绝对目录>`，最多 16 个。目录必须严格位于既有可读根内，不增加读取权限；公开请求/子 Scope 不能取消保护。Runtime 拒绝其文件写入并固定目录身份；OS 后端保护子树以及祖先删除/重命名，Linux 使用只读挂载与 seccomp，macOS 使用 Seatbelt deny。Linux 同时固定输入与可写根之间的中间父目录，收窄到可写工作区的 Scope 也不能重命名这些目录；保护不扩大 Scope 的读取范围。`full-access` 有此约束时也执行沙箱，不回退为裸命令。只读输入与其他可写 scratch 文件可共存；候选文件的原有权限/链接限制继续适用。这保护命令及 Runtime 文件操作，不约束可信宿主上的外部修改；结束时仍应校验输入摘要。
