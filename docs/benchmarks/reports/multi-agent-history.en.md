[中文](multi-agent-history.md) | **English**

# Multi-agent research archive notes

Earlier research covered a Python prototype, production Rust Workgroups, fixed concurrency widths and Adaptive admission. Different executors, source versions, decompositions and model budgets were measured separately; their results are not interchangeable with current Core performance.

Retained design principles are to use a single-agent baseline, resolve shared writes/dependencies before measuring actual model overlap, include verification/repair costs and avoid assuming that more Workers or Adaptive is faster. The current CLI still defaults to balanced + fixed with 2 Workers; Adaptive remains explicit.

Old controllers, per-attempt data, SQLite measurements and execution receipts have been removed from current source. The earlier experiment reports are consolidated into these notes rather than continuing unsupported speed rankings or obsolete commands. Research history requires the corresponding repository revision and separate confirmation of data availability/redistribution permission. This checkout is not a complete reproduction package for those studies.

See current [Workgroup design](../../design/workgroups.en.md), runnable [tests](../../development/testing.en.md) and [methodology](../methodology.en.md) for new evaluations.
