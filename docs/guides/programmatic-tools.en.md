[中文](programmatic-tools.md) | **English**

# Programmatic tool calling

`ToolPolicy.programmatic_tools` (JSON `programmaticTools`) defaults to true. When a Runtime and native tools are available, it adds `tool_program`: JavaScript can consume returned values in subsequent arguments, branches, loops, process waits and selected observations. Native tools remain directly visible by default; the program catalog lists names without duplicating their schemas. `programmaticToolsOnly` defaults to false, requires the former option and moves the same native schemas into the program catalog. This changes model exposure without granting tools or filesystem authority.

```json
{"policy":{"programmaticTools":true,"programmaticToolsOnly":false}}
```

Set `programmaticTools:false` to restore native-only tool exposure. Save this JSON to the file named by `[tools] extensions_file`. Ordinary mode and old histories remain compatible. Exhaustive Rust `ToolPolicy` literals must supply both fields or use `..ToolPolicy::default()`.

## Execution and observations

`tool_program({code, timeoutMs?})` runs top-level await in a fresh QuickJS context. There is no Node, filesystem, network, module import, timer or cross-call state. File and process operations must use declared native tools. Every child follows the original Core/Runtime schema, permissions, hooks, file versions, budget and journal. The catalog contains currently visible built-ins and `read_history/read_tool_result`; recursive programs, MCP and delegation are excluded.

```javascript
const listing = await tools.fs_list({path: 'workspace://repo'});
text(listing.data);
const first = await tools.fs_read({path: 'workspace://repo/config.json'});
if (first.success) {
    const config = JSON.parse(first.data.text);
    const file = await tools.fs_stat({path: config.outputPath});
    text({output: file.data});
}
```

`tools.NAME(args)` returns `{success,outcome,callId,itemId,data,text,availableImages}`. `data` is parsed native JSON and `text` retains its text. Calls complete serially: await is supported and Promise.all does not increase native concurrency. `text(value)` selects observations. For parsed JSON, `text(nativeResult)` omits the redundant `text` field while both `data` and `text` remain available inside the program; `image(nativeResult)` forwards actual images from this parent's children only. Return observations when new visual or business judgment is required. Each child's outcome and native `commandStatus/outputReadComplete/processId` are mandatory receipts and cannot be hidden by filtering.

Original observations remain in separate `DynamicToolCall` items linked by the optional `ToolExecution.parentCallId`. Model history contains only the model's actual parent function call and its result, never fabricated child calls. `read_history(itemId)` retrieves a recorded child. Native paging and snapshot limits remain; unread process output never becomes observed implicitly.

## Budgets, failures and recovery

Each program allows at most 64 child calls, 64 KiB of code or child arguments, 64 MiB interpreter memory, a 512 KiB stack, 1 MiB of selected text measured in actual UTF-8 bytes and four image selections. Wall time defaults to 600 seconds; `timeoutMs` accepts 1–1800000. Original Turn deadlines still apply. Parent and children share tool, output and Agent budgets; filtering does not waive execution cost. CPU interrupt checks bound infinite loops.

Selected text above 16 KiB is saved as complete JSON before displaying a marked preview and `read_tool_result` reference. Display limits do not abort subsequent steps. All child outcomes, process receipts and actual images remain complete. If storage or retrieval is unavailable, retain the original bounded result under the shared output budget. Exceeding the 1 MiB archive limit remains an explicit error with completed effects retained.

Scripts may inspect known failures explicitly. UNKNOWN, cancellation and exhausted shared budgets stop dispatch even when caught. Completed effects remain and nothing is retried automatically. Cancellation settles admitted children and exits the interpreter. Core restart reconstructs receipts and preserves uncertain outcomes as UNKNOWN, without restoring JavaScript state or replaying code.

This implementation supports result-dependent composition and selected observations, excluding Codex's cross-model-round yield/wait cells, deferred tool discovery and parallel leaf scheduling. These capabilities do not imply complete product compatibility. Fewer model calls need not mean lower tokens or latency: code, catalogs, mandatory receipts, extra reads and failures can offset savings. Saved-trajectory replay can verify deterministic recovery errors and projection overhead; regressions with an identical operation set exclude early-failure speedups. Separate mechanism evidence from real model adoption, cache hits and task quality. Cross-task capability claims follow the [evaluation methodology](../benchmarks/methodology.en.md).
