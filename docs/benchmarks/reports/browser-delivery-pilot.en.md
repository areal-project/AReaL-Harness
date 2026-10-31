[中文](browser-delivery-pilot.md) | **English**

# Local HTML and browser task pilot validation

HTML reply links open in the built-in Browser. Agents use `openDocument` to approve a file scope and reveal the result without focusing a background chat. See the [Browser API](../../api/browser.en.md) for behavior and file scopes.

Source Electron passed 25 document protocol assertions and six desktop checks with normal application shutdown. The existing Browser Core regression passed 33 checks with matching source hashes. Eight Rust approval tests, 76 Browser contract tests and 25 task/cleanup tests passed. Type checking and the GUI build passed.

The six-task pilot starts from a new chat. Core-approved `describe` creates the native page. In the final run, all five ordinary tasks completed. The stop task confirmed authoritative interruption, stable side effects during the observation window, no new approvals and no model request in flight. All six instances cleaned up, and source/artifact checks matched before and after. The [structured summary](browser-delivery-pilot.json) retains each run's status and raw evidence locations.

Unfavorable debugging results remain available. A dynamic tool in the static Profile, an unsupported public create field and manual page warmup each blocked setup. The fixture then mistook trailing runtime context for a tool receipt, causing six stream failures. The next run passed ordinary tasks but continued answering approvals after Stop, producing UNKNOWN. Fixes were checked against the actual input validator, production plans, persisted receipts and stop boundaries. Answers and grading conditions were not relaxed to accept failures.

This run uses a deterministic local model and establishes pipeline and source-desktop behavior only. Real providers, autonomous HTML generation followed by opening, packages and other platforms remain unverified. It establishes no Agent efficiency or general capability gain. See the [methodology](../methodology.en.md) for real-mode budgets, auxiliary requests and retry layers. Further optimization requires fixed-model, fixed-budget comparisons of task success, request/token costs and elapsed time, with stop safety reported separately.
