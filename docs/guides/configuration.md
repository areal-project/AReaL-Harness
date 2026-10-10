**中文** | [English](configuration.en.md)

# 配置

`core/config` 统一解析启动配置，由 server 注入各组件；本地产品默认 YOLO，审批策略和 Runtime 执行边界分别管理。完整示例见 [config.toml](../../core/config/examples/config.toml)，字段类型见[配置源码](../../core/config/src/lib.rs)。

## 文件与优先级

`显式 CLI > 已登记环境变量 > 选定 TOML > 默认值`。默认配置为 `~/.areal/config.toml`，数据为同目录 `state/`。`AREAL_HARNESS_HOME` 指定非空绝对 home；`--config` 优先于 `AREAL_HARNESS_CONFIG`，替代默认文件，不叠加。不自动读取项目 TOML 或 `.env`。

GUI 默认使用同一配置文件和 Core 读写接口；服务登记与运行数据保持隔离。`AREAL_HARNESS_SERVICE_HOME` 只选择共享服务登记及默认实例数据的非空绝对目录，不改变配置位置；省略时沿用 `AREAL_HARNESS_HOME` 或 `~/.areal`。GUI 自动选择自己的服务目录，无需为共享默认配置设置环境变量；路径覆盖见 [GUI 指南](../../clients/gui/README.md)。

共享 TUI/Web 入口使用按工作区隔离的默认数据目录；显式 dataDir 仍遵循上述优先级。历史迁移与配置兼容性见[本地服务契约](../api/local-service.md)。

默认文件不存在可继续；显式文件不存在、未知字段、类型/版本错误或已设置为空的值均拒绝。文件限普通 UTF-8、1 MiB，接受 `schema_version=1` 或 `2`。TOML 相对路径以配置文件目录为基准，CLI/env 相对路径以启动 cwd 为基准，不展开 `~`、变量或 glob。即使字段被高层覆盖，低层格式错误仍拒绝。

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

普通 Turn 没有组合墙钟超时；模型请求/流空闲、工具执行和清理沿用各自的超时，显式 Goal、研究 worker 和 Workgroup 预算仍有效。迁移时删除 `limits.turn_timeout_seconds`（旧 TOML 字段会被拒绝）和 `AREAL_HARNESS_TURN_TIMEOUT_SECONDS`（旧环境变量也会被拒绝）。`thread/configuration/read` 的 `limits` 不再包含 `turnTimeoutMs`。手动上下文压缩也只受模型超时与关闭取消约束。

```toml
schema_version = 1
[server]
listen = "127.0.0.1:4500"
[model]
provider = "example"
name = "your-model-id"
# context_window_tokens = 131072
max_retries = 2
[model.providers.example]
protocol = "responses"
endpoint = "https://model.example.com/v1/responses"
api_key_env = "AREAL_API_KEY"
[context]
mode = "auto"
recent_tokens = 8192
# target_tokens = 0                 # 0: automatic target
# output_reserve_tokens = 8192

[budget]
# Omitted or 0: unlimited cumulative budget.
# max_tool_calls = 0
# max_output_bytes = 0
# max_history_bytes = 0

[resources]
model_concurrency = 32
max_threads = 20000
max_active_turns = 256
max_children_per_turn = 64
max_agent_depth = 8
max_response_tool_calls = 128
max_response_bytes = 4194304
max_tool_buffer_bytes = 4194304

[network]
retry_mode = "persistent"
stream_idle_timeout_seconds = 30
[logging]
filter = "info"
```

endpoint 是完整 HTTP(S) 请求 URL；Core 只支持 `chat-completions` / `responses`，不自动补路径。配置只写密钥变量名；普通启动时，显式引用必须解析为非空且可用于 HTTP header 的值；未选中 provider 不要求密钥。省略引用为匿名，不从其他应用读取凭据。`--management` 允许选中模型的凭据暂不可用，以便启动管理和 Workspace 入口；该模型的请求会明确报 `MODEL_CREDENTIAL_UNAVAILABLE`，不会匿名发送或改用其他模型。模型名称、端点和协议仍须有效；设置凭据后需重启服务。

例如 Chat Completions 通常填写 `https://model.example.com/v1/chat/completions`，Responses 填写 `https://model.example.com/v1/responses`，以供应商实际接口为准。仅填 `/v1` 可能得到 HTTP 200 的 HTML 网页，触发 `model response must use text/event-stream`；Goal 模式还会因未知用量显示 `GOAL_USAGE_UNKNOWN`，并保留原始错误。修改启动配置后须[停止并重新启动共享服务](../api/local-service.md#公共入口)，只重开客户端不会重新加载配置。

`reasoning_effort` 可为 none/minimal/low/medium/high/xhigh，供应商需支持；可选 `max_output_tokens` 映射到协议对应字段。`max_retries` 为 0–8，控制接受流之前的有限 HTTP 重试，涵盖传输错误、HTTP 408/429 和全部 5xx。该额度耗尽后，默认启用的 Core watchdog 仍会继续网络恢复。

可选 `model.reasoning_summary = "auto"`（也可为 `concise` / `detailed`）仅适用于 `responses`，映射到请求的 `reasoning.summary`；环境变量为 `AREAL_HARNESS_REASONING_SUMMARY`。默认省略，不向 Chat Completions 或未选择此功能的模型附加摘要参数。端点/模型必须支持所选摘要模式；是否返回摘要取决于供应商，不保证始终有思考文本。

可选采样参数不配置时省略，显式 0 保留。`temperature` 为有限数 [0,2]，`top_p` / `min_p` 为 [0,1]，`top_k` 为正整数或 -1，`presence_penalty` 为 [-2,2]，`repetition_penalty` 大于 0。Chat 与 Responses 均接受 temperature/top_p；其余四项只支持 Chat，Responses 配置时拒绝。参数发送不证明供应商实际采纳。摘要默认继承求解采样/推理配置并禁用工具。可单独设置 `model.summary_reasoning_effort` 和 `model.summary_max_output_tokens`（环境变量 `AREAL_HARNESS_SUMMARY_REASONING_EFFORT` / `AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS`），不会修改后续求解参数。摘要输出上限为全局输出上限、摘要专用上限、Goal 剩余额度与 16384 中的最小值；专用上限需大于零。未配置时兼容原行为；例如可在求解 high 时显式选择摘要 low/4096，需验证供应商支持和任务保留效果。

`model.context_window_tokens` 声明当前模型的窗口（1–2000000），Provider/模型默认参数及 `parameters.contextWindowTokens` 同样支持。Core 不按模型名称猜测；未配置时使用旧全局字段的 65536 token 兜底，诊断区分模型元数据与兜底。输出预留取 `context.output_reserve_tokens`（默认 8192）与当前模型输出上限的较大值。每次求解请求在发送前检查完整消息、动态指令和工具 schema 是否落在窗口减预留以内。估算按 ASCII 约 3 字节/token、非 ASCII 约 2 token/字符及媒体代理成本计算；已结算完整输入用量（含缓存）加 10% 余量校准追加历史，压缩后重置。估计不等于供应商 tokenizer 精确计数。

`context.target_tokens=0` 自动选择可用输入窗口的 60%；正数必须小于输入上限。`context.recent_tokens` 默认 8192。Core 按完整组压缩，保留工具/结果配对及未确认副作用。原文保留优先首个任务与最近修订，预算为 min(8192, 输入窗口 / 4) 个估算 token；证据另有同等预算。旧原文仍在磁盘，可通过 `read_history` 查回。摘要只是可出错的历史证据。摘要请求也先预检；过大证据会显式标记省略并缩短。不可缩减的求解请求报 `LLM_CONTEXT_WINDOW_EXCEEDED`。自动模式下，提供方在任何输出/工具调用之前返回明确的上下文溢出错误时，最多压缩恢复一次，仍受 Goal 计量约束；不重放工具副作用。

`context.mode` 可为 `auto`（默认）、`manual`（仅显式压缩）或 `disabled`（自动/手动均关闭）。后两者在请求超限时停止。Schema 1 与旧 `[limits]` 显式值仍可使用：`context_compaction_enabled=false` 对应 disabled；`context_window_bytes` 与 `context_recent_bytes` 作为旧字节保护选项保留，默认均为 0。旧 `context_window_tokens=0` 只关闭全局 token 兜底，模型窗口优先。不要同时配置新旧别名，或同时配置旧压缩开关与 `context.mode`，冲突会拒绝。关闭委派可设置资源中的子任务数/深度为 0；显式开启研究扩展时需要非零子任务限额。

网络 watchdog 默认启用，网络错误没有重试次数上限。设置 `AREAL_HARNESS_WATCHDOG_DISABLE=1` 关闭，删除该变量或设为 `0` 恢复默认；也接受 `true`/`false`，对应 TOML `limits.watchdog_disable`。环境变量覆盖 TOML。watchdog 覆盖连接/传输失败、请求与流空闲超时、提前断流、HTTP 408/429/5xx，以及 SSE 明确报告的限流/服务不可用。求解、子 Agent 与上下文摘要采用同一策略，250 ms 指数退避、最长 30 秒；取消、显式 Goal/研究 worker 时间预算及显式 Workgroup 实际请求预算仍有效。401/403、无效请求、额度不足、长度上限和空回复不进入无限重试。

Goal 的共享预算与未知用量约束优先于重试配置。Goal 请求禁用 HTTP 内部重试；失败或超时产生未知消费时保留预算预留并停止自动推进，watchdog 与有限重试额度均不能绕过此限制。

`limits.max_completion_retries` 默认为 0、范围 0–8，是每 Turn 的有限未完成响应恢复额度，与 HTTP `max_retries` 和网络 watchdog 分开；关闭 watchdog 不关闭已有的有限重试。恢复条件与审计见 [Core API](../api/core.md#recovery)。HTTPS 使用公开根证书和宿主系统信任库；私有 CA 应安装到信任库。工具调用仅来自协议结构化字段，正文中的 XML/JSON 不作为调用执行。

`resources.max_tool_buffer_bytes` 默认 4 MiB，约束每个响应缓冲的工具 id、name、arguments；单调用参数仍最多 64 KiB。`resources.max_response_tool_calls` 默认 128，有效值取该保护与显式 Turn 剩余调用预算的较小者。`resources.max_response_bytes` 默认 4 MiB，约束单响应的文本、推理、provider context 和模型二进制输出。这些保护独立于累计执行预算。Chat/Responses 共用工具缓冲检查，重复的 Responses 终态条目不重复计数。新增环境变量后缀为 `MAX_RESPONSE_TOOL_CALLS`、`MAX_RESPONSE_BYTES`、`CONTEXT_MODE`、`CONTEXT_RECENT_TOKENS`、`CONTEXT_TARGET_TOKENS`、`MODEL_CONTEXT_WINDOW_TOKENS`；旧环境变量保留。

`[budget]` 中 `max_tool_calls`、`max_output_bytes`、`max_history_bytes` 默认 0（无限）；正数分别显式限制每 Turn 调用数/累计输出和每 Thread 存储历史，压缩不会重置这些预算。历史计入热快照和引用的冷分段。旧配置中的显式有限值保持原意，两个 schema 版本中省略字段均采用新的无限默认。资源容量仍需正数，子任务数/深度可为 0。`max_threads=20000` 是部署会话容量，不是单会话长度预算。空闲超时用于检测停滞请求，不是整个任务的运行时长。`[network] retry_mode` 默认 persistent，也可为 bounded（对应关闭旧 watchdog）。`config show` 展示新分组并保留旧 `limits` 诊断对象；来源键仍使用归一化的旧名称。

| 环境变量（前缀 `AREAL_HARNESS_`） | 对应配置 |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | 模型名称、provider、完整 URL、协议与凭据引用 |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | 模型参数 |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | 采样参数 |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_COMPACTION_ENABLED` | 可选上下文 token 预算与压缩开关 |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | server、扩展文件与日志 |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | 并发与任务容量 |
| `STREAM_IDLE_TIMEOUT_SECONDS` | 时限 |
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

桌面运行时 provider 目录使用 `areal/provider/*` 和 `AREAL_CREDENTIAL_<ref>`；只支持 chatCompletions/responses。TOML 中的供应商在启动时装配，运行时目录是执行投影；配置管理的 ID 拒绝 upsert/remove。`--desktop-config` 装配版本化 Profile/Skill/Workflow；使用 `--agent code-agent@v2` 启动 TUI、headless 或 `exec` 时选择 Profile，Profile 绑定的 Workflow 会随 Thread 自动启动，不再额外传 Workflow 参数。会话显式配置按 revision 更新，见[桌面契约](../api/desktop.md)。

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

### GUI 与 CLI 共享模型目录

`areal config models read [--config /absolute/config.toml]` 输出 JSON：`path`、文件内容 revision、`data`（供应商目录）、`defaultModel`（文件值）、`credentialStates`（供应商 ID 到凭据状态的映射）、`credentialSources`（凭据来源）和 `effective`（经过 CLI／环境覆盖的诊断，含 sources）。读取不创建文件、缺少密钥不阻止管理读取。`credentialStates` 使用 `notRequired`、`available`、`unavailable`，由 Core 按当前可信环境和解析后的凭据引用判断；不包含密钥，不影响文件 revision，也不代表远端认证或推理已通过。`areal config models write` 从 stdin 接收 `{ "expectedRevision": "...", "data": [...], "defaultModel": { "providerId": "local", "modelId": "one" } }`；传 `null` 清除默认值。接口完整替换模型目录，保留其他配置和注释，输出新快照。两个入口必须使用同一文件才共享；环境覆盖不会写回文件。

`credentialSources` 使用 `none`（无需认证）、`environment`（环境变量凭据）、`stored`（已保存凭据）。可信适配器调用 read/write 时可重复传 `--stored-credential-env NAME`，声明由安全存储注入的环境变量名；Core 根据实际解析的引用判定来源，并独立校验该值是否就绪。此来源信息不持久化、不改变 revision、不使缺少值的引用变为可用。独立 CLI 不传此参数，其凭据来源为环境变量。GUI 的“认证方式”可选择“无需认证”：保存时通过 Core 移除该供应商的 `api_key_env`，应用后新模型选择不发送认证头；旧任务仍保留原凭据引用。API Key 输入留空保留已有引用；没有引用和新密钥时不能保存为 API Key 模式。GUI 不读取终端启动脚本，环境凭据按应用／后台启动时的环境提供。

```toml
schema_version = 1
[model]
catalog_version = 1
provider = "local"
name = "one"
[model.providers.local]
name = "Local model service"
endpoint = "http://127.0.0.1:8000/v1/chat/completions"
protocol = "chat-completions"
enabled = true
api_key_env = "LOCAL_MODEL_KEY"
parameters = { temperature = 0.2 }
models = [
  { id = "one", display_name = "Primary", enabled = true, parameters = { reasoning_effort = "low" } },
  { id = "two", enabled = false, parameters = {} },
]
```

JSON 使用 camelCase（`apiKeyEnv`、`displayName`、`maxOutputTokens`、`reasoningEffort`），协议仍为 `chat-completions` / `responses`。最多 32 个供应商，每个最多 64 个模型。供应商与模型都支持启停、名称和参数；参数按显式会话、模型、供应商默认值叠加。全局 TOML／环境／CLI 参数仍遵循原优先级。文件默认引用必须指向启用的供应商与模型。旧单模型 TOML 无需立即改写，选中的名称作为目录项；首次共享保存会添加 `catalog_version = 1`。仅含原有字段的旧供应商表可以省略 endpoint，由环境变量或 CLI 补齐，仍遵循 CLI > 环境变量 > 文件的优先级。共享目录读写要求供应商在文件中提供完整 endpoint；未补齐时读取明确失败，不丢弃供应商，也不将临时覆盖写回文件。

普通配置只保存密钥环境变量名。共享接口拒绝带查询参数的 endpoint，避免把 URL 中的认证信息送入 GUI；旧配置诊断仍脱敏查询参数。桌面安全存储不向独立 CLI 暴露，CLI 自行提供引用变量。`areal_openai` 为桌面动态账号目录保留，允许作为默认引用，禁止写为静态供应商；独立 CLI 缺少账号传输端点时明确失败。

写入先校验、检查整个文件 revision，再使用同目录临时文件、fsync 和原子替换；合作写入者通过锁串行，过期请求失败。默认缺失文件可以首次创建，显式缺失文件和写入符号链接拒绝。非合作编辑器不参与锁，多次摘要校验不等于文件系统原子 CAS。

共享目录采用保存／应用分离：`catalog_version = 1` 的模型变更显示 restartRequired，由客户端在安全空闲时重启；未启动实例下次加载。运行中的模型及已有任务不被保存动作修改，新默认值仅用于应用后创建的任务。历史任务保留原配置和凭据引用，轮换时需继续提供旧引用所需的环境凭据。

GUI 设置页分别显示 Core 已保存的启用状态、凭据来源与就绪状态、配置应用状态；未保存的开关或密钥输入保留为草稿。桌面适配器把安全存储中的凭据提供给 Core 诊断，Renderer 只接收状态。当前文件 revision 与项目已加载 revision 不一致时显示“待应用”；安全应用成功后刷新项目的 Core 模型目录。停用的供应商或模型不进入 Composer 的执行目录，启用但缺少凭据的模型仍显示名称与原因。GUI 数据目录隔离意味着共享配置中的凭据引用可能在另一个 GUI 实例中不可用，状态按当前实例诊断。

## 模型配置热更新

共享 TUI/Web 服务每秒读取选定 TOML，连续两次读到同一有效配置后应用。默认模型、端点、协议、凭据引用和采样/推理参数变更用于后续新提交；显式 CLI/环境覆盖仍有更高优先级。非法编辑保留旧配置，TUI/Web 显示错误。独占 launcher 和独立 Core 仍只读取启动配置。

活动 Turn、其子任务、摘要和已入队请求保持原模型版本；会话显式选择的模型保持不变。Goal 自动续轮在下次提交边界使用当时的默认值。默认模型版本保存在私有 `dataDir/desktop/default-models.json` 中，供队列跨重启恢复，最多 128 个版本、1 MiB；不保存环境凭据值。退役凭据缺失时拒绝对应队列项执行，不替换成其他模型。迁移历史时需同时保留此文件。

其他配置需要重启。TUI 等待 Turn、Goal、队列和资源结算后重启；`areal service ensure` 也会为空闲服务应用 TOML 或二进制更新。权限/部署变化和模型 CLI/环境覆盖变化需带目标参数执行 `areal service restart`。模型文件变更在 3 秒内未完成热更新时，共享入口会尝试空闲安全重启；解析、归档或持久化错误保留旧服务并报告具体原因。若新凭据引用不在旧服务环境中，服务同时报告错误和 `restartRequired=true`；在持有新凭据的终端重新打开 TUI/Web 或执行 `areal service ensure`，客户端先校验配置和凭据，再自动安全重启。忙碌时拒绝本次应用，工作结算后重试。新终端环境变量不能直接更新现有进程；仅修改同名凭据的值或代理环境、不改变模型配置时仍需显式重启。默认重启拒绝忙碌服务；`--cancel` 才显式取消并结算工作。

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
max_turns = 0
max_active_seconds = 0
max_unreported_turns = 3
turn_model_rounds = 0
```

示例数字为默认值。`max_turns`、`max_active_seconds`、`turn_model_rounds` 的 0 表示无部署上限；正数分别接受 1–86400、1–86400、2–1024。显式请求/会话限制仍生效，并与正数部署上限取交集。未设置的 Goal token/轮次/时间预算保持无限。GUI 用 inferLimits 请求模型解释目标中的显式限制；需允许 goal_set_limits，有轮次限制时至少三轮。有上限的根 Turn 至少两轮，最后一轮禁用工具以交接。`max_unreported_turns` 仍默认 3（1–86400），属于进度完整性保护：连续根 Turn 未提交 goal_update 时暂停为 progressUnreported。

活动时间包括根 Turn 的模型排队、执行、工具、交互等待和清理，子任务时间不叠加，轮次间容量等待、暂停和离线时间不计入。显式研究 worker 预算和 Runtime 硬限额继续生效；普通 Turn 没有总时限。Goal 请求禁用 HTTP 层隐式重试，以保留逐次消费的归因；未知消费会停止自动推进。使用与恢复见 [Goal 模式](clients.md#goals)。

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

自动压缩使用上述有效模型 token 窗口与输出预留。已完成的历史前缀保存为不可变 SHA-256 分段，当前快照保留近期条目与 checkpoint。自动模式下，热历史原始数据超过 max(1 MiB, 8 × 窗口 token 数) 也触发滚动；只有存储压力时使用有界的已记录证据。原文保留使磁盘用量持续增长，仍受可用磁盘和单记录保护约束。兼容的完整历史读取会物化全部请求历史；有界回取使用分页 `read_history`。压缩会重建缓存前缀，应同时观察未缓存输入与任务正确性。

## 缓存诊断

使用 `python3 scripts/cache-report.py /absolute/Core-state --output cache-report.json` 汇总 `model-requests` 和 `model-requests-child`。报告按线程、协议、模型参数及请求用途比较 wire 消息块，展示完整前缀保留、工具定义变化、输入/缓存/未缓存 token 和未返回用量的请求。`usageDetails.cachedInputTokens=null` 或旧审计缺少该字段时计为未知，不补零；网络失败的未知用量不计入命中率分母。报告的字节前缀不等于供应商 tokenizer 前缀，不能证明缓存驻留。新审计在供应商返回规范 ID 时记录 `usageDetails.providerResponseId`，并记录显式返回的 `cacheWriteTokens`；它们用于关联上游日志，不推断缺失的后端路由。缓存百分比必须同时结合成功率、总输入与未缓存输入评估，不能通过填充历史或删除必要 reasoning 提升比例。

审计另外记录首次响应字节、首个非空正文 delta、首个非空思考 delta 的毫秒耗时（仅发生时才有字段）。三者口径不同，不以总请求 duration 代替首 token 延迟；加密 reasoning 无可见 delta 时保持未知。

HTTP 审计在响应返回规范、长度受限的关联 ID 时保留 `httpRequestId`（x-request-id）和 `gatewayTraceId`（x-cpa-trace-id），用于关联供应商/网关日志。不收集认证头、cookie 或粘性路由 token，也不将 trace ID 推断为后端实例。

## Responses 增量传输（实验）

`[model] responses_websocket = true` 或 `AREAL_HARNESS_RESPONSES_WEBSOCKET=true` 显式启用；默认 false，仅适用于 `protocol="responses"`。endpoint 仍填写完整 HTTP(S) Responses 地址，连接时映射到 WS(S)。服务需支持 Responses WebSocket beta 协议；此路径直接连接，不使用 HTTP 代理环境变量，也不自动降级 HTTP。

连接按模型实例、Thread 和 Turn 隔离。只有前一响应完整结束并返回完整 output 数组、非 input 参数完全一致、当前输入严格扩展前次输入与输出时，才携带 previous_response_id 发送增量；否则关闭旧连接，在新连接发送完整输入。新 Turn、凭据/模型实例变更、取消、失败、连接断开不会沿用旧续接状态。发送后失败不在传输层自动重放；Goal 用量与 Engine 重试规则继续有效。最多保留 16 个空闲会话、32 MiB 请求/输出引用，120 秒空闲后清理；长工具任务可能需要重新建立完整上下文。连接中断后已执行的工具不能自动重跑。

审计中的 body/messageBlocks 表示完整逻辑输入，transport=responses-websocket、incremental、wireInputItems 和 wireBodyBytes 表示实际传输。减少传输字节不等于减少供应商计费输入或保证 KV 命中；请同时观察缓存、延迟、失败与任务结果。摘要使用独立连接，不污染同 Turn 的求解连接。

WebSocket 求解连接携带 Core 线程 ID 作为 session-id/thread-id，以便兼容网关维持会话亲和；这不表示供应商一定采用该路由提示，也不保证跨连接缓存保留。摘要与未绑定线程的直接调用不携带求解身份。

模型配置登记表保留与 revision 绑定的原始编码；新增可选默认值不会使历史 revision 失效，也不重写排队 Turn 的引用，摘要不匹配仍拒绝篡改。不要手动格式化或编辑 Core 所有的 `desktop/default-models.json`。
