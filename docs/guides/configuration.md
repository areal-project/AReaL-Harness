**中文** | [English](configuration.en.md)

# 配置

`core/config` 统一解析启动配置，由 server 注入各组件；不通过用户配置扩大 Runtime 授权。完整示例见 [config.toml](../../core/config/examples/config.toml)，字段类型见[配置源码](../../core/config/src/lib.rs)。

## 文件与优先级

`显式 CLI > 已登记环境变量 > 选定 TOML > 默认值`。默认配置为 `~/.areal-harness/config.toml`，数据为同目录 `state/`。`AREAL_HARNESS_HOME` 指定非空绝对 home；`--config` 优先于 `AREAL_HARNESS_CONFIG`，替代默认文件，不叠加。不自动读取项目 TOML 或 `.env`。

默认文件不存在可继续；显式文件不存在、未知字段、类型/版本错误或已设置为空的值均拒绝。文件限普通 UTF-8、1 MiB，必须声明 `schema_version=1`。TOML 相对路径以配置文件目录为基准，CLI/env 相对路径以启动 cwd 为基准，不展开 `~`、变量或 glob。即使字段被高层覆盖，低层格式错误仍拒绝。

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
context_window_bytes = 196608
context_recent_bytes = 65536
context_window_tokens = 0
context_output_reserve_tokens = 0
max_completion_retries = 0
[logging]
filter = "info"
```

endpoint 是完整 HTTP(S) 请求 URL；Core 只支持 `chat-completions` / `responses`，不自动补路径。配置只写密钥变量名；显式引用必须非空且可用于 HTTP header，未选中 provider 不要求密钥。省略引用为匿名，不从其他应用读取凭据。

`reasoning_effort` 可为 none/minimal/low/medium/high/xhigh，供应商需支持；可选 `max_output_tokens` 映射到协议对应字段。`max_retries` 为 0–8，只重试接受流之前的连接错误和 HTTP 408/429/500/502/503/504；已消费流或工具不重放。

可选采样参数不配置时省略，显式 0 保留。`temperature` 为有限数 [0,2]，`top_p` / `min_p` 为 [0,1]，`top_k` 为正整数或 -1，`presence_penalty` 为 [-2,2]，`repetition_penalty` 大于 0。Chat 与 Responses 均接受 temperature/top_p；其余四项只支持 Chat，Responses 配置时拒绝。参数发送不证明供应商实际采纳。求解与摘要使用同一采样/推理配置；摘要禁用工具，输出上限为 `min(max_output_tokens,16384)`，未配置时为 16384。

`context_window_tokens=0` 禁用 token 估计，最大 2000000；启用时 reserve 必须小于 window。历史、system 与工具定义的估计达到 window 减 reserve，或字节阈值时触发压缩。估计按 ASCII 约 3 字节/token、非 ASCII 约 2 token/字符及媒体代理成本计算，可由上次输入用量向上校准；缓存命中不降低估计，不保证匹配供应商 tokenizer。

`limits.max_completion_retries` 默认为 0、范围 0–8，是每 Turn 的未完成响应恢复额度，与 HTTP `max_retries` 分开。恢复条件与审计见 [Core API](../api/core.md#recovery)。HTTPS 使用公开根证书和宿主系统信任库；私有 CA 应安装到信任库。工具调用仅来自协议结构化字段，正文中的 XML/JSON 不作为调用执行。

字节与容量限额为正整数；扇出和深度可为 0 以禁用委派。output 小于 history，recent 小于 context window，时限为 1–86400 秒。上下文字节是估计值，不是 tokenizer 窗口。活动任务、模型请求和 Runtime 资源分别计数。

| 环境变量（前缀 `AREAL_HARNESS_`） | 对应配置 |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | 模型名称、provider、完整 URL、协议与凭据引用 |
| `REASONING_EFFORT`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | 模型参数 |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | 采样参数 |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS` | 可选上下文 token 预算 |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | server、扩展文件与日志 |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | 并发与任务容量 |
| `TURN_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | 时限 |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | 历史、工具与上下文预算 |

未知 `AREAL_HARNESS_*` 报错。旧 `AREAL_MODEL*` 与 `RUST_LOG` 为低优先级兼容别名。无 provider 文件记录的旧模型入口可使用可选 `AREAL_API_KEY`；显式文件 provider 不隐式继承它。

## 诊断与运行时目录

```sh
target/debug/areal-server config validate --config /absolute/config.toml
target/debug/areal-server config show --sources --config /absolute/config.toml
```

诊断不监听、不创建数据、不启动 Runtime/MCP/插件，也不探测模型；输出有效值和来源并脱敏。配置文件不热重载，启动凭据不进入 Runtime 环境。`OTEL_*` 由 server 的 telemetry 装配处理。

桌面运行时 provider 目录使用 `areal/provider/*` 和 `AREAL_CREDENTIAL_<ref>`；只支持 chatCompletions/responses。`--desktop-config` 装配版本化 Profile/Skill/Workflow；会话配置可在空闲边界通过 CAS 更新并冻结到新 Turn/队列，见[桌面契约](../api/desktop.md)。这与启动 TOML 不热重载是不同机制。

<a id="tui"></a>
## TUI 偏好

`${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`，可用 `--tui-config` / `AREAL_TUI_CONFIG` 替代。字段为 `theme=dark|light|terminal`、`color=auto|always|never`、`no_logo=false`、`ascii=false`。优先级 CLI > `AREAL_TUI_*` > 文件 > 默认；非空 `NO_COLOR` 强制关闭颜色。`--prompt` 不读此文件。

Skill 自动发现见[Skill](skills.md)，工具配置见[工具](tools.md)，部署权限见[Runtime](runtime.md)。
