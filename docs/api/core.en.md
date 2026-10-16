[中文](core.md) | **English**

# Core API

Core implements a subset of pinned Codex app-server 0.145.0 plus AReaL extensions, not full official-client compatibility. See the [baseline schema](../../schemas/app-server/codex-0.145.0.json) and [desktop API](desktop.en.md) for authentication and product extensions.

`Turn` optionally includes `startedAt`, `completedAt` (Unix seconds), and `durationMs` (milliseconds). Admission persists the start; settlement persists and publishes the end and final duration. A monotonic clock measures `durationMs` from activation through model/tool/approval waits and cleanup, excluding the queue before admission. Clients refresh only the running display; they must not sum tool durations or restart timing when a view opens. Old records and unconfirmed end/duration after crash recovery remain absent, not zero or the restart time. Normal cancellation and failure settlement also persist final timing.

## Transport and sessions

Each WebSocket text frame carries one request, response or notification, up to 4 MiB. Requests are `{id,method,params}` with string/integer id and object params. jsonrpc is optional; responses contain either result or error; batches are unsupported. Request initialize, then send initialized.

| Method | Parameters |
|---|---|
| `model/list` | `{}` |
| `thread/start` | `{cwd?,model?,dynamicTools?}` |
| `areal/thread/start` | `{requestId,agentProfile:{id,revision},cwd?,model?,parameters?,dynamicTools?}`; starts the Workflow bound to the Profile automatically |
| `thread/list` | `{cursor?,limit?}`; 1–100, default 30 |
| `thread/read` | `{threadId,includeTurns?}` |
| `thread/resume` | `{threadId}` |
| `turn/start` | `{threadId,input}` |
| `turn/steer` | `{threadId,expectedTurnId,input}` |
| `turn/interrupt` | `{threadId,turnId,admissionGuard?}` |

Core owns stable Thread/Turn/Item IDs and history. read does not subscribe; resume atomically snapshots and subscribes, returning the baseline before subsequent events. Each connection permits 128 subscriptions, a 256-item send queue and 128-event Thread windows. Lag disconnects consumers; reconnect and resume again. Observer disconnection does not cancel tasks.

`areal/thread/fork` requires `anchor:{turnId,boundary}` with an explicit `before` or `after` and `workspaceMode:"sharedCurrent"`. `before` excludes the selected turn and everything after it, including an active turn; `after` requires a terminal turn. Failed and interrupted states in the included prefix remain unchanged. An unsettled tool or hook, or a tool, hook, or plugin UNKNOWN outcome without source inspection, returns `HISTORY_UNRESOLVED`. Inspection records facts and does not turn a historical UNKNOWN into success. A missing anchor returns `ANCHOR_NOT_FOUND`, a delegated Worker or Side source returns `SOURCE_KIND_UNSUPPORTED`, and `after` on an active turn returns `TURN_NOT_TERMINAL`; clients can use `error.data.reason` to present a recovery path. Fork inherits conversation history while project files remain in the current shared workspace. See the [desktop API](desktop.en.md) for the full request and origin metadata.

input preserves text/image/audio/file ordering with at most 1 MiB aggregate UTF-8 text, also constrained by the history budget. Authenticated clients upload media Blobs rather than supplying host localImage/localAudio paths. Adapter/model capabilities validate modalities. Original thread/start model must match the service default; product model selection uses areal/thread/start/configure.

Events include thread/started, turn/started/completed, item/started/completed and item/agentMessage/delta; AReaL media uses areal/item/agentMedia/available. Terminal completed/interrupted/failed state is published after persistence. steer preserves emitted text, cancels the current model request and continues within the same Turn.

Optional `admissionGuard: {ordinarySession: true}` requires the supplied `turnId` to remain active and currently ordinary-owned when Core acquires the Thread → Tasks locks, retained through queue persistence and cancellation. A terminal/replaced target or Task, Goal, coordinator/child ownership conflicts (-32009) before any queue, Goal, or cancellation mutation; `ordinarySession: false` is invalid (-32602). The capability is `features.turnInterruptAdmissionGuard`; clients requiring this guarantee must refuse stop when it is absent. Omitting the guard preserves legacy behavior, including queue pausing for a historical terminal Turn. Success means cancellation was accepted; clients must still wait for the original Turn terminal event. This method has no submission receipt.

Context compaction can move an active Turn's prefix into cold history, so `turn.items` in `turn/started` / `turn/completed` is not a complete history replacement. Clients merge observed items by stable Item ID, update matching content and phases, append new items, and retain omitted items in their original order. A repeated start receipt for an existing Turn must not overwrite displayed messages or move a terminal Turn back to running. Only `areal/model/completionDiscarded` explicitly removes the specified uncommitted model response. `thread/read(includeTurns:true)`, `thread/resume`, and `areal/thread/observe` restore cold history and provide a complete authoritative baseline that replaces the local projection. Compaction, completion, interruption, and failure must preserve the display of retained user inputs, steers, and Agent replies.

### Structured terminal outcomes

`Turn.error` retains `message` and adds optional `outcome:{code,class,source,details?}`. Core preserves typed causes at their origin and projects them when settling the Turn. `turn/completed`, `thread/read`, persistence and restart use the same object. Legacy records remain readable without outcome; consumers must not infer categories from message text. Rust callers constructing a legacy `TurnError` must set `outcome: None`.

| code | Meaning |
|---|---|
| `LLM_CONTEXT_WINDOW_EXCEEDED` | Local context budget exceeded (`source=core_context_budget`, with byte/estimated-token measurements and limits), or an explicit Provider `context_length_exceeded` (`provider_http` / `provider_stream`) |
| `LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED` | Provider length/max_tokens/max_output_tokens stop; does not prove actual generation reached the requested client cap |
| `LLM_RESPONSE_TIMEOUT` | Model request or stream timeout, `class=timeout`; existing network retry policy is preserved |
| `AGENT_MAX_TURNS_EXCEEDED` | Configured `maxModelRounds` exhausted, or tools requested during the final handoff; `class=agent`, `source=core_model_round_budget`, with round count and limit in details. A normal handoff is not a failure. No limit is enabled when unconfigured |
| `AGENT_RUN_TIMEOUT` | Explicit Goal or research-worker deadline, `class=agent` |
| `LLM_RESPONSE_FAILED` | Other recognized model failures, distinguished by details; invalid tool indices retain `invalid_tool_call_index` and are not classified as context overflow or invalid tool JSON |
| `MODEL_REQUEST_TOO_LARGE` | Wire-size budget: `core_request_budget` rejects before send; `provider_http` represents a sent HTTP 413. Local rejection details retain stage, bytes/lower bound, limit and requestSent; provider 413 retains HTTP status and the sent marker |
| `HARNESS_INTERNAL_ERROR` | Unclassified Core error, persistence failure or recovered UNKNOWN tool outcome, `class=infrastructure` |

Provider HTTP error bodies are read with a 64 KiB / two-second bound. Only allowlisted code/type/reason labels are retained; raw bodies, Provider messages and credentials are excluded from outcome. HTTP status is retained in `details.httpStatus`. Classification does not enable retries, promote failures to success, continue the task or run scoring. Unknown codes should remain unknown.

External platforms consume the native CLI through `exec --output-format stream-json --include-native-events`. Core notifications and terminal structured errors retain their native fields; see the [CLI contract](claude-cli.en.md). Platforms own input staging, process deadlines, outcome projection, artifact collection and deployment usage accounting. The repository no longer ships the legacy EnvArena Python runner or zipapp. Existing immutable platform releases remain independently versioned.

<a id="agent-message-phase"></a>
### Agent message phases

`agentMessage` has an optional `phase`: `commentary` or `final_answer`. Core creates streaming messages as commentary and finalizes the phase in `item/completed`. A message preceding tools, steering or additional child/Workgroup results remains commentary. Only a model round requiring no further continuation becomes final_answer. This is execution metadata, not a guess based on text or a provider-specific reasoning field; it does not change replay or accounting. Clients must accept phase updates when replacing the completed Item, and still use the Turn terminal status to determine success.

```json
{"type":"agentMessage","id":"message-id","text":"Observed result","phase":"final_answer"}
```

Failures or interruption may leave partial commentary. TUI preserves the last nonempty partial reply as incomplete. Old records lacking phase deserialize without it and remain visible; snapshots and events add an optional field without a version bump. Clients that ignore it retain their previous behavior. Rust callers constructing `Item::AgentMessage` must supply `phase: None` for unclassified legacy messages or the applicable phase.

### Reasoning progress

Model adapters project displayable reasoning into separate `reasoning` Items before body text or stream completion. Their lifecycle is `item/started` → reasoning deltas → `item/completed`; they start with `summary: []` and `content: []`. Clients extend the corresponding array with empty strings before appending a delta at its index:

| Model protocol data | Client event and destination |
|---|---|
| Chat Completions `delta.reasoning_content` | `item/reasoning/textDelta`, `contentIndex=0` |
| Responses `response.reasoning_summary_text.delta` | `item/reasoning/summaryTextDelta`, `summary[summaryIndex]` |
| Responses `response.reasoning_text.delta` | `item/reasoning/textDelta`, `content[contentIndex]` |

Responses maps each provider item ID to a stable Core Item ID within a request, preserving multiple Items and their summary/content indices. Full text in `*.done`, `reasoning_summary_part.added/done`, `output_item.done`, and `response.completed.output` only supplies the suffix not yet emitted. Repeated snapshots do not duplicate text; conflicting snapshots are protocol errors. Part indices must be below 64. The decoder retains at most 128 reasoning parts and 1 MiB of reasoning text. Core allows at most 64 reasoning Items per model request, also bounded by Turn output limits.

```json
{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"THREAD_ID","turnId":"TURN_ID","itemId":"REASONING_ITEM_ID","summaryIndex":0,"delta":"Inspect dependencies"}}
```

Responses summaries are explicitly enabled with optional `reasoning_summary` / `reasoningSummary`; see [configuration](../guides/configuration.en.md) and [desktop parameters](desktop.en.md#submissions). No summary request parameter is added by default, preserving existing model and compatible-endpoint requirements. Clients show a generic waiting indicator when the endpoint returns no displayable text. Other provider-specific fields and native protocols are outside this adapter's scope.

Snapshots from `thread/read` and `thread/resume` include the received reasoning prefix. Replace the client baseline on resume, then apply deltas; do not append the snapshot again. Interrupt and steer preserve received content. When retrying a discarded completion, `areal/model/completionDiscarded.itemIds` removes its reasoning and body together. `item/completed` means the Item will no longer change; the Turn terminal state determines success.

Reasoning counts toward the existing Turn text output byte limit. It is separate from `agentMessage` and does not count as a final answer; reasoning without body text, media, or tool calls still triggers empty-completion handling. Display `reasoning` Items are excluded from model input replay. Chat retains its existing no-replay behavior; legacy `modelContext.value.type=chat_reasoning` records remain readable, while new Chat requests no longer archive a duplicate internal context. Original Responses reasoning objects remain in separate `modelContext` Items and replay once with provider fields such as summary and encrypted_content intact. Clients display only plaintext parts, never decrypting or displaying encrypted content.

This adds an Item variant and notifications. Clients must recognize or ignore `reasoning`; exhaustive Rust `Item` / `ModelEvent` matches need corresponding branches. `ModelOptions` / `ModelParameters` / `SelectedModelConfig` gain an optional summary field. See the [Core schema](../../schemas/areal-core-v1.json) and [client guide](../guides/clients.en.md).

<a id="recovery"></a>
When a unified-delegation settlement receipt was already fully provided through tool results in the current model request, Core does not require another final response merely because automatic settlement repeats it. Comparison ignores only wait metadata and remaining tool-call allowance; execution identity, state, cleanup, text, verification, artifact and delivery facts must match. New results, failures, unknown state and incomplete delivery retain the existing finalization checks; no tools are replayed.

## Execution and recovery

Tools execute only after complete model-stream termination. dynamicToolCall retains original arguments, effectiveArguments, callId, execution backend and running/succeeded/failed/cancelled/unknown outcomes. Local tools also record epoch/scope/operationId; external tools do not invent Runtime facts. Hooks and nested plugin operations have separate journals; outer failure does not erase confirmed writes.

Confirmed argument/schema errors can return to the model for correction. Persistence failures and UNKNOWN stop automatic execution. `areal/tool/acknowledge {threadId,itemId,inspection}` records 1–1024 bytes of inspection while idle. It preserves unknown history without replay or expanded grants.

`execution.backend` is runtime/command/client/mcp/plugin/agent/coordination/core. Optional `modelArguments` stores replay arguments after hooks but before Runtime ID expansion; `effectiveArguments` retains real IDs for audit and is the fallback for older records. Replay keeps one assistant text/tool-call batch per completion followed by ordered tool results. Tool images follow the batch as user images linked to callId. Chat reasoning is archived without replay; opaque Responses context preserves order.

`Limits.watchdog_disable` defaults to false. Core retries the current model request without a retry count limit for classified network failures: transport errors, HTTP 408/429/5xx, premature EOF, request/stream idle timeouts and explicit SSE rate-limit/unavailability errors. Length, empty-answer, authentication, quota and parameter errors are not network failures. See the [configuration guide](../guides/configuration.en.md). Root Agents, child Agents and independent Workgroup Engines inherit the host switch. Embedded callers pass Limits explicitly; Engine never reads process environment variables. Rust `Limits`, `NativeFactory` and `NativeExecutor` gain a `watchdog_disable` field, so explicit struct initializers must be updated. `Limits::default()` and `NativeExecutor::new()` enable the watchdog.

The watchdog keeps the same messages, tools, sampling parameters and model round. It does not consume `max_completion_retries` or reserve another Agent logical-request slot; Workgroups still account for each physical request and enforce deployment budgets. Backoff starts at 250 ms and doubles up to 30 seconds. Failed streams release their shared model permits before waiting, and cancellation and overall deadlines remain effective; solve requests also respond to steer. Core audits and discards the failed response's text, context and unexecuted calls, restores its output-byte allowance, and retains earlier executed tools and observed usage. Events are `areal/model/completionDiscarded` (new `retryKind=network|completion`) and `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`. Discarding a response neither rolls back executed tools nor restarts the Turn. Both events are included in `areal/capabilities.notifications` and the public JSON Schema; `turnId` may be null for summary retries.

SSE errors `server_is_overloaded` and `service_unavailable_error` are retained as retryable overload/unavailability categories. Explicit permanent failures such as authentication or quota errors still prevent retry. Classification only selects network watchdog candidates; it does not bypass Goal unknown-consumption checks.

Goal requests check the shared budget and known usage before retrying. A failed or timed-out request with unknown usage retains its reservation and blocks the Goal with usageUnknown, without watchdog backoff or finite completion retries. The Turn error preserves both `GOAL_USAGE_UNKNOWN` and the original request failure so usage checks do not hide endpoint, authentication or timeout diagnostics. Summary requests follow the same rule: the previous checkpoint is retained without a degraded replacement. Metered HTTP requests disable internal transport retries so one reservation cannot hide multiple requests.

Root and child threads share the Goal ledger. A child model failure without final usage blocks further model or tool submissions in other threads. The root diagnostic retains the observed child request classification, ledger request ID and owning thread/turn instead of reporting an unexplained internal failure. The ledger adds only an optional redacted classification field and accepts older records, which may lack the original cause. After inspecting the failed request, use `/goal-resume` in the TUI to acknowledge the conservative reservation and continue; failed tools are not replayed automatically and unknown usage is not replaced with zero.

`max_empty_completion_retries` is an experimental extra allowance defaulting to 0 (disabled); explicit opt-in provides bounded recovery of empty or reasoning-only endings. General `max_completion_retries` remains 0. Both share a Turn-wide counter; empty completions use the larger ceiling, without resetting after tools. Recovery discards only the unaccepted completion, never replays executed operations, preserves failed content and usage in audit, and remains subject to hard budgets and cancellation.

`max_completion_retries` defaults to 0 and enables finite recovery for classified length truncation, invalid tool indices or empty completions (reasoning alone is not a final answer). With the watchdog disabled, classified network failures also use this finite allowance. Tools execute only after a complete successful stream; UNKNOWN, persistence errors, cancellation and overall deadline errors are never replayed.

Missing/null Chat tool indices, non-integer types, negative values, values outside u64, and non-object fragments produce a typed internal protocol error. Only finite completion recovery accepts it; the network watchdog and Workgroup inference checkpoints do not. Core never guesses indices or fragment ownership. Count, argument and buffer budget errors are not automatically retried. Recovery discards the failed response from model history while retaining confirmed tools, steer input and observed usage. Parsing errors propagate immediately after queued events; parsed usage from the same or earlier events is counted once, and clean EOF preserves the original error type.

Rust `Model::chat_with_limits(messages, tools, purpose, ToolCallLimits, cap)` passes request budgets explicitly through the HTTP adapter, shared pool and Worker wrappers. The optional output-token cap is forwarded together with tool budgets through Goal metering. Its default delegates to `chat_limited`, which preserves existing custom Model implementations and rejects unsupported nonempty caps; custom adapters bound their own internal buffers, while Engine checks their emitted calls before execution. Summaries have a zero-call budget. `Limits` gains `max_tool_buffer_bytes`; `NativeFactory`/`NativeExecutor` gain `tool_call_limits`, requiring updates to explicit struct initializers. Constructors provide defaults. No client protocol methods change; snapshot format 14 is documented below.

`Limits::default()` uses a 131072-token fallback context window. Built-in HTTP models default to a 16384-token output cap per request; `ModelOptions.max_output_tokens=None`, including omitted values in old model snapshots, uses the same default. Explicit positive values can raise or lower it; Goal and summary-specific caps still take the smaller value. Custom `Model` implementations do not acquire an HTTP output cap and must declare their capabilities and enforce request allowances correctly. See the [configuration guide](../guides/configuration.en.md) for precedence and input-space calculations.

Checkpoint `retainedInputs: [{itemId, content}]` and `evidence: string[]` share the complete request budget without independent fixed quotas. Retain the latest real user request in full when it lies in the prefix, then prioritize newer corrections. The initial question has no permanent priority. Output follows authoritative chronology. Older attachments may be omitted with an explicit marker while retaining text; full originals remain retrievable through `read_history`. Automatic Goal continuation is not a new user request. Legacy checkpoints without retainedInputs retain existing replay semantics until the next successful compaction, without bulk history rewrites. Summaries are fallible historical evidence and cannot override later user instructions.

When a candidate's required projection already reaches the soft token target, older text-only revisions may use remaining hard-window space within the existing byte allocation; historical attachments and optional receipts keep their existing allocation. `targetMet=false` reports an unmet soft goal without discarding revisions that still fit. Full-request hard preflight remains mandatory. Summary guidance cannot assume every older requirement is replayed separately.

Compaction uses complete input accounting shared with solve and cuts only complete tool rounds; unresolved or UNKNOWN effects cannot enter the prefix. Before atomic commit, candidates must reduce context, fit the hard input limit and preserve prefix identity and tool pairing. Replan with steer received during summarization; solve still rebuilds and preflights the actual request. Summary input preflight explicitly marks omitted evidence, and summary text is limited to 16 KiB. Only received invalid summaries get one validation retry; permanent request failures such as HTTP 400 fail directly. Failure or cancellation preserves the old checkpoint without committing a degraded summary; observed usage remains durable. Storage-only rolling may archive non-replayable records with historical excerpts, never as a failed-summary fallback. Continue if the old projection fits the full request; otherwise report `LLM_CONTEXT_WINDOW_EXCEEDED` with the summary failure cause. Accounting and cancellation errors cannot be bypassed. No reducible valid prefix means no paid summary.

Build each request's complete live context in memory, reserve the estimated difference between the full request and its history projection, then plan compaction. New controls are not persisted until accepted by preflight, so they cannot block a safe cut after a completed tool tail. Rebuild after compaction or history changes; revalidate history boundaries, enforce hard preflight and persist accepted controls under the commit lock, preserving ordering with new steer input. Recovery hints survive until request acceptance. Local rebuilding does not consume solve rounds, while actual summary requests retain normal accounting. Sent controls, tool facts, context windows and execution budgets remain unchanged.

`areal/context/compacted` retains before/after bytes and estimated tokens, targetTokens/targetMet, summary budget, degradationReason, retainedUserMessages, trigger (manual/tokens/bytes/storage) and usage. `degradationReason=storage_archive` identifies storage rolling without a model summary. The new `areal/context/compactionFailed {threadId,code:"LLM_CONTEXT_COMPACTION_FAILED",reason,checkpointPreserved:true,windowTokens,outputReserveTokens,inputLimitTokens,beforeEstimatedTokens}` is registered in capabilities and JSON Schema. It means the candidate was not committed, not necessarily that the Turn failed.

`areal/context/read` adds `outputLimitTokens` (nullable for custom models), `historyEstimatedTokens`, `estimatedInputTokens`, `estimateScope:"historyWithRecordedInstructionsAndCurrentTools"` and `retentionStrategy:"automatic"|"legacyRecentBoundary"` to `budget`, retaining window, reserve, input limit, target and window source. Estimates include recorded fixed instructions and current tools, without claiming to include live controls not yet constructed for the next request. Solve and manual compaction share fixed-instruction assembly and accounting; final solve additionally includes actual live context. Auto mode permits one recovery from a typed provider context overflow before output/tool calls, subject to Goal accounting.

After compaction, solve context also includes Core-extracted historical paths, exact SHA-256 values and read ranges from successful file-operation receipts (at most 24 entries / 8 KiB). Expired fileVersion handles are excluded, and paged reads are not inferred to cover entire files. The summarizer is instructed not to transcribe hashes.

If a checkpoint covers the entire settled tail round, the next solve appends a labeled internal restoration control so that a historical summary is not treated as the current Turn final response. This control is not a new user task and does not require rereading unchanged files or repeating completed checks; work already supported by evidence should be reported and finished.

When byte pressure triggers compaction with an explicit token target, boundary selection also aims at 75% of the byte window. Summary guidance adapts to the space left by retained context (1–8 KiB) to reduce immediate recompaction. This writing target does not hard-truncate valid summaries; the existing net-reduction checks still apply.

With `limits.context_compaction_enabled=false`, exceeding an automatic threshold fails the Turn and explicit `areal/context/compact` returns an error without writing a checkpoint. See [context limits](../guides/configuration.en.md#models-and-limits).

The CLI default model and providers selected from the GUI/desktop catalog share the same audit path for solve, summary and child-Agent requests; Core-owned requests retain thread/turn correlation. Model audits in `data_dir/model-requests/*.json` and `requests.jsonl` record solve/summary, parameters, body digest/size, attempts, usage, stopReason, duration and bounded response shape, without headers, endpoints or prompts. `usageObserved=true` means a complete parseable usage event was received, including zero; missing/false is not known zero. A length termination still collects same-frame/tail usage within deadlines and cancellation, then marks truncation and prevents tool execution.

SSE streaming Provider errors also write `data_dir/model-requests/errors/<requestId>.json`, referenced by `errorDetailFile` in the ordinary audit. The directory is 0700 and files are 0600. They contain the original error object, including code/type/message values outside the classification allowlist. Serialized content over 16 KiB is stored as a UTF-8-safe `rawJsonPrefix` with `truncated=true`. These private diagnostic artifacts may contain upstream echoed content; they are excluded from `requests.jsonl`, TurnOutcome and telemetry. Original content discarded by older versions cannot be recovered. HTTP request and response-body transport failures also retain their phase, classification flags and underlying cause after URL removal in the same private detail file. Public classification, retries and Goal unknown-usage gates remain unchanged.

Diagnostics use fixed retention limits. At collection time, reaching any age, count or aggregate size limit evicts the oldest completed records:

| Artifact (limits apply separately to each directory) | Maximum age | File count / size |
|---|---|---|
| `model-requests/*.json`, `model-requests-child/*.json` | 30 days | 4096 / 64 MiB |
| `errors/*.json` beneath either request directory | 7 days | 512 / 8 MiB |
| `audit/*.json` (compaction, discarded responses and other Core diagnostics) | 30 days | 1024 / 16 MiB |
| `requests.jsonl`, `requests.jsonl.1` beneath either request directory | 30 days | Two files, 8 MiB each |

The same rules apply to existing diagnostics after upgrade, including shrinking legacy oversized JSONL; there is no permanent-retention toggle. Services check immediately on startup and every minute thereafter; request writes also trigger checks at most once per minute. Embedded callers can invoke `areal_engine::diagnostics::collect(data_dir)`. File-lock leases protect in-flight requests, which are excluded from completed-record limits. Completion releases leases; subsequent checks reclaim crashed leases. Raw details can expire before ordinary audits, so `errorDetailFile` is not permanently readable. Removing a parent audit also removes orphan details. Export private artifacts before expiration if longer investigation retention is needed.

JSONL expiration uses the file’s last modification time, without inspecting each row’s age; size rotation happens during writes. Per-request JSON and error details expire by their own modification times. Count and aggregate size limits apply at collection time and can be briefly exceeded between checks.

An ordinary audit exceeding 1 MiB retains only identity/status fields plus `auditTruncated=true` and `originalBytes`; authoritative history is unaffected. JSONL writes and rotation share a cross-process lock. Legacy oversized files retain a bounded tail of complete records; unterminated records from interrupted writes are discarded. Aggregate readers should inspect both the current file and `.1`; earlier records are available only in unexpired per-request JSON. Diagnostic directories are 0700 and files 0600. Cleanup recognizes only known regular-file names and does not follow symlinks. Diagnostic atomic-write staging files expire after one day; Store staging remnants are removed after acquiring exclusive ownership.

These limits do not apply to session history, Goal journals/request archives, Workgroup artifacts or user scratch used for recovery and audit. They must not be deleted by diagnostic TTL; Blob/cold-history GC remains reference-based.

An unset tokenBudget means unlimited tokens, while Goal accounting and unknown-consumption checks remain active. A valid usage object with zero input/output counters and confirmed terminal framing settles as known zero. A scalar `usage: 0`, missing counters or invalid values do not establish known zero. Usage in a generic error event, even zero, does not replace final usage confirmation. Fabricated zero counters from a Provider underestimate usage; Harness does not infer actual billing from them.

Transport failures, HTTP error statuses and non-SSE responses before stream consumption are also recorded as `outcome=failed`, with sanitized diagnostics in `error`. Non-SSE responses suggest checking the full API endpoint, without recording error-page bodies or raw response headers. Cancelled or unfinished requests remain `interrupted_or_unfinished`.

Tool error audits add `errorCode` and `toolCallError`: `invalid_tool_call_index` includes a fixed reason, protocol, field path, one-based SSE data-event number, index JSON type and buffered call count; `tool_call_budget_exceeded` includes budget kind, limit and observed value. Fields contain only fixed labels and bounded numbers, never copied SSE, arguments, reasoning or invalid field values; the same record supplies the local `requestId`. The existing `responseShape.toolArgumentBytes` name counts validated ID/name/argument bytes together.

Snapshots are written in format 14. Old formats 1–14 without derivation metadata remain readable; Fork/Side records must use format 14 and pass conversation-version and persistent-permission validation. Older binaries cannot read new snapshots; lowering the version cannot bypass role checks. Optional `historyArchive` references immutable SHA-256 segments in `history/`, with head, throughItemId, completedTurns, items and bytes. Each segment is at most 32 MiB. Core syncs the new segment before committing its reference. Hot snapshots contain recent items and checkpoints; full thread reads restore original Turns/Items and omit the storage manifest. `read_history` pages by item ID without loading the entire archive. GC traces both hot snapshots and cold segments. Tool intent persistence and UNKNOWN recovery remain unchanged; archived effects are never replayed. Missing usage/duration is unknown, not zero.

`ToolExecution` adds optional resultSnapshot: MediaRef and outputProjection metrics; older records omit them. Original retrieval is the Core model tool read_tool_result, not a new Runtime RPC; see the [tool guide](../guides/tools.en.md). Model request audits also record messageBlocks digests/byte counts, toolSchemaSha256 and instructionsSha256 for offline prefix comparison without prompt text. Identical prefixes do not establish provider cache hits. `usageDetails` records optional provider cached-input and reasoning token counters; missing counters are null, without changing budget accounting.

<a id="dynamic-tools"></a>
## Dynamic tool callbacks

thread/start.dynamicTools accepts `{name,description,inputSchema,outputSchema?}[]`, persisted and immutable for the Thread lifetime. After recording intent, Core requests the registering connection:

```json
{"id":"REQUEST_ID","method":"item/tool/call","params":{"threadId":"THREAD_ID","turnId":"TURN_ID","callId":"CALL_ID","tool":"lookup","arguments":{"key":"answer"}}}
```

The client echoes the request id:

```json
{"id":"REQUEST_ID","result":{"success":true,"contentItems":[{"type":"inputText","text":"42"}],"structuredContent":42}}
```

success/contentItems are required. Successful structured output is checked against outputSchema; see [desktop API](desktop.en.md) for media extensions. success=false is confirmed failure. RPC errors, invalid/oversized results, disconnects, timeouts and cancellation become UNKNOWN without retry. areal/tool/cancelled is best-effort and does not guarantee rollback.

Restored definitions have no host binding. A callback-capable client may take over through resume when the old host is disconnected and Thread idle. Execution-host disconnection stops the affected Turn. TUI/Web return method-not-found for arbitrary callbacks. See [tools](../guides/tools.en.md) for registration limits.

<a id="agent-tools"></a>
## Agent tools

Models use one delegation entry point to describe intent and delivery. Core selects shared read-only execution, a shared exclusive writer, or an isolated workspace. Users do not choose a backend. Mandatory isolation and trusted checks are explicit requirements that cannot silently weaken.

| Tool | Parameters |
|---|---|
| `agent_spawn` | `{prompt,intent:"inspect"\|"modify",delivery:"report"\|"changes"\|"patch",writes?,independent?,requiresCurrentEnvironment?,requireTrustedChecks?,maxModelRounds?}` |
| `agent_read` | `{executionId,offset?:0}` |
| `agent_wait` | `{executionId,timeoutMs?:10000}` |
| `agent_wait_any` | `{executionIds,timeoutMs?:10000}` |
| `agent_artifact` | `{executionId,path?,offset?:0}` |
| `agent_report` | `{summary,evidence,remaining}` |
| `agent_send_input` | `{executionId,prompt}` |
| `agent_cancel` | `{executionId,mode?:"graceful"}` |

prompt must be nonblank; delegation text input totals at most 32000 bytes. inspect delivers only report and cannot request writes or trusted source acceptance. modify delivers changes or patch. writes contains at most 256 distinct workspace-relative files and is required for isolation. maxModelRounds is 1–1024 and cannot exceed the parent limit; the last round is for handoff. Waits accept 0–60000 ms and never cancel on timeout; wait_any accepts 1–16 distinct executions. report remains child-only with its existing field limits.

Core checks parent permissions, Profile, write authority, environment and snapshot support before execution. Independent modifications prefer isolation. Coupled work, current-environment requirements and unavailable optional isolation select a shared exclusive writer. patch and requireTrustedChecks cannot fall back to shared writes. Shared writers hold the workspace lease while ordinary tools wait, and cannot recursively delegate. Isolated workers inherit tool restrictions and required approvals, run Headless and reject operations that cannot obtain approval. Source snapshotting, shared-writer activation and delivery check unsettled Runtime processes; a returned process handle is not completion evidence.

`agent_send_input` can correct shared workers. Isolated contracts are frozen: cancel, confirm settlement and submit revised work. Cancellation seals shared descendants against new admission and propagates to them. force shortens cleanup grace without promising rollback. A unified execution record’s durable `cancelRequested` cannot be reversed (read projections expose `stopRequested`): a completed but undelivered candidate reports `status=cancelled` and `delivery.status=cancelled`, and waits, Turn settlement and recovery never apply it. When cancellation races delivery, an already-started Runtime operation is awaited for its actual receipt before further operations stop. Existing `partial`, `unknown` and completed `applied` receipts are preserved rather than reported as no writes. Cancelled candidate artifacts remain readable; revised work or renewed delivery requires a new execution.

### Unified client API

`areal/agent/delegate` accepts `{requestId,parentThreadId,input,intent?,delivery?,writes?,independent?,requiresCurrentEnvironment?,requireTrustedChecks?,maxModelRounds?,agentProfile?,instructions?,skills?,model?,toolAllowlist?}` with inspect/report defaults. An active parent Turn is required. Identical requestId and arguments within a parent return the same executionId; changed arguments fail. Creation intent is durable before dispatch; unknown creation is not replayed. History retains at most 10000 execution records.

| Method | Parameters and behavior |
|---|---|
| `areal/execution/list` | `{parentThreadId,offset?:0,limit?:50}`; limit 1–100, returns data/nextOffset |
| `areal/execution/read` | `{parentThreadId,executionId,offset?:0}`; authoritative projection; shared replies use offset/nextOffset pagination and preserve source/sourceItemId/textBytes |
| `areal/execution/wait` | `{parentThreadId,executionId,timeoutMs?:10000}`; read-only, returns on settled or awaitingDelivery; timeout never cancels |
| `areal/execution/artifact` | `{parentThreadId,executionId,path?,offset?:0}`; candidate file list or bounded content, with head and verified |
| `areal/execution/cancel` | Same target plus `mode?:"graceful"`; requests cancellation without claiming completed cleanup |
| `areal/execution/apply` | `{parentThreadId,executionId}`; Core-owned complete candidate delivery; an active Turn carries permissions and cancellation, otherwise returns requiresActiveTurn |

list/read/wait/artifact require observe; delegate/cancel/apply require interact. All check parentThreadId visibility and execution ownership. Bounded asynchronous RPC slots keep cancellation available during waits. Public wait never writes. Model waits, Turn settlement and TaskRun scheduling perform already-requested changes delivery.

Client delegation and delivery also obey Goal budget-confirmation and stop-report gates. Pending limits or an accepted stop report prohibit new executions and writes; existing execution and delivery receipts remain readable, and cancellation and artifact reads remain available for cleanup. Isolated workers inherit deployment ask/deny rules and mandatory parent Profile approvals without copying session or project approval memory.

The projection separates status, settled, resourcesReleased, verification and delivery. notRun is not a passed check. Strict execution uses trusted deployment checks; automatic isolation never invents acceptance. candidate means an artifact is ready; only applied means it reached the workspace. Delivery journals record original sourceHead, actual composed head, baseline and operation receipts. Disjoint changes can compose; strict mode rechecks a changed composed tree. Same-file changes conflict. partial/unknown never mean success and are never replayed automatically. Verification and application are historical receipts; subsequent workspace edits do not erase them.

Delivery preflights every changed path before writing source files. Runtime v0's unencoded paths cannot represent file names containing `%`, `?`, `#`, or exceeding the URI length limit. Delivery does not remove directories, so replacing an existing directory, including an empty one, with a regular file is rejected. These cases return conflict without starting any file operation for the group. Unchanged special file names and replacing a file with a directory remain supported.

Ownership is the current Turn or an existing TaskRun, reusing Thread/Turn, Task/TaskRun and the Goal budget rather than creating another lifecycle. TaskRun workers survive coordinator Turns. A delivery-ready candidate wakes the same coordinator; undelivered work or unconfirmed cleanup prevents Goal completion. Model children join before normal completion. Legacy prompt/threadId tool calls, `areal/agent/spawn` and advanced Workgroup APIs remain compatible; manual spawn still cancels descendants when its parent Turn ends. Legacy history remains available through its original API without fabricated unified receipts.

Optional research deployments retain `delegate_tasks`, `read_agent` and `cancel_agent`; see [research tools](../guides/tools.en.md#research-agents). Unified tools do not expand Runtime permissions or turn external plugin/MCP effects into filesystem transactions.

<a id="workgroups"></a>
## Workgroups and embedding

Service methods are `areal/workgroup/policy/start/list/read/wait/cancel/revise/artifact`. start takes `{requestId,plan,workers?,admission?}`; wait takes `{id,afterRevision,timeoutMs}`; revise takes `{id,requestId,expectedRevision,plan}`; artifact takes `{id,path?,offset?}`. See the [schema](../../schemas/areal-core-v1.json) and [usage guide](../guides/workgroups.en.md).

State revision and planRevision are separate. Revisions affect unstarted tasks or appended nodes and preserve original checks/grants. Identical owner/requestId and parameters return the original group; changed parameters conflict. Models control only their current Turn's groups. Waits are limited to 60 seconds without blocking cancellation on the connection. Four of 16 in-flight slots are reserved for control. Only verified artifacts with confirmed cleanup are readable.

Rust interfaces live in [Engine](../../core/engine/src/lib.rs), [concurrency](../../core/engine/src/concurrency.rs) and [Workgroup](../../core/engine/src/workgroup/mod.rs). Embedders own Runtime, MCP Connections, PluginHost and Service lifecycles. Await Engine shutdown before closing hosts; Drop is not asynchronous cleanup. A Service's parent Engine and Factory should share a SharedModel pool.

`Factory::probe_availability` defaults to success for compatible custom executors; `NativeFactory` overrides it to verify actual Runtime initialization and shutdown. Unified delegation checks the service-cached probe before recording an execution. Confirmed unavailability may select shared execution; `AvailabilityError::CleanupUnknown` must reject without fallback or replay. See [execution strategy selection](../design/multi-agent.en.md#selecting-execution).

Rust launchers call `areal_config::skills::discover(workspace, homedir)` for `SkillDiscovery { skills, warnings }` and must display individual Skill warnings. Each entry includes id/revision/root/metadata. Engine `SkillLocation` accepts optional metadata and reuses the header parser when omitted. The new field affects Rust struct-literal callers; existing deployment JSON may still omit it. Bodies and attachments are not cached in the startup catalog; see the [desktop Skill contract](desktop.en.md#skills).

## Errors

Standard -32700/-32600/-32601/-32602/-32603 mean parse/request/method/argument/internal errors. -32000 is closed, -32001 capacity, -32003 authentication, -32004 missing and -32009 conflict. Transport id is not a business deduplication key. Read authoritative state after losing old turn/start or spawn responses; never replay automatically. See [desktop submissions](desktop.en.md#submissions) for requestId semantics.

<a id="goals"></a>
## Goal mode

Goals need no deployment toggle. `areal/capabilities.features.goals` is always true to advertise support; automatic continuation starts only after explicitly creating a Goal. See [client usage and recovery](../guides/clients.en.md#goals) and [deployment limits](../guides/configuration.en.md#goals). These are AReaL extensions to the pinned Codex 0.145.0 baseline, not upstream `thread/goal/*` compatibility.

### Client control

Reads require observe; mutations require interact and authorization for the Thread. Mutations require `requestId`, `threadId` and `expectedRevision`; existing-Goal mutations also require `goalId`. Identical principal/method/requestId and parameters return the original receipt before checking revision; changed parameters conflict. Read a fresh snapshot after conflicts instead of blindly retrying writes.

| Method | Additional parameters | Behavior |
|---|---|---|
| `areal/goal/get` | `threadId` | Return the projection, including control revision when goal=null |
| `areal/goal/create` | `objective, tokenBudget?, maxTurns?, maxActiveSeconds?, interactionMode?, inferLimits?` | Create on an idle root Thread without pending input and atomically accept the first Turn; an uncleared Goal conflicts |
| `areal/goal/update` | `goalId, objective?, tokenBudget?, maxTurns?, maxActiveSeconds?, inferLimits?` | Edit after stopping and cleanup; retain identity and usage without starting execution |
| `areal/goal/pause` | `goalId` | Persist paused, pause the user queue and request cancellation; cleanup may still be running when the response arrives |
| `areal/goal/resume` | `goalId` | Validate budget, UNKNOWN and hosts, then resume; wait for active-Turn capacity if needed; only queue pauses caused by Goal pause/Stop are resumed automatically |
| `areal/goal/clear` | `goalId` | Require stopped execution, no active Turn, pending input or unsettled resources; increment control revision and retain historical attribution, evidence and accounting |

objective contains 1–4000 Unicode characters and cannot be blank. Explicit limits are positive integers. maxTurns includes the initial root Turn; maxActiveSeconds measures active time. Each omitted create limit is unlimited, with null in the projection; deployment defaults are not substituted. Omitted update fields retain their values and explicit null removes a limit. Deployment max_turns/max_active_seconds only validate supplied values. Completed Goals remain read-only.

A recurring Task with a cross-Run token budget cannot replace that budget through Goal prompt inference; its Task control API remains authoritative.

The GUI submits objective and inferLimits=true without budget inputs. Inference cannot be combined with explicit limits on create; update inference requires objective, clears old limits and reopens confirmation while retaining identity/usage without resuming. Before work, the root Agent calls goal_set_limits to interpret only explicit token/turn/active-time instructions, converting time to seconds. Unspecified fields remain unlimited; numbers describing task content are not budgets. Interpretation requests/time count toward usage. At least three model rounds and goal_set_limits in any allowlist are required. Old numeric limits are retained; old records without derivation metadata in formats 1–14 remain readable and upgrade to 14 on their next write; older Core binaries cannot read the new format.

resume retains all usage and cannot bypass exhausted limits or resume completed Goals. It acknowledges conservative reservations for unknown model consumption without deleting them or restoring accountingComplete=true. Tool UNKNOWN still requires independent inspection and acknowledgement. Ordinary `thread/resume` restores subscriptions and snapshots without resuming Goal execution. Only the queue pause owned by that Goal pause can be cleared by Goal resume.

The projection contains `threadId`, `revision`, `eventSequence` and `goal`. A Goal contains `id`, `threadId`, `objective`, `status`, `reason`, budgets/usage, `activeTurnId`, `settling`, `waitingForInput`, `waitingForAgents`, `waitingForCapacity`, latest `report`/`reportTurnId` and `unreportedTurns`. Status is active/paused/blocked/completed/budgetLimited/failed. Control changes advance revision; persistent projection changes advance eventSequence. get and atomic resume include current usage; events are not emitted per token. State and receipts are persisted before events. A save failure emits in-memory failed/SystemError and recovery remains conservative.

A Turn stopped by token admission reports `GOAL_TOKEN_BUDGET` with source `core_goal_token_budget`. Goal activity deadlines report `AGENT_RUN_TIMEOUT` with `details.goalDeadlineReached=true`. Clients use these structured outcomes for Goal stopping explanations.

goal.usage contains `inputTokens`, `cachedInputTokens`, `outputTokens`, `tokensUsed`, `reservedTokens`, `unknownRequests`, `timeUsedSeconds`, `turnsStarted` and `accountingComplete`. tokensUsed sums confirmed input/output; cached input is a subset, not an extra charge. Outstanding reservations also count toward admission. Unknown statistics never become zero. A crash window or missing usage makes accountingComplete=false. Estimated request admission does not guarantee that provider charges cannot exceed tokenBudget.

```json
{"id":20,"method":"areal/goal/create","params":{"requestId":"goal-migration-1","threadId":"THREAD_ID","expectedRevision":0,"objective":"Complete the module migration, preserve public API compatibility and pass the relevant behavior tests.","tokenBudget":200000,"maxTurns":20,"maxActiveSeconds":3600}}
```

create returns the projection and first turnId. Events `areal/goal/updated` and `areal/goal/cleared` carry threadId, revision, eventSequence and the projection; clear also carries the removed goalId. Existing Turn events and terminal meanings remain intact. Thread adds optional `goals:{revision,eventSequence,goal}`; children use `goalOwner:{threadId,goalId}`. Turn adds `goal:{goalId,sequence,origin,predecessorTurnId}`, where origin is initial/user/continuation. Old data defaults to no Goal; clear preserves revision to reject stale requests.

Goal events use the existing atomic snapshot/subscription boundary, authorization filters and backpressure rules. Reconnect by replacing local state with the full resume snapshot before applying events. Separate get/subscribe calls do not provide that atomic boundary. Rust types generate request, response and event definitions in [areal-core-v1.json](../../schemas/areal-core-v1.json).

### Model tools

| Tool | Parameters | Authority and behavior |
|---|---|---|
| `goal_read` | `{}` | Read the bound Goal, state, budget and remaining work; children receive a read-only projection |
| `goal_set_limits` | `{expectedRevision, sources, tokenBudget?, maxTurns?, maxActiveSeconds?}` | Root-only, once while limitsPending=true; sources quotes the exact objective instruction for every supplied limit, or is empty for no limits |
| `goal_update` | `{expectedRevision, status, summary, evidence, remaining, blocker?}` | Current root Goal Turn only; continue/complete/blocked reports progress or requests settlement |

After accepting a complete/blocked report, `goal_update` returns `nextAction` requesting a tool-free final response. Remaining active until the current Turn settles is expected and does not require polling or resubmitting the report. Dynamic Goal instructions preserve this finishing state across compaction while still requiring later user corrections to be handled.

Core binds Goal/root identity. summary is nonempty and at most 4096 characters; evidence and remaining each allow 16 entries of at most 1024 characters, with at most 32 KiB total arguments. complete requires nonempty evidence and empty remaining; blocked requires a nonempty blocker describing the obstacle and resolution. Evidence is model-reported text referencing tools, checks or artifacts, not independent semantic verification. Core checks report structure, unconsumed verification handles, pending input and child/Workgroup settlement; actual checks and model reporting still determine business correctness.

`goal_update` returns the accepted control revision. complete remains pending until the Turn settles normally. User control, steer or queued input invalidates the previous completion request; cleanup, persistence or child failure cannot publish completed. Core rejects work tools and progress/completion reports until confirmation, and rejects paused/stale/child/repeated confirmations. Quotes establish provenance; the model interprets their numeric meaning, without regex inference in Core. Models cannot create, resume, raise confirmed budgets or clear Goals, bypass approvals, or finish a Goal through ordinary final text or Turn completion.

Rust embedders use `Limits.goals: goals::Policy` and `Engine::goal_get/goal_create/goal_control`. Custom Model implementations must explicitly support per-request output caps in `chat_limited` and preserve accounting via `share_context`; the HTTP adapter supports both. Custom Workgroup Factories must implement `executor_for_goal` and retain the supplied Budget; the default rejects Goal calls. Ordinary Turns and standalone Workgroups retain their existing behavior.

Goal request ledgers are stored at `goals/<goal-id>.json`, with reservations persisted before sending. Root/child Agents, native Workgroups and active-Turn summaries share accounting. Confirmed settled requests roll into immutable `goals/requests/` segments and cumulative usage; the hot ledger retains in-flight and unknown requests, with a 4 MiB resource guard. There is no default cumulative request count budget. Rolling the ledger does not reset usage or release unknown reservations. clear retains ledgers and archives; automatic ledger GC is not provided. The API remains areal.core.v1; snapshot format 14 retains cold-history references and bounded checkpoint retention and protects persistent Fork/Side conversation semantics.

Task Mode adds foreground/scheduled/background Tasks, TaskRuns and independent Channels/Inbox above Goals. Goal create also returns taskId/runId. ask_user_question may choose mode=async inside a Goal; headless never waits for users. See the [Task contract](tasks.en.md) for APIs, budgets and recovery. timeUsedSeconds is the union of coordinator Turn and TaskRun worker activity; pure asynchronous user waiting is excluded.

Ordinary Turns have no aggregate deadline. `thread/configuration/read` returns only `historyBytes` and `contextBytes` in `limits`; `turnTimeoutMs` has been removed. Model, tool and explicit task budgets continue to apply independently.

Model requests place fixed instructions and history first, then append round counters, current Goal/Task state, child results and budget hints as system messages after the complete history, keeping tool calls and results adjacent. Live hints are persisted before dispatch as `modelContext.value.type=areal_request_context`, retaining their position before the associated output. New snapshots supersede old state semantically without deleting previous input. Final-round tool removal and context compaction can still change the cache prefix. Cache hits also depend on the provider and routing; message ordering alone cannot guarantee them.

`thread/read {threadId,includeTurns:true}` returns persisted Turn/Item history; `areal/thread/inspect` returns execution configuration and tool views; `areal/context/read {threadId,offset,limit}` returns a paginated history projection (limit 1–32) and the instruction snapshot, omitting opaque provider context. This projection includes persisted request-state snapshots; hints not saved by older versions cannot be recovered. It is still not an exact replay of a past HTTP request. Each model call records the Engine messages submitted after budget preflight and summary fitting through `areal::trajectory` in `gen_ai.input.messages`; exported traces are queried through the deployment telemetry backend. That field contains logical messages before protocol adaptation; the separate fields below preserve the adapted request.

### Durable trajectory protocol

The transport is the standard OTLP HTTP/protobuf `ExportLogsServiceRequest`, not an Arena-specific request. `areal.trajectory/v1` is this project's public, versioned Agent trajectory profile; `areal.*` keys are custom OTLP attributes, not OpenTelemetry standard attributes. Any standard Collector can receive and forward these logs. Independent receivers and other producers can implement the profile from this contract without installing Harness or Arena packages. Ordinary logs without Turn identity or terminal evidence must not be interpreted as complete Agent trajectories.

Harness identifies itself with `service.name=areal-core` and uses `service.instance.id`, `areal.thread.id`, and `areal.turn.id` for installation, conversation, and Turn identity; a receiver must not treat this service name as a required product identity. Receiver authentication determines ownership; log attributes do not replace an authenticated account. Collector fan-out should preserve event identities, original request strings, versions, timestamps, and manifests. Rewriting these fields or dropping events cannot preserve a claim of original trajectory completeness. See [persistent export configuration](../guides/configuration.en.md#persistent-trajectory-export) for multiple receivers and failure boundaries.

The durable OTLP Logs channel adds `areal.trajectory.schema_version=areal.trajectory/v1`, `areal.event.id` (UUID), and `areal.event.sequence` starting at 1 to each Turn event. `areal.turn.completed` carries `areal.turn.event_count` (including itself) and `areal.turn.events_sha256`: SHA-256 of UTF-8 `sequence:event_id\n` concatenated in sequence order. Sequence allocation precedes queue admission, making memory rejection, disk eviction, and delivery loss detectable as gaps. Receivers may confirm complete delivery only when the manifest, contiguous sequence, and unique identities match without capture truncation. Missing terminal events, legacy protocols, or missing protocol fields remain unknown; DONE does not establish completeness. Execution outcome and delivery completeness are independent.

| Attribute                                                            | Contract                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.version` / `service.build.revision` / `service.build.dirty` | Resource package version, build commit, and whether local modifications existed at build time; unavailable Git identity is `unknown`. Source archive builds may explicitly inject `AREAL_BUILD_REVISION` / `AREAL_BUILD_DIRTY`             |
| `areal.model.request.id`                                             | UUID for each Engine model request; HTTP retries before accepting a stream share it                                                                                                                                                        |
| `areal.model.adapter.version`                                        | `areal.model/v1`                                                                                                                                                                                                                           |
| `areal.model.request.protocol` / `.transport` / `.purpose`           | `chat-completions` or `responses`; `http` or `websocket`; `solve` or `summary`                                                                                                                                                             |
| `areal.model.request.body` / `.sha256`                               | Full request JSON **string** after protocol adaptation, media resolution, tools, and sampling settings, plus its original UTF-8 SHA-256; excludes authentication headers. It remains a string to avoid digest changes from reserialization |
| `areal.model.request.wire`                                           | Actual Responses WebSocket JSON string, potentially using `previous_response_id` and incremental input; `.body` still holds the full effective input                                                                                       |
| `gen_ai.response.id` / `.model` / `.finish_reasons`                  | Provider-returned response ID, model, and finish reason; absent values remain absent and request aliases do not establish checkpoints                                                                                                      |
| `areal.model.response.accepted`                                      | Response accepted at Engine request settlement; failed, cancelled, and steering-discarded responses are false. This is not a correctness or training quality verdict                                                                       |
| `areal.model.response.status` / `.incomplete_details` | Responses status and incomplete details; `finish_reasons` prefers the actual `reason`, otherwise the terminal status |
| `areal.model.response.usage_details`                                 | Observed detailed token usage, retaining unknown values. Usage received during cancellation draining updates both request and Turn                                                                                                         |
| `gen_ai.tool.call.arguments`                                         | Original model tool intent                                                                                                                                                                                                                 |
| `areal.tool.call.effective_arguments`                                | Arguments actually submitted after hooks and runtime handle resolution                                                                                                                                                                     |
| `gen_ai.tool.call.result` / `areal.tool.result.projected`            | Execution result and Core result projection; the subsequent `.request.body` is authoritative for the actual model observation                                                                                                              |
| `areal.tool.outcome`                                                 | Execution conclusion such as `succeeded`, `failed`, `cancelled`, or `unknown`; absence of an exception does not establish success                                                                                                          |

Interpret `areal.duration_ms` according to event type: model events measure a logical client call from request preparation through response consumption, including network traffic, provider queuing, and internal retries; tool events measure tool execution; terminal Turn events measure complete Agent execution. None include background upload waiting, and model-call duration is not pure server inference time. See [configuration](../guides/configuration.en.md#persistent-trajectory-export) for the scope of client timing aggregates.

Shared budgets bound captured content. Actual loss sets `areal.capture.truncated`; complete JSON that remains unexpanded only sets `areal.capture.json_fallback`. Receivers can retain partial data for troubleshooting. Text SFT conversion additionally needs completeness, successful accepted requests, verified tool chains, immutable source digests, and independent quality acceptance. External media URLs and local files are not guaranteed retrievable; the protocol does not contain token logits and does not establish exact multimodal replay, soft-logit distillation, or RL rollouts. See [durable export configuration](../guides/configuration.en.md#persistent-trajectory-export).

Tool execution records add optional `originalArguments`; older records remain readable. History retains original JSON bytes when hooks have not changed argument semantics. Original Responses `function_call` items are retained as `modelContext`; matching unchanged calls preserve their item IDs and fields. Chat projections omit Responses metadata. Compaction retains request snapshots with their associated outputs as one unit and establishes a new cache prefix.

The Chat Completions HTTP adapter merges all plain-text system messages, in their original relative order, at the beginning of the request for templates that accept system messages only at the start. Other messages retain their order. This does not modify persisted history or Responses message/encrypted-reasoning replay. Changing live state can therefore reduce Chat prefix-cache reuse.

When a summary exceeds 16 KiB, Core drains its stream under the existing idle deadline and cancellation rules, collects trailing usage, then rejects the summary using the existing bounded format retry. Oversized text alone no longer discards arriving usage. Truly missing usage remains UNKNOWN and does not automatically resume a Goal.

New request-state snapshots persist the internal `areal_context` role. Chat projects them as user-role status data at their original positions, with a fixed explanatory rule at the beginning; they grant no new user authorization and Core still enforces permissions and budgets. Actual system rules remain consolidated at the beginning for templates requiring a single initial system message. Responses maps the internal role back to system. Historical system snapshots are not silently migrated; older sessions may only obtain fully stable prefixes after compaction or a new session. Only identical static headless hints already visible in history are deduplicated; dynamic state transitions back to earlier values remain appended.

Goal prompt projections omit eventSequence and per-request usage/clock counters, retaining only usage.turnsStarted. Full accounting remains available through goal_read and Goal APIs. Identical latest snapshots are not repeated; revision, report or state changes append a new snapshot, including A-to-B-to-A transitions. Only the prompt projection is reduced; durable accounting and budget enforcement are unchanged.

HTTP final handoff rounds retain currently visible tool schemas with `tool_choice=none` and a zero decoder/execution call budget; returned calls are rejected. Normal handoff no longer removes tool definitions or fixed delegation instructions, preserving reusable prefixes. Legacy custom Model adapters without tool-choice support still receive an empty tool list. Permission changes still alter tool visibility immediately; caching never overrides authorization.

Goal steering (including `agent_send_input` to a metered child) is persisted immediately but does not abandon an in-flight model request. Core waits for the response to settle, then applies pending steering before dispatching any tool from that response. Old-response tool calls are discarded; known usage remains charged once. Existing idle and explicit Goal deadlines/cancellation still apply, and genuine missing usage remains UNKNOWN. Ordinary unmetered Turns retain immediate steering behavior.

### Local trajectory control

`areal trajectory set-enabled <true|false> [--expected-revision <sha256>] --config <file>` changes only an existing configuration's `[trajectory].enabled` under the shared file lock with an atomic write, preserving formatting, comments, other fields, and queue identity. Enabling requires an existing valid HTTP(S) receiver; the command does not create receiver configuration. Status and control responses include optional `config_revision` (raw file SHA-256, or `missing` for no file). Clients must not assume older versions without this field support toggling. Omitting `--expected-revision` still binds the file hash loaded by this command and rejects intervening writes. Stale revisions reject writes. A disabled-to-enabled transition resumes retained failed payloads while preserving receiver backoff; repeated enablement does not reset attempts. `sync-config --resume-retained` supplies the same explicit recovery to external configuration tools. Clients safely apply new capture assembly to existing Core instances; CLI does not cancel active tasks. See [configuration](../guides/configuration.en.md#persistent-trajectory-export).

### Child stopping and usage settlement

`agent_cancel` accepts `{threadId,mode?:"graceful"|"force"}`, defaulting to graceful. Both stop execution of further response tools and admission of the next model request. Graceful allows an issued request up to 60 seconds to settle usage; force allows one second, bounded by the original Goal/research deadline. Repeated cancellation never extends settlement; switching to force shortens it. Neither guarantees a handoff or provider usage. Use `agent_send_input` to request a handoff first. The outer Turn continues polling the cancelling generation future within that deadline, including requests waiting for headers. Missing final usage retains UNKNOWN and its reservation, never zeroes accounting or expands budgets. Crash recovery remains conservative; provider usage lookup is not implemented.

`agent_read/wait/cancel` expose `stopRequested`, `resourcesReleased`, and Goal child `accounting.{usageSettled,pendingRequests,unknownRequests,scope}`. Accounting covers that child turn, not the entire Goal. Snapshot `activity` contains recorded item/tool counts and the last tool identity/status, not heartbeat timestamps. Cancellation acceptance is not settlement; await cleanup before taking file ownership. Short waits, unchanged hashes, and old handoff text alone do not establish a stalled worker.

### Exact working excerpts after compaction

Restoration retains at most eight interface-oriented file excerpt groups, at most 4096 locally estimated tokens in their serialized content and 40 lines per group, excluding oversized lines. Entries retain observed path, SHA, line numbers and event references, never edit handles. The current heuristic favors interface documents and source declarations; it does not claim semantic completeness. Later receipts with a changed SHA invalidate older excerpts; absence of a receipt cannot establish unchanged disk state. Original requests remain authoritative.

Persistent `contextCompactionCandidate` audits record the boundary, retained items, before/after estimates, overhead, usage calibration, targetMet and wholeLatestRound. Written before checkpoint commit, they do not alone prove installation: verify the actual checkpoint throughItemId. File views are recorded once with new tool results; replay never rewrites old provider context.

Observed summary usage is charged to the Turn as it arrives, even if cancellation or rejection prevents checkpoint installation. Cancellation settlement adds only newly received usage once; missing final usage still remains UNKNOWN.

Without an observed usage event, Turn usage remains absent and the CLI does not emit fabricated zero consumption; an explicitly reported all-zero usage event is still retained.

Embedded Rust hosts constructing NativeFactory/NativeExecutor explicitly must provide `worker_limits: Limits`, preserving cumulative budgets and context policy for worker Engines. NativeExecutor::new supplies unlimited-budget defaults; request tool guards remain in tool_call_limits.

`ModelCapabilities` and `ModelOptions` add optional window/output metadata; custom Rust struct literals must include the new fields or use defaults. `ModelParameters.contextWindowTokens` is additive in the client protocol.

CLI retains the 2 MiB `--input-file` limit with bounded reads before JSON parsing. `--input-error-file` writes a content-free `INPUT_ENVELOPE_TOO_LARGE` rejection. Arena Runner projects it and `PUBLIC_INPUT_NOT_ACCESSIBLE` preparation errors into existing outcomes instead of generic missing-Core-Turn failures. Media preprocessing errors remain recoverable tool results (`details.reason=MEDIA_PREPROCESS_FAILED`), not fabricated terminal Turns.

Engine loads project instructions before the first model request of each Turn and persists them in `instructionSnapshot`. It reads `AGENTS.md` along the workspace-root-to-Thread-`cwd` chain and includes source paths in the snapshot. No API fields are added; projects with only a root file remain compatible. Combined content above 32 KiB, invalid UTF-8, symlinks or a chain beyond 64 levels fail the Turn before a model request instead of truncating rules. See [clients](../guides/clients.en.md#history-recovery-and-observability) for scope, precedence and cwd path aliases.

Shared Browser attachment of the fixed bundle to an older Thread is implemented as `areal/thread/tools/attach`; see the [Browser contract](browser.en.md#10-existing-threads-and-core-extensions) for its request, receipt, storage version, and downgrade limits. Preparation and read-only observation subscriptions remain proposals. `thread/resume` behavior is unchanged.

An experimental setting, disabled by default, enables bounded whole-file references in Core request projection and checkpoint evidence; Runtime owns execution waits. See the [configuration guide](../guides/configuration.en.md#reference-retention-and-bounded-tool-recovery) for retrieval, noninteractive stdin and failure limits.

Rust `Limits` and `ResolvedCoreConfig` gain these experimental control fields plus `command_stdin_closed`. Callers constructing exhaustive struct literals must supply them, or use `..Limits::default()` where applicable; defaults enable none of the four experimental policies.
