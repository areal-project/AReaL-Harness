[中文](core.md) | **English**

# Core API

Core implements a subset of pinned Codex app-server 0.145.0 plus AReaL extensions, not full official-client compatibility. See the [baseline schema](../../schemas/app-server/codex-0.145.0.json) and [desktop API](desktop.en.md) for authentication and product extensions.

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
| `turn/interrupt` | `{threadId,turnId}` |

Core owns stable Thread/Turn/Item IDs and history. read does not subscribe; resume atomically snapshots and subscribes, returning the baseline before subsequent events. Each connection permits 128 subscriptions, a 256-item send queue and 128-event Thread windows. Lag disconnects consumers; reconnect and resume again. Observer disconnection does not cancel tasks.

input preserves text/image/audio/file ordering with at most 1 MiB aggregate UTF-8 text, also constrained by the history budget. Authenticated clients upload media Blobs rather than supplying host localImage/localAudio paths. Adapter/model capabilities validate modalities. Original thread/start model must match the service default; product model selection uses areal/thread/start/configure.

Events include thread/started, turn/started/completed, item/started/completed and item/agentMessage/delta; AReaL media uses areal/item/agentMedia/available. Terminal completed/interrupted/failed state is published after persistence. steer preserves emitted text, cancels the current model request and continues within the same Turn.

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
## Execution and recovery

Tools execute only after complete model-stream termination. dynamicToolCall retains original arguments, effectiveArguments, callId, execution backend and running/succeeded/failed/cancelled/unknown outcomes. Local tools also record epoch/scope/operationId; external tools do not invent Runtime facts. Hooks and nested plugin operations have separate journals; outer failure does not erase confirmed writes.

Confirmed argument/schema errors can return to the model for correction. Persistence failures and UNKNOWN stop automatic execution. `areal/tool/acknowledge {threadId,itemId,inspection}` records 1–1024 bytes of inspection while idle. It preserves unknown history without replay or expanded grants.

`execution.backend` is runtime/command/client/mcp/plugin/agent/coordination/core. Optional `modelArguments` stores replay arguments after hooks but before Runtime ID expansion; `effectiveArguments` retains real IDs for audit and is the fallback for older records. Replay keeps one assistant text/tool-call batch per completion followed by ordered tool results. Tool images follow the batch as user images linked to callId. Chat reasoning is archived without replay; opaque Responses context preserves order.

`Limits.watchdog_disable` defaults to false. Core retries the current model request without a retry count limit for classified network failures: transport errors, HTTP 408/429/5xx, premature EOF, request/stream idle timeouts and explicit SSE rate-limit/unavailability errors. Length, empty-answer, authentication, quota and parameter errors are not network failures. See the [configuration guide](../guides/configuration.en.md). Root Agents, child Agents and independent Workgroup Engines inherit the host switch. Embedded callers pass Limits explicitly; Engine never reads process environment variables. Rust `Limits`, `NativeFactory` and `NativeExecutor` gain a `watchdog_disable` field, so explicit struct initializers must be updated. `Limits::default()` and `NativeExecutor::new()` enable the watchdog.

The watchdog keeps the same messages, tools, sampling parameters and model round. It does not consume `max_completion_retries` or reserve another Agent logical-request slot; Workgroups still account for each physical request and enforce deployment budgets. Backoff starts at 250 ms and doubles up to 30 seconds. Failed streams release their shared model permits before waiting, and cancellation and overall deadlines remain effective; solve requests also respond to steer. Core audits and discards the failed response's text, context and unexecuted calls, restores its output-byte allowance, and retains earlier executed tools and observed usage. Events are `areal/model/completionDiscarded` (new `retryKind=network|completion`) and `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`. Discarding a response neither rolls back executed tools nor restarts the Turn.

Goal requests check the shared budget and known usage before retrying. A failed or timed-out request with unknown usage retains its reservation and blocks the Goal with usageUnknown, without watchdog backoff or finite completion retries. The Turn error preserves both `GOAL_USAGE_UNKNOWN` and the original request failure so usage checks do not hide endpoint, authentication or timeout diagnostics. Summary requests follow the same rule: the previous checkpoint is retained without a degraded replacement. Metered HTTP requests disable internal transport retries so one reservation cannot hide multiple requests.

`max_completion_retries` defaults to 0 and enables finite recovery for classified length truncation, invalid tool indices or empty completions (reasoning alone is not a final answer). With the watchdog disabled, classified network failures also use this finite allowance. Tools execute only after a complete successful stream; UNKNOWN, persistence errors, cancellation and overall deadline errors are never replayed.

Missing/null Chat tool indices, non-integer types, negative values, values outside u64, and non-object fragments produce a typed internal protocol error. Only finite completion recovery accepts it; the network watchdog and Workgroup inference checkpoints do not. Core never guesses indices or fragment ownership. Count, argument and buffer budget errors are not automatically retried. Recovery discards the failed response from model history while retaining confirmed tools, steer input and observed usage. Parsing errors propagate immediately after queued events; parsed usage from the same or earlier events is counted once, and clean EOF preserves the original error type.

Rust `Model::chat_with_limits(messages, tools, purpose, ToolCallLimits, cap)` passes request budgets explicitly through the HTTP adapter, shared pool and Worker wrappers. The optional output-token cap is forwarded together with tool budgets through Goal metering. Its default delegates to `chat_limited`, which preserves existing custom Model implementations and rejects unsupported nonempty caps; custom adapters bound their own internal buffers, while Engine checks their emitted calls before execution. Summaries have a zero-call budget. `Limits` gains `max_tool_buffer_bytes`; `NativeFactory`/`NativeExecutor` gain `tool_call_limits`, requiring updates to explicit struct initializers. Constructors provide defaults. No client protocol methods or snapshot format change.

Compaction retains the original goal and recent content without splitting completion/tool-result or opaque-reasoning boundaries. Summaries are at most 16 KiB with throughItemId and a persisted checkpoint. Network failures retry the same summary input without consuming validation attempts. Empty or pseudo-tool summaries get one retry; subsequent failure permits explicitly marked DEGRADED CONTEXT only if it reduces input, otherwise the Turn fails. Cancellation preserves the old checkpoint. Compaction never deletes history, journals or Turn tool state.
With `limits.context_compaction_enabled=false`, exceeding an automatic threshold fails the Turn and explicit `areal/context/compact` returns an error without writing a checkpoint. See [context limits](../guides/configuration.en.md#models-and-limits).

Model audits in `data_dir/model-requests/*.json` and `requests.jsonl` record solve/summary, parameters, body digest/size, attempts, usage, stopReason, duration and bounded response shape, without headers, endpoints or prompts. `usageObserved=true` means a complete parseable usage event was received, including zero; missing/false is not known zero. A length termination still collects same-frame/tail usage within deadlines and cancellation, then marks truncation and prevents tool execution.

Transport failures, HTTP error statuses and non-SSE responses before stream consumption are also recorded as `outcome=failed`, with sanitized diagnostics in `error`. Non-SSE responses suggest checking the full API endpoint, without recording error-page bodies or raw response headers. Cancelled or unfinished requests remain `interrupted_or_unfinished`.

Tool error audits add `errorCode` and `toolCallError`: `invalid_tool_call_index` includes a fixed reason, protocol, field path, one-based SSE data-event number, index JSON type and buffered call count; `tool_call_budget_exceeded` includes budget kind, limit and observed value. Fields contain only fixed labels and bounded numbers, never copied SSE, arguments, reasoning or invalid field values; the same record supplies the local `requestId`. The existing `responseShape.toolArgumentBytes` name counts validated ID/name/argument bytes together.

Snapshots are written in format 9 and formats 1–9 can be read; older Core cannot read new snapshots. contextCheckpoint affects model input without deleting original history. modelContext retains opaque Responses context, not user content. Missing usage/duration is unknown, not zero.

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

| Tool | Parameters |
|---|---|
| `agent_spawn` | `{prompt,maxModelRounds?}` |
| `agent_read` | `{threadId,offset?:0}` |
| `agent_wait` | `{threadId,timeoutMs?:10000}` |
| `agent_wait_any` | `{threadIds,timeoutMs?:10000}` |
| `agent_report` | `{summary,evidence,remaining}` |
| `agent_send_input` | `{threadId,prompt}` |
| `agent_cancel` | `{threadId}` |

prompt is nonempty, at most 32000 characters and subject to the input-byte budget. maxModelRounds is 1–1024 and cannot expand the parent limit; the final round is handoff-only. wait timeout is 0–60000 ms without cancellation. wait_any accepts 1–16 distinct direct children. report is child-only: summary up to 4096 characters, two arrays of up to 16 entries/512 characters each, at most 16 KiB serialized arguments.

Snapshots contain status, settled, text, offset/nextOffset, source/sourceItemId, partial and errors. Text pages contain at most 2048 UTF-8 bytes; restart from 0 when the content source changes. settled confirms task and cleanup settlement. Reports do not turn failure into success. Targets are bound to the parent Turn; cross-root/sibling/ancestor control is forbidden.

Model-spawned tasks join before normal parent completion. Manual `areal/agent/spawn {parentThreadId,input}` cancels descendants when the parent ends; `areal/agent/list` observes with pagination. Default depth/fan-out are 8/64; either set to 0 disables tools. See [admission design](../design/multi-agent.en.md).

Optional research mode replaces default model agent tools with `delegate_tasks`, `read_agent` and `cancel_agent`; see [configuration, asynchronous results and reports](../guides/tools.en.md#research-agents). It does not change the client `spawn_child` RPC. Restoring `source=nativeResearchAgent` reapplies read-only source access and built-in-tool restrictions.

Embedded `RuntimeConfig.command_scratch` may name a separate directory but must not contain workspace or Core data. Runtime must explicitly grant `workspace://scratch`. Shared research budgets cover one Engine lifetime; restart starts a new budget lifecycle.

<a id="workgroups"></a>
## Workgroups and embedding

Service methods are `areal/workgroup/policy/start/list/read/wait/cancel/revise/artifact`. start takes `{requestId,plan,workers?,admission?}`; wait takes `{id,afterRevision,timeoutMs}`; revise takes `{id,requestId,expectedRevision,plan}`; artifact takes `{id,path?,offset?}`. See the [schema](../../schemas/areal-core-v1.json) and [usage guide](../guides/workgroups.en.md).

State revision and planRevision are separate. Revisions affect unstarted tasks or appended nodes and preserve original checks/grants. Identical owner/requestId and parameters return the original group; changed parameters conflict. Models control only their current Turn's groups. Waits are limited to 60 seconds without blocking cancellation on the connection. Four of 16 in-flight slots are reserved for control. Only verified artifacts with confirmed cleanup are readable.

Rust interfaces live in [Engine](../../core/engine/src/lib.rs), [concurrency](../../core/engine/src/concurrency.rs) and [Workgroup](../../core/engine/src/workgroup/mod.rs). Embedders own Runtime, MCP Connections, PluginHost and Service lifecycles. Await Engine shutdown before closing hosts; Drop is not asynchronous cleanup. A Service's parent Engine and Factory should share a SharedModel pool.

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
| `areal/goal/create` | `objective, tokenBudget?, maxTurns?, maxActiveSeconds?, interactionMode?` | Create on an idle root Thread without pending input and atomically accept the first Turn; an uncleared Goal conflicts |
| `areal/goal/update` | `goalId, objective?, tokenBudget?, maxTurns?, maxActiveSeconds?` | Edit after stopping and cleanup; retain identity and usage without starting execution |
| `areal/goal/pause` | `goalId` | Persist paused, pause the user queue and request cancellation; cleanup may still be running when the response arrives |
| `areal/goal/resume` | `goalId` | Validate budget, UNKNOWN and hosts, then resume; wait for active-Turn capacity if needed; only queue pauses caused by Goal pause/Stop are resumed automatically |
| `areal/goal/clear` | `goalId` | Require stopped execution, no active Turn, pending input or unsettled resources; increment control revision and retain historical attribution, evidence and accounting |

objective is 1–4000 Unicode characters and cannot be whitespace-only. Budgets are positive integers. maxTurns includes the first root Turn; maxActiveSeconds counts root-Turn model queues, execution, tools, interactions and cleanup without adding child duration or capacity waits between Turns, paused time or offline time. Omitting tokenBudget at creation leaves tokens unlimited by the Goal. For updates, omitted fields retain values and explicit null removes the Goal token limit; deployment limits still apply. Only client control can raise limits. update needs at least one field. completed Goals are read-only; clear/create starts a new Goal.

resume retains all usage and cannot bypass exhausted limits or resume completed Goals. It acknowledges conservative reservations for unknown model consumption without deleting them or restoring accountingComplete=true. Tool UNKNOWN still requires independent inspection and acknowledgement. Ordinary `thread/resume` restores subscriptions and snapshots without resuming Goal execution. Only the queue pause owned by that Goal pause can be cleared by Goal resume.

The projection contains `threadId`, `revision`, `eventSequence` and `goal`. A Goal contains `id`, `threadId`, `objective`, `status`, `reason`, budgets/usage, `activeTurnId`, `settling`, `waitingForInput`, `waitingForAgents`, `waitingForCapacity`, latest `report`/`reportTurnId` and `unreportedTurns`. Status is active/paused/blocked/completed/budgetLimited/failed. Control changes advance revision; persistent projection changes advance eventSequence. get and atomic resume include current usage; events are not emitted per token. State and receipts are persisted before events. A save failure emits in-memory failed/SystemError and recovery remains conservative.

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
| `goal_update` | `{expectedRevision, status, summary, evidence, remaining, blocker?}` | Current root Goal Turn only; continue/complete/blocked reports progress or requests settlement |

Core binds Goal/root identity. summary is nonempty and at most 4096 characters; evidence and remaining each allow 16 entries of at most 1024 characters, with at most 32 KiB total arguments. complete requires nonempty evidence and empty remaining; blocked requires a nonempty blocker describing the obstacle and resolution. Evidence is model-reported text referencing tools, checks or artifacts, not independent semantic verification. Core checks report structure, unconsumed verification handles, pending input and child/Workgroup settlement; actual checks and model reporting still determine business correctness.

`goal_update` returns the accepted control revision. complete remains pending until the Turn settles normally. User control, steer or queued input invalidates the previous completion request; cleanup, persistence or child failure cannot publish completed. Models cannot create, resume, raise budgets or clear Goals, bypass approvals, or finish a Goal through ordinary final text or Turn completion.

Rust embedders use `Limits.goals: goals::Policy` and `Engine::goal_get/goal_create/goal_control`. Custom Model implementations must explicitly support per-request output caps in `chat_limited` and preserve accounting via `share_context`; the HTTP adapter supports both. Custom Workgroup Factories must implement `executor_for_goal` and retain the supplied Budget; the default rejects Goal calls. Ordinary Turns and standalone Workgroups retain their existing behavior.

Goal request ledgers are stored at `goals/<goal-id>.json`, with reservations persisted before sending. Root/child Agents, native Workgroups and active-Turn summaries share accounting. Each ledger permits 4096 requests/4 MiB; clear retains ledgers and history. Snapshot format 10 stores Goals, Turn attribution, reasoning Items and Task interaction policy and cannot be read by older binaries; the API remains areal.core.v1.

Task Mode adds foreground/scheduled/background Tasks, TaskRuns and independent Channels/Inbox above Goals. Goal create also returns taskId/runId. ask_user_question may choose mode=async inside a Goal; headless never waits for users. See the [Task contract](tasks.en.md) for APIs, budgets and recovery. timeUsedSeconds is the union of coordinator Turn and TaskRun worker activity; pure asynchronous user waiting is excluded.
