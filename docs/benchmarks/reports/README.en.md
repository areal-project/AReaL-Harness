[中文](README.md) | **English**

# Historical reports

Historical records do not define current capabilities. Use the [run guide](../README.en.md) for new benchmarks and [methodology](../methodology.en.md) for interpretation.

| Report | Evidence scope |
|---|---|
| [Modeling tool-surface comparison](modeling-tool-surface.en.md) | Ten same-main artifact-workspace pairs; explicit tool selection, all attempts, joint blind reviews and rejected process-image candidate |
| [Conversation directory, pagination and GUI refreshes](conversation-catalog.en.md), [follow-up validation](conversation-catalog-validation.en.md), [memory and SQLite comparison](conversation-catalog-sqlite.en.md), [compact metadata and lazy history](conversation-catalog-lazy.en.md) | Alternating release Engine/RPC comparisons, real GUI cache IO and compatibility regressions; adverse results retained, no overall Agent speedup claim |
| [Completion, read refill and Responses routing](completion-cache-routing.en.md) | Fixed100 comparison; cache fractions converge but30.6% wall gap remains; failures, UNKNOWN and rejected promotion retained |
| [Completion, artifact readiness and policy inheritance](complex-work10-completion-runtime.en.md) | Fixed100 rolling comparison and local GUI installation; corrected protocol relay, two completion timeouts and UNKNOWN usage retained; historical41% is not a causal baseline |
| [Complex-workflow concurrency, shared writes and network recovery](complex-workflow-concurrency.en.md) | Generic mechanisms and actual GUI installation; contaminated100, interrupted6 and final20 kept separate, including remaining tails and UNKNOWN usage |
| [Complex workflow environment, handoff and completion repairs](complex-workflow-repair.en.md) | Eight seen tasks, five repetitions per arm, 80 runs; retained failures, UNKNOWN usage, ambiguous reproduction contract and shared-writer serialization limits |
| [Standard122 after permission repairs](standard122-permission-rerun.en.md) | Two-model 244-task rerun, five failure retries, historical DSH/Codex comparison; failures and incomplete usage retained |
| [Inspection permissions and local tools](inspection-permissions-v2.en.md) | Default read-only, explicit inheritance, writer leases and macOS Git/Bash repairs; failures and UNKNOWN retained |
| [Delegation admission and concurrency](delegation-admission-repair.en.md) | Effective Scope admission, creation locks and quota-race mechanism regressions |
| [Child-result consumption and completion](child-result-consumption.en.md) | Fixed-version Codex/DSH references, observed terminal-result deduplication, late results and compaction; deterministic request counts, no overall speedup claim |
| [Context continuity and persistence](context-continuity.en.md) | Live revisions, repeated compaction, restart and Goal delivery; Chat/Responses and persistence-stage comparison |
| [Bundled search and historical result retrieval](native-result-views.en.md) | 146 attempts, with 18 final ordinary pairs and three MCP retrieval pairs; includes cost/latency regressions, no MM480 rerun |
| [Native tool optimization A/B](tool-optimization.en.md) | 56 targeted attempts with the configured model, including regressions and 12 final pairs; not an MM480 success-rate claim |
| [Five-task Harness comparison](perf-pro-five-report.en.md) | JSON and checkable aggregates for 23 attempts, limited by selection bias, missing usage and private images |
| [Multi-agent research archive notes](multi-agent-history.en.md) | Scope of research observations; old controllers and raw data are not shipped with current source |

Historical speedups are not promises for current source, other models or platforms. Where full traces are not public alongside summaries, complete independent reproduction materials are not claimed.
