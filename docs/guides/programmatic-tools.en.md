[中文](programmatic-tools.md) | **English**

# Programmatic tool calling

`ToolPolicy.programmatic_tools` (JSON `programmaticTools`) defaults to true. When a Runtime and native tools are available, it adds `tool_program`: JavaScript can consume returned values in subsequent arguments, branches, loops, process waits and selected observations. Native tools remain directly visible by default; the program catalog lists names without duplicating their schemas. `programmaticToolsOnly` defaults to false, requires the former option and moves the same native schemas into the program catalog. This changes model exposure without granting tools or filesystem authority.

```json
{"policy":{"programmaticTools":true,"programmaticToolsOnly":false}}
```

Set `programmaticTools:false` to restore native-only tool exposure. Save this JSON to the file named by `[tools] extensions_file`. Ordinary mode and old histories remain compatible. Exhaustive Rust `ToolPolicy` literals must supply both fields or use `..ToolPolicy::default()`.

## Execution and observations

`tool_program({code, timeoutMs?})` runs top-level await in a fresh QuickJS context. There is no Node, filesystem, network, module import, timer or cross-call state. File and process operations must use declared native tools. Every child follows the original Core/Runtime schema, permissions, hooks, file versions, budget and journal. The catalog contains currently visible built-ins and `read_history/read_tool_result/edit_files`; recursive programs, MCP and delegation are excluded.

After reading the files and choosing the edits and test entry point, compose edits, verification and bounded collection. Return to the model for unexpected failures, conflicts, permissions, UNKNOWN or visual judgment; do not install dependencies or choose new plans inside a loop. With no independent work, use the normal wait budget instead of explicit one-second status turns.

```javascript
const e = await tools.edit_files({files:[{path:'src/a.py',patches:[{oldText:'old_a',newText:'new_a'}]},{path:'src/b.py',patches:[{oldText:'old_b',newText:'new_b'}]}]});
text(e);
if (e.success && e.data.allApplied) {
  await collect(await tools.run_command({argv:['python','-m','pytest','tests/test_feature.py','-q']}));
}
```

`tools.NAME(args)` returns `{success,outcome,callId,itemId,data,text,availableImages}`. `data` is parsed native JSON and `text` retains its text. Calls complete serially: await is supported and Promise.all does not increase native concurrency. `text(value)` selects observations. For parsed JSON, `text(nativeResult)` displays only `{itemId,data}`; identity, outcome and errors remain in mandatory child receipts, and the original object including `data/text` is unchanged inside the program. Identical displays of the same native result object are emitted once per program, including text() after collect(); a changed object produces a new display; `image(nativeResult)` forwards actual images from this parent's children only. Return observations when new visual or business judgment is required. Each child's outcome and native `commandStatus/outputReadComplete/processId` are mandatory receipts and cannot be hidden by filtering.

`await collect(processResult, {timeoutMs?, maxReads?})` collects only the supplied process through existing `read_process` calls. It never starts or retries a command. It displays each observation and returns the last native result; another `text()` is unnecessary. Defaults are 540000 ms total and 16 reads, with explicit ranges of 0–1800000 ms and 0–64 reads. Remaining program time, native-call limits, cancellation and shared budgets still apply. It finishes on process exit plus drained output and returns immediately on failure. Bounds or an exited process with no cursor progress retain the actual state, cursor and stopping reason, without inferring evidence sufficiency or test success. Do not use it when an interactive prompt needs judgment first or independent work is available.

Original observations remain in separate `DynamicToolCall` items linked by the optional `ToolExecution.parentCallId`. Model history contains only the model's actual parent function call and its result, never fabricated child calls. `read_history(itemId)` retrieves a recorded child. Native paging and snapshot limits remain; unread process output never becomes observed implicitly.

## Budgets, failures and recovery

Each program allows at most 64 child calls, 64 KiB of code or child arguments, 64 MiB interpreter memory, a 512 KiB stack, 1 MiB of selected text measured in actual UTF-8 bytes and four image selections. Wall time defaults to 600 seconds; `timeoutMs` accepts 1–1800000. Original Turn deadlines still apply. Parent and children share tool, output and Agent budgets; filtering does not waive execution cost. CPU interrupt checks bound infinite loops.

Selected text above 16 KiB is saved as complete JSON before displaying a marked preview and `read_tool_result` reference. Display limits do not abort subsequent steps. All child outcomes, process receipts and actual images remain complete. If storage or retrieval is unavailable, retain the original bounded result under the shared output budget. Exceeding the 1 MiB archive limit remains an explicit error with completed effects retained.

Scripts may inspect known failures explicitly. UNKNOWN, cancellation and exhausted shared budgets stop dispatch even when caught. Completed effects remain and nothing is retried automatically. Cancellation settles admitted children and exits the interpreter. Core restart reconstructs receipts and preserves uncertain outcomes as UNKNOWN, without restoring JavaScript state or replaying code.

This implementation supports result-dependent composition and selected observations, excluding Codex's cross-model-round yield/wait cells and parallel leaf scheduling. These capabilities do not imply complete product compatibility. Fewer model calls need not mean lower tokens or latency: code, catalogs, mandatory receipts, extra reads and failures can offset savings. Saved-trajectory replay can verify deterministic recovery errors and projection overhead; regressions with an identical operation set exclude early-failure speedups. Separate mechanism evidence from real model adoption, cache hits and task quality. Cross-task capability claims follow the [evaluation methodology](../benchmarks/methodology.en.md).

Known file ranges can be read in one program with `for (const path of paths) text(await tools.read_file({path,offset:1,limit:80}));`. Return content with `fileVersion/nextLine`; unfamiliar code still requires model interpretation. At the loop or time bound, preserve the actual process state, handle and cursor. `edit_files` also works directly with PTC disabled; existing file tools remain compatible; see the [tool contract](tools.en.md). Batch containers and each leaf count against the 64-call program bound and Turn tool budget; admission conservatively reserves the requested maximum number of leaves.

## Compact interaction candidate

`policy.compactTools:true` exposes reads, search, `edit_files`, commands/verification, process interaction, images, environment facts and raw-result retrieval. `tool_search` discovers other authorized native capabilities by name/description; matching schemas appear on the next model request and reset each Turn. Low-level files, recovery, skills, services and collaboration remain registered under existing permissions/allowlists. Batch edits dispatch native children internally. If an allowlist excludes discovery, the original surface remains available. MCP `lazyMcpSchemas` is independent.

Compact mode uses shorter instructions and program descriptions with the same executor. `programmaticTools` is independently configurable, without model-name routing. `programmaticToolsOnly` moves schemas into the program description; fewer entry points do not imply fewer input tokens. Merge this explicit candidate fragment into existing extensions, preserving tools/hooks/permissions:

```json
{"policy":{"compactTools":true,"programmaticTools":true,"programmaticToolsOnly":true,"programmaticDirectTools":["edit_files"],"resultViews":{"repeatedObservations":true}}}
```

Evaluate final request size, actual adoption, provider input/cached/output tokens and all summary/recovery subrequests separately. Deterministic replay establishes execution invariants, not real model adoption.

Program results distinguish `programCompleted` (interpreter completion), `allChildrenSucceeded` (every native child succeeded) and `pendingProcesses` (deduplicated using the latest receipt per process). Outer success is true only when both the interpreter and every child succeeded. Later success cannot erase earlier failure; expected failing controls remain recorded as failures for model interpretation. This result-contract change does not automatically block explicitly composed later steps or add retries.

Use [compact-composition.json](../../examples/tool-profiles/compact-composition.json) for mixed interaction: large file creation stays in direct `edit_files`; after allApplied, compose selected execution and collection in a program. Small patches can share a program with their checks. `collect` displays observations automatically, avoiding handwritten polling and duplicate text(). Defaults are unchanged. [compact-programmatic.json](../../examples/tool-profiles/compact-programmatic.json) remains a program-only control: moving schemas into descriptions can increase fixed input and quoting/recovery costs. A smaller menu is not evidence of efficiency. Compare final instructions, schemas, history, cached and uncached input separately; removing highly cached mechanical turns also changes the hit ratio.

`programmaticDirectTools` (empty by default) retains up to 16 distinct native direct entries with `programmaticToolsOnly:true`. It only intersects the currently visible, authorized catalog and cannot expose hidden tools. Direct definitions are not duplicated in the program catalog; `tools.NAME` calls remain available. A nonempty list without only mode is rejected. The explicit composition profile uses `programmaticDirectTools:["edit_files"]` to keep full source in JSON while routing decided reads, execution and collection through the program entry. For a broader direct surface, explicitly select only=false and an empty list; adoption and net cost still require separate validation. Exhaustive Rust `ToolPolicy` literals must include the new field or use the default update.
