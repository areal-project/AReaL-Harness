[中文](conversation-reading-acceptance.md) | **English**

# Conversation reading experience and acceptance

This document defines desktop reading targets, cases, and delivery order. It does not claim that the implementation meets them. See the [Messages reading contract](../../clients/gui/renderer/src/Messages.md) for current behavior and the [Core API](../api/core.en.md) for interfaces.

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
