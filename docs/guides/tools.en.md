[中文](tools.md) | **English**

# Tools and hooks

Core's registry binds names and JSON Schemas to built-in, command, client, MCP or plugin backends. Core validates inputs and outputs; Runtime handles local execution. Full model-tool schemas are in [tools.rs](../../core/engine/src/tools.rs).

| Tool | Key parameters and boundaries |
|---|---|
| `read_file` | `path,offset?=1,limit?=120`; UTF-8 lines, line numbers, nextLine/eof, whole-file digest and fileVersion; at most 1000 lines/about 14 KiB |
| `search_files` | `pattern,path?=".",glob?,context?=2,limit?=50`; rg regex, context ≤10 and limit ≤100; respects gitignore without following symlinks |
| `image_read` | `path,maxDimension?=2048,crop?`; PNG/JPEG/WebP, up to 8 MiB/32 MP; downscales only and returns actual Core Blob image content |
| `fs_read/list/stat` | Relative paths or workspace URIs; read offset defaults to 0, maxBytes defaults/caps at 8192, returning a whole-file digest/version; list defaults to 100, maximum 256 |
| `fs_create` | `path,text`; create only if absent |
| `fs_write` | `path,text,fileVersion?/expectedSha256?`; omitted version uses the current Turn's last observation, or create-only if unobserved |
| `fs_apply_patch` | `path,oldText,newText,fileVersion?/expectedSha256?`; old text must be nonempty and match uniquely |
| `run_command` | Exactly one of `command` or `argv`; command uses `/bin/bash -o pipefail -c`, argv runs directly; cwd defaults to `.` |
| `verify_command` | `argv,cwd?,timeoutMs?,yieldMs?`; direct execution, rejects shell entry points and requires separate scratch |
| `read_process/write_process/terminate_process` | Current-Turn process handles for continued reads, input and termination |
| `task_state` | `{}`; bounded observations of files/processes/children/scratch and summaryThroughItemId, without live probes |

Files are limited to 8 MiB and individual writes/patches to 64 KiB, also constrained by the 64 KiB total argument budget. Explicit fileVersion and expectedSha256 are mutually exclusive; null SHA means create-only. Successful edits return a new version and normalized path. Shell/external edits do not refresh observations; reread after CAS conflicts. Use fs_read for long lines. read/search execute Python/rg in the same Scope with a 15-second deadline, requiring `/usr/bin/python3` and rg on PATH without widening the sandbox.

Each complete model response permits at most 16 sequential calls. Tool results are at most 16 KiB; argument errors and known command failures return to the model, while UNKNOWN stops execution. Results report remainingToolCalls, with a wrap-up reminder at ≤32.

`verify_command` writes complete output (up to 64 MiB) and a receipt under scratch/verification, including exit status, logs and before/after source fingerprints. Fingerprints cover Git tracked/unignored files, or a fallback walk excluding dependencies/build/cache. Source changes invalidate verification. Task-writable receipts do not authenticate hostile tasks. Pending verification processes receive bounded finalization feedback requiring a terminal read or explicit termination. Ordinary background run_command processes are exempt; this does not wake completed Turns.

## Waiting and state

Command timeoutMs defaults to 600000, capped by Runtime grants and reported as effectiveTimeoutMs. Commands/continued reads default to 120 seconds and PTYs to 1 second. `yieldMs` / `waitMs` accept nonnegative u64 values; 0 returns immediately. Waits do not extend process deadlines or hold model permits and collect at most 2 KiB. No output continues waiting; received output is coalesced with 100 ms of silence, using underlying polls of at most 1 second.

`returnReason` is completed, waitBudget, outputLimit, outputLoss or outputQuiet. `commandStatus` is running/succeeded/failed/terminated. `outputReadComplete` / `outputClosed` mean the producer closed and retained output was drained; `outputIntegrity` is retained/incomplete and `nextAction` suggests follow-up. completed still requires checking exit status. gap/truncated continue to mean loss after draining.

Omitted read_process after resumes the last cursor returned in this Turn; explicit null rereads earliest retained output. Short process/cursor/fileVersion handles bind to the Turn and target. Core expands them before Runtime permission checks; malformed handles return recoverable errors without guessing. Caches hold at most 128 file versions and one current cursor alias per process; old explicit cursor aliases expire. task_state observedOnly=true identifies historical observations, not current facts. Compaction retains these caches; Turn completion or restart expires them.

## Extension configuration

Set `[tools] extensions_file="tools.json"` in user TOML. JSON may contain policy, tools, hooks, mcpServers, plugins and agents. It is limited to 1 MiB, validated at startup and never implicitly loaded from the workspace. See runnable plugin [tools.json](../../core/sdk-typescript/examples/tools.json) and the [MCP guide](mcp.en.md).

Command definitions are `{definition:{name,description,inputSchema,outputSchema?},argv,timeoutMs}`. The registry allows 128 tools total, with unique 1–64-character ASCII letter/digit/underscore/hyphen names. Schemas use Draft 2020-12 without external `$ref`; input roots are objects and schema defaults are not injected.

Commands run at workspace root, reading one parameter JSON line without waiting for EOF. stdout contains one [DynamicToolResponse](../api/core.en.md#dynamic-tools); diagnostics go to stderr. Exit 0 with success=false is a confirmed business failure. Nonzero exit, timeout, truncation or malformed results may follow side effects and become UNKNOWN. stdout/stderr are each limited to 16 KiB. argv has no implicit shell or variable expansion.

## Hooks

At most 64 unique names, configured as `{name,event,matcher,argv,timeoutMs}`. matcher is an exact tool name or `*`. Hooks run in order without recursion.

| Event | Response |
|---|---|
| PreToolUse | After input validation, allow/block or updatedArguments; rewritten input is validated again |
| PostToolUse | After confirmed success, allow only; cannot rewrite results or undo effects |
| PostToolUseFailure | After confirmed failure, allow only; no automatic retry |

Input is one `{event,threadId,turnId,callId,tool,arguments,result}` line. Output may contain decision (default allow), reason and updatedArguments. Initial rejection, pre-hook blocking and UNKNOWN skip post hooks. Tools and hooks have separate journals, so a crashing post hook does not erase a confirmed tool outcome. Inspect UNKNOWN before recording acknowledgement.

Client tool hosts own their side effects; TUI/Web do not execute arbitrary callbacks. See [plugins](../design/plugins.en.md) and [MCP](mcp.en.md) for trusted-host boundaries.

<a id="research-agents"></a>
## Optional research agents

An explicit agents entry in extensions JSON replaces default model agent tools with `delegate_tasks/read_agent/cancel_agent`. It is disabled by default and does not change the client spawn_child RPC.

```json
{"agents":{"maxModelRequests":256,"maxToolCalls":512,"maxWorkerModelRequests":48,"maxWorkerToolCalls":96,"workerTimeoutSeconds":1200}}
```

This requires Runtime, separate task scratch and nonzero max_children_per_turn/max_agent_depth. For example, use model_concurrency=4, max_active_turns=4, max_children_per_turn=3 and max_agent_depth=1. Child admission is cumulative per parent Turn and is not refunded; Workers cannot delegate. Model requests (including summaries/completion recovery) and tool budgets are shared for one Engine lifetime with additional Worker caps; restart resets counters. Internal HTTP retries use model settings. This is not an exact global token limit.

| Tool | Contract |
|---|---|
| `delegate_tasks` | `{tasks,wait?=false}`; 1–3 strings or `{prompt}` objects, each prompt ≤16000 characters; returns immediately by default, true waits for all terminal states |
| `read_agent` | `{threadId,waitMs?=0}`; waits 0–60000 ms and returns the current bounded report |
| `cancel_agent` | `{threadId}`; cancels and awaits settlement; repeatable for ended tasks without refunding quotas |

Dispatch returns requested/started/allAccepted, reports[], rejected[], asynchronous and advisory=true/sourceWriter=parent. Partial admission retains all started handles and explains rejected input indexes; zero admission fails. Reports contain actual status, reportKind=final/partial/none, up to 3000 UTF-8 bytes of report, truncation markers, up to 512 bytes of error.message and usage. Child usage is not double-counted in the parent. Only completed Turns yield final reports. Handles control only children created by the current parent Turn and cannot cross Turns/restarts. Parent completion automatically cancels and awaits unfinished Workers.

**Compatibility: omitted wait now means asynchronous dispatch; callers requiring the previous synchronous behavior must pass wait=true.** Worker failures are reported for parent handling; unconfirmed cleanup or persistence still fails the parent.

The parent is the sole source writer. Workers share model settings but have independent context and built-in tools, writing only `workspace://scratch/agent-<thread-id>`. TMPDIR and verification receipts use that directory; Runtime Scope/OS sandbox enforce read-only source access. Workers inherit no command extensions, hooks, client callbacks, MCP or plugins. Full history lives in a separate Thread; source=nativeResearchAgent restores the same permissions. There is no source snapshot isolation or multiwriter merge, so the parent must verify reports and final results.

The model chooses delegation timing, count and content without fixed phases or case-ID branches. Empty scratch for rejected Workers is rolled back using remove_dir only. Admitted scratch retains evidence for caller collection/cleanup; cancellation reclaims execution resources only. See [general](../../core/engine/src/instructions.md), [delegation](../../core/engine/src/agent-instructions.md) and [compaction](../../core/engine/src/summary-instructions.md) instructions.
