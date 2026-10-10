[中文](configuration.md) | **English**

# Configuration

`core/config` resolves startup settings and server injects them into components. Approval policy and Runtime execution boundaries are separate; local product launch defaults to YOLO. See the [complete example](../../core/config/examples/config.toml) and [configuration source](../../core/config/src/lib.rs).

## Files and precedence

`Explicit CLI > registered environment > selected TOML > defaults`. Default configuration is `~/.areal/config.toml`, with data in its sibling `state/`. `AREAL_HARNESS_HOME` selects a nonempty absolute home. `--config` takes precedence over `AREAL_HARNESS_CONFIG` and replaces, rather than overlays, the default file. Project TOML and `.env` are not discovered automatically.

The GUI defaults to the same configuration file and Core read/write interface, with isolated service registration and runtime data. `AREAL_HARNESS_SERVICE_HOME` selects only a nonempty absolute directory for shared-service registration and default instance data; it does not change configuration lookup. When omitted, it falls back to `AREAL_HARNESS_HOME` or `~/.areal`. The GUI selects its service directory automatically, so sharing the default configuration requires no environment variable. See the [GUI guide](../../clients/gui/README.en.md) for overrides.

Shared TUI/Web entry points use a workspace-specific default data directory; explicit dataDir configuration retains the precedence above. See [local services](../api/local-service.en.md) for migration and compatibility.

A missing default file is allowed. A missing explicit file, unknown field, type/version error or explicitly empty value is rejected. Files must be regular UTF-8, at most 1 MiB, with `schema_version=1` or `2`. TOML paths resolve against its directory; CLI/env paths resolve against startup cwd. There is no tilde, variable or glob expansion. Malformed lower-priority inputs are rejected even when overridden.

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

Ordinary Turns have no aggregate wall-clock timeout. Model request/stream idle, tool execution and cleanup timeouts still apply, as do explicit Goal, research-worker and Workgroup budgets. Remove `limits.turn_timeout_seconds` (old TOML fields are rejected) and `AREAL_HARNESS_TURN_TIMEOUT_SECONDS` (old environment variables are also rejected) when migrating. The `limits` object in `thread/configuration/read` no longer includes `turnTimeoutMs`. Manual context compaction also relies on model timeouts and shutdown cancellation.

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

The endpoint is a complete HTTP(S) request URL. Core supports only `chat-completions` / `responses` and appends no path. Configuration stores credential variable names; for normal startup, explicit references must resolve to nonempty HTTP-header-compatible values. Unselected providers need no key. Omitted references mean anonymous access; other applications' credentials are not read. `--management` permits a temporarily unavailable credential for the selected model so management and Workspace can start. Requests to that model fail explicitly with `MODEL_CREDENTIAL_UNAVAILABLE`; Core does not send them anonymously or select another model. The model name, endpoint and protocol must still be valid. Restart the service after setting the credential.

Typical endpoints are `https://model.example.com/v1/chat/completions` for Chat Completions and `https://model.example.com/v1/responses` for Responses; use the provider's actual API URL. A URL ending at `/v1` may return an HTML page with HTTP 200, triggering `model response must use text/event-stream`. Goal mode also reports `GOAL_USAGE_UNKNOWN` for the unconfirmed usage while preserving the original error. After changing startup configuration, [stop and restart the shared service](../api/local-service.en.md#public-entry-points); reopening only the client does not reload configuration.

`reasoning_effort` accepts none/minimal/low/medium/high/xhigh when supported upstream. Optional `max_output_tokens` maps to the protocol-specific field. `max_retries` is 0–8 and controls bounded HTTP retries before stream acceptance for transport failures, HTTP 408/429 and all 5xx statuses. After that allowance is exhausted, the default Core watchdog continues network recovery.

Optional `model.reasoning_summary = "auto"` (also `concise` / `detailed`) is Responses-only and maps to `reasoning.summary`. Its environment variable is `AREAL_HARNESS_REASONING_SUMMARY`. It is omitted by default; no summary parameter is added to Chat Completions or models that have not opted in. The endpoint/model must support the selected summary mode; providers determine whether a summary is returned, so reasoning text is not guaranteed.

Optional sampling fields are omitted when unset and preserve explicit zero. `temperature` is finite [0,2], `top_p` / `min_p` are [0,1], `top_k` is a positive integer or -1, `presence_penalty` is [-2,2], and `repetition_penalty` is positive. Both protocols accept temperature/top_p; the other four are Chat-only and rejected for Responses. Sending a parameter does not prove provider support. Summary requests inherit solve sampling/reasoning by default. Optional `model.summary_reasoning_effort` and `model.summary_max_output_tokens` (`AREAL_HARNESS_SUMMARY_REASONING_EFFORT` / `AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS`) affect only summaries. The output cap is the minimum of the global cap, summary cap, remaining Goal allowance and 16384. A configured summary cap must be positive. For example, explicitly select low/4096 summaries with high-effort solving after validating provider support and retention quality.

`model.context_window_tokens` declares the selected model window (1–2000000), also supported in provider/model defaults and `parameters.contextWindowTokens`. Core does not infer it from a model name. Unspecified models use the legacy global fallback of 65536 tokens; diagnostics distinguish model metadata from fallback. Output reserve is the larger of `context.output_reserve_tokens` (default 8192) and the selected model output cap. All messages, live instructions and tool schemas are checked against window minus reserve before every solve request. Estimates use roughly 3 ASCII bytes/token, 2 tokens/non-ASCII character and media proxies. Settled full input usage, including cached tokens, calibrates append-only history with 10% headroom; compaction resets calibration. These are conservative estimates, not exact provider tokenizer counts.

`context.target_tokens=0` chooses 60% of the available input window; a positive target must be below the input limit. `context.recent_tokens` defaults to 8192. Core summarizes complete groups, preserving tool/result pairing and unresolved effects. Retained exact user inputs prioritize the initial task and newest corrections, within min(8192, input window / 4) estimated tokens; evidence has a separate equal allowance. Older originals remain on disk and can be retrieved with `read_history`. Summaries are fallible historical evidence. Summary requests have their own preflight; oversized evidence is shortened with an explicit omission marker. An irreducible solve request fails with `LLM_CONTEXT_WINDOW_EXCEEDED`. A typed provider context-overflow error before output/tool calls allows one compaction recovery in auto mode, subject to Goal accounting; it never replays tool effects.

`context.mode` accepts `auto` (default), `manual` (only explicit compaction), or `disabled` (neither automatic nor manual compaction). Manual/disabled modes stop before sending an oversized request. Schema 1 and explicit legacy `[limits]` values remain supported: `context_compaction_enabled=false` maps to disabled; `context_window_bytes` and `context_recent_bytes` are optional legacy byte guards, both default 0. Legacy `context_window_tokens=0` disables the fallback token guard, but a model window still takes precedence. Do not combine aliases or the old compaction flag with `context.mode`; conflicting settings are rejected. To disable delegation, set resource child/depth limits to 0; explicitly enabled research extensions require nonzero child limits.

The network watchdog is enabled by default with no retry count limit. Set `AREAL_HARNESS_WATCHDOG_DISABLE=1` to disable it; remove the variable or set it to `0` to restore the default. It also accepts `true`/`false`, mapping to TOML `limits.watchdog_disable`; the environment overrides TOML. It covers connection/transport failures, request and stream idle timeouts, premature EOF, HTTP 408/429/5xx and explicit SSE rate-limit/service-availability errors. Solve, child Agent and context-summary requests use the same policy, with exponential backoff from 250 ms capped at 30 seconds. Cancellation, explicit Goal/research-worker time budgets and explicit Workgroup physical-request budgets remain effective. Authentication, invalid requests, insufficient quota, output length limits and empty answers do not receive unlimited retries.

Goal shared-budget and unknown-usage constraints take precedence over retry settings. Goal requests disable internal HTTP retries; failures or timeouts with unknown usage retain their reservation and stop automatic progress. Neither the watchdog nor finite retry allowances bypass this constraint.

`limits.max_completion_retries` defaults to 0, accepts 0–8, and budgets bounded incomplete-response recovery per Turn separately from HTTP `max_retries` and the network watchdog. Disabling the watchdog preserves existing finite retry allowances. See [Core recovery](../api/core.en.md#recovery). HTTPS uses public roots and the host trust store; install private CAs there. Tools execute only from structured protocol fields, never from XML/JSON in response text.

`resources.max_tool_buffer_bytes` defaults to 4 MiB and bounds buffered tool IDs, names and arguments per response. Each call permits at most 64 KiB arguments. `resources.max_response_tool_calls` defaults to 128; the effective cap is the minimum of this guard and an explicitly configured remaining Turn budget. `resources.max_response_bytes` defaults to 4 MiB and bounds text, reasoning, provider context and binary model output per response. These guards are independent of cumulative execution budgets. Chat and Responses share tool-buffer enforcement; repeated Responses terminal items are not charged twice. New environment suffixes include `MAX_RESPONSE_TOOL_CALLS`, `MAX_RESPONSE_BYTES`, `CONTEXT_MODE`, `CONTEXT_RECENT_TOKENS`, `CONTEXT_TARGET_TOKENS` and `MODEL_CONTEXT_WINDOW_TOKENS`. Existing environment names remain supported.

`[budget]` fields `max_tool_calls`, `max_output_bytes` and `max_history_bytes` default to 0 (unlimited). Positive values explicitly limit calls/output per Turn and stored history per Thread; compaction does not reset them. History includes the hot snapshot and referenced cold segments. Existing explicit finite values keep their meaning, while omitted values use the new unlimited defaults in both schema versions. Resource capacities remain positive; child/depth limits may be 0. `max_threads=20000` is deployment session capacity, not a conversation length budget. Idle timeout detects stalled requests, not total task duration. `[network] retry_mode` is persistent by default, or bounded (legacy watchdog disabled). `config show` includes the new groups and retains the legacy `limits` diagnostic object; source keys remain normalized legacy names.

| Environment suffix (prefix `AREAL_HARNESS_`) | Configuration |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | Model name, provider, complete URL, protocol and credential reference |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | Model parameters |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | Sampling parameters |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_COMPACTION_ENABLED` | Optional context token budget and compaction switch |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | Server, extensions file and logging |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | Concurrency and task capacity |
| `STREAM_IDLE_TIMEOUT_SECONDS` | Deadlines |
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

The desktop runtime provider catalog uses `areal/provider/*` and `AREAL_CREDENTIAL_<ref>` with chatCompletions/responses. TOML providers are installed at startup as an execution projection; their IDs reject runtime upsert/remove. `--desktop-config` installs versioned Profiles/Skills/Workflows. `--agent code-agent@v2` selects a Profile for TUI, headless or `exec`; its Workflow starts with the Thread. Explicit thread settings remain revision controlled; see the [desktop contract](../api/desktop.en.md).

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

### Shared GUI and CLI model catalog

`areal config models read [--config /absolute/config.toml]` returns JSON with `path`, a whole-file `revision`, provider `data`, the file's `defaultModel`, `credentialStates` and `credentialSources` keyed by provider ID, and `effective` diagnostics including CLI/environment sources. Reads create no files; missing credentials do not prevent management reads. Core derives `notRequired`, `available`, or `unavailable` from the current trusted environment and resolved credential references. These states contain no keys, do not affect the file revision, and do not indicate successful remote authentication or inference. `areal config models write` accepts `{ "expectedRevision": "...", "data": [...], "defaultModel": { "providerId": "local", "modelId": "one" } }` on stdin; `null` clears the default. It replaces the model catalog, preserves other settings and comments, and returns a new snapshot. Sharing requires both clients to select the same file. Temporary overrides are never written back.

`credentialSources` uses `none` (no authentication), `environment` (environment credential), or `stored` (securely saved credential). Trusted adapters may repeat `--stored-credential-env NAME` on read/write to identify environment names injected from secure storage. Core classifies the resolved reference and independently validates readiness. This provenance is not persisted, does not change revision, and cannot make an absent value usable. Independent CLI clients omit this option and use environment credentials. The GUI authentication selector supports no authentication: Core removes the provider's `api_key_env` on save, and new model selections after application send no authentication header; old tasks retain their original credential references. An empty API Key input preserves an existing reference; API Key mode cannot be saved without a reference or new key. The GUI does not read terminal startup scripts; environment credentials come from the application/backend startup environment.

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

JSON uses camelCase (`apiKeyEnv`, `displayName`, `maxOutputTokens`, `reasoningEffort`); protocols remain `chat-completions` / `responses`. Up to 32 providers and 64 models per provider are supported. Providers and models have names, enablement and generation defaults. Explicit thread parameters override model defaults, then provider defaults. Global TOML/environment/CLI parameters retain existing precedence. The file default must reference an enabled provider and model. Legacy single-model TOML remains readable; its selected name becomes a catalog entry and the first shared save adds `catalog_version = 1`. Legacy provider tables containing only original fields may omit endpoint and supply it through environment variables or CLI, preserving CLI > environment > file precedence. Shared catalog reads and writes require complete provider endpoints in the file; incomplete reads fail explicitly without dropping providers or persisting temporary overrides.

Only credential environment names belong in ordinary configuration. Shared metadata rejects endpoint query parameters to avoid exposing URL credentials to a GUI; legacy diagnostics still redact them. Independent CLI clients supply their own environment values and cannot read desktop secure storage. `areal_openai` is reserved for the desktop account's dynamic catalog: it may be a default reference but not a static provider. An independent CLI without its account transport endpoint fails explicitly.

Writes validate first, compare the whole-file revision, then fsync and atomically replace a temporary file in the same directory. A cooperative writer lock serializes updates; stale requests fail. A missing default file can be created, while missing explicit files and symlink writes fail. Repeated hash checks do not provide atomic CAS against editors that do not participate in the lock.

Saving and applying are separate. Changes to a `catalog_version = 1` catalog report restartRequired; clients restart safely when idle, while unopened instances load it on their next start. Saving does not change running models or existing tasks. New defaults apply to tasks created after application. Historical tasks retain their configuration and credential references; supply credentials for their retired references after key rotation.

GUI settings separately show Core's saved enablement, credential source and readiness, and configuration application state. Unsaved switches and key inputs remain drafts. The desktop adapter supplies securely stored credentials to Core diagnostics; the renderer receives only states. A difference between the current file revision and a project's loaded revision displays “Pending apply.” Successful safe application refreshes the project's Core model catalog. Disabled providers or models are excluded from Composer's execution catalog; enabled models with missing credentials retain their names and reasons. Isolated GUI data directories mean a shared credential reference may be unavailable in another GUI instance; diagnostics reflect the current instance.

## Model configuration reload

Shared TUI/Web services poll their selected TOML once per second and apply a valid configuration after two identical reads. Changes to the selected default model, endpoint, protocol, credential reference and sampling/reasoning parameters apply to subsequent submissions. Explicit CLI/environment overrides retain precedence. Invalid edits leave the previous configuration active; TUI/Web display the error. Owned launchers and standalone Core retain startup-only configuration.

Active Turns, their children, summaries and queued requests retain their model version. Explicit session model selections are preserved. Goal continuation uses the default applicable at its next submission boundary. Default model revisions are retained in the private `dataDir/desktop/default-models.json` archive for queue recovery across restarts, with at most 128 revisions and 1 MiB; values of environment credentials are never stored. A missing retired credential prevents dispatch of the affected queue item instead of substituting another model. The archive must be kept with the history.

Other configuration changes require restart. TUI waits for Turns, Goals, queues and resources to settle before restarting; `areal service ensure` also restarts idle services for changed TOML settings or binaries. Permission/deployment changes and model CLI/environment override changes require `areal service restart` with the desired options. When a model file change has not hot-reloaded within three seconds, shared entry points attempt a safe idle restart; parse, archive and persistence errors retain the running service and report the specific cause. If a new credential reference is unavailable in the old service environment, the service reports both the error and `restartRequired=true`. Reopen TUI/Web or run `areal service ensure` from a terminal containing the new credential: the client validates configuration and credentials before automatically restarting safely. Busy services reject this application attempt; retry after work settles. New terminal environment variables cannot directly update an existing process; changing only the value of an existing credential or proxy environment, without changing model configuration, still requires explicit restart. Default restart refuses busy services; `--cancel` explicitly cancels and settles work.

<a id="tui"></a>
## TUI preferences

Use `${XDG_CONFIG_HOME:-~/.config}/areal-harness/tui.toml`, overridden by `--tui-config` / `AREAL_TUI_CONFIG`. Fields are `theme=dark|light|terminal`, `color=auto|always|never`, `no_logo=false`, `ascii=false` and `mouse=true`. Precedence is CLI > `AREAL_TUI_*` > file > defaults. Nonempty `NO_COLOR` disables color. `--prompt` and `--goal` skip this file.

Set `--mouse=false`, `AREAL_TUI_MOUSE=false` or `mouse = false` in this file to disable mouse capture. Mouse capture defaults to enabled; history remains fully operable with the keyboard.

<a id="goals"></a>
## Goal execution policy

Create a Goal explicitly through `/goal <objective>`, the Web panel, `--goal` or the API; no additional toggle is required. The optional TOML below only adjusts execution limits. Omitting the entire `[goals]` table uses defaults.

```toml
[goals]
max_turns = 0
max_active_seconds = 0
max_unreported_turns = 3
turn_model_rounds = 0
```

The values shown are defaults. `max_turns`, `max_active_seconds` and `turn_model_rounds` use 0 for no deployment ceiling; positive values accept 1–86400, 1–86400 and 2–1024 respectively. Explicit request/session limits still apply and are intersected with any positive deployment limits. Omitted Goal token/turn/time limits stay unlimited. The GUI requests prompt confirmation through inferLimits, requiring goal_set_limits and at least three model rounds when a limit exists. A bounded root Turn requires at least two rounds and keeps its final round tool-free for handoff. The progress integrity guard `max_unreported_turns` remains 3 (range 1–86400): repeated root Turns without goal_update pause as progressUnreported.

Active time includes root-Turn model queuing, execution, tools, interactions and cleanup without adding child durations. Capacity waits between Turns, paused time and offline time are excluded. Existing explicit Goal/research-worker time budgets and Runtime hard limits still apply. Goal requests disable implicit HTTP retries to preserve per-request accounting; unknown usage stops automatic continuation. See [usage and recovery](clients.en.md#goals).

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

Automatic compaction uses the effective model token window and output reserve described above. Completed history prefixes are stored as immutable SHA-256 segments; current snapshots retain recent items and checkpoints. Raw hot history above max(1 MiB, 8 × window tokens) also requests rolling storage in auto mode, using bounded recorded evidence when only storage is under pressure. Disk use continues to grow with retained originals; available disk and per-record protections still apply. Full compatibility history reads materialize all requested history; use paged `read_history` for bounded retrieval. Monitor task correctness together with uncached input, since compaction rebuilds cache prefixes.

## Cache diagnostics

Run `python3 scripts/cache-report.py /absolute/Core-state --output cache-report.json` to summarize `model-requests` and `model-requests-child`. The report compares wire message blocks by thread, protocol, model parameters and request purpose, showing full-prefix retention, tool-definition changes, input/cached/uncached tokens and unknown usage. Null or missing `usageDetails.cachedInputTokens` stays unknown, including older audit files; unknown usage from failed requests is excluded from rate denominators. Byte-prefix equality does not prove provider tokenization or cache residency. New audits retain `usageDetails.providerResponseId` for recognized provider IDs and explicit `cacheWriteTokens` when returned, allowing upstream log correlation without inferring missing routing data. Evaluate cache rates alongside success rate and total/uncached input; never pad history or drop necessary reasoning merely to improve the percentage.

Audits also record milliseconds to first response bytes, first nonempty text delta and first nonempty reasoning delta, only when observed. These are distinct measurements; total request duration is not TTFT, and opaque reasoning without visible deltas remains unknown.

HTTP audits retain bounded correlation IDs when present: `httpRequestId` from x-request-id and `gatewayTraceId` from x-cpa-trace-id. These correlate upstream logs, not backend identity. Authentication headers, cookies and sticky-routing tokens are not collected.

## Incremental Responses transport (experimental)

Explicitly enable `[model] responses_websocket = true` or `AREAL_HARNESS_RESPONSES_WEBSOCKET=true`; default false, only valid for `protocol="responses"`. Keep the full HTTP(S) Responses endpoint in configuration; it is mapped to WS(S). The endpoint must support the Responses WebSocket beta protocol. This path connects directly, does not use HTTP proxy environment variables, and does not automatically fall back to HTTP.

Connections are isolated by model instance, Thread and Turn. Only complete prior responses with a full output array, identical non-input parameters and an exact prior-input-plus-output prefix permit previous_response_id with incremental input; otherwise close the old connection and send full input on a fresh connection. New Turns, credentials/model-instance changes, cancellation, errors and disconnects invalidate continuation state. The transport does not replay failed sends; Engine retry and Goal accounting rules remain applicable. Retain at most 16 idle sessions and 32 MiB of request/output references, clearing connections after 120 idle seconds. Long tool operations may need full-context reconnection; executed tools must not be replayed.

Audit body/messageBlocks represent full logical input; transport=responses-websocket, incremental, wireInputItems and wireBodyBytes describe actual transmission. Fewer wire bytes do not imply fewer billed input tokens or guaranteed KV hits. Evaluate cache, latency, failures and task correctness together. Summaries use separate connections and never pollute the solve continuation.

WebSocket solve connections send the Core thread ID as session-id/thread-id for compatible gateway affinity. Providers may ignore these hints; they do not guarantee cache retention across connections. Summaries and unowned direct model calls do not carry the solve identity.

Model configuration archives preserve the encoded bytes bound to each revision. New optional defaults do not invalidate historical revisions or rewrite queued Turn references; digest mismatches still reject modified archives. Do not manually reformat or edit the Core-owned `desktop/default-models.json`.
