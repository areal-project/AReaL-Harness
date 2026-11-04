Combine native operations whose inputs and next steps are already decided. Use direct edit_files for large file bodies; small patches or short helper files can share a program with their selected check. Return to the model for new errors, conflicts, UNKNOWN, permission needs or visual/semantic decisions; no hidden repair, install or retry.

Arguments: input is JSON data (patches, regex, scripts, argv); code is only the JavaScript body, not a tool_program(...) call. JSON escaping still applies; referencing input avoids another JavaScript string-escaping layer. tools.NAME(args) returns {success,outcome,itemId,data,text,availableImages}. text(result) selects evidence; image(result) forwards images. Check success and data.allApplied before dependent execution.

JSON argument examples (use the observed interpreter and selected check):

Small patch + check + bounded collection:
```json
{"input":{"edit":{"files":[{"path":"src/a.py","patches":[{"oldText":"old_a","newText":"new_a"}]}]},"check":{"argv":["python","-m","pytest","tests/test_a.py","-q"]}},"code":"const e=await tools.edit_files(input.edit);text(e);if(e.success && e.data.allApplied) await collect(await tools.verify_command(input.check));"}
```

Regex data, with a literal opening parenthesis:
```json
{"input":{"pattern":"def fit\\(","path":"src"},"code":"text(await tools.search_files(input));"}
```

Short multiline script as data:
```json
{"input":{"argv":["python","-c","print('check')\nassert 1 + 1 == 2"]},"code":"await collect(await tools.verify_command(input));"}
```

Always await collect(processResult, {timeoutMs?,maxReads?}) when only waiting/output recovery remains. It displays each same-process observation; do not text its return again. Defaults: 540s/16 reads, clamped to remaining budgets. Return unfinished handles/cursors at a bound; an exited process is not proof of sufficient verification.

Fresh JavaScript with top-level await; no Node, host I/O, imports, timers or persistent state. Native calls are serial even in Promise.all and retain permissions, versions, hooks and shared budgets. Limits: 64 calls (batch leaves count), 64 KiB combined code/input and per-call arguments, 1 MiB archived text/16 KiB preview, four images; timeout 600s by default, at most 1800s. Cancel/timeout/UNKNOWN stop dispatch. programCompleted, allChildrenSucceeded and pendingProcesses are separate facts; outer success is false if any child failed. Effects persist; recover evidence with read_history/read_tool_result instead of replaying edits.
