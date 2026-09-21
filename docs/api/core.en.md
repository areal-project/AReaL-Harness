[中文](core.md) | **English**

# Core API

Core implements a subset of pinned Codex app-server 0.145.0 plus AReaL extensions, not full official-client compatibility. See the [baseline schema](../../schemas/app-server/codex-0.145.0.json) and [desktop API](desktop.en.md) for authentication and product extensions.

## Transport and sessions

Each WebSocket text frame carries one request, response or notification, up to 4 MiB. Requests are `{id,method,params}` with string/integer id and object params. jsonrpc is optional; responses contain either result or error; batches are unsupported. Request initialize, then send initialized.

| Method | Parameters |
|---|---|
| `model/list` | `{}` |
| `thread/start` | `{cwd?,model?,dynamicTools?}` |
| `thread/list` | `{cursor?,limit?}`; 1–100, default 30 |
| `thread/read` | `{threadId,includeTurns?}` |
| `thread/resume` | `{threadId}` |
| `turn/start` | `{threadId,input}` |
| `turn/steer` | `{threadId,expectedTurnId,input}` |
| `turn/interrupt` | `{threadId,turnId}` |

Core owns stable Thread/Turn/Item IDs and history. read does not subscribe; resume atomically snapshots and subscribes, returning the baseline before subsequent events. Each connection permits 128 subscriptions, a 256-item send queue and 128-event Thread windows. Lag disconnects consumers; reconnect and resume again. Observer disconnection does not cancel tasks.

input preserves text/image/audio/file ordering with at most 1 MiB aggregate UTF-8 text, also constrained by the history budget. Authenticated clients upload media Blobs rather than supplying host localImage/localAudio paths. Adapter/model capabilities validate modalities. Original thread/start model must match the service default; product model selection uses areal/thread/start/configure.

Events include thread/started, turn/started/completed, item/started/completed and item/agentMessage/delta; AReaL media uses areal/item/agentMedia/available. Terminal completed/interrupted/failed state is published after persistence. steer preserves emitted text, cancels the current model request and continues within the same Turn.

<a id="recovery"></a>
## Execution and recovery

Tools execute only after complete model-stream termination. dynamicToolCall retains original arguments, effectiveArguments, callId, execution backend and running/succeeded/failed/cancelled/unknown outcomes. Local tools also record epoch/scope/operationId; external tools do not invent Runtime facts. Hooks and nested plugin operations have separate journals; outer failure does not erase confirmed writes.

Confirmed argument/schema errors can return to the model for correction. Persistence failures and UNKNOWN stop automatic execution. `areal/tool/acknowledge {threadId,itemId,inspection}` records 1–1024 bytes of inspection while idle. It preserves unknown history without replay or expanded grants.

`execution.backend` is runtime/command/client/mcp/plugin/agent/coordination/core. Optional `modelArguments` stores replay arguments after hooks but before Runtime ID expansion; `effectiveArguments` retains real IDs for audit and is the fallback for older records. Replay keeps one assistant text/tool-call batch per completion followed by ordered tool results. Tool images follow the batch as user images linked to callId. Chat reasoning is archived without replay; opaque Responses context preserves order.

`Limits.watchdog_disable` defaults to false. Core retries the current model request without a retry count limit for classified network failures: transport errors, HTTP 408/429/5xx, premature EOF, request/stream idle timeouts and explicit SSE rate-limit/unavailability errors. Length, empty-answer, authentication, quota and parameter errors are not network failures. See the [configuration guide](../guides/configuration.en.md). Root Agents, child Agents and independent Workgroup Engines inherit the host switch. Embedded callers pass Limits explicitly; Engine never reads process environment variables. Rust `Limits`, `NativeFactory` and `NativeExecutor` gain a `watchdog_disable` field, so explicit struct initializers must be updated. `Limits::default()` and `NativeExecutor::new()` enable the watchdog.

The watchdog keeps the same messages, tools, sampling parameters and model round. It does not consume `max_completion_retries` or reserve another Agent logical-request slot; Workgroups still account for each physical request and enforce deployment budgets. Backoff starts at 250 ms and doubles up to 30 seconds. Failed streams release their shared model permits before waiting, and cancellation and overall deadlines remain effective; solve requests also respond to steer. Core audits and discards the failed response's text, context and unexecuted calls, restores its output-byte allowance, and retains earlier executed tools and observed usage. Events are `areal/model/completionDiscarded` (new `retryKind=network|completion`) and `areal/model/watchdogRetry {threadId,turnId,purpose:solve|summary,retry,delayMs}`. Discarding a response neither rolls back executed tools nor restarts the Turn.

`max_completion_retries` defaults to 0 and enables finite recovery for classified length truncation or empty completions (reasoning alone is not a final answer). With the watchdog disabled, classified network failures also use this finite allowance. Tools execute only after a complete successful stream; UNKNOWN, persistence errors, cancellation and overall deadline errors are never replayed.

Compaction retains the original goal and recent content without splitting completion/tool-result or opaque-reasoning boundaries. Summaries are at most 16 KiB with throughItemId and a persisted checkpoint. Network failures retry the same summary input without consuming validation attempts. Empty or pseudo-tool summaries get one retry; subsequent failure permits explicitly marked DEGRADED CONTEXT only if it reduces input, otherwise the Turn fails. Cancellation preserves the old checkpoint. Compaction never deletes history, journals or Turn tool state.

Model audits in `data_dir/model-requests/*.json` and `requests.jsonl` record solve/summary, parameters, body digest/size, attempts, usage, stopReason, duration and bounded response shape, without headers, endpoints or prompts. `usageObserved=true` means a complete parseable usage event was received, including zero; missing/false is not known zero. A length termination still collects same-frame/tail usage within deadlines and cancellation, then marks truncation and prevents tool execution.

Snapshot format 5 reads formats 1–4; older Core cannot read new snapshots. contextCheckpoint affects model input without deleting original history. modelContext retains opaque Responses context, not user content. Missing usage/duration is unknown, not zero.

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
