[中文](configuration.md) | **English**

# Configuration

`core/config` resolves startup settings and server injects them into components. Approval policy and Runtime execution boundaries are separate; local product launch defaults to YOLO. See the [complete example](../../core/config/examples/config.toml) and [configuration source](../../core/config/src/lib.rs).

## Files and precedence

`Explicit CLI > registered environment > selected TOML > defaults`. Default configuration is `~/.areal/config.toml`, with data in its sibling `state/`. `AREAL_HARNESS_HOME` selects a nonempty absolute home. `--config` takes precedence over `AREAL_HARNESS_CONFIG` and replaces, rather than overlays, the default file. Project TOML and `.env` are not discovered automatically.

The GUI defaults to the same configuration file and Core read/write interface, with isolated service registration and runtime data. `AREAL_HARNESS_SERVICE_HOME` selects only a nonempty absolute directory for shared-service registration and default instance data; it does not change configuration lookup. When omitted, it falls back to `AREAL_HARNESS_HOME` or `~/.areal`. The GUI selects its service directory automatically, so sharing the default configuration requires no environment variable. See the [GUI guide](../../clients/gui/README.en.md) for overrides.

Configure models through Settings > Model settings. The provider directory shows names only, with spacing and a divider between enabled and disabled groups. Credentials and availability appear in the detail pane. GUI model settings can save providers, API Keys and model lists while tasks are running, including connections that have no models yet. Once connection fields are complete, the page fetches models using the unsaved address and key; manual addition remains available if discovery fails. File saves check the revision. Running tasks retain their model and credential, and idle Core instances apply the saved configuration automatically. Feedback distinguishes saved configuration from application. Application failure does not roll back this save, and unknown outcomes only inspect the original request. Ordinary model settings and API Key saves do not restart Core or Runtime. The fallback default can reference a saved model under an enabled provider or a ChatGPT model in the current account catalog. Changing the fallback default and removing providers still require idle, confirmed application, with revision-checked rollback after a known failure. ChatGPT defaults use the existing `areal_openai` reference; desktop account management retains authorization ownership. An explicit Profile model takes precedence over the last-used preference and fallback default.

Before sending, a new draft displays its concrete model and the effort it will submit. It prefers a supported saved or last-admitted effort, then the configured model default, supported `medium`, or the first offered value. Explicit `none` is a concrete strength and displays "无". Models without reasoning neither display nor submit an effort. Existing conversations with an unspecified or unsupported effort display "未指定". Opening the menu preserves configuration; selecting through the slider or an unspecified effort tick saves a concrete value. Strength names appear on hover, focus, or selection; the current value stays at the top. Explicit model changes select the target model's configured default or the same fallback sequence. The Composer has no reset or configuration actions. When no model is selectable, a single-line "No models available" label keeps the full settings guidance in its tooltip. New chats reuse the provider, model, and effective reasoning effort from the last admitted user submission in a main conversation, across projects and desktop/Core restarts. Core records this at message or continue admission, including queue admission; later model failure does not undo the preference. Unsent configuration changes, history navigation, Side turns, subagents, and background scheduling do not update it. Drafts with an explicit model or effort selection retain that choice. Without a record, new chats use the fallback default. An unavailable remembered model displays a notice and the fallback; unsupported effort displays a notice and selects a supported value using the sequence above. The preference contains only model identity and effort; it does not rewrite provider/service defaults or copy credentials. Changing the fallback does not rewrite existing conversations. Model and effort changes in a conversation save immediately and survive reopening and restart; past Turn snapshots remain unchanged.

Shared TUI/Web entry points use a workspace-specific default data directory; explicit dataDir configuration retains the precedence above. See [local services](../api/local-service.en.md) for migration and compatibility.

A missing default file is allowed. A missing explicit file, unknown field, type/version error or explicitly empty value is rejected. Files must be regular UTF-8, at most 1 MiB, with `schema_version=1` or `2`. TOML paths resolve against its directory; CLI/env paths resolve against startup cwd. There is no tilde, variable or glob expansion. Malformed lower-priority inputs are rejected even when overridden.

<a id="permissions"></a>
## Permission modes

New desktop and Remote chats default to Ask for approval. The Composer also offers Approve for me and Full access. The first two presets restrict managed commands and file tools to the workspace and task scratch, with command networking denied by default. Routine edits and commands inside that boundary do not ask for approval. Requests for additional access go to the user or, for Approve for me, a separate model review without tools. Unavailable or uncertain reviews fall back to the user. Explicit denials and mandatory human approvals retain priority.

Full access uses the complete resource range allowed by the deployment and skips routine approvals. The menu cannot widen a restricted deployment. Plan mode adds an independent read-only restriction. A selection affects new submissions in the current chat; queued messages retain their admitted permission snapshot. Existing chats without an explicit preset retain their previous semantics and never silently gain Full access. Clients must check `features.permissionPresets` before submitting a new preset.

Project `AGENTS.md` reads use the same restricted base Scope as tools and do not replace the Turn authority ceiling. Additional access still requires `run_command.permissionRequest` and the applicable approval, and applies only to that operation. The presence of project rules neither blocks requests nor grants access outside the workspace.

Resource restrictions cover Runtime-managed execution. They do not imply that Core, MCP, plugin hosts or the browser share the command sandbox. Browser access has separate page control and per-action target validation. See [permission architecture](../design/permissions.en.md).

The deployment settings below still apply to entry points without a chat preset and supply explicit tool rules for all chats.

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

## Automatic collaboration and compatibility verification policy

Ordinary Agent collaboration needs no additional feature switch or shared/isolated mode selection. Core chooses shared inspection, a shared exclusive writer, or an isolated candidate from task requirements and effective permissions. Automatic isolation also requires independent Runtime/file helpers and a snapshot-compatible workspace. Ordinary modification may select a shared exclusive writer before starting if isolation is unavailable; candidate-only patches or explicitly required trusted verification cannot silently lose those guarantees.

The host constructs internal execution boundaries from existing write authorization and parent restrictions. YOLO cannot override read-only Profiles, denied tools, or Runtime limits, and project instructions or model plans cannot create grants. Without trusted checks, automatic isolation does not claim verification passed. Existing `--workgroup-policy` continues to provide deployment-controlled strict write paths and final checks for legacy Workflows, explicit groups, and delegations requiring trusted verification. Ordinary usage needs no second policy JSON. See [execution selection](../design/multi-agent.en.md) and [legacy Workgroup configuration](workgroups.en.md).

## Inspection child permissions

Work responsibility and execution authority are separate: `intent="inspect", delivery="report"` requires a report and does not authorize edits. Deployment policy decides whether source read-only access is additionally enforced.

```toml
[delegation]
inspection_permissions = "read-only" # default, enforced read-only
# inspection_permissions = "inherit" # explicit candidate, inherit effective parent authority
```

`AREAL_HARNESS_INSPECTION_PERMISSIONS` accepts `read-only` / `inherit` and overrides TOML. The policy is fixed at startup and requires a safe service restart to change. Redacted diagnostics expose `delegation.inspection_permissions`; model workspace facts expose `inspectionPermissions`.

`read-only` preserves the existing contract: read-only sources and writable private scratch, rejected before child model work when the restricted Scope is unavailable. `inherit` adds no inspection-specific read-only/network-denial restriction. Parent authority, Profiles, denied tools and approval rules still apply; an already restricted parent still requires its sandbox. This mode cannot promise that a child cannot edit sources: behavioral instructions are not OS enforcement. Explicit legacy `workspaceMode="sharedReadOnly"` and research Agents are unchanged.

In inherited mode, trusted native file reads and model reasoning may overlap. Commands, file mutations and ambient tools can have side effects; before the first such action the child takes an exclusive workspace lease until Turn process cleanup and durable settlement. Calls with hooks are also treated as potentially writing; shell text is never guessed to be read-only. Waiting for the lease is cancellable, control queries take no lease, and these children cannot delegate recursively or start services that outlive the Turn. Keep the default mode, narrow the parent/trusted Profile, or use the explicit legacy read-only route when enforcement is required. Failures never silently switch policy.

This remains an explicit deployment candidate; local regressions do not justify replacing the default. See [delegation design](../design/multi-agent.en.md) for both modes and counterexamples.

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
# max_output_tokens = 16384
max_retries = 2
max_request_bytes = 16777216
[model.providers.example]
protocol = "responses"
endpoint = "https://model.example.com/v1/responses"
api_key_env = "AREAL_API_KEY"
[context]
mode = "auto"
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
max_side_turns_per_source = 2
max_side_turns_per_deployment = 8
max_side_model_rounds = 8
max_side_tool_calls = 16
max_side_turn_seconds = 300
max_children_per_turn = 64
max_agent_depth = 8
max_response_tool_calls = 128
max_response_bytes = 4194304
max_tool_buffer_bytes = 4194304

[network]
retry_mode = "persistent"
model_request_timeout_seconds = 300
stream_idle_timeout_seconds = 30
[logging]
filter = "info"
```

The endpoint is a complete HTTP(S) request URL. Core supports only `chat-completions` / `responses` and appends no path. Configuration stores credential variable names; for normal startup, explicit references must resolve to nonempty HTTP-header-compatible values. Unselected providers need no key. Omitted references mean anonymous access; other applications' credentials are not read. `--management` permits a temporarily unavailable credential for the selected model so management and Workspace can start. Requests to that model fail explicitly with `MODEL_CREDENTIAL_UNAVAILABLE`; Core does not send them anonymously or select another model. The model name, endpoint and protocol must still be valid. Credentials added through an external process environment require a service restart. Encrypted API Keys saved by the GUI use protected hot apply and require no restart.

Typical endpoints are `https://model.example.com/v1/chat/completions` for Chat Completions and `https://model.example.com/v1/responses` for Responses; use the provider's actual API URL. A URL ending at `/v1` may return an HTML page with HTTP 200, triggering `model response must use text/event-stream`. Goal mode also reports `GOAL_USAGE_UNKNOWN` for the unconfirmed usage while preserving the original error. After changing non-model startup configuration, [stop and restart the shared service](../api/local-service.en.md#public-entry-points); reopening only the client does not reload configuration.

`reasoning_effort` accepts none/minimal/low/medium/high/xhigh/max when supported upstream. `model.max_output_tokens` defaults to 16384 (16k) and maps to the protocol-specific field. It is an overridable per-request default, must be positive, and is separate from cumulative Turn budgets. Explicit global settings, model/provider parameters and environment overrides retain their existing precedence; omitted values, including nulls in old model snapshots, use the new default. OpenAI reasoning models count reasoning and visible output toward this limit; complex tasks can use a larger model-specific value such as 32768 while leaving room for input. `max_retries` is 0–8 and controls bounded HTTP retries before stream acceptance for transport failures, HTTP 408/429 and all 5xx statuses. After that allowance is exhausted, the default Core watchdog continues network recovery.

Optional `model.reasoning_summary = "auto"` (also `concise` / `detailed`) is Responses-only and maps to `reasoning.summary`. Its environment variable is `AREAL_HARNESS_REASONING_SUMMARY`. It is omitted by default; no summary parameter is added to Chat Completions or models that have not opted in. The endpoint/model must support the selected summary mode; providers determine whether a summary is returned, so reasoning text is not guaranteed.

Optional sampling fields are omitted when unset and preserve explicit zero. `temperature` is finite [0,2], `top_p` / `min_p` are [0,1], `top_k` is a positive integer or -1, `presence_penalty` is [-2,2], and `repetition_penalty` is positive. Both protocols accept temperature/top_p; the other four are Chat-only and rejected for Responses. Sending a parameter does not prove provider support. Summary requests inherit solve sampling/reasoning by default. Optional `model.summary_reasoning_effort` and `model.summary_max_output_tokens` (`AREAL_HARNESS_SUMMARY_REASONING_EFFORT` / `AREAL_HARNESS_SUMMARY_MAX_OUTPUT_TOKENS`) affect only summaries. The output cap is the minimum of the global cap, summary cap, remaining Goal allowance and 16384. A configured summary cap must be positive. For example, explicitly select low/4096 summaries with high-effort solving after validating provider support and retention quality.

`model.context_window_tokens` sets the selected model user working budget (1–2000000), also supported in provider/model defaults and `parameters.contextWindowTokens`. Service reports and user budgets resolve separately, with the smaller value defining the working window. Accounts without a report use the global 131072-token fallback. Other endpoints without reports or budgets use exact-ID defaults, then the global fallback. Diagnostics show report provenance, user budget, and the effective window separately. Output reserve is the larger of `context.output_reserve_tokens` (default 8192) and the selected model output cap. Default HTTP models therefore reserve 16384 tokens, leaving at most 114688 tokens for the complete input, including live instructions and tool schemas. Explicit output settings take precedence; user working budgets are constrained by service reports. Omitted settings use defaults. No capability is inferred from provider names; smaller-window models may require a lower output cap and reserve. All messages, live instructions and tool schemas are checked against window minus reserve before every solve request. Estimates use roughly 3 ASCII bytes/token, 2 tokens/non-ASCII character and media proxies. Settled full input usage, including cached tokens, calibrates append-only history with 10% headroom; compaction resets calibration. These are conservative estimates, not exact provider tokenizer counts.

Normal use needs only the model window, output cap and `context.mode`. `context.target_tokens=0` chooses 60% of the available input window; positive targets must be below the input limit. `context.recent_tokens` now defaults to 0 (automatic); positive values and legacy `context_recent_bytes` remain compatibility boundary preferences with source diagnostics. Common examples no longer pin a recent quota. One complete request budget allocates recent complete rounds, user originals, summary and evidence. There are no separate 8192-token input/evidence quotas or permanent priority for the initial question. The latest real user request and attachments remain complete. Allocate other originals newest first; older attachments may be omitted with an explicit marker while retaining their text. Unresolved or UNKNOWN tool effects cannot enter the compacted prefix. Original records and complete attachments remain on disk for `read_history`.

Solve builds actual live context before the shared estimator accounts for fixed instructions, complete history, tool schemas and protocol headroom. Candidate planning and final preflight use the same budget. Commit only candidates that reduce context, satisfy the hard input limit and preserve prefix identity and tool pairing. Replan with steer received during summarization, then rebuild and preflight the solve request. When the soft target cannot be reached but the hard limit fits, events report `targetMet=false`; soft targets never cause unlimited compaction.

Summary requests have separate preflight and a 16 KiB text resource guard. Permanent request failures such as HTTP 400 are not validation retries. Received empty, oversized or tool-bearing summaries get at most one validation retry. Request failure, exhausted validation or insufficient net saving preserves the previous checkpoint and originals without committing a degraded summary; observed usage is still persisted. Continue if the original complete request fits; otherwise return `LLM_CONTEXT_WINDOW_EXCEEDED` with the summary failure cause. Storage-only rolling may archive non-replayable reasoning with historical excerpts, but never substitutes for a failed model summary. Cancellation and unknown Goal usage cannot continue. See [context management](../design/context-management.en.md) for allocation and migration rules.

`areal/context/read` exposes window, output reserve/cap, history estimate, input estimate including recorded instructions and current tools, window source and retention strategy in `budget`. This diagnoses the history projection for the next request and excludes live controls not yet constructed. `areal/context/compactionFailed` reports failure classification and `checkpointPreserved=true`; it does not necessarily fail the Turn. In auto mode, a typed provider context overflow before output/tool calls permits one compaction recovery, subject to Goal accounting and without replaying tool effects.

`context.mode` accepts `auto` (default), `manual` (only explicit compaction), or `disabled` (neither automatic nor manual compaction). Manual/disabled modes stop before sending an oversized request. Schema 1 and explicit legacy `[limits]` values remain supported: `context_compaction_enabled=false` maps to disabled; `context_window_bytes` and `context_recent_bytes` are optional legacy byte guards, both default 0. Legacy `context_window_tokens=0` disables the fallback token guard, but a model window still takes precedence. Do not combine aliases or the old compaction flag with `context.mode`; conflicting settings are rejected. To disable delegation, set resource child/depth limits to 0; explicitly enabled research extensions require nonzero child limits.

The network watchdog is enabled by default with no retry count limit. Set `AREAL_HARNESS_WATCHDOG_DISABLE=1` to disable it; remove the variable or set it to `0` to restore the default. It also accepts `true`/`false`, mapping to TOML `limits.watchdog_disable`; the environment overrides TOML. It covers connection/transport failures, request and stream idle timeouts, premature EOF, HTTP 408/429/5xx and explicit SSE rate-limit/service-availability errors. Solve, child Agent and context-summary requests use the same policy, with exponential backoff from 250 ms capped at 30 seconds. Cancellation, explicit Goal/research-worker time budgets and explicit Workgroup physical-request budgets remain effective. Authentication, invalid requests, insufficient quota, output length limits and empty answers do not receive unlimited retries.

Solve and summary HTTP requests share Engine and model-pool capacity. Both outer recovery and internal HTTP retries release every failed-request permit before backoff, then requeue and charge request allowance again. Backoff is excluded from active model-pool occupancy; live streams retain their permits. Admitted attempts without final observed usage during cancellation remain UNKNOWN, never assumed zero. `network.retry_mode="bounded"` permits at most five Core network recoveries for each current solve or summary request, then reports failure; `persistent` retains continuous recovery. Exhaustion cannot use `max_completion_retries` to replay further network attempts. An accepted completion starts a new logical-request counter. HTTP `model.max_retries` remains independent, and every physical admission is charged against existing request/task budgets. Recovery neither clears unknown usage nor replays executed tools. A local deployment can explicitly choose bounded mode; this is not a claim that it dominates persistent mode under all availability conditions.

`bounded` no longer aliases `limits.watchdog_disable=true`: the mode recovers interrupted streams and transient network failures finitely; the legacy flag still disables Core network recovery. They can be configured independently, with disable taking precedence. `AREAL_HARNESS_WATCHDOG_DISABLE=0` restores the selected mode, while `AREAL_HARNESS_NETWORK_RETRY_MODE` overrides that mode. The default remains persistent. Both modes release solve/summary capacity before backoff. Cancellation, Goal unknown consumption and unsettled tools still prohibit automatic replay; the retry count is not a whole-task wall-clock deadline.


Goal shared-budget and unknown-usage constraints take precedence over retry settings. Goal requests disable internal HTTP retries; failures or timeouts with unknown usage retain their reservation and stop automatic progress. Neither the watchdog nor finite retry allowances bypass this constraint.

`limits.max_completion_retries` defaults to 0, accepts 0–8, and budgets bounded incomplete-response recovery per Turn separately from HTTP `max_retries` and the network watchdog. Disabling the watchdog preserves existing finite retry allowances. See [Core recovery](../api/core.en.md#recovery). HTTPS uses public roots and the host trust store; install private CAs there. Tools execute only from structured protocol fields, never from XML/JSON in response text.

`resources.max_tool_buffer_bytes` defaults to 4 MiB and bounds buffered tool IDs, names and arguments per response. Each call permits at most 64 KiB arguments. `resources.max_response_tool_calls` defaults to 128; the effective cap is the minimum of this guard and an explicitly configured remaining Turn budget. `resources.max_response_bytes` defaults to 4 MiB and bounds text, reasoning, provider context and binary model output per response. These guards are independent of cumulative execution budgets. Chat and Responses share tool-buffer enforcement; repeated Responses terminal items are not charged twice. New environment suffixes include `MAX_RESPONSE_TOOL_CALLS`, `MAX_RESPONSE_BYTES`, `CONTEXT_MODE`, `CONTEXT_RECENT_TOKENS`, `CONTEXT_TARGET_TOKENS` and `MODEL_CONTEXT_WINDOW_TOKENS`. Existing environment names remain supported.

`[budget]` fields `max_tool_calls`, `max_output_bytes` and `max_history_bytes` default to 0 (unlimited). Positive values explicitly limit calls/output per Turn and stored history per Thread; compaction does not reset them. History includes the hot snapshot and referenced cold segments. Existing explicit finite values keep their meaning, while omitted values use the new unlimited defaults in both schema versions. Resource capacities remain positive; child/depth limits may be 0. `max_threads=20000` is deployment session capacity, not a conversation length budget. Idle timeout detects stalled requests, not total task duration. `[network] retry_mode` defaults to persistent; bounded permits at most five Core network recoveries for the current request. `config show` includes the new groups and retains the legacy `limits` diagnostic object; legacy alias source keys stay normalized, while `network.retry_mode` has an independent source.

`network.model_request_timeout_seconds` defaults to 300 and limits each model request until its first successful event, including shared model permit waits, request preparation and HTTP retries. Receiving response headers does not restart this deadline. After the first event, `network.stream_idle_timeout_seconds` defaults to 30 and limits the gap between events. Activity and usage events refresh the idle deadline even without visible text. Both settings accept 1–86400 seconds and apply to solve and compaction summary requests. They also accept the same keys under `[limits]`. A timeout retains the `LLM_RESPONSE_TIMEOUT` classification and existing watchdog recovery. These limits do not bound total Turn duration.

| Environment suffix (prefix `AREAL_HARNESS_`) | Configuration |
|---|---|
| `MODEL`, `MODEL_PROVIDER`, `MODEL_ENDPOINT`, `MODEL_PROTOCOL`, `API_KEY_ENV` | Model name, provider, complete URL, protocol and credential reference |
| `REASONING_EFFORT`, `REASONING_SUMMARY`, `MAX_OUTPUT_TOKENS`, `MODEL_MAX_RETRIES` | Model parameters |
| `TEMPERATURE`, `TOP_P`, `TOP_K`, `MIN_P`, `PRESENCE_PENALTY`, `REPETITION_PENALTY` | Sampling parameters |
| `CONTEXT_WINDOW_TOKENS`, `CONTEXT_OUTPUT_RESERVE_TOKENS`, `CONTEXT_COMPACTION_ENABLED` | Optional context token budget and compaction switch |
| `LISTEN`, `DATA_DIR`, `TOOL_EXTENSIONS`, `LOG_FILTER` | Server, extensions file and logging |
| `MODEL_CONCURRENCY`, `MAX_THREADS`, `MAX_ACTIVE_TURNS`, `MAX_CHILDREN_PER_TURN`, `MAX_AGENT_DEPTH` | Concurrency and task capacity |
| `MODEL_REQUEST_TIMEOUT_SECONDS`, `STREAM_IDLE_TIMEOUT_SECONDS` | First model event deadline and subsequent stream idle deadline |
| `NETWORK_RETRY_MODE` | `network.retry_mode`; persistent or bounded, default persistent |
| `WATCHDOG_DISABLE` | `limits.watchdog_disable`; `1` disables, default `0` |
| `MAX_HISTORY_BYTES`, `MAX_OUTPUT_BYTES`, `MAX_TOOL_CALLS`, `MAX_TOOL_BUFFER_BYTES`, `CONTEXT_WINDOW_BYTES`, `CONTEXT_RECENT_BYTES` | History, tools and context budgets |

Unknown `AREAL_HARNESS_*` names are errors. Legacy `AREAL_MODEL*` and `RUST_LOG` are lower-priority aliases. Legacy model entry points without a provider file record may use optional `AREAL_API_KEY`; explicit file providers do not inherit it implicitly.

### Desktop loading and execution limits

Transport limits and model execution budgets apply independently. Raising one does not relax another channel. Sizes count encoded bytes; one MiB is 1,048,576 bytes.

| Boundary | Current limit | Behavior at the limit |
|---|---|---|
| Core incoming requests / outgoing messages | 4 MiB / 64 MiB | Oversized responses return `RESPONSE_TOO_LARGE` and other chats remain readable. Failed cached views cannot send new work. Oversized notifications close the connection and block passive reconnect. History is not deleted and submissions are not replayed automatically |
| Desktop shared-service aggregate projections | 256 MiB receive; 32 MiB pre-send buffered-data check | Several large chats can still exceed aggregate transport capacity. A 64 MiB message ceiling does not bound total memory |
| Core RPC / Desktop background RPC | 30 seconds by default / 150 seconds | A failed wait does not stop background work. Read failures do not imply an unknown submission. Unknown writes require reconciliation by original requestId, without automatic replay |
| Observation subscriptions per Core connection | 128, shared by chats and Tasks | New subscriptions are rejected at capacity. Restoring all cached chats can still exhaust it. This is not a stored-history count limit |
| Connection tests / model discovery | 30 seconds, 1 MiB response | A probe failure does not imply Core exited. API discovery returns at most 64 models and ChatGPT discovery 256, currently without a truncation indicator |
| ChatGPT local-proxy model requests | 16 MiB | The proxy still rejects larger requests even if `model.max_request_bytes` is raised |

Core has a 256-message send queue, a 128-event chat window, and a five-second socket write deadline. Queue overload or a slow consumer disconnects the stream to prevent use of an incomplete projection. Desktop automatic reconnect backs off from 500 ms to 30 seconds. Explicit message-size failures require user action instead of repeated reconnects.

These desktop limits are not controlled by `[budget]`. History loading still materializes the complete history before encoding and does not provide paginated recovery. See the [Core API](../api/core.en.md#transport-and-sessions) for transport and oversized-result semantics. Model output, context, network retries, and Runtime subprocess budgets retain their own configuration.

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

On macOS, the GUI backend reads the active network's static HTTP, HTTPS and SOCKS settings with `scutil --proxy` at startup and passes them to Core as the environment variables above. Model discovery, connection tests and ChatGPT subscription requests use the same proxy snapshot. System HTTPS proxies use HTTP CONNECT; system SOCKS proxies use `socks5h` with proxy-side destination DNS. On macOS, SOCKS connections pass through a loopback TCP relay in the GUI backend before reaching the configured upstream proxy, accommodating system proxies whose handshakes fail with direct native Core connections. Authentication, SOCKS bytes and TLS pass through unchanged. The backend saves relay ports and upstream address hashes with mode 0600 and reuses the ports after restart, without storing proxy passwords; proxy URL and bypass semantics remain unchanged. Precedence is explicit protocol environment variables, explicit `ALL_PROXY`, system protocol proxy, then system SOCKS; both cases are normalized to Core's uppercase-first rule. System domain, IP and CIDR exclusions merge with existing `NO_PROXY`; `*.example.com` becomes `.example.com`, including the root domain. Localhost, its subdomains, 127.0.0.0/8 and ::1 always bypass proxies. This path neither executes shell startup scripts nor modifies system settings. PAC, automatic discovery, the simple-hostname exclusion option and wildcards in arbitrary positions are not interpreted. Other platforms continue to use proxy environment variables. After changing system settings, wait for tasks to finish, stop the backend in the GUI's backend-service settings and reconnect to reload and apply them; closing the window does not refresh the background environment. Explicit Responses WebSocket mode retains the direct-connection limitation described on this page.

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

## Desktop general settings

UI, content, code, and terminal font sizes default to 12px. Saved font-size preferences and inherited terminal profile sizes still take precedence; headings retain their existing hierarchy.

The Terminal section provides system profile inheritance and a font override. Inheritance is enabled by default and tries the current user's iTerm2, macOS Terminal, or Kitty appearance settings. An explicit font takes precedence. Clear it to restore automatic selection. Fonts, font sizes, and ANSI colors apply to new or reopened terminals. Existing terminals keep running. The app still controls base background and text colors. Detection failures use the default appearance. Login shell startup and restricted Runtime HOME and permissions remain unchanged.

The Network section saves an HTTP(S) proxy, comma-separated bypass addresses, and an absolute path to a PEM root certificate bundle. An explicit proxy overrides environment and system proxies. Clear it to restore existing discovery. The app proxy field does not accept credentials. Authenticated proxies can continue to use the environment-variable route above. Bypass entries support hostnames, domain suffixes, IP addresses, and CIDRs. Local control connections always stay direct. Custom certificates add trust roots while retaining hostname, expiry, and certificate-chain validation. The file must be a PEM bundle of self-signed CAs, limited to 1 MiB and 128 certificates. Chromium additional-root validation supports critical basic constraints, key usage, extended key usage, and subject alternative names. It rejects other critical extensions. Desktop saves these settings without changing system proxies or the system trust store.

Proxy and certificate settings cover Core HTTP models, model connection tests, subscription connections, trusted MCP servers, and plugin Hosts. Runtime commands with full access and network permission also receive proxy and certificate environment variables. Third-party commands must support those variables. Network permissions do not expand. Explicit Responses WebSocket mode retains its direct-connection limitation. The default Chromium session and shared embedded browser also use the explicit proxy and certificate settings. With the proxy left blank, the browser follows the system proxy and its bypass rules. The app bypass list applies to Chromium only with an explicit proxy.

After changing network settings or Chromium hardware acceleration, wait for active tasks to finish, quit the app completely, and restart it. Saving does not restart tasks. Hardware acceleration is enabled by default. Turning it off can help diagnose rendering problems caused by graphics drivers.

Task notifications is the master switch for completion, approval, and question notifications. Turning it off preserves category and sound preferences. Re-enabling it does not replay old notifications. Interaction behavior uses the existing queue and steer paths. Queue waits until the current run ends. Steer requests an interruption of current output and continues in the same turn. It does not promise to stop tools immediately. Hold ⌘/Ctrl while clicking Send to reverse the selected behavior for that submission.

`pnpm --dir clients/gui run test:desktop-settings` checks settings persistence, terminal appearance, and restart behavior with isolated Electron and Core. `pnpm --dir clients/gui run test:desktop-network` checks local proxy and TLS boundaries. These runners do not establish packaged-app, real-provider, or cross-platform acceptance.

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

This example is an explicit legacy Workflow deployment: `tool-agent@v1` can use its permitted tools, while `code-agent@v2` needs a trusted `--workgroup-policy` and `--allow-write`; the policy must authorize `src/main.rs` and provide final checks (see the [Workgroup guide](workgroups.en.md)). The bound Profile starts the Workflow plan automatically. A regular Turn from `--prompt` or `exec` is a separate user interaction.

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


Custom models can set `capabilities = { tools = true, vision = false, reasoning = true, reasoning_effort_options = ["low", "high"] }`. These fields declare tools, image input, and reasoning support; they add no media generation capabilities. Omitting declarations preserves legacy protocol behavior. New GUI models enable tools and reasoning by default. Without an explicit capability declaration, Low, Medium, High and Extra high are preselected. Declared template capabilities, explicit reasoning disablement, custom effort choices and model/provider defaults are preserved; a known default outside those four remains selectable. New drafts select and submit a supported concrete effort using the sequence above, without guessing provider behavior from model names. Existing conversations are not rewritten automatically. Existing models are not migrated; explicitly clearing an existing effort list still retains the six legacy choices. An explicit list can include `max` when supported remotely. Disabled reasoning omits legacy reasoning parameters.

Shared catalog persistence and application are separate. Writing a `catalog_version = 1` file alone does not change running instances. After saving, the GUI uses the [model configuration hot-apply API](../api/desktop.en.md#model-configuration-hot-apply) to request the exact file revision; each Core rereads and validates its authoritative file. Protected local requests append immutable secure-storage credential references without changing the process environment. Core, Runtime and existing connections retain their generations. Stopped instances load the configuration when next started. Historical Turns, active requests, and accepted queue items retain their snapshots. New requests in old conversations can refresh reported capacity and model capabilities when endpoint, protocol, and credential reference match. Other parameters retain existing thread override rules. Retain credentials required by old tasks. A Core without hot-apply support requires an explicit backend update before the GUI writes. Non-model deployment changes still require an explicit safe restart.

Each project applies atomically; multiple projects do not share a transaction. Saving completes only after every project confirms the target revision and the file still matches. A confirmed partial failure first attempts a file CAS compensation, then applies the actual restored revision. External writes, active work or unknown requests can prevent recovery. In that case, retain pending-apply state and the draft, without claiming full recovery, cancelling work or restarting automatically.

GUI settings separately show Core's saved enablement, credential source and readiness, and configuration application state. Unsaved switches and key inputs remain drafts. The desktop adapter supplies securely stored credentials to Core diagnostics; the renderer receives only states. A difference between the current file revision and a project's loaded revision displays “Pending apply.” Successful safe application refreshes the project's Core model catalog. The Composer picker shows only enabled, available models. Disabled models and models with missing credentials are absent from choices; settings retain diagnostics. Historical model identity stays in the trigger without an automatic switch. Isolated GUI data directories mean a shared credential reference may be unavailable in another GUI instance; diagnostics reflect the current instance.

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

The bounded native read concurrency candidate uses the same JSON: `{"policy":{"parallelReadCalls":4}}`. The range is 1–4, with a default of 1. Explicitly selecting 4 permits bounded overlap without increasing total model, tool or output budgets. Unknown backends and stateful tools remain barriers; matching hooks and finite output limits retain serial execution. See the [Core contract](../api/core.en.md#tool-concurrency-and-execution-progress). This is not promoted as a global performance default without source-isolated confirmation.

`ToolPolicy.completionFocus` (JSON `completionFocus`) is an explicit behavioral experiment defaulting to false. It asks the Agent to finish required deliverables and relevant validation, add checks for specific unresolved concerns, hand off within assigned child boundaries, and use longer idle waits and receipt cursors. Plans identify finite acceptance evidence early, overlapping documentation and check preparation with implementation. Late integration verification observes applied inputs; preparing a script in an isolated snapshot is not final acceptance. Once required delivery, relevant acceptance and owned-resource settlement finish, optional screenshots, extra checks and repeated plan updates are not added as completion conditions. It neither forces a final nor waives acceptance, expands budgets or infers task requirements. Example: `{"policy":{"parallelReadCalls":4,"completionFocus":true}}`. Isolated workers inherit pure tool policy; absent unseen-source evidence this is not promoted as a global default.

`ToolPolicy.executionFocus` (JSON `executionFocus`) is a separate behavioral experiment, defaulting to false. Core asks the Agent to batch known independent reads in one response and use the advertised wait default for finite commands whose result is needed next. Short waits remain appropriate for interaction, explicit deadlines or actual independent work. Implementation or check preparation that can use the current snapshot and an agreed interface should explicitly declare `independent=true` and exact, non-overlapping `writes`; evolving shared state and final integration verification retain shared execution. Guidance distinguishes isolated check preparation from verification of applied changes and retains workspace conflict protection. Dependent reads, writes, process cursors and UNKNOWN retain their existing order and semantics. The policy does not rewrite model-specified yieldMs/waitMs, change budgets or validation requirements, or alter cancellation. Isolated workers inherit pure tool policy. Example: `{"policy":{"executionFocus":true,"parallelReadCalls":4,"resultViews":{"mode":"on"}}}`. This is an explicit combined experiment: combined effects cannot be attributed to one component, and mechanism tests do not replace real-task and unseen-source confirmation.

Tool result views are configured in the JSON file named by `[tools] extensions_file`, under `policy.resultViews`: `mode` is `off`, `observe` (default) or `on`, with `searchGroups` and `repeatLines` switches. Large-result snapshots and bundled rg work independently of this switch. See [tools](tools.en.md) for quotas and retrieval.

## Persistent trajectory export

`[trajectory]` enables optional collection for local TUI, GUI, `exec`, and services. It is disabled by default. Core places trajectory Events/Logs in a bounded memory buffer; a background thread saves them to a user-level disk queue. An independent process normally waits for the owning Turn's terminal record, then uploads individual records as standard OTLP HTTP/protobuf. It can also deliver incomplete persisted records after the producer exits or crashes. To avoid indefinite backlog when a terminal event is lost, a record becomes eligible five minutes after enqueueing even if its producer is still alive. A long Turn may therefore upload partial content first and append its terminal event later. Receivers must treat content without a terminal event as incomplete, not infer success. Agent responses and shutdown do not wait for network uploads. After an owned CLI exits, the uploader can continue processing records already on disk. This feature does not depend on a specific receiver platform or object store: receivers own archiving, indexing, analysis-source registration, and training-data management. An OSS object URL is not an OTLP receiver.

```toml
[trajectory]
enabled = true
endpoint = "https://collector.example.com"
# Choose either headers_env or headers_file; both refer to credentials.
headers_file = "/absolute/private/trajectory-headers.txt"
# The default user configuration uses <AREAL_HARNESS_HOME>/trajectory; other files get isolated queues.
max_disk_bytes = 268435456
max_memory_bytes = 16777216
max_batch_bytes = 4194304
max_records = 2000
max_retries = 6
retry_initial_seconds = 5
retry_max_seconds = 300
request_timeout_seconds = 10
upload_interval_ms = 1000
```

`endpoint` is an HTTP(S) base URL. `/v1/logs` is appended unless already present; user information, query parameters, and fragments are forbidden. Credentials use the standard comma-separated OTEL `key=percent-encoded-value` format, such as `authorization=Bearer%20TOKEN`. `headers_env` references the environment snapshot inherited when the independent uploader starts; restarting Core does not necessarily refresh an already-running uploader. Prefer `headers_file` for persistent setup or credential rotation. It must reference a regular private file with mode 0600, at most 16 KiB, and is reread before each send. These references are mutually exclusive. Relative paths resolve against the TOML directory. Credential values never appear in configuration diagnostics, CLI status, or the GUI.

| Field | Default and constraints |
|---|---|
| `enabled` | `false`; collection requires explicit opt-in |
| `spool_dir` | The default user configuration uses `<AREAL_HARNESS_HOME>/trajectory`; other files use `<AREAL_HARNESS_HOME>/trajectory-sources/<source_id>`. Core and CLI runs using the same configuration share its queue across workspaces |
| `max_disk_bytes` | 256 MiB, 1 MiB–1 TiB; limits telemetry copies, excluding authoritative conversation history |
| `max_memory_bytes` | 16 MiB, 1–1 GiB; collection-buffer byte budget |
| `max_batch_bytes` | 4 MiB, 1–64 MiB, no larger than memory or disk budgets; maximum single OTLP payload, currently persisted and sent per record |
| `max_records` | 2000, 1–10000; maximum retained delivery records |
| `max_retries` | 6, 0–100; automatic retries after the initial attempt |
| `retry_initial_seconds` / `retry_max_seconds` | 5 / 300 seconds, 1–86400; maximum must cover initial delay |
| `request_timeout_seconds` | 10 seconds, 1–86400; network request timeout |
| `upload_interval_ms` | 1000 milliseconds, 1–86400000; interval for the single upload worker |

Network failures and OTLP retryable statuses 429, 502, 503, and 504 use exponential backoff; other 4xx/5xx statuses remain failed without automatic retry. Both delay-seconds and HTTP-date `Retry-After` values are supported. `retry_max_seconds` caps only local backoff and never shortens a receiver-requested wait. Restarting with the same endpoint preserves the saved wait floor. Switching endpoints does not inherit the previous endpoint’s global backoff or rewrite old records’ retry times. A record marked `destination_changed` must return to its original endpoint and receive an explicit `retry` to requeue, resetting that record’s retry budget and wait. Delivery requires HTTP 200, an `application/x-protobuf` response, and a valid protobuf acknowledgment; partial rejection is not automatically retried. Exhausted records remain available for manual retry. A full memory buffer or oversized record drops that telemetry copy and increments a counter; disk or record limits evict old copies in order and record the eviction. Whole events rejected before queue admission because of identity capacity, sequence contention, or memory limits also increment `dropped_memory`, persisted by the background worker on a best-effort basis. Individual field truncation uses the trajectory truncation flag without counting another dropped event. Successful uploads release local payloads while retaining bounded status metadata. These policies do not delete authoritative Core history or change Turn outcomes. This is not a zero-loss path: events and diagnostic counters still in memory can be lost on forced termination, the capture processor waits at most 200 ms for local persistence during graceful shutdown, and retried uploads may create duplicates. Receivers should deduplicate by record identity. This 200 ms capture-processor wait limit is not a hard deadline for the whole Core process to exit. Existing background diagnostics blocked on uninterruptible disk I/O may delay process exit without changing responses that have already completed.

Installation identity loading, queue initialization, history cleanup, and JSON projection run in the background. Message and tool content becomes nested OTLP values within shared memory, node-count, and 32-level depth budgets. Over-budget projection preserves the complete original JSON string and marks `areal.capture.json_fallback=true`; this does not indicate missing content. Only actual capture-field loss is marked `areal.capture.truncated=true`. Invalid JSON and values that cannot be represented losslessly remain unchanged; structured projection is not guaranteed for every value. The memory limit bounds added capture buffers, not the RSS of the entire Core process.

Queue ownership derives from the effective configuration file's canonical absolute path. The internal `source_id` cannot be set in TOML; content updates and path aliases for the same file retain its identity. Multiple Core instances using that configuration share its queue, while separate configurations get separate queues so another configuration cannot change its enablement or destination. Explicitly selecting the same `spool_dir` does not merge ownership: a different existing owner produces a configuration conflict without overwriting control or reading that configuration's trajectories. Removing `spool_dir` restores the default isolated location; the old queue remains in place. Background initialization checks the source file’s internal revision under the queue lock, preventing a delayed startup snapshot from overwriting newer control. Direct TOML edits still apply on the next startup. Before changing a destination or queue, run `trajectory suspend` against the original configuration and wait for its uploader to stop. Existing queue data is not automatically migrated or redirected.

Enable or disable durable export through `[trajectory]` in the user configuration. Configuration selection follows command-line `--config`, then `AREAL_HARNESS_CONFIG`, then `config.toml` under home. Home follows `AREAL_HARNESS_HOME` or `~/.areal`. Back up the file before editing and preserve unrelated settings such as models. Set `enabled` to `true` to enable export or `false` to disable it. Users manage receiver destinations, credentials, and deployment settings; they are not product defaults or distribution dependencies.

`headers_env` references an environment variable available when Core starts. `headers_file` references an OTEL encoded-header file readable only by its user. They are mutually exclusive. Headers use `key=percent-encoded-value` syntax. Explicitly replace or remove old credential references when changing the destination to avoid forwarding credentials to another receiver. Keep secrets out of source code, command-line arguments, and logs.

After editing the file, run `trajectory sync-config` to apply local upload control and safely restart existing Core instances to load capture parameters. Command success only confirms local control; verify remote receipt, archival, and display through an actual execution, `trajectory status`, and receiver readback. Disabled control prevents subsequent enqueueing and sends; an in-flight HTTP request may run until its current timeout. Export configuration participates in the deployment fingerprint, so shared services do not silently ignore changes.


Once a receiver is configured, the GUI Data Flywheel switch controls export: ready enablement is pale green; disabled, capture application pending, or attention states are pale orange with text labels. It changes only the current file's `enabled`, preserving the receiver, credential references, and queue. CLI equivalents are `trajectory set-enabled true` and `trajectory set-enabled false`; optional `--expected-revision` accepts `status.config_revision` to reject concurrent edits. A disabled-to-enabled transition resumes retained failed payloads while preserving receiver Retry-After. Repeated enablement does not reset retry budgets. External configuration tools can explicitly resume failed copies with `sync-config --resume-retained`; ordinary `sync-config` preserves them.

The GUI reuses Core's `ifIdle` drain and safe configuration application once Core is idle and unrelated settings are unchanged. Active tasks, terminals, and queued messages defer the restart and display pending status. Other configuration changes or application failures require the existing background-service safe apply flow. CLI controls uploads only; existing Core capture assembly still requires a safe restart. Disabling preserves the cache and conversation history. Re-enabling cannot recover evicted payloads or events never captured while disabled.

```sh
target/debug/areal trajectory status --config /absolute/config.toml
target/debug/areal trajectory retry --config /absolute/config.toml
target/debug/areal trajectory sync-config --config /absolute/config.toml
```

These commands return JSON. `status` starts neither Agent work nor uploads. It reports current file configuration, uploader state, queue counts/bytes, drop/eviction counters, safe error categories, and the latest 100 delivery records. Records may include Turn, event name, model, Harness version, and event time. The model-name index retains a UTF-8 prefix of up to 1024 bytes and appends an ellipsis when longer; the original trajectory payload remains intact. Missing fields in older records remain unknown.

Capture initialization failure reports `capture_initialization_failed`; failure to create the capture thread reports `capture_thread_unavailable`. These safe categories are stored separately from upload statistics: upload success or retry cannot clear them, and successful capture reinitialization clears failures for this process or exited processes. Failures from other live Core processes sharing the configuration remain visible. Diagnostics retain at most 64 failed processes; overflow conservatively reports `capture_diagnostic_capacity` until the effective trajectory settings change, after which all Core instances must be restarted and checked. Corrupt or unreadable diagnostic files report `capture_diagnostic_unavailable` and are not overwritten with healthy state. Status in the Core process prefers its in-memory failure. The capture background thread attempts persistence directly. Thread-creation failure uses the existing diagnostics background task: its first check is immediate, followed by checks every 60 seconds; slow storage and lock contention may delay persistence. Diagnostics do not add disk waits to Agent startup or event emission. Independent CLI/GUI processes read persisted state. If the spool is completely unwritable or Core exits before persistence, failure history cannot be guaranteed. When status reading itself fails, clients report that status is unavailable; this does not establish successful capture. Failure identity is bound to configuration ownership and effective trajectory settings, including the destination; model-only and comment-only edits do not change it. With an existing control snapshot for the same configuration, failure diagnostics may persist across file revisions without modifying control. Successful cleanup and writes without a control snapshot still check the original file revision. If thread creation fails before control exists and the file is subsequently revised, the old Core cannot persist its diagnostic; restart Core to initialize the current configuration. Snapshots contain no underlying error text, credentials, or request content.

A model event's `model_call_duration_ms` measures a logical client model call, including request preparation, network traffic, provider queuing, streamed responses, and internal retries, but excluding subsequent tool execution. It is not pure server inference time. A terminal Turn's `execution_duration_ms` measures Agent execution, including models, tools, and waits. `model_call_summary` counts model events with valid durations in the same latest-100-record window, returning the count, total, mean, and maximum. Durations are `null` when none are valid. Upload retries do not add model calls, and internal HTTP retries are not counted as separate calls. This window is neither complete history nor a complete per-Turn aggregate. `created_at` / `uploaded_at` represent local record creation and successful delivery, separate from the event's `occurred_at`; their difference includes queueing and retries and is not pure upload network time.

`retry` requeues and wakes the uploader without waiting for remote success. `sync-config` applies export control without reassembling an existing Core. Explicit `retry` and enabled `sync-config` bypass the five-second automatic spawn throttle, allowing immediate wakeup after rapid disable/re-enable or worker exit. Automatic recovery retains throttling, and a cross-process lease keeps one uploader active. Each child-process startup handshake waits at most five seconds for the local lease, without waiting for remote uploads; queue and startup lock waits are separate. If a backlog remains, inspect uploader state and error categories through `status`.

GUI “Settings → Data flywheel” refreshes every 2.5 seconds while visible and connected, with manual refresh and retry still available. While the GUI session is visible, a read-only check every 15 seconds marks the settings entry for problems and clears it after recovery, without adding errors to chat content. Read-only export status queries do not occupy normal operation admission and can run alongside model or resource configuration application. A background query cannot reject configuration application, and configuration application alone does not turn a status query into an export failure. Manual retry retains the existing configuration-application and shutdown restrictions. Both reads share one in-flight request. Hiding, leaving the page, or disconnecting stops the corresponding polling, and stale responses cannot overwrite current state. Local TUI/exec uses one background thread while the process lives: an immediate check followed by five seconds between completed checks, with at most one warning per process. Slow checks do not block startup, inference, or exit; results are delivered while the process remains alive. A short exec may exit before a check completes, with persistent failure discoverable on the next launch. Exec writes warnings only to stderr; TUI uses a separate status notice without changing chat history. Ordinary remote `--endpoint` connections do not inspect the local queue; a locally launched TUI uses its actual configuration-file identity.

GUI recent upload records show 15 records per page, with previous/next controls, page numbers, and record ranges at the top and bottom of the list. Automatic refresh keeps the current page and clamps it to a valid page if records are removed. Navigating from the bottom returns to the top of the list. Pagination still covers only the latest 100 records returned by the status API.

Invalid addresses, unavailable credentials, and upload failures affect only collection/export state. Configuration validation rejects invalid field types, capacity ranges, and conflicts. Payload content is the same as the OpenTelemetry trajectories below, including actual input, reasoning, tool arguments, and results; choose a receiver suitable for this content before enabling export. Persistent export and standard `OTEL_*` observability settings can be used independently; configuring both for the same destination may produce duplicate data.

Each event is constrained by both memory and payload limits. Background copies and encoding conservatively reserve eight times the estimated content size, so the default queue accepts events below roughly 1 MiB including logical input, final request, output, and metadata. `max_batch_bytes=4 MiB` does not guarantee capture of a 4 MiB event. For long contexts, explicitly increase `max_memory_bytes` (for example to 64 MiB) and inspect drops and completeness; all concurrent requests still share that budget.

The disk quota counts logical payload and status-metadata bytes managed in the current spool, plus a 64 KiB control reserve. It excludes filesystem allocation overhead, unrelated files, and authoritative conversation history, and is not a machine-wide quota across configurations. Values below 1 MiB are rejected; a disk quota below the default 4 MiB batch limit also requires lowering `max_batch_bytes`. Existing configurations below 1 MiB must explicitly increase the quota, including disabled configurations.

Capture memory is partitioned into one quarter for Engine content construction, one quarter for event fields, and one half for background copies and encoding. Streaming output, summaries, and input serialization reserve shared capacity before allocating; exhaustion stops capture of that copy while the business stream continues. Final model requests include tool schemas and effective settings, alongside build and response-model identity. Event sequences and terminal manifests detect missing whole events. See the [durable trajectory protocol](../api/core.en.md#durable-trajectory-protocol) for fields, digests, and training boundaries. Setting only `RUST_LOG=info` neither enables raw trajectory capture nor prints its content to the terminal.

### Sending to multiple backends through a standard Collector

Harness capture and durable export do not depend on any platform SDK, domain, or authentication header. The wire format is standard OTLP HTTP/protobuf; `areal.*` attributes are public Harness trajectory semantics. Generic OTLP backends can receive and store them, while Turn completeness and training conversion still require the [trajectory contract](../api/core.en.md#durable-trajectory-protocol). Durable export currently has one destination. Use **Harness → OpenTelemetry Collector → backends** for multiple destinations, without adding platform routing to Harness or treating the different `OTEL_*` and durable channels as equivalent reliable copies.

The [neutral configuration](../../examples/telemetry/collector-fanout.yaml) targets official `otelcol-contrib 0.143.0`; [collector-pins.json](../../examples/telemetry/collector-pins.json) records official release locations and archive SHA256 values. Run the Collector locally or in a trusted per-user sidecar and provide complete Logs URLs and a private storage directory:

```sh
export OTEL_FANOUT_STORAGE=/absolute/private/collector-storage
export OTEL_BACKEND_A_LOGS_ENDPOINT=https://backend-a.example/v1/logs
export OTEL_BACKEND_B_LOGS_ENDPOINT=https://backend-b.example/custom/logs
/path/to/otelcol-contrib --config examples/telemetry/collector-fanout.yaml
```

Set `enabled = true` and `endpoint = "http://127.0.0.1:4318"` in Harness `[trajectory]`, remove `headers_env` / `headers_file` references that do not apply to this local receiver, then apply `trajectory sync-config` and safely restart Core. The receiver defaults to loopback `127.0.0.1:4318`.

Configure each backend's headers, TLS, and client certificates independently on its Collector exporter, using protected environment variables or authentication extensions. Harness does not forward those credentials. A shared Collector with one backend token represents that Collector account, not each sender's identity. Per-user attribution needs per-user Collector/exporter credentials or reviewed authentication and tenant routing; producer-supplied attributes are not authenticated identities.

Each exporter has its own persistent queue, acknowledgments, and retries. The example limits incoming requests to 4 MiB and each pending queue to 8 MiB of serialized data (`sizer: bytes`, not request count), with one consumer and a finite ten-minute retry window. Storage enables `fsync` and compaction on startup and rebound. This queue limit is **not** a hard disk quota: database space, compaction temporary files, and logs need their own volume/quota, monitoring, and retention. The memory limiter is not a hard process RSS cap either. Overflow, permanent rejection, exhausted retries, and storage failure can still lose data. Upstream retries after one queue fills can also duplicate events at an already successful backend; receivers should deduplicate by event identity. Harness memory and disk limits remain independent.

Harness `uploaded` means its direct receiver, the Collector, acknowledged the data. It does not prove that every backend stored it. Check Collector queue metrics and downstream records for final delivery; multi-hop OTLP does not provide cross-backend atomic commits or zero-loss guarantees. See [OTLP multi-destination guidance](https://opentelemetry.io/docs/specs/otlp/#multi-destination-exporting) and [Collector persistent queues](https://opentelemetry.io/docs/collector/resiliency/).

The bounded local interoperability check uses the official binary. Download the archive for your platform from the pinned release first; the script neither downloads nor installs it and validates the pinned SHA256 before execution:

```sh
AREAL_OTELCOL_ARCHIVE=/absolute/otelcol-contrib_0.143.0_darwin_arm64.tar.gz \
AREAL_COLLECTOR_SMOKE_OUTPUT=/absolute/collector-evidence \
  node scripts/trajectory-collector-smoke.mjs
```

The check uses an isolated Core, a real local model endpoint, and the official Collector. One neutral backend accepts while the other returns 503. After the healthy backend receives all events and Agent responses finish, it kills and restarts the Collector and verifies persistent recovery to the failed backend. Ingress remains native Harness protobuf, recorded by a byte-preserving loopback proxy. The Collector exports standard OTLP JSON for independent checks of complete resource attributes, event identities, sequence manifests, and actual model request SHA256 values. Evidence includes original protobuf, actual model requests, and received data without real user credentials. This is a separate check; ordinary builds do not require a Collector installation.

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
| `OTEL_SDK_DISABLED=true` | Disables standard OTEL exporters; `trajectory.enabled` independently controls durable trajectories |

Trajectories cover Turns, individual model requests, tool calls, and context compaction. Model requests use `gen_ai.*` attributes and the `gen_ai.client.inference.operation.details` event; messages use the OpenTelemetry GenAI `role` / `parts` structure, encoded as JSON strings on spans and structured attributes on logs. Model inputs (including system instructions), outputs, reasoning text, tool arguments, and results retain their actual content. There is no redaction logic or redaction switch; media retains the references or inline data received by Engine. Retries are separate requests; cancellation preserves received output and marks the operation incomplete.

Project-specific attributes and events use the `areal.*` namespace. Logs correlate through standard Trace ID and Span ID, and graceful shutdown flushes batch exports. Logs-only configuration still generates local correlation IDs; Trace and Log export switches are independent. Metrics are not exported. GenAI semantic conventions remain in development; see the [official conventions](https://github.com/open-telemetry/semantic-conventions-genai).

Automatic compaction uses the effective model token window and output reserve described above. Completed history prefixes are stored as immutable SHA-256 segments; current snapshots retain recent items and checkpoints. Raw hot history above max(1 MiB, 8 × window tokens) also requests rolling storage in auto mode, using bounded recorded evidence when only storage is under pressure. Disk use continues to grow with retained originals; available disk and per-record protections still apply. Full compatibility history reads materialize all requested history; use paged `read_history` for bounded retrieval. Monitor task correctness together with uncached input, since compaction rebuilds cache prefixes.

## Cache diagnostics

Explicitly enable the experimental Responses body cache key with `[model] responses_prompt_cache = true` or `AREAL_HARNESS_RESPONSES_PROMPT_CACHE=true`; the default is false. Trusted model assembly and catalog Responses providers use this option. Chat Completions never sends it, and enabling it for a selected Chat protocol is rejected early. A 64-character hexadecimal digest scopes the key to the Core thread, model, credential and request purpose without exposing their raw values. It remains stable across turns and process reconstruction; changing a scope changes the key. Direct calls without a valid Core owner omit it. Input, tools, budgets, retries and compaction are unchanged, and no server response state is stored. Restart after changing trusted startup configuration using the existing service compatibility procedure. Old configurations and archives that omit this field remain readable; older binaries cannot read a new archive recording true, so use separate state directories for experiments and rollback.

This supplies an identity for cache grouping supported by the public protocol; it cannot guarantee hits or lower latency. Gateways may treat body keys and session headers differently. The [OpenAI caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) states that the official GPT-6 API does not require this key for routing; measure other gateways before opting in. Audits add only `promptCacheKeySha256`: null means this request sent no key, while a missing field in old records remains unknown. Cache reports distinguish key changes from input prefix changes. This remains an experimental candidate, with no claim of complete pipeline speedup or promotion to a default policy.

Run `python3 scripts/cache-report.py /absolute/Core-state --output cache-report.json` to summarize `model-requests` and `model-requests-child`. The report compares wire message blocks by thread, protocol, model parameters and request purpose, showing full-prefix retention, tool-definition changes, input/cached/uncached tokens and unknown usage. Null or missing `usageDetails.cachedInputTokens` stays unknown, including older audit files; unknown usage from failed requests is excluded from rate denominators. Byte-prefix equality does not prove provider tokenization or cache residency. New audits retain `usageDetails.providerResponseId` for recognized provider IDs and explicit `cacheWriteTokens` when returned, allowing upstream log correlation without inferring missing routing data. Evaluate cache rates alongside success rate and total/uncached input; never pad history or drop necessary reasoning merely to improve the percentage.

Audits also record milliseconds to first response bytes, first nonempty text delta and first nonempty reasoning delta, only when observed. These are distinct measurements; total request duration is not TTFT, and opaque reasoning without visible deltas remains unknown.

HTTP audits retain bounded correlation IDs when present: `httpRequestId` from x-request-id and `gatewayTraceId` from x-cpa-trace-id. These correlate upstream logs, not backend identity. Authentication headers, cookies and sticky-routing tokens are not collected.

## Incremental Responses transport (experimental)

Explicitly enable `[model] responses_websocket = true` or `AREAL_HARNESS_RESPONSES_WEBSOCKET=true`; default false, only valid for `protocol="responses"`. Keep the full HTTP(S) Responses endpoint in configuration; it is mapped to WS(S). The endpoint must support the Responses WebSocket beta protocol. This path connects directly, does not use HTTP proxy environment variables, and does not automatically fall back to HTTP.

Connections are isolated by model instance, Thread and Turn. Only complete prior responses with a full output array, identical non-input parameters and an exact prior-input-plus-output prefix permit previous_response_id with incremental input; otherwise close the old connection and send full input on a fresh connection. New Turns, credentials/model-instance changes, cancellation, errors and disconnects invalidate continuation state. The transport does not replay failed sends; Engine retry and Goal accounting rules remain applicable. Retain at most 16 idle sessions and 32 MiB of request/output references, clearing connections after 120 idle seconds. Long tool operations may need full-context reconnection; executed tools must not be replayed.

Audit body/messageBlocks represent full logical input; transport=responses-websocket, incremental, wireInputItems and wireBodyBytes describe actual transmission. Fewer wire bytes do not imply fewer billed input tokens or guaranteed KV hits. Evaluate cache, latency, failures and task correctness together. Summaries use separate connections and never pollute the solve continuation.

WebSocket solve connections send the Core thread ID as session-id/thread-id for compatible gateway affinity. Providers may ignore these hints; they do not guarantee cache retention across connections. Summaries and unowned direct model calls do not carry the solve identity.

Model configuration archives preserve the encoded bytes bound to each revision. New optional defaults do not invalidate historical revisions or rewrite queued Turn references; digest mismatches still reject modified archives. Do not manually reformat or edit the Core-owned `desktop/default-models.json`.

`model.max_request_bytes` independently caps complete materialized HTTP JSON / Responses WebSocket wire envelopes, including tools and replayed history. The default is 16 MiB; range 1024–134217728 bytes. `AREAL_HARNESS_MODEL_MAX_REQUEST_BYTES` is also supported. This is a local guard, not a claim about gateway capacity; use a verified service limit. Aggregate media lower bounds are checked before materialization, then serialized JSON is counted without allocating an oversized send buffer. WebSocket continuations apply the wire limit to the actual delta; candidate full history has a separate 128 MiB materialization guard, and full-request fallback must satisfy the wire limit again. Rejection sends no request and causes no network retry, returning `MODEL_REQUEST_TOO_LARGE` with stage, measured bytes/lower bound and limit. HTTP 413 uses the same category with request-sent status. Token, tool-display and compaction budgets remain independent; this limit never silently removes historical images or task requirements.

### Reference retention and bounded tool recovery

Observation folding, file-reference retention, repeated-failure execution caps and extra empty-response recovery lack source-separated evidence of general benefit and are disabled by default. Existing keys and schema 1/2 aliases remain supported. Omitted fields no longer activate historical candidate values; explicit positive settings keep their meaning. Direct Engine use and server configuration loading share the same defaults.

| Experimental setting | Default | Explicit candidate example | Range |
|---|---:|---:|---|
| `context.observation_tokens` | 0 | 8192 | 0–2000000 |
| `context.reference_tokens` | 0 | 8192 | 0–2000000 |
| `limits.max_repeated_tool_failures` | 0 | 2 | 0–8 |
| `limits.max_empty_completion_retries` | 0 | 2 | 0–8 |

`context.observation_tokens` is an experimental per-request soft budget defaulting to 0. It applies only in auto compaction mode with retrieval allowed. Core may fold older successful text receipts into head/tail excerpts with exact raw-result references, without rewriting authoritative history or arguments. The latest two results, failures, UNKNOWN, media, unretrievable content and conversations bound to opaque reasoning remain intact. The soft target is not guaranteed; actual sends still pass full-request hard-budget preflight.

Examples are historical candidate values, not performance recommendations. Set only the policy under test in an isolated experimental TOML, freezing source, model, root budget and comparison design. Do not enable several policies and attribute their combined result to one. Reference retention requires `read_history` to be allowed; request indexing/protection also requires auto observation projection and `read_tool_result`; checkpoint reference evidence is independently controlled by explicit `reference_tokens`. Original storage/retrieval, real user corrections, UNKNOWN termination, protection against effect replay and failure notices remain active without these policies. `command_stdin_closed` is a stdin contract and compatibility switch and remains true by default.

`context.reference_tokens` (alias of `limits.context_reference_tokens`) is an experimental file-retention budget defaulting to 0 (disabled). In ordinary sessions with observation projection enabled, Core budgets whole observed `read_file` / `fs_read` receipts newest first, without filename heuristics, up to one quarter of the available input window. At most 32 read ranges are indexed; omitted receipts retain an `itemId` and path for `read_history`. Unread pages still require reading. Checkpoints prioritize these references within the shared request allocator’s remaining capacity so they can survive cold-history rollover; insufficient space can still omit them. New file-version receipts invalidate older reads; shell or external edits cannot be ruled out by historical evidence. Files remain untrusted data and grant no permissions. Original user constraints follow existing input retention rules; summaries explicitly list unfinished obligations, without guaranteeing model understanding or completion.

`limits.command_stdin_closed=true` closes non-PTY stdin by default for `run_command`. Use `stdinOpen:true` for subsequent input, then `write_process` with `text` and optionally `close:true` to send EOF after writing. Shell redirection still works; PTYs use control characters. Set `command_stdin_closed=false` for legacy behavior. Runtime deadlines, cancellation and Turn cleanup still apply. Silence alone does not establish an input wait and does not automatically kill a silent build.

`limits.max_repeated_tool_failures` is an experimental execution cap defaulting to 0 (disabled), accepts 0–8, and requires an explicit positive value. After the threshold of consecutive confirmed failures with the same tool and parsed arguments in the current Turn, the next call is journaled as rejected without execution; another unchanged call ends the Turn. Read-only inspection does not reset the sequence; a different operation or arguments does. Earlier failures may have partial effects. Rejection and recovery hints do not imply rollback. UNKNOWN still stops without automatic replay. This bounds repeated execution, not the underlying failure.

Ablations can use `AREAL_HARNESS_CONTEXT_OBSERVATION_TOKENS`, `AREAL_HARNESS_MAX_EMPTY_COMPLETION_RETRIES`, `AREAL_HARNESS_CONTEXT_REFERENCE_TOKENS`, `AREAL_HARNESS_COMMAND_STDIN_CLOSED`, and `AREAL_HARNESS_MAX_REPEATED_TOOL_FAILURES`. Added input and recovery usage remain charged to the root budget; estimated compression is not measured savings.

## Hooks configuration

`[features]` accepts boolean `hooks` and the legacy alias `codex_hooks` (`hooks` wins when both appear). Omission enables discovery, with separate trust still required for every current definition. User `hooks=false` gates both configuration and package hooks; project switches cannot override it. Top-level `[hooks]` is delegated to the hooks parser while model/permission fields retain strict parsing. Project `.codex/config.toml` is read only for hooks, without changing the global precedence described above.

```toml
[features]
hooks = true

[[hooks.UserPromptSubmit]]
hooks = [{ type = "command", command = "python3 /absolute/path/hook.py", timeout = 30 }]
```

See the [plugin guide](plugins.en.md#hooks-p2-candidate) for sources, review, execution and remaining limits.
