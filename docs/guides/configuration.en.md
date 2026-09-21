[中文](configuration.md) | **English**

# Configuration

`core/config` resolves startup settings and server injects them into components. User configuration cannot expand Runtime grants. See the [complete example](../../core/config/examples/config.toml) and [configuration source](../../core/config/src/lib.rs).

## Files and precedence

`Explicit CLI > registered environment > selected TOML > defaults`. Default configuration is `~/.areal-harness/config.toml`, with data in its sibling `state/`. `AREAL_HARNESS_HOME` selects a nonempty absolute home. `--config` takes precedence over `AREAL_HARNESS_CONFIG` and replaces, rather than overlays, the default file. Project TOML and `.env` are not discovered automatically.

A missing default file is allowed. A missing explicit file, unknown field, type/version error or explicitly empty value is rejected. Files must be regular UTF-8, at most 1 MiB, with `schema_version=1`. TOML paths resolve against its directory; CLI/env paths resolve against startup cwd. There is no tilde, variable or glob expansion. Malformed lower-priority inputs are rejected even when overridden.

## Models and limits

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

The endpoint is a complete HTTP(S) request URL. Core supports only `chat-completions` / `responses` and appends no path. Configuration stores credential variable names; explicit references must resolve to nonempty HTTP-header-compatible values. Unselected providers need no key. Omitted references mean anonymous access; other applications' credentials are not read.

`reasoning_effort` accepts none/minimal/low/medium/high/xhigh when supported upstream. Optional `max_output_tokens` maps to the protocol-specific field. `max_retries` is 0–8 and retries only connection errors and HTTP 408/429/500/502/503/504 before accepting a stream. Consumed streams and tools are not replayed.

Optional sampling fields are omitted when unset and preserve explicit zero. `temperature` is finite [0,2], `top_p` / `min_p` are [0,1], `top_k` is a positive integer or -1, `presence_penalty` is [-2,2], and `repetition_penalty` is positive. Both protocols accept temperature/top_p; the other four are Chat-only and rejected for Responses. Sending a parameter does not prove provider support. Solve and summary requests share sampling/reasoning settings; summaries disable tools and cap output at `min(max_output_tokens,16384)`, or 16384 when unset.

`context_window_tokens=0` disables token estimation; its maximum is 2000000. When enabled, reserve must be below window. Estimated history, system and tool definitions trigger compaction at window minus reserve, or at the byte threshold. Estimates use roughly 3 ASCII bytes/token, 2 tokens/non-ASCII character and media proxies, and may be calibrated upward from prior input usage. Cache hits do not reduce estimates; these are not exact provider tokenizer counts.

`limits.max_completion_retries` defaults to 0, accepts 0–8, and budgets incomplete-response recovery per Turn separately from HTTP `max_retries`. See [Core recovery](../api/core.en.md#recovery). HTTPS uses public roots and the host trust store; install private CAs there. Tools execute only from structured protocol fields, never from XML/JSON in response text.

Byte and capacity limits are positive integers; fan-out and depth may be 0 to disable delegation. Output must be smaller than history, recent context smaller than the context window, and deadlines 1–86400 seconds. Context bytes are estimates rather than tokenizer windows. Active tasks, model requests and Runtime resources are counted separately.

| Environment suffix (prefix `AREAL_HARNESS_`) | Configuration |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | Model name, provider, complete URL, protocol and credential reference |
| `REASONING_EFFORT`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | Model parameters |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | Sampling parameters |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS` | Optional context token budget |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | Server, extensions file and logging |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | Concurrency and task capacity |
| `TURN_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | Deadlines |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | History, tools and context budgets |

Unknown `AREAL_HARNESS_*` names are errors. Legacy `AREAL_MODEL*` and `RUST_LOG` are lower-priority aliases. Legacy model entry points without a provider file record may use optional `AREAL_API_KEY`; explicit file providers do not inherit it implicitly.

## Diagnostics and runtime catalogs

```sh
target/debug/areal-server config validate --config /absolute/config.toml
target/debug/areal-server config show --sources --config /absolute/config.toml
```

Diagnostics do not listen, create data, start Runtime/MCP/plugins or probe models. They report redacted values and sources. Files are not hot-reloaded; startup credentials are not forwarded to Runtime. Server telemetry handles `OTEL_*` separately.

The desktop runtime provider catalog uses `areal/provider/*` and `AREAL_CREDENTIAL_<ref>`, supporting chatCompletions/responses only. `--desktop-config` installs versioned Profiles/Skills/Workflows. Session settings can change through CAS at idle boundaries and are frozen into new Turns/queue items; see the [desktop contract](../api/desktop.en.md). This is separate from startup TOML loading.

<a id="tui"></a>
## TUI preferences

Use `${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`, overridden by `--tui-config` / `AREAL_TUI_CONFIG`. Fields are `theme=dark|light|terminal`, `color=auto|always|never`, `no_logo=false` and `ascii=false`. Precedence is CLI > `AREAL_TUI_*` > file > defaults. Nonempty `NO_COLOR` disables color. `--prompt` skips this file.

See [Skills](skills.en.md) for discovery, [tools](tools.en.md) for extensions and [Runtime](runtime.en.md) for deployment permissions.
