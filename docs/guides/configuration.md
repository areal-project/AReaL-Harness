**中文** | [English](configuration.en.md)

# 配置

`core/config` 统一解析启动配置，由 server 注入各组件；本地产品默认 YOLO，审批策略和 Runtime 执行边界分别管理。完整示例见 [config.toml](../../core/config/examples/config.toml)，字段类型见[配置源码](../../core/config/src/lib.rs)。

## 文件与优先级

`显式 CLI > 已登记环境变量 > 选定 TOML > 默认值`。默认配置为 `~/.areal/config.toml`，数据为同目录 `state/`。`AREAL_HARNESS_HOME` 指定非空绝对 home；`--config` 优先于 `AREAL_HARNESS_CONFIG`，替代默认文件，不叠加。不自动读取项目 TOML 或 `.env`。

共享 TUI/Web 入口使用按工作区隔离的默认数据目录；显式 dataDir 仍遵循上述优先级。历史迁移与配置兼容性见[本地服务契约](../api/local-service.md)。

默认文件不存在可继续；显式文件不存在、未知字段、类型/版本错误或已设置为空的值均拒绝。文件限普通 UTF-8、1 MiB，必须声明 `schema_version=1`。TOML 相对路径以配置文件目录为基准，CLI/env 相对路径以启动 cwd 为基准，不展开 `~`、变量或 glob。即使字段被高层覆盖，低层格式错误仍拒绝。

<a id="permissions"></a>
## 权限模式

本地 TUI、Web、CLI 和 `scripts/launch.py` 默认 **YOLO**：普通任务可读写当前用户有权访问的文件（含工作区外和 `/tmp`），命令可联网，不逐次询问。无需再传 `--allow-write` / `--allow-network`。操作系统自身权限仍有效；显式 Profile、只读 Turn、工具拒绝规则和受限 Runtime 不能被 YOLO 覆盖。

全局配置 `~/.areal/config.toml`：

```toml
schema_version = 1
[permissions]
mode = "ASK_PERMISSIONS"
# 规则只匹配工具 ID，支持 *；不是 shell 命令模式。
# deny = ["mcp__untrusted__*"]
# ask = ["run_command"]
# allow = ["read_file"]
```

已有文件只添加 `[permissions]`，不要重复 `schema_version`。省略此表或设置 `mode = "YOLO"` 恢复默认。也可使用环境变量或单次启动参数：

```sh
ASK_PERMISSIONS=1 make tui
AREAL_HARNESS_PERMISSION_MODE=ASK_PERMISSIONS target/debug/areal web
make tui ARGS='--permissions ASK_PERMISSIONS'
```

优先级：`--permissions` > `AREAL_HARNESS_PERMISSION_MODE` > `ASK_PERMISSIONS` > TOML > YOLO。`ASK_PERMISSIONS` 接受 `1/true`（询问）、`0/false`（YOLO）。权限模式在服务启动时固定；已有共享服务需显式执行 `ASK_PERMISSIONS=1 target/debug/areal service restart`，带回原有自定义部署参数。重启默认拒绝忙碌服务。`--endpoint` 使用远端服务的策略。

ASK_PERMISSIONS 自动允许内置工作区/scratch 读取、搜索和内部状态操作；命令、文件修改、工作区外读取、外部工具进入审批。它是工具调用审批，不是 shell 静态分析；允许一次命令即允许该命令在当前 Scope 内执行其子操作。TUI 弹窗和 Web 面板提供拒绝、允许一次、记住本会话/当前项目相同请求；强制审批与无法核验代际的 MCP 工具仅单次回答。当前不提供命令前缀规则或按域名联网授权。

规则优先级固定为 `deny > ask > allow > mode`，每组最多 128 个、每个最多 128 字节的工具 ID glob。显式 ask 与 Profile/客户端追加的审批不能被授权记忆覆盖；allow 不能覆盖只读 Scope。批准绑定实际参数摘要；取消、过期、重复或摘要不符的回答不执行工具。

记忆绑定工具、规范化参数、Host 代际、工作区与权限边界；修改命令或策略会重新询问。会话记忆随 Thread 持久化；项目记忆位于该部署的 `dataDir/desktop/permissions.json`，同工作区不同 dataDir 不共享。每组最多 64 条、128 KiB；文件含获批参数，应与会话数据一起管理。TUI `/permissions` 显示模式来源、Runtime 权限与记忆，`/permissions clear-session`、`/permissions clear-project` 撤销后续复用，不撤销已经受理的副作用。撤销要求目标 Thread 空闲。

launcher 自动创建与 dataDir 同级的 `scratch/`，为每个 Thread 设置独立 `TMPDIR`；可用 `--scratch` 指定现有目录。目录与工作区/dataDir 不重叠，保留至部署数据被人工清理。只读/研究任务仍可写自己的 scratch。直接嵌入 Core 或运行 Runtime daemon 的默认边界保持受限；部署显式 `--sandbox-profile native` 可继续使用原有 write/network 开关，见 [Runtime 部署](runtime.md)。

## 模型与限额

```toml
schema_version = 1
[server]
listen = "127.0.0.1:4500"
[model]
provider = "example"
name = "your-model-id"
max_retries = 2
[model.providers.example]
protocol = "responses"
endpoint = "https://model.example.com/v1/responses"
api_key_env = "AREAL_API_KEY"
[limits]
model_concurrency = 32
max_threads = 20000
max_active_turns = 256
max_children_per_turn = 64
max_agent_depth = 8
turn_timeout_seconds = 300
stream_idle_timeout_seconds = 30
max_history_bytes = 2097152
max_output_bytes = 262144
max_tool_calls = 128
max_tool_buffer_bytes = 4194304
context_window_bytes = 196608
context_compaction_enabled = true
context_recent_bytes = 65536
context_window_tokens = 0
context_output_reserve_tokens = 0
max_completion_retries = 0
watchdog_disable = false
[logging]
filter = "info"
```

endpoint 是完整 HTTP(S) 请求 URL；Core 只支持 `chat-completions` / `responses`，不自动补路径。配置只写密钥变量名；普通启动时，显式引用必须解析为非空且可用于 HTTP header 的值；未选中 provider 不要求密钥。省略引用为匿名，不从其他应用读取凭据。`--management` 允许选中模型的凭据暂不可用，以便启动管理和 Workspace 入口；该模型的请求会明确报 `MODEL_CREDENTIAL_UNAVAILABLE`，不会匿名发送或改用其他模型。模型名称、端点和协议仍须有效；设置凭据后需重启服务。

例如 Chat Completions 通常填写 `https://model.example.com/v1/chat/completions`，Responses 填写 `https://model.example.com/v1/responses`，以供应商实际接口为准。仅填 `/v1` 可能得到 HTTP 200 的 HTML 网页，触发 `model response must use text/event-stream`；Goal 模式还会因未知用量显示 `GOAL_USAGE_UNKNOWN`，并保留原始错误。修改启动配置后须[停止并重新启动共享服务](../api/local-service.md#公共入口)，只重开客户端不会重新加载配置。

`reasoning_effort` 可为 none/minimal/low/medium/high/xhigh，供应商需支持；可选 `max_output_tokens` 映射到协议对应字段。`max_retries` 为 0–8，控制接受流之前的有限 HTTP 重试，涵盖传输错误、HTTP 408/429 和全部 5xx。该额度耗尽后，默认启用的 Core watchdog 仍会继续网络恢复。

可选 `model.reasoning_summary = "auto"`（也可为 `concise` / `detailed`）仅适用于 `responses`，映射到请求的 `reasoning.summary`；环境变量为 `AREAL_HARNESS_REASONING_SUMMARY`。默认省略，不向 Chat Completions 或未选择此功能的模型附加摘要参数。端点/模型必须支持所选摘要模式；是否返回摘要取决于供应商，不保证始终有思考文本。

可选采样参数不配置时省略，显式 0 保留。`temperature` 为有限数 [0,2]，`top_p` / `min_p` 为 [0,1]，`top_k` 为正整数或 -1，`presence_penalty` 为 [-2,2]，`repetition_penalty` 大于 0。Chat 与 Responses 均接受 temperature/top_p；其余四项只支持 Chat，Responses 配置时拒绝。参数发送不证明供应商实际采纳。求解与摘要使用同一采样/推理配置；摘要禁用工具，输出上限为 `min(max_output_tokens,16384)`，未配置时为 16384。

`context_window_tokens=0` 禁用 token 估计，最大 2000000；启用时 reserve 必须小于 window。历史、system 与工具定义的估计达到 window 减 reserve，或字节阈值时触发压缩。估计按 ASCII 约 3 字节/token、非 ASCII 约 2 token/字符及媒体代理成本计算，可由上次输入用量向上校准；缓存命中不降低估计，不保证匹配供应商 tokenizer。

`limits.context_compaction_enabled=false` 关闭自动和手动压缩（默认 true）。超过 `context_window_bytes` 或达到启用的 token 阈值时，Turn 直接失败并报告上下文上限，不再向模型发送求解或摘要请求；原始历史仍保留。这个估计阈值不是提供方的真实上下文上限。需同时关闭 Agent 委派与 Workgroup 子任务时，设置 `max_children_per_turn=0` 和 `max_agent_depth=0`。若显式启用了原生研究 Agent 扩展，子任务限额不能为 0，启动会拒绝该组合。

网络 watchdog 默认启用，网络错误没有重试次数上限。设置 `AREAL_HARNESS_WATCHDOG_DISABLE=1` 关闭，删除该变量或设为 `0` 恢复默认；也接受 `true`/`false`，对应 TOML `limits.watchdog_disable`。环境变量覆盖 TOML。watchdog 覆盖连接/传输失败、请求与流空闲超时、提前断流、HTTP 408/429/5xx，以及 SSE 明确报告的限流/服务不可用。求解、子 Agent 与上下文摘要采用同一策略，250 ms 指数退避、最长 30 秒；取消、Turn 总期限及显式 Workgroup 实际请求预算仍有效。401/403、无效请求、额度不足、长度上限和空回复不进入无限重试。

Goal 的共享预算与未知用量约束优先于重试配置。Goal 请求禁用 HTTP 内部重试；失败或超时产生未知消费时保留预算预留并停止自动推进，watchdog 与有限重试额度均不能绕过此限制。

`limits.max_completion_retries` 默认为 0、范围 0–8，是每 Turn 的有限未完成响应恢复额度，与 HTTP `max_retries` 和网络 watchdog 分开；关闭 watchdog 不关闭已有的有限重试。恢复条件与审计见 [Core API](../api/core.md#recovery)。HTTPS 使用公开根证书和宿主系统信任库；私有 CA 应安装到信任库。工具调用仅来自协议结构化字段，正文中的 XML/JSON 不作为调用执行。

`limits.max_tool_buffer_bytes` 默认为 4194304（4 MiB），必须为正整数，限制每次响应缓冲的所有工具 id、name、arguments 的 UTF-8 字节总量；不包含 reasoning 或独立音视频/图像 Blob；嵌入参数的媒体字符串仍按 UTF-8 字节计数。这不是进程内存总上限。它与 Turn 的 `max_output_bytes` 和历史预算独立，调高缓冲不扩大执行或持久化额度。Chat Completions 与 Responses 共用该预算，重复的 Responses 终态条目不重复计数。单调用 arguments 仍最多 64 KiB；调用数量使用当前 Turn 剩余的 `max_tool_calls`，不再限制为每响应 16 个。环境变量为 `AREAL_HARNESS_MAX_TOOL_BUFFER_BYTES`。

字节与容量限额为正整数；扇出和深度可为 0 以禁用委派。output 小于 history，recent 小于 context window，时限为 1–86400 秒。上下文字节是估计值，不是 tokenizer 窗口。活动任务、模型请求和 Runtime 资源分别计数。

| 环境变量（前缀 `AREAL_HARNESS_`） | 对应配置 |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | 模型名称、provider、完整 URL、协议与凭据引用 |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | 模型参数 |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | 采样参数 |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_COMPACTION_ENABLED` | 可选上下文 token 预算与压缩开关 |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | server、扩展文件与日志 |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | 并发与任务容量 |
| `TURN_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | 时限 |
| `WATCHDOG_DISABLE` | `limits.watchdog_disable`；`1` 关闭，默认 `0` |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `MAX_TOOL_BUFFER_BYTES`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | 历史、工具与上下文预算 |

未知 `AREAL_HARNESS_*` 报错。旧 `AREAL_MODEL*` 与 `RUST_LOG` 为低优先级兼容别名。无 provider 文件记录的旧模型入口可使用可选 `AREAL_API_KEY`；显式文件 provider 不隐式继承它。

<a id="proxies"></a>
## 出站网络代理

Core 的模型请求（含摘要、子 Agent 与 Workgroup）、Streamable HTTP MCP 和可选 OTLP HTTP 导出支持 `http://`、`https://`、`socks5://`、`socks5h://` 代理。代理协议与目标 URL 协议独立：例如 HTTPS 模型接口可通过 HTTP CONNECT 或 SOCKS 代理访问。HTTPS 代理和 HTTPS 目标都保持证书校验；私有 CA 须受对应 HTTP 客户端的信任库信任。

使用启动 Core 时的标准环境变量；无需在 TOML 中重复配置：

| 环境变量 | 用途 |
|---|---|
| `HTTP_PROXY` / `http_proxy` | HTTP 目标的代理 |
| `HTTPS_PROXY` / `https_proxy` | HTTPS 目标的代理 |
| `ALL_PROXY` / `all_proxy` | 未设置对应协议代理时的回退 |
| `NO_PROXY` / `no_proxy` | 绕过代理的域名、IP 或 CIDR，逗号分隔；`*` 绕过全部 |

Core HTTP 客户端优先读取大写变量，再读取小写变量；第三方工具的优先级由其 HTTP 库决定，建议大小写值保持一致。`socks5` 在本地解析目标域名，`socks5h` 交给代理解析。HTTP(S) Basic 和 SOCKS5 用户名/密码可通过代理 URL 的 userinfo 配置；该 URL 可能包含凭据，不应写入仓库或共享诊断。

例如使用 SOCKS5 远端 DNS，并保留已有绕过条目：

```sh
export ALL_PROXY='socks5h://127.0.0.1:1080'
export all_proxy="$ALL_PROXY"
export NO_PROXY="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"
areal service restart --workspace /absolute/workspace --json
```

已有 `HTTP_PROXY` / `HTTPS_PROXY` 及其小写值会覆盖对应目标的 `ALL_PROXY`；统一走 SOCKS 时需同步调整这些变量。共享服务保留启动环境，修改变量后必须在新环境中显式 restart，只重开 TUI/Web 不会刷新后台进程环境。自定义配置或部署参数按[共享服务契约](../api/local-service.md)传给 restart。本地服务发现和登录 HTTP 请求固定直连，避免将 loopback 认证发送到外部代理。

可信 stdio MCP 与插件 Host 自动继承上述八个代理变量，包括代理 URL 中的认证信息；其他环境仍按各自白名单处理。`web_search` 等外部工具须使用支持相应代理协议与环境变量的 HTTP 库；Core 不拦截其自建 socket，也不替远程 MCP 服务配置它到搜索供应商的网络。Runtime 命令环境及网络授权保持独立，代理不扩大 Scope 权限。具体边界见 [MCP](mcp.md) 和[插件](../design/plugins.md)。

## 诊断与运行时目录

```sh
target/debug/areal config validate --config /absolute/config.toml
target/debug/areal config show --sources --config /absolute/config.toml
```

诊断不监听、不创建数据、不启动 Runtime/MCP/插件，也不探测模型；输出有效值和来源并脱敏。共享本地服务支持下述模型配置热更新；启动凭据不进入 Runtime 环境。`OTEL_*` 由 server 的 telemetry 装配处理。

桌面运行时 provider 目录使用 `areal/provider/*` 和 `AREAL_CREDENTIAL_<ref>`；只支持 chatCompletions/responses。`--desktop-config` 装配版本化 Profile/Skill/Workflow；使用 `--agent code-agent@v2` 启动 TUI、headless 或 `exec` 时选择 Profile，Profile 绑定的 Workflow 会随 Thread 自动启动，不再额外传 Workflow 参数。会话配置可在空闲边界通过 CAS 更新并冻结到新 Turn/队列，见[桌面契约](../api/desktop.md)。会话显式选择的 Provider 与 TOML 默认模型分别管理。

```sh
target/debug/areal --desktop-config deployment.json --agent code-agent@v2
target/debug/areal --desktop-config deployment.json --agent code-agent@v2 --prompt "检查当前改动"
target/debug/areal exec --desktop-config deployment.json --agent code-agent@v2 "运行测试"
```

`deployment.json` 中让 Profile 绑定工具与 Workflow；同一文件可保留不带 Workflow 的 Agent：

```json
{
  "profiles": [
    {"id":"tool-agent","revision":"v1","displayName":"Tool agent","instructions":"检查并报告结果。","toolAllowlist":["fs_read","run_command"]},
    {"id":"code-agent","revision":"v2","displayName":"Code agent","instructions":"按阶段完成并验证任务。","toolAllowlist":["fs_read","run_command","fs_apply_patches"],"workflow":{"id":"code-flow","revision":"v1"}}
  ],
  "workflows": [
    {"id":"code-flow","revision":"v1","displayName":"Code flow","plan":{"objective":"修改并验证代码","tasks":[{"id":"implement","instruction":"修改 src/main.rs 并运行测试","writes":["src/main.rs"],"configuration":{"agentProfile":{"id":"code-agent","revision":"v2"}}}]}}
  ]
}
```

`tool-agent@v1` 可直接使用允许的工具，不需要 Workgroup；`code-agent@v2` 需要可信 `--workgroup-policy` 和 `--allow-write`，策略须授权 `src/main.rs` 并提供最终检查，详见 [Workgroup 指南](workgroups.md)。Workflow 计划由绑定 Profile 自动启动，`--prompt` 或 `exec` 的普通 Turn 是独立的用户交互。

## 模型配置热更新

共享 TUI/Web 服务每秒读取选定 TOML，连续两次读到同一有效配置后应用。默认模型、端点、协议、凭据引用和采样/推理参数变更用于后续新提交；显式 CLI/环境覆盖仍有更高优先级。非法编辑保留旧配置，TUI/Web 显示错误。独占 launcher 和独立 Core 仍只读取启动配置。

活动 Turn、其子任务、摘要和已入队请求保持原模型版本；会话显式选择的模型保持不变。Goal 自动续轮在下次提交边界使用当时的默认值。默认模型版本保存在私有 `dataDir/desktop/default-models.json` 中，供队列跨重启恢复，最多 128 个版本、1 MiB；不保存环境凭据值。退役凭据缺失时拒绝对应队列项执行，不替换成其他模型。迁移历史时需同时保留此文件。

其他配置需要重启。TUI 等待 Turn、Goal、队列和资源结算后重启；`areal service ensure` 也会为空闲服务应用 TOML 或二进制更新。权限/部署变化和模型 CLI/环境覆盖变化需带目标参数执行 `areal service restart`。新终端环境变量不能更新现有进程，改变凭据值后应显式重启。默认重启拒绝忙碌服务；`--cancel` 才显式取消并结算工作。

<a id="tui"></a>
## TUI 偏好

`${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`，可用 `--tui-config` / `AREAL_TUI_CONFIG` 替代。字段为 `theme=dark|light|terminal`、`color=auto|always|never`、`no_logo=false`、`ascii=false`、`mouse=true`。优先级 CLI > `AREAL_TUI_*` > 文件 > 默认；非空 `NO_COLOR` 强制关闭颜色。`--prompt` 和 `--goal` 不读此文件。

可用 `--mouse=false`、`AREAL_TUI_MOUSE=false` 或文件中的 `mouse = false` 关闭鼠标捕获。默认开启；关闭后历史仍可通过键盘完整操作。

Skill 自动发现见[Skill](skills.md)，工具配置见[工具](tools.md)，部署权限见[Runtime](runtime.md)。

<a id="goals"></a>
## Goal 执行策略

Goal 通过 `/goal <目标>`、Web 面板、`--goal` 或 API 显式创建，无需额外开关。下面的可选 TOML 配置只调整执行限制；省略整个 `[goals]` 表时使用默认值。

```toml
[goals]
max_turns = 100
max_active_seconds = 3600
max_unreported_turns = 3
turn_model_rounds = 32
```

示例中的数字为默认值。前三个数字字段的范围为 1–86400；turn_model_rounds 为 2–1024。创建 Goal 的 maxTurns/maxActiveSeconds 可以收窄到部署上限；tokenBudget 只在用户明确设置时启用。根 Turn 使用 min(会话 maxModelRounds, turn_model_rounds)，必须至少两轮，工具 allowlist 必须允许 goal_read 和 goal_update；最后一轮仍禁用工具用于交接。连续指定数量的根 Turn 未提交 goal_update 时暂停为 progressUnreported。

活动时间包括根 Turn 的模型排队、执行、工具、交互等待和清理，子任务时间不叠加，轮次间容量等待、暂停和离线时间不计入。既有单 Turn 期限和 Runtime 硬限额继续生效。Goal 请求禁用 HTTP 层隐式重试，以保留逐次消费的归因；未知消费会停止自动推进。使用与恢复见 [Goal 模式](clients.md#goals)。

工具结果视图通过 `[tools] extensions_file` 指向的 JSON 配置，在 `policy.resultViews` 下设置 `mode: off|observe|on`（默认 observe）及 `searchGroups`、`repeatLines` 开关。大结果快照与内置 rg 不依赖该开关；额度和回取行为见[工具指南](tools.md)。

## OpenTelemetry 轨迹上报

Core 使用开源 OpenTelemetry SDK，通过标准 OTLP HTTP/protobuf 导出 Traces 和 Events/Logs。未配置 endpoint 时不启用，上报失败不改变 Turn 结果。配置在 Core 启动时读取，修改后需重启服务。

```bash
export OTEL_SERVICE_NAME=areal-core
export OTEL_RESOURCE_ATTRIBUTES='service.namespace=research,deployment.environment.name=development'
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

通用 endpoint 自动追加 `/v1/traces` 和 `/v1/logs`。也可以分别设置完整地址；信号专用配置优先于通用配置：

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20your-token'
export OTEL_EXPORTER_OTLP_TIMEOUT=10000
```

| 标准配置 | 行为 |
|---|---|
| `OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES` | 服务名和自定义 Resource 属性；服务名默认 `areal-core`，显式服务名优先于 Resource 中的 `service.name` |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_ENDPOINT` | 对应信号的完整接收地址；只设置一个信号的地址时只导出该信号 |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_PROTOCOL` | 覆盖通用协议；当前仅支持 `http/protobuf` |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_HEADERS` | 覆盖通用认证头，由 SDK 按标准格式解析 |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_TIMEOUT` | 覆盖通用超时，单位为毫秒，默认 10000 |
| `OTEL_TRACES_EXPORTER`、`OTEL_LOGS_EXPORTER` | `otlp` 或 `none`；可分别关闭信号 |
| `OTEL_TRACES_SAMPLER`、`OTEL_TRACES_SAMPLER_ARG` | 使用 SDK 的标准 Trace 采样配置 |
| `OTEL_BSP_*`、`OTEL_BLRP_*` | 使用 SDK 的标准 Trace/Log 批量队列和调度配置 |
| `OTEL_SDK_DISABLED=true` | 关闭全部遥测 |

轨迹记录 Turn、每次模型请求、工具调用和上下文压缩。模型请求使用 `gen_ai.*` 属性与 `gen_ai.client.inference.operation.details` 事件，消息按 OpenTelemetry GenAI 的 `role` / `parts` 结构记录，Span 中为 JSON 字符串，Logs 中为结构化属性。模型输入（含系统指令）、输出、推理文本、工具参数与结果均保留实际内容，没有脱敏逻辑或脱敏开关；媒体保留 Engine 收到的引用或内联数据。重试按独立请求记录，取消时保留已收到的输出并标记未完成。

本项目扩展字段和事件使用 `areal.*` 命名空间。Logs 通过标准 Trace ID 和 Span ID 关联调用，优雅关闭时刷新批量导出。只有 Logs 时也生成本地关联 ID；Traces 和 Logs 的导出开关相互独立。当前不导出 Metrics。GenAI 语义约定仍处于开发状态，参见[官方约定](https://github.com/open-telemetry/semantic-conventions-genai)。
