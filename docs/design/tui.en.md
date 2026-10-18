[中文](tui.md) | **English**

# TUI structure

TUI projects Core state; it does not own the model loop or business history. Fullscreen and `--prompt` share the protocol client. Interactive shared services connect through `areal-local-service` in `main.rs`; `local.rs` assembles the trusted launcher for owned mode.

| Module | Responsibility |
|---|---|
| `main.rs`, `client.rs` | Terminal and mouse capture lifecycle, WebSocket, queues and reconnect |
| `app.rs`, `commands.rs` | RPC context, focus, subscription budget, slash metadata, pickers and block selection |
| `history.rs` | Activity summaries, results, layout cache, wide-character wrapping, reading anchors and viewport clipping |
| `theme.rs`, `ui.rs` | Themes, local preferences, color fallback, responsive layout, task tree and Workgroups |
| `headless.rs`, `local.rs` | Single-Turn output filtering and local launcher |

Session selection, child trees and Workgroups come from Core. Subscriptions have a budget; reconnect resumes a replacement baseline before consuming deltas, without inventing missing events. Model selection/reset uses configuration revisions at idle boundaries. Theme, expansion and selection state never enter model context.

See [client controls](../guides/clients.en.md) and [testing](../development/testing.en.md).

## Default information hierarchy

| Content | Default | Expanded |
|---|---|---|
| User input, final answers, result media | Body or media description; empty Agent messages are omitted | Normal reading |
| Consecutive tools, Reasoning and commentary | One Activity summary with call counts, running state and issue count | Individual summaries first; select a record to view arguments, output or reasoning |
| Failed or UNKNOWN tools | Issue count and at most three bounded diagnostics in the group | Available full diagnostics; cancellation is counted separately |
| Failed, interrupted or completed Turns without an answer | Persistent result after the Turn | Error details and Turn ID |
| Stopped current Goal, unconfirmed usage | Reason and usage independent of the sidebar | Goal ID and reason code |
| Pending approval or question | Approval dialog; pending notice for questions | Approve/deny in TUI; answer questions in Web |

Groups do not cross user input, visible answers, media or Turn boundaries. Summaries use Item types, tool names and result states without another model call. Unknown tools retain their names and counts; call counts are not described as file counts. Successful output previews, commands, JSON arguments, diffs, reasoning and commentary are hidden by default.

Core assigns [message phases](../api/core.en.md#agent-message-phase) from actual execution rounds: streaming messages and messages requiring further tools or child results use `commentary`; only a message confirmed to need no continuation becomes `final_answer`. TUI never guesses from wording. Legacy records without a phase keep nonempty text visible. The last nonempty message before failure or cancellation appears as `Agent · incomplete reply`. `ModelContext` is excluded from the transcript.

## Errors and state

Turn results derive from snapshots and use stable Turn IDs. Reconnect, session switching and duplicate terminal events preserve errors without duplicating them. Failures show a bounded `Turn.error.message` summary, with an explicit fallback when details are absent. Completion without a final answer or media shows `Turn completed · no final reply`; Reasoning alone is not an answer.

The active Turn status shows model waiting, tool execution, pending interactions or a notified automatic retry. `areal/model/watchdogRetry` supplies the attempt and delay; output, terminal state, snapshot replacement and disconnect clear the retry indicator. Terminal state stops the observation timer. Elapsed time never implies success or failure.

Connection, current Turn and Goal are separate dimensions. Disconnected or unsubscribed sessions await synchronization. A stopped Goal contradicting its active Turn outside settlement triggers at most one `thread/resume` per Turn/Goal sequence, awaiting the authoritative snapshot. A blocked Goal does not override a later independent user Turn; stale list responses cannot regress a newer Goal projection.

`usageUnknown` explains unconfirmed request usage. The display distinguishes confirmed tokens and unknown requests; incomplete accounting with zero unknown requests shows `accounting incomplete`. Missing Turn usage is unknown, not zero consumption. `/goal-resume` remains subject to Core budget and UNKNOWN checks, without client tool replay. See [Core recovery](../api/core.en.md#recovery).

The editor tracks its cursor at grapheme boundaries, applying typing, paste and deletion at that position. Its single-line viewport follows the cursor using terminal display widths, with visible representations of newlines and tabs. Option+← / Option+→ (Alt+b / Alt+f when the terminal does not enable the enhanced keyboard protocol) move by Codex insert-mode word boundaries: previous word start and next word end. Ctrl-A / Ctrl-E move to the current logical line start / end in pasted text. Slash completion and failed-input restoration place the cursor at the end; submission resets it. Popups and other focus targets preserve the background draft. See [client controls](../guides/clients.en.md#tui-controls).

Failed submission RPCs retain a bounded input-area notice. Original input returns automatically to an empty editor, preserving newer drafts; `/restore-input` restores it explicitly. Disconnect during submission marks the outcome unconfirmed without resending. This is client feedback, not fabricated business history.

## Expansion and reading

- Click a summary to toggle that block. Hit testing uses the actual viewport, scroll offset and wrapped headers. Dragging never toggles; the wheel scrolls history. Exit disables mouse capture; `--mouse=false` preserves native terminal mouse behavior.
- With history focused, `↑/↓` selects expandable blocks, `Enter/Space` toggles, and `←/→` collapses/expands. Enter still sends from the editor; Esc returns to it.
- `/details` or `Ctrl+O` toggles compact/detailed views. New sessions start compact. Returning to compact restores previous local expansion choices without changing the draft.
- Expansion, collapse, deltas, snapshot replacement and resizing use stable content anchors. Explicit expansion pauses following; `End` returns to the bottom and resumes it. Incoming events do not steal focus while browsing; new failures appear in reading progress.
- Only expandable blocks have toggles. Text distinguishes failure, cancellation, running and UNKNOWN even in narrow or monochrome terminals.

Client block keys distinguish Items, Activities keyed by their first member, Turn results, the current Goal and pending interactions. Goal notices describe only the current projection, without fabricating past events. Collapsed successful output is not concatenated or wrapped. Expanded content caches wrapped rows; rendering clips to the viewport. Model, tool and error text continues to sanitize terminal controls. Folding does not replace redaction or change stored history, execution, context replay or accounting.

## References and validation

Interaction references include the details entry point in [OpenCode TUI](https://opencode.ai/docs/tui/), separate errors in its [pinned source](https://github.com/anomalyco/opencode/blob/fe3f3a41f79ad292cc3c7c629567385a20ec5130/packages/tui/src/routes/session/index.tsx), `Ctrl+O` in [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode), and local expansion in [fullscreen mode](https://code.claude.com/docs/en/fullscreen). Product details do not define this project's protocol.

Regression coverage includes failure/empty/partial answers, legacy messages, 100-call folding, precise second/third record selection, Chinese wrapping and resizing, detailed-view round trips, new failures while browsing, retries and late events, and Goal synchronization. Real PTY smoke covers mouse, keyboard, default hiding, errors surviving reconnect, and terminal cleanup. Core phase tests cover events, tool continuation, failure and persistence.
