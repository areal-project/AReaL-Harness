[中文](conversation-reading-acceptance.md) | **English**

# Conversation and Composer experience acceptance contract

This document defines the desktop journey from composing through submission, execution, reading, and continuation. It does not claim that the implementation meets this contract. Reading standards C1-C7 and the existing quantitative gates remain in effect; the sections below add Composer, cross-stage state, and evidence requirements. See the [Messages reading contract](../../clients/gui/renderer/src/Messages.md) for current behavior and the [Core API](../api/core.en.md) for interfaces.

## Problem definition

Users need to read what they said, how the Agent responded, and the current task state as one continuous conversation. Opening, pagination, refresh, navigation, and background output belong to that same experience.

This work addresses reading continuity during loading and updates. Users report responses appearing without prompts, noticeable waits, and content jumps. The cases below must establish how reading, projection, and layout contribute; screenshots alone do not establish a root cause. Complete final records do not prove readability during loading. A completed request does not prove that content is visible and stable.

This scope prioritizes ordinary users. A conversation with few turns but extensive tool output or a long-running turn remains an ordinary case. Internal log size must not reclassify it as extreme history. Prioritizing most users is a product tradeoff, not a measured coverage percentage without usage-distribution evidence.

## Reading concepts

- **Basic conversation** includes user messages, outward responses, original ordering, turn associations, and execution state. User attachments retain identifiable entry points.
- **Process details** include tool arguments and full output, model context, execution traces, and large attachment bodies. They may load after basic conversation. Collapsed content need not expand in advance.
- **Reading position** identifies a stable message or paragraph and its viewport offset, rather than only a scrollbar value.
- **Readable time** is when basic conversation at the target position is rendered and usable. A response, `complete=true`, or placeholder does not satisfy it.

These are experience concepts. They do not prescribe new durable models, caches, or APIs.

## Experience standards

| ID | Standard | Observable acceptance condition |
| --- | --- | --- |
| C1 | Complete, trustworthy conversation order | A response in a published reading range has its user context. Pagination must not expose a new response while its prompt remains unloaded. Messages are not lost, duplicated, or associated with the wrong turn. |
| C2 | Basic conversation becomes readable first | Delaying tool bodies or traces does not prevent prompts and responses from appearing. Loading every internal record in a turn must not require a blank conversation. |
| C3 | Active reading is not interrupted | After the user leaves the bottom, pagination, streaming, reobservation, and asynchronous layout do not pull them back or reverse their scrolling. |
| C4 | Browsing requires little awareness of loading | Normal pagination inserts no loading-text row, clears no content, and requires no repeated upward gestures to finish an already exposed portion of basic conversation. |
| C5 | Returning resumes reading | Switching away and back within the same process restores the message or paragraph and offset. If its content left the cache, restore the required reading range. New navigation during that wait wins. |
| C6 | Following and reading history are distinct | Follow output at the bottom. Stop following when the user scrolls away and resume on an explicit return to latest. Stream completion and activity collapse preserve that intent. |
| C7 | Failures preserve readable content | Page or detail failures preserve confirmed content and position. Actionable errors offer local recovery. Unloaded history must not be presented as the end. |

C1 does not require the prompt bubble and a long response to fit on one screen. Scrolling into a response, restoring a saved position, and explicit message navigation are valid. The condition is whether the prompt belongs to the same available reading range, not whether both bubbles appear in a screenshot. Navigating to unloaded content must also establish context rather than silently exposing an isolated tail.

During execution, a user message may appear before a response exists. System events without a user prompt retain their actual origin; do not invent messages to form pairs. Completeness is measured against messages and associations that exist in authoritative records.

A first open without reusable content may show a lightweight placeholder that does not shift the reading area. It does not count as readable content, and extending the wait cannot substitute for early readability. Refresh preserves confirmed content. User-requested expansion, font changes, or resizing may change total height, but must preserve the reading anchor. Stability does not prohibit all height changes.

## Initial quantitative gates

These are initial gates for design and implementation, not existing performance results. Measurements must identify the machine, build mode, data, and load. Changes to a gate require an explicit reason rather than adjustment to make a failing result pass.

| Metric | Gate and measurement boundary |
| --- | --- |
| Completeness | Final basic-message IDs, order, and associations match independent authoritative data in every required case. Check C1 at each visible commit or sampled frame during loading, not only after settlement. |
| Unrequested displacement | After input stops, pagination, refresh, and arriving details displace the anchor by at most 2 CSS px. Loading must not reverse movement during scrolling. Boundary clamping and explicit navigation are evaluated separately. |
| Repeat open | With the application and Core ready and the conversation previously visited, selection to readable basic content at the target position has p95 at most 200 ms. |
| First read | With the application and Core ready but the conversation unread, the same metric has p95 at most 1 s. Measure application cold startup separately. |
| Scroll response | In a controlled local environment, input to observable scroll feedback has p95 at most 50 ms, with no unresponsive interval over 100 ms during continuous browsing. Evaluate main-thread tasks, frame intervals, and visual evidence together. Absence of long tasks alone does not prove fluency. |

Do not hide first-run correctness failures with retries. For latency, run each major data class at least 20 times and report count, p50, p95, maximum, and failures. Interleave benchmark comparisons. Report debug and production builds separately. Mark evidence insufficient when concurrent compilation, background load, or probe overhead prevents comparison.

## Case design

Select cases by failure mechanism. Real conversations are samples, not separate fix branches. Every case checks transitions and final state.

| ID | Data and operation | Required checks |
| --- | --- | --- |
| T1 | First open of a short conversation, then switch away and back | C1, C2, C5; first-read and return-read timing. |
| T2 | Only 2 to 3 turns, with extensive tool records and a raw turn larger than a transport page | Treat it as ordinary usage. Prompts and responses appear without waiting for internal records. |
| T3 | Identical basic conversation with small, large, and deliberately delayed tool bodies | Identical basic content and order. C2 holds while a barrier blocks details; first-read timing meets its gate for each variant. |
| T4 | A 40-turn conversation paginated between turns, between prompt and response, and inside activity | C1, C3, C4; real upward and downward inputs cross boundaries without transient omissions or reordering. |
| T5 | Long text, tables, code, and images, with late fonts, image dimensions, or highlighting | Initial layout and viewport entry cause no unrequested jump. Asynchronous changes preserve the reading anchor. |
| T6 | Read history while background output streams, completes, and collapses activity | C3, C6; preserve historical reading while the bottom-following path still works. |
| T7 | Save a middle position, switch conversations, release cached pages, reobserve, and return | C1, C5; verify the same message or paragraph, not merely equal scrollTop. |
| T8 | Reverse direction, switch conversations, or return to latest while an older-page request is pending, then release it | New intent wins. A late response cannot reclaim position, enter another conversation, or override navigation. |
| T9 | Page or detail timeout, failure, reconnect, and stale cursor | C7; preserve confirmed content, never resend user input as recovery, and avoid unbounded retries. |
| T10 | Additional user input and multiple outward responses in one turn, with failed or interrupted settlement | C1, C6; neither implementation nor tests assume exactly one prompt and response per turn. |
| T11 | History clearly beyond ordinary scope, or an oversized individual message | Bounded reads, readable existing content, and cancellable or recoverable operations. Report performance separately without complicating the ordinary path. |

T2 and T3 keep basic messages fixed while independently varying internal record volume. T4 must actually paginate; raising the observation budget must not remove that coverage. T8 uses controlled response barriers rather than fixed sleeps to infer ordering.

Cover a boundary read with wheel, keyboard, and scrollbar input at least once each. Automated input checks deterministic behavior. Retain manual checks for physical trackpads and rapid back-and-forth browsing; simulated input does not establish device feel.

## Evidence and delivery order

1. **Define the problem and standards.** Describe defects using C1 through C7. Record gates and scope before choosing a patch.
2. **Design cases.** Specify fixtures, operations, independent expectations, and observations for T1 through T11. Add transition assertions before running the current implementation. Distinguish fail, pass, not run, and insufficient evidence.
3. **Compare designs.** Derive required capabilities from the failure matrix. Compare the existing reading path with the smallest interface adjustment. Explain coverage, costs, and compatibility. A larger page alone does not establish semantic completeness.
4. **Implement.** Deliver a complete vertical slice at the selected boundary. Prioritize basic conversation, then details. Add mechanisms only for current cases.
5. **Validate together.** Rerun failures and affected regressions, then two different kinds of real-history copies. Record source revision, Core and Renderer identities, isolation, original failures, and cleanup.

Existing entry points include `test:history-compat`, `test:conversation-reading`, `test:history-recovery`, and the Core `bounded_history` integration tests. These are reusable entry points, not claims of full coverage of this document. Maintain the current execution plan in the task evidence directory. This document contains no private conversation content, one-off measurements, or historical pass claims.

Each execution record includes its case ID, standards, fixture identity, initial reading position, input and response-release order, independent expectations, actual result, and evidence location. Derive expectations from original fixture messages, not the projection under test. Frame sampling must report its interval and detection limits; it cannot establish every state between samples.

Before design, establish a failure matrix on the current version. Distinguish content not returned, missing projection, DOM not yet rendered, and content outside the viewport. Before implementation, map every design decision to a failing case and an owning boundary. If T3 shows that tool-body reads block basic conversation, evaluate a Core basic-conversation read interface. Fetching more raw records at once does not replace this check.

Delivery must map standards to cases, design decisions, changes, and evidence. One passing real conversation, passing static checks, or complete final message counts cannot independently establish that the conversation experience is fixed.

## Composer and cross-stage contract

A task includes an unsubmitted draft, attached context, an admitted operation, and execution results. Their identities cannot be inferred from a bubble appearing, the editor clearing, or animation stopping. Core/Runtime own execution and history facts; Composer owns intent not yet handed off; the reading host owns viewport, selection, and expansion state.

| ID | Invariant | Counterexample and acceptance |
| --- | --- | --- |
| D1 | One keypress consumes one user intent | Confirming an IME candidate neither sends nor selects a command; a subsequent deliberate Enter can send according to settings. Enter in a Slash/Mention menu only selects. Check remapped shortcuts and newlines separately. Record compositionstart/end, isComposing, keyCode, and actual admission count rather than copying a fixed 500 ms window. |
| D2 | Drafts and context are isolated by project/conversation; recovery does not silently degrade them | Test text, images, files, and references across A/B navigation, renderer reload, and application reopening separately. When file bytes cannot be restored, retain at least an identifiable needs-reattach record and an explicit notice. Restoring text while silently omitting context fails. Recovery must not read paths beyond the original authorization. |
| D3 | Submission identity and feedback are trustworthy | Repeated clicks or keypresses do not duplicate admission. Distinguish uploading, not yet admitted, queued, running, explicitly failed, and awaiting reconciliation. Reconcile a lost receipt before considering resubmission; do not replay unknown submissions. Explicit failure preserves recoverable input. |
| D4 | Asynchronous completion cannot overwrite newer intent | While upload, configuration, or submission is pending, navigate, edit, or cancel through entries the product actually permits. Old receipts settle only their original draft/operation; they cannot clear newer content, steal focus, or attach files to another conversation. If editing is temporarily disabled, verify content and focus during the lock and after release. |
| D5 | Stop, approval, and queue state follow execution facts | A stop request is not confirmed termination; approval is not tool success; queued is not running. Verify ownership, terminal state, and actual side effects. Persistent faults expose specific problems the user can act on. |
| D6 | Reading details survive output and settlement | Open a diagram, select text, or expand a tool, then advance output, tool settlement, and turn completion. The diagram remains open; selection and manual expansion follow the same content identity. Closing returns to an identifiable entry. Deleted or changed content is a separate boundary. |
| D7 | Keyboard and layout do not block the task | Complete input, attachment actions, send, stop, menu dismissal, and result use with narrow windows, large text, and keyboard-only input. Focus is visible. Closing a menu does not also stop a task. Ordinary text does not widen the page; wide tables/diagrams scroll locally. |

### Required journeys and production owners

| Case | Fixed operation and passing condition | Standards / existing owners / entry |
| --- | --- | --- |
| J1 Input intent | Compose Chinese, confirm a candidate, then deliberately press Enter; select Slash/Mention items and insert normal newlines; verify text and admission count | D1; LexicalChatInput, ChatPromptEditor; `test:composer`. Native IME acceptance is separate; synthetic events do not replace it. |
| J2 Draft recovery | Add text, a test image, files/references through UI; navigate A/B, reload, and separately reopen; recover completely or explicitly require reattachment | D2, D4; Composer, composerDraftStorage, composerDraftAttachments; `test:composer-files` can be extended. The command existing does not establish reload coverage. |
| J3 Submission boundaries | Fail before admission, lose the receipt after admission, double-click send, and change target while pending; reconcile the same requestId with independent admission records | D3, D4; Composer, submitMessage, and the main-process admission owner; `test:send-admission`. |
| J4 Execution intervention | Append/queue while running, approve, and stop while subsequent events arrive; verify state, ownership, and actual side effects | D5; Composer, TurnActivity, Core/Runtime; `test:stop-turn`, `test:composer`. |
| J5 Reading control | In a genuinely overflowing response, scroll up and select an old paragraph; continue output through completion; explicitly return to latest and resume following | C3, C6, D6; Messages, conversationReading, readingViews; `test:conversation-reading`, `test:reading-checkpoint`. |
| J6 Result use | Enlarge a closed diagram block while the response streams, zoom/pan, then close after completion; horizontally scroll wide tables, retain long-table headers, copy/download | D6, D7; Messages, MessageResponse, DiagramReader, MarkdownTable; `test:content-reading`. |
| J7 Performance interference | Type continuously into short and approximately 30k-character drafts; then type and read history during a long streaming response; verify actual character growth and layout | P1/P2 below and existing scrolling gates; TextContentPlugin, Composer, Messages; measure in a real browser/desktop, not only pure-function tests. |

### Composer performance measurement

These are additional initial budgets; they do not change existing reading gates. Separate client feedback, submission admission, first provider output, and execution completion rather than combining them into one response time.

- **P1 Input feedback:** renderer receipt of a real input event to the corresponding character entering the DOM and the next visible feedback has a p95 target of at most 100 ms. Collect at least 20 valid samples per workload, reporting p50/p95/max, missing/duplicated characters, long tasks, and frame intervals. Compute percentiles from sorted samples at `ceil(p*n)-1`. Verify actual text growth.
- **P2 Foreground/background isolation:** report idle typing, typing during streaming, and history reading separately. Specify content size, delta frequency, mounted message count, and tool-detail state. Empty-page speed does not substitute for the streaming case.
- `keydown -> next rAF callback` is only a pre-paint proxy. Callback arrival, DOM mutation, and screen paint are different boundaries. Proxy-only evidence is insufficient for formally passing P1.
- Report local IPC admission and provider first-output latency separately. Do not count Playwright/CDP round trips or provider wait as local input latency. Record build mode, CPU load, and probe overhead; uncontrolled conditions do not support cross-product speed rankings.

## Acceptance records and release decision

Record each item as `PASS`, `FAIL`, `UNVERIFIED`, or `BLOCKED`, with its boundary and reason. `BLOCKED` means prerequisites such as launch, build, or the test driver prevented observation. `UNVERIFIED` means untested or insufficient evidence. A zero exit status, partially completed stages, or an existing screenshot does not automatically pass a whole journey.

Minimum fields: contract/case ID, source commit and dirty state, Core/Renderer identity, OS/browser/window/text size, workload size, actions and event order, independent expectation, observed result, raw samples/screenshots/trace, failure classification, and cleanup. Correctness counterexamples must fail the target assertion; a probe deliberately throwing a sampling-complete exception is not a product failure. Preserve the first failure and subsequent corrections rather than erasing them through changed locators, environment, or waits.

Fault injection must first establish that the boundary actually used by the target operation fails, before asserting draft retention, feedback, and recovery. For example, once Host copies deployment skills into runtime snapshots, moving the original skill file does not establish failure of the active skill read. Record the requested resource identity, error receipt, and admission count. Classify an injection that misses its target as a fixture failure, not a product defect inferred from a missing-error timeout; do not skip the recovery case.

The release floor is no confirmed unresolved content loss, cross-conversation contamination, duplicate admission, misleading state, or lost reading control within scoped D1-D6 and C1/C3/C7. Judge performance budgets independently; low latency cannot offset data errors. Explicitly retain untested native IME, real-provider, package, platform, and assistive-technology boundaries rather than substituting static checks.

## Dual-product baseline

Compare the same user journey, not appearance or internal state implementations. Record feature coverage, action/recovery cost, interruptions, and performance separately. Other scores cannot compensate for data errors. Untested subcases do not inherit a journey-wide PASS.

| ID | Fixed journey | Minimum acceptance and observation |
| --- | --- | --- |
| B1 | Compose with files, images, and references | Check chips, preview, removal, and actual request context. Count actions from a focused editor. File injection does not pass the native picker. |
| B2 | New/existing drafts, A/B navigation, reload, separate reopen | Track text, bytes or reattach state, references, and caret separately. Missing context blocks sending or is explicitly removed. Reload is not process restart. |
| B3 | IME confirmation, another Enter, Slash/Mention, newline, undo | Record text and actual admissions; separate physical and synthetic IME. Adapt menus to supported capabilities. |
| B4 | Failure before admission, lost receipt after admission, recovery | Prove the fault reaches the real boundary. Preserve drafts/newer intent and prevent duplicate execution. Mark BLOCKED without a controllable protocol; UI timers cannot manufacture success. |
| B5 | Read history, select, type short/long drafts while streaming, return to latest | Record rate, history size, paragraph identity, anchor, character integrity, and event-to-DOM/rAF/paint separately. Final position alone cannot prove continuous stability. |
| B6 | Enlarge/zoom/pan Mermaid; read/copy/export tables | Exercise closed fences during streaming and completed output separately. Record entry, focus return, continuity, copied content, and downloaded bytes. Missing actions start as feature differences. |

Generate shared material with the command below, including per-file SHA-256: short and 30,000-character drafts, text file, test image, 80 initial paragraphs, 40 chunks with a suggested 100 ms interval, Mermaid, and an eight-column thirty-row table. Drivers consume the same files. Protocol adapters only translate transport; internal setters cannot replace actions or persistence under test. Default Replay content with a different workload is reported separately.

```sh
node clients/gui/scripts/support/conversation-baseline.mjs /tmp/conversation-baseline-materials
```

Pin commits, dirty-diff summaries, build type, OS, runtime, CSS viewport, zoom, font size, theme, language, and background load. Separate cold/warm runs and alternate serially. Keep at least 20 valid raw samples per workload; cross-product rankings additionally require matched material/boundaries and repeated runs. Mark historical one-sided evidence reused, not a fresh controlled comparison. Report React duration, IPC admission, provider first output, and presentation separately.

Each result includes starting state, actual actions, visible outcome, source owner, evidence path, collection method, PASS/FAIL/UNVERIFIED/BLOCKED, and limits. Feature coverage separately uses full/partial/unsupported/product choice/unverified. Source inference cannot receive a runtime PASS. Pair screenshots by state and dimensions; count actions only between equivalent endpoints, excluding preparation or skipped steps.

Prevent recurrence: run B2 for attachment recovery changes, B3 and long-draft B5 for editor/persistence changes, B5 and scaling checks for projection/list changes, and verified injection followed by B4 for fault fixtures. Reuse existing runners; source checks do not replace desktop validation. Retain failing target assertions before fixes or from isolated fault injection, including first failures and later passes. Label exploration scripts not wired into CI rather than claiming automatic gates.

## How references inform the contract

Open Claude UI provides interaction research material; T3 Code provides a readable product implementation. Neither comments, demos, nor source alone establishes AReaL's behavior or original Claude behavior.

- [Open Claude UI Composer](https://github.com/Caho1/open-claude-ui/blob/2d56ab417f888e8c77f5d5090f53c1f65a05ab0b/code-examples/RichComposerWithMentions.tsx) and [scroll hook](https://github.com/Caho1/open-claude-ui/blob/2d56ab417f888e8c77f5d5090f53c1f65a05ab0b/code-examples/useClaudeScrollPinning.ts): derive input intent and reading ownership; their particular time/distance values are not this product's gates.
- [T3 draft storage](https://github.com/pingdotgg/t3code/blob/2ad6712c6d8054f32de9e04df89bd659380f48a3/apps/web/src/composerDraftStore.ts): preserve metadata and recovery state when files cannot serialize; informs D2 counterexamples without requiring its state library.
- [T3 submission](https://github.com/pingdotgg/t3code/blob/2ad6712c6d8054f32de9e04df89bd659380f48a3/apps/web/src/components/chat/useComposerSend.ts) and [reading anchors](https://github.com/pingdotgg/t3code/blob/2ad6712c6d8054f32de9e04df89bd659380f48a3/apps/web/src/components/chat/timelineScrollAnchoring.ts): reference submission snapshots, protecting newer drafts on failure, and explicit scroll modes; validate this product through its existing state owners.
