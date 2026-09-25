[中文](configuration.md) | **English**

# Configuration

`core/config` resolves startup settings and server injects them into components. Approval policy and Runtime execution boundaries are separate; local product launch defaults to YOLO. See the [complete example](../../core/config/examples/config.toml) and [configuration source](../../core/config/src/lib.rs).

## Files and precedence

`Explicit CLI > registered environment > selected TOML > defaults`. Default configuration is `~/.areal/config.toml`, with data in its sibling `state/`. `AREAL_HARNESS_HOME` selects a nonempty absolute home. `--config` takes precedence over `AREAL_HARNESS_CONFIG` and replaces, rather than overlays, the default file. Project TOML and `.env` are not discovered automatically.

Shared TUI/Web entry points use a workspace-specific default data directory; explicit dataDir configuration retains the precedence above. See [local services](../api/local-service.en.md) for migration and compatibility.

A missing default file is allowed. A missing explicit file, unknown field, type/version error or explicitly empty value is rejected. Files must be regular UTF-8, at most 1 MiB, with `schema_version=1`. TOML paths resolve against its directory; CLI/env paths resolve against startup cwd. There is no tilde, variable or glob expansion. Malformed lower-priority inputs are rejected even when overridden.

<a id="permissions"></a>
## Permission modes

Local TUI, Web, CLI and `scripts/launch.py` default to **YOLO**: ordinary tasks may read/write files accessible to the current OS user, including outside the workspace and `/tmp`, and commands may use networking without per-call approval. `--allow-write` / `--allow-network` are no longer required. OS permissions, explicit Profiles, read-only Turns, deny rules and restricted Runtime deployments still apply.

Global `~/.areal/config.toml`:

```toml
schema_version = 1
[permissions]
mode = "ASK_PERMISSIONS"
# Match tool IDs with * wildcards, not shell command patterns.
# deny = ["mcp__untrusted__*"]
# ask = ["run_command"]
# allow = ["read_file"]
```

For an existing file, add only `[permissions]` without duplicating `schema_version`. Omit the table or set `mode = "YOLO"` to restore the default. Environment and launch overrides:

```sh
ASK_PERMISSIONS=1 make tui
AREAL_HARNESS_PERMISSION_MODE=ASK_PERMISSIONS target/debug/areal web
make tui ARGS='--permissions ASK_PERMISSIONS'
```

Precedence: `--permissions` > `AREAL_HARNESS_PERMISSION_MODE` > `ASK_PERMISSIONS` > TOML > YOLO. `ASK_PERMISSIONS` accepts `1/true` for asking and `0/false` for YOLO. The service fixes permissions at startup. For an existing shared service, explicitly run `ASK_PERMISSIONS=1 target/debug/areal service restart`, retaining original custom deployment arguments. Restart refuses busy services by default. `--endpoint` uses the remote service policy.

ASK_PERMISSIONS automatically allows built-in workspace/scratch reads, searches and internal state operations. Commands, file changes, outside-workspace reads and external tools request approval. This is tool-call approval, not shell static analysis: approving a command permits its child operations within the current Scope. TUI dialogs and Web panels offer deny, allow once, and remember the exact request for this session/project. Mandatory approvals and MCP tools without verifiable connection generations accept single-use answers only. Command-prefix rules and per-domain network approval are not provided.

Precedence is `deny > ask > allow > mode`. Each array permits at most 128 tool-ID globs of 128 bytes each. Explicit ask and Profile/client mandatory approvals cannot be bypassed by remembered grants; allow cannot bypass a read-only Scope. Answers bind the effective-argument digest. Cancelled, expired, duplicate or mismatched answers do not execute tools.

Memory binds the tool, normalized arguments, Host generation, workspace and permission boundaries; changed commands or policy ask again. Session memory persists with its Thread. Project memory lives in the deployment's `dataDir/desktop/permissions.json`; separate data directories do not share grants. Each set permits 64 entries/128 KiB. The file contains approved arguments and should be managed with session data. TUI `/permissions` shows mode, source, Runtime grants and memory. `/permissions clear-session` and `/permissions clear-project` prevent future reuse without revoking already accepted effects; the target Thread must be idle.

The launcher creates `scratch/` beside dataDir and sets an individual Thread `TMPDIR`; `--scratch` can select an existing directory. It must not overlap workspace/dataDir and remains until deployment data is manually cleaned. Read-only/research tasks may still write their own scratch. Direct Core embedding and standalone Runtime daemon defaults remain restricted. An explicit launcher `--sandbox-profile native` retains the previous write/network switches; see [Runtime deployment](runtime.en.md).

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

The endpoint is a complete HTTP(S) request URL. Core supports only `chat-completions` / `responses` and appends no path. Configuration stores credential variable names; for normal startup, explicit references must resolve to nonempty HTTP-header-compatible values. Unselected providers need no key. Omitted references mean anonymous access; other applications' credentials are not read. `--management` permits a temporarily unavailable credential for the selected model so management and Workspace can start. Requests to that model fail explicitly with `MODEL_CREDENTIAL_UNAVAILABLE`; Core does not send them anonymously or select another model. The model name, endpoint and protocol must still be valid. Restart the service after setting the credential.

Typical endpoints are `https://model.example.com/v1/chat/completions` for Chat Completions and `https://model.example.com/v1/responses` for Responses; use the provider's actual API URL. A URL ending at `/v1` may return an HTML page with HTTP 200, triggering `model response must use text/event-stream`. Goal mode also reports `GOAL_USAGE_UNKNOWN` for the unconfirmed usage while preserving the original error. After changing startup configuration, [stop and restart the shared service](../api/local-service.en.md#public-entry-points); reopening only the client does not reload configuration.

`reasoning_effort` accepts none/minimal/low/medium/high/xhigh when supported upstream. Optional `max_output_tokens` maps to the protocol-specific field. `max_retries` is 0–8 and controls bounded HTTP retries before stream acceptance for transport failures, HTTP 408/429 and all 5xx statuses. After that allowance is exhausted, the default Core watchdog continues network recovery.

Optional `model.reasoning_summary = "auto"` (also `concise` / `detailed`) is Responses-only and maps to `reasoning.summary`. Its environment variable is `AREAL_HARNESS_REASONING_SUMMARY`. It is omitted by default; no summary parameter is added to Chat Completions or models that have not opted in. The endpoint/model must support the selected summary mode; providers determine whether a summary is returned, so reasoning text is not guaranteed.

Optional sampling fields are omitted when unset and preserve explicit zero. `temperature` is finite [0,2], `top_p` / `min_p` are [0,1], `top_k` is a positive integer or -1, `presence_penalty` is [-2,2], and `repetition_penalty` is positive. Both protocols accept temperature/top_p; the other four are Chat-only and rejected for Responses. Sending a parameter does not prove provider support. Solve and summary requests share sampling/reasoning settings; summaries disable tools and cap output at `min(max_output_tokens,16384)`, or 16384 when unset.

`context_window_tokens=0` disables token estimation; its maximum is 2000000. When enabled, reserve must be below window. Estimated history, system and tool definitions trigger compaction at window minus reserve, or at the byte threshold. Estimates use roughly 3 ASCII bytes/token, 2 tokens/non-ASCII character and media proxies, and may be calibrated upward from prior input usage. Cache hits do not reduce estimates; these are not exact provider tokenizer counts.

`limits.context_compaction_enabled=false` disables automatic and manual compaction (true by default). When `context_window_bytes` is exceeded or an enabled token threshold is reached, the Turn fails with a context limit error without sending another solve or summary request; original history remains intact. These estimates are not the provider's actual context limit. To also disable Agent delegation and Workgroup child tasks, set `max_children_per_turn=0` and `max_agent_depth=0`. An explicitly enabled native research Agent extension requires nonzero child limits and rejects this combination at startup.

The network watchdog is enabled by default with no retry count limit. Set `AREAL_HARNESS_WATCHDOG_DISABLE=1` to disable it; remove the variable or set it to `0` to restore the default. It also accepts `true`/`false`, mapping to TOML `limits.watchdog_disable`; the environment overrides TOML. It covers connection/transport failures, request and stream idle timeouts, premature EOF, HTTP 408/429/5xx and explicit SSE rate-limit/service-availability errors. Solve, child Agent and context-summary requests use the same policy, with exponential backoff from 250 ms capped at 30 seconds. Cancellation, Turn deadlines and explicit Workgroup physical-request budgets remain effective. Authentication, invalid requests, insufficient quota, output length limits and empty answers do not receive unlimited retries.

Goal shared-budget and unknown-usage constraints take precedence over retry settings. Goal requests disable internal HTTP retries; failures or timeouts with unknown usage retain their reservation and stop automatic progress. Neither the watchdog nor finite retry allowances bypass this constraint.

`limits.max_completion_retries` defaults to 0, accepts 0–8, and budgets bounded incomplete-response recovery per Turn separately from HTTP `max_retries` and the network watchdog. Disabling the watchdog preserves existing finite retry allowances. See [Core recovery](../api/core.en.md#recovery). HTTPS uses public roots and the host trust store; install private CAs there. Tools execute only from structured protocol fields, never from XML/JSON in response text.

`limits.max_tool_buffer_bytes` defaults to 4194304 (4 MiB) and must be positive. It bounds the UTF-8 bytes of all buffered tool IDs, names and arguments per response; it excludes reasoning and separate audio/video/image blobs, while media strings embedded in arguments still count as UTF-8 bytes. This is not a process memory limit. It is independent of Turn `max_output_bytes` and history budgets: raising it does not increase execution or persistence allowances. Chat Completions and Responses share this budget; repeated Responses terminal items are not charged twice. Each call still permits at most 64 KiB of arguments. Call count uses the remaining Turn `max_tool_calls` allowance, replacing the fixed 16-call response cap. The environment variable is `AREAL_HARNESS_MAX_TOOL_BUFFER_BYTES`.

Byte and capacity limits are positive integers; fan-out and depth may be 0 to disable delegation. Output must be smaller than history, recent context smaller than the context window, and deadlines 1–86400 seconds. Context bytes are estimates rather than tokenizer windows. Active tasks, model requests and Runtime resources are counted separately.

| Environment suffix (prefix `AREAL_HARNESS_`) | Configuration |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | Model name, provider, complete URL, protocol and credential reference |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | Model parameters |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | Sampling parameters |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_COMPACTION_ENABLED` | Optional context token budget and compaction switch |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | Server, extensions file and logging |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | Concurrency and task capacity |
| `TURN_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | Deadlines |
| `WATCHDOG_DISABLE` | `limits.watchdog_disable`; `1` disables, default `0` |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `MAX_TOOL_BUFFER_BYTES`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | History, tools and context budgets |

Unknown `AREAL_HARNESS_*` names are errors. Legacy `AREAL_MODEL*` and `RUST_LOG` are lower-priority aliases. Legacy model entry points without a provider file record may use optional `AREAL_API_KEY`; explicit file providers do not inherit it implicitly.

<a id="proxies"></a>
## Outbound network proxies

Core model requests (including summaries, child Agents and Workgroups), Streamable HTTP MCP and optional OTLP HTTP export support `http://`, `https://`, `socks5://` and `socks5h://` proxies. The proxy scheme is independent of the destination scheme: an HTTPS model endpoint can use HTTP CONNECT or SOCKS. Both HTTPS proxies and HTTPS destinations retain certificate verification; private CAs must be trusted by the corresponding HTTP client's trust store.

Use standard environment variables when starting Core; no duplicate TOML configuration is needed:

| Environment variable | Purpose |
|---|---|
| `HTTP_PROXY` / `http_proxy` | Proxy for HTTP destinations |
| `HTTPS_PROXY` / `https_proxy` | Proxy for HTTPS destinations |
| `ALL_PROXY` / `all_proxy` | Fallback when the destination's protocol has no proxy configured |
| `NO_PROXY` / `no_proxy` | Comma-separated domains, IPs or CIDRs that bypass proxies; `*` bypasses all |

Core HTTP clients prefer uppercase variables, then lowercase. Third-party tools follow their own HTTP libraries; keep both forms consistent. `socks5` resolves destination names locally; `socks5h` resolves through the proxy. HTTP(S) Basic and SOCKS5 username/password authentication can use proxy URL userinfo; these URLs may contain credentials and should not be committed or included in shared diagnostics.

For example, use SOCKS5 with remote DNS while preserving existing bypass entries:

```sh
export ALL_PROXY='socks5h://127.0.0.1:1080'
export all_proxy="$ALL_PROXY"
export NO_PROXY="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost,::1"
export no_proxy="$NO_PROXY"
areal service restart --workspace /absolute/workspace --json
```

Existing `HTTP_PROXY` / `HTTPS_PROXY` and lowercase equivalents override `ALL_PROXY` for their destinations; adjust them too when switching all traffic to SOCKS. Shared services retain their startup environment. Restart explicitly from the updated environment after changing variables; reopening TUI/Web does not update the background process. Pass custom configuration and deployment arguments to restart as described in the [local service contract](../api/local-service.en.md). Local service discovery and login HTTP requests always connect directly to keep loopback authentication out of external proxies.

Trusted stdio MCP servers and plugin Hosts automatically inherit these eight variables, including credentials in proxy URLs; other variables retain their respective allowlists. External tools such as `web_search` must use HTTP libraries that support the selected proxy scheme and environment variables. Core does not intercept their custom sockets or configure a remote MCP server's connection to its search provider. Runtime command environments and network authorization remain separate; proxies do not expand Scope permissions. See [MCP](mcp.en.md) and [plugin boundaries](../design/plugins.en.md).

## Diagnostics and runtime catalogs

```sh
target/debug/areal config validate --config /absolute/config.toml
target/debug/areal config show --sources --config /absolute/config.toml
```

Diagnostics do not listen, create data, start Runtime/MCP/plugins or probe models. They report redacted values and sources. Shared local services reload model configuration as described below; startup credentials are not forwarded to Runtime. Server telemetry handles `OTEL_*` separately.

The desktop runtime provider catalog uses `areal/provider/*` and `AREAL_CREDENTIAL_<ref>`, supporting chatCompletions/responses only. `--desktop-config` installs versioned Profiles/Skills/Workflows. Pass `--agent code-agent@v2` to TUI, headless or `exec` to select a Profile; a Profile-bound Workflow starts with the Thread, so no separate Workflow argument is needed. Session settings can change through CAS at idle boundaries and are frozen into new Turns/queue items; see the [desktop contract](../api/desktop.en.md). Explicit session Providers are managed separately from the TOML default model.

```sh
target/debug/areal --desktop-config deployment.json --agent code-agent@v2
target/debug/areal --desktop-config deployment.json --agent code-agent@v2 --prompt "检查当前改动"
target/debug/areal exec --desktop-config deployment.json --agent code-agent@v2 "运行测试"
```

In `deployment.json`, bind tools and a Workflow to a Profile. The same file can also keep an Agent without a Workflow:

```json
{
  "profiles": [
    {"id":"tool-agent","revision":"v1","displayName":"Tool agent","instructions":"Inspect and report results.","toolAllowlist":["fs_read","run_command"]},
    {"id":"code-agent","revision":"v2","displayName":"Code agent","instructions":"Complete and verify the staged task.","toolAllowlist":["fs_read","run_command","fs_apply_patches"],"workflow":{"id":"code-flow","revision":"v1"}}
  ],
  "workflows": [
    {"id":"code-flow","revision":"v1","displayName":"Code flow","plan":{"objective":"Change and verify code","tasks":[{"id":"implement","instruction":"Modify src/main.rs and run tests","writes":["src/main.rs"],"configuration":{"agentProfile":{"id":"code-agent","revision":"v2"}}}]}}
  ]
}
```

`tool-agent@v1` can use its permitted tools without a Workgroup. `code-agent@v2` needs a trusted `--workgroup-policy` and `--allow-write`; the policy must authorize `src/main.rs` and provide final checks (see the [Workgroup guide](workgroups.en.md)). The bound Profile starts the Workflow plan automatically. A regular Turn from `--prompt` or `exec` is a separate user interaction.

## Model configuration reload

Shared TUI/Web services poll their selected TOML once per second and apply a valid configuration after two identical reads. Changes to the selected default model, endpoint, protocol, credential reference and sampling/reasoning parameters apply to subsequent submissions. Explicit CLI/environment overrides retain precedence. Invalid edits leave the previous configuration active; TUI/Web display the error. Owned launchers and standalone Core retain startup-only configuration.

Active Turns, their children, summaries and queued requests retain their model version. Explicit session model selections are preserved. Goal continuation uses the default applicable at its next submission boundary. Default model revisions are retained in the private `dataDir/desktop/default-models.json` archive for queue recovery across restarts, with at most 128 revisions and 1 MiB; values of environment credentials are never stored. A missing retired credential prevents dispatch of the affected queue item instead of substituting another model. The archive must be kept with the history.

Other configuration changes require restart. TUI waits for Turns, Goals, queues and resources to settle before restarting; `areal service ensure` also restarts idle services for changed TOML settings or binaries. Permission/deployment changes and model CLI/environment override changes require `areal service restart` with the desired options. New terminal environment variables cannot update an existing process: explicitly restart to inherit changed credentials. Default restart refuses busy services; `--cancel` explicitly cancels and settles work.

<a id="tui"></a>
## TUI preferences

Use `${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`, overridden by `--tui-config` / `AREAL_TUI_CONFIG`. Fields are `theme=dark|light|terminal`, `color=auto|always|never`, `no_logo=false`, `ascii=false` and `mouse=true`. Precedence is CLI > `AREAL_TUI_*` > file > defaults. Nonempty `NO_COLOR` disables color. `--prompt` and `--goal` skip this file.

Set `--mouse=false`, `AREAL_TUI_MOUSE=false` or `mouse = false` in this file to disable mouse capture. Mouse capture defaults to enabled; history remains fully operable with the keyboard.

<a id="goals"></a>
## Goal execution policy

Create a Goal explicitly through `/goal <objective>`, the Web panel, `--goal` or the API; no additional toggle is required. The optional TOML below only adjusts execution limits. Omitting the entire `[goals]` table uses defaults.

```toml
[goals]
max_turns = 100
max_active_seconds = 3600
max_unreported_turns = 3
turn_model_rounds = 32
```

The numeric values shown are defaults. The first three numeric fields accept 1–86400; turn_model_rounds accepts 2–1024. Goal maxTurns/maxActiveSeconds can narrow deployment limits; tokenBudget applies only when explicitly set. Root Turns use min(session maxModelRounds, turn_model_rounds), require at least two rounds, and require goal_read/goal_update in any tool allowlist. The final round remains tool-free for handoff. Consecutive root Turns without goal_update pause as progressUnreported at the configured threshold.

Active time includes root-Turn model queuing, execution, tools, interactions and cleanup without adding child durations. Capacity waits between Turns, paused time and offline time are excluded. Existing Turn deadlines and Runtime hard limits still apply. Goal requests disable implicit HTTP retries to preserve per-request accounting; unknown usage stops automatic continuation. See [usage and recovery](clients.en.md#goals).

See [Skills](skills.en.md) for discovery, [tools](tools.en.md) for extensions and [Runtime](runtime.en.md) for deployment permissions.

Tool result views are configured in the JSON file named by `[tools] extensions_file`, under `policy.resultViews`: `mode` is `off`, `observe` (default) or `on`, with `searchGroups` and `repeatLines` switches. Large-result snapshots and bundled rg work independently of this switch. See [tools](tools.en.md) for quotas and retrieval.

## OpenTelemetry trajectory reporting

Core uses the open-source OpenTelemetry SDK to export Traces and Events/Logs over standard OTLP HTTP/protobuf. Reporting is disabled without an endpoint, and export failures do not change Turn outcomes. Core reads configuration at startup; restart the service after changes.

```bash
export OTEL_SERVICE_NAME=areal-core
export OTEL_RESOURCE_ATTRIBUTES='service.namespace=research,deployment.environment.name=development'
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

The common endpoint gets `/v1/traces` and `/v1/logs` appended automatically. Alternatively, configure full signal endpoints; signal-specific settings take precedence:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20your-token'
export OTEL_EXPORTER_OTLP_TIMEOUT=10000
```

| Standard configuration | Behavior |
|---|---|
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Service name and custom Resource attributes; the default name is `areal-core`, and the explicit service name overrides Resource `service.name` |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_ENDPOINT` | Full endpoint for each signal; configuring just one signal endpoint exports only that signal |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_PROTOCOL` | Overrides the common protocol; currently only `http/protobuf` is supported |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_HEADERS` | Overrides common authentication headers, parsed by the SDK in standard format |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS}_TIMEOUT` | Overrides the common timeout in milliseconds; defaults to 10000 |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` or `none`; disable each signal independently |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Standard SDK Trace sampling configuration |
| `OTEL_BSP_*`, `OTEL_BLRP_*` | Standard SDK Trace/Log batch queue and scheduling configuration |
| `OTEL_SDK_DISABLED=true` | Disables all telemetry |

Trajectories cover Turns, individual model requests, tool calls, and context compaction. Model requests use `gen_ai.*` attributes and the `gen_ai.client.inference.operation.details` event; messages use the OpenTelemetry GenAI `role` / `parts` structure, encoded as JSON strings on spans and structured attributes on logs. Model inputs (including system instructions), outputs, reasoning text, tool arguments, and results retain their actual content. There is no redaction logic or redaction switch; media retains the references or inline data received by Engine. Retries are separate requests; cancellation preserves received output and marks the operation incomplete.

Project-specific attributes and events use the `areal.*` namespace. Logs correlate through standard Trace ID and Span ID, and graceful shutdown flushes batch exports. Logs-only configuration still generates local correlation IDs; Trace and Log export switches are independent. Metrics are not exported. GenAI semantic conventions remain in development; see the [official conventions](https://github.com/open-telemetry/semantic-conventions-genai).
