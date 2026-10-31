[中文](0015-scheduled-conversation-target.md) | **English**

# Conversation targets for scheduled messages

Status: core product decisions confirmed, not implemented; creation, editing and cancellation boundaries remain open. This design changes the original always-new-conversation rule for scheduled runs, without changing Core ownership of scheduling, history or execution records.

## Decision and trade-offs

New schedules default to reusing the current conversation at creation. When due, they automatically send a message and start the Agent. Messages identify their scheduled origin, and replies continue in the same conversation. The target is a fixed conversation, not whichever conversation the interface displays at trigger time. Execution uses the latest context when work actually starts, under ordinary history and compaction rules, rather than a snapshot from schedule creation.

Settings provide a “Start each run in a new chat” switch, off by default for new schedules. When enabled, each execution creates an independent conversation without automatically inheriting source or previous-run chat history. There is no third mode that creates a conversation once and reuses it thereafter. Existing schedules retain their execution mode; the new default does not rebind them. Completion does not take interface focus.

Reusing a conversation lets continuing work incorporate recent discussion, but later human messages and earlier executions can influence subsequent work. Independent conversations suit periodic checks that do not need history. Both modes retain schedule identity and individual execution records; conversation count is not execution count. New conversations do not isolate working directories or file state.

## Confirmed conflict and invalid-target rules

- If the target is doing other work or awaiting approval, do not interrupt it or inject concurrent work. Show that the message is waiting for the conversation to become idle. Retain at most one pending send per schedule and coalesce triggers arriving while it waits.
- If this schedule's previous execution has already started and remains unfinished, retain the existing rule of skipping subsequent triggers rather than accumulating another run. Pending sends and started executions must be distinct.
- Archiving hides a conversation without pausing its schedules or automatically unarchiving it. If the target is deleted or access is lost, stop delivery and show the reason for user action; never silently switch to a new conversation.
- Once Core and the desktop Host are online again, coalesce missed triggers into at most one catch-up send, showing planned and actual start times. Explicitly paused schedules do not catch up.
- Interrupted executions that already started require explicit user recovery, not automatic replay. Scheduling does not expand approval or permission boundaries.

## Implementation constraints

The current creation tool accepts only the objective and timing rule. Its source conversation must be separate from the execution anchor, and the execution path creates a Thread for a new Run. Target selection belongs in Core's schedule contract and admission boundary, not only in the GUI or by treating the source field as an execution target.

The implementation must distinguish schedule origin, bound target conversation and individual execution identity, while preserving idempotent admission, revision conflict checks and recovery receipts. When human messages and scheduled work share a target, stopping or deleting a schedule must not stop unrelated human work. Exact control semantics remain to be settled below.

Implementation entry points: [creation tools](../../core/engine/src/task_mode/schedule_tools.rs), [desktop scheduling](../../core/engine/src/task_mode/desktop_schedules.rs), and [Task types](../../core/protocol/src/tasks.rs). The currently implemented contract remains in the [Task API](../api/tasks.en.md); this design does not claim runtime support.

## Open decisions

- How creation from the scheduling page establishes a bound conversation when no source conversation exists.
- When edits to the mode switch take effect, and whether arbitrary existing conversations can be selected.
- The relationship between pausing, deleting, cancelling a pending send and stopping an execution.
- Ordering when multiple schedules and human messages wait for the same conversation.
- Whether new-conversation objectives need to be expanded into standalone instructions, and how execution configuration is inherited.

## Post-implementation acceptance boundaries

Verify two successive scheduled sends and human follow-up in one conversation; history isolation in new-conversation mode; coalescing while busy or awaiting approval; no duplicate sends after reconnect; archiving without pausing; no redirection for invalid targets; and unchanged existing schedules. Add editing and cancellation cases once those decisions are confirmed. Documentation checks do not replace Core behavior regressions or real GUI interaction acceptance.
