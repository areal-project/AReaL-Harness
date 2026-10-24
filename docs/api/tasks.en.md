[中文](tasks.md) | **English**

# Task Mode and independent communication

This contract belongs to `areal.core.v1` and serves TUI, GUI, WebUI and other clients. Rust types are in [tasks.rs](../../core/protocol/src/tasks.rs); request, response and notification schemas are in [areal-core-v1.json](../../schemas/areal-core-v1.json). Complete [authentication and initialization](desktop.en.md), then check `features.taskModes/taskChannels/asyncQuestions/headlessInteractions`. Full Run history also requires `features.taskRunHistory`.

## Ownership and modes

A Task owns identity, objective, schedule, total token budget and a persistent Channel. A TaskRun represents one execution, associated with a Goal and coordinator Thread. The Goal manages progress, execution budgets and continuation across Turns. Threads/Sessions hold model history; closing a client does not delete the Task or Channel. Runtime processes retain existing Scope and permission boundaries.

| mode | threadId | Default interactionMode | Trigger |
|---|---|---|---|
| foreground | Required root Thread | interactive | Queued after acceptance |
| scheduled | Required root Thread locating the execution environment | interactive | UTC trigger with a connected desktop Host; fresh Thread per Run |
| background | Optional; Core creates a coordinator Thread | asynchronous | Queued after acceptance; workers may use independent Sessions |

`areal/goal/create` still atomically admits its first Turn and also registers a foreground Task; its response adds `taskId/runId`. `areal/task/create` persists acceptance before asynchronous dispatch; success does not mean the model has started. An existing Goal, active Turn or user queue on the bound Thread delays admission. Each Task has at most one unfinished Run.

Task identity is independent of the client connection, and communication does not target the execution Session. Moving a running coordinator to another Thread, migration across Core deployments and arbitrary mailbox addressing are not supported. Background workers have their own Threads/Sessions. Inbox projects pending questions from accessible Tasks without storing another copy.

## Interaction policy

| interactionMode | ask_user_question | Tools requiring human approval |
|---|---|---|
| interactive | Waits by default; the model may choose `mode="async"` | Existing Turn-bound approval |
| asynchronous | Forces a persistent asynchronous question and returns immediately | Immediate PermissionDenied |
| headless | Immediately returns `status="unavailable", reason="headless", waiting=false`; creates no question | Immediate PermissionDenied |

Headless never awaits users or automatically approves operations. The model can continue with justified assumptions or report a concrete blocker. Tools already permitted by effective policy still execute. background rejects interactive mode and client dynamic-tool Threads. scheduled fixes interactive mode and uses current configuration/tools from the desktop Host under existing Runtime and Profile permissions.

Set policy through `GoalCreate.interactionMode` or `ClientOptions.interactionMode`. The optional `interactionMode` on `areal/turn/start/enqueue` overrides that submission; queued items freeze it without changing Thread defaults. TUI headless and Claude CLI without a bidirectional response channel explicitly select headless. Explicit bidirectional stream-json CLI sessions retain the interactive host protocol; dontAsk still selects headless. Interaction policy cannot expand tool permissions.

Model tools:

| Tool | Arguments | Behavior |
|---|---|---|
| ask_user_question | `questions, mode?: wait/async, required?: bool, timeoutSeconds?` | async returns taskId/runId/questionId and allows independent work; interactive wait still uses interaction/respond |
| task_channel_read | `afterSequence?` | Reads the current Task Channel with identity bound by Core |
| task_wait | `{}` | Coordinator ends its Turn, cleans resources and releases capacity; a valid reply, question expiry or worker settlement enables continuation |
| task_spawn | `prompt, maxModelRounds?` | Creates a TaskRun-owned worker, immediately returns threadId/turnId, and publishes its result to the Channel |

Asking does not suspend execution. Use task_wait only after independent work is exhausted; ordinary Turn children and pending verification handles must settle first. Suspension without pending questions or workers is rejected; headless can wait only for workers. Each model request includes bounded Channel context, with explicit pagination when needed. Replies do not interrupt an already submitted model request or append a new user Turn to execution history.

Async questions default to 86400 seconds and accept 1–604800; synchronous questions accept 1–3600 and remain bounded by the Turn deadline. A batch contains 1–8 questions with unique IDs, titles up to 4096 UTF-8 bytes, at most eight options of 1024 bytes each, and at most 32 KiB of serialized questions. `required=true` prevents Goal completion while an unanswered, unexpired question remains. After expiry the model must reassess assumptions or report a blocker. Optional questions do not prevent completion; Run termination cancels unanswered questions.

## Client API

The table omits the `areal/` prefix. create/update/control/reply require interact; all other methods require observe. Mutation requestId is a business idempotency key separate from RPC id. Retries with the same identity, method, requestId and arguments return the original acceptance response; different arguments conflict. Deduplication precedes revision checks. The original response may be stale; read the current projection afterward.

| Method | Parameters | Response |
|---|---|---|
| task/create | `requestId, mode, objective, threadId?, sourceThreadId?, interactionMode?, schedule?, scheduleV2?, tokenBudget?, maxTurns?, maxActiveSeconds?` | Task projection |
| task/schedule/context | `timeZone` | `{coreNow,timeZone,localDate,localTime}` |
| task/schedule/preview | `schedule: ScheduleIntent, from?, count: 1..10` | `{coreNow,from,schedule,timeZone,occurrences,warnings}` |
| task/list | `after?, limit?` | `{data: Task[], nextCursor}` |
| task/read | `taskId` | Task projection |
| task/runs/list | `taskId, cursor?, limit?` | `{data: TaskRun[], nextCursor, hasMore, runCount}` |
| task/run/read | `taskId, runId` | One complete TaskRun |
| task/update | `requestId, taskId, expectedRevision, objective?, schedule?, scheduleV2?` | Updated Task projection |
| task/runNow | `requestId, taskId, expectedRevision` | `{taskId, runId, revision, accepted:true}` |
| task/pause, task/resume, task/cancel, task/delete | `requestId, taskId, expectedRevision` | Task projection after persisting control intent |
| task/stopRun, task/resumeRun | `requestId, taskId, expectedRevision, expectedRunId` | Current Run stop/resume intent without changing recurrence |
| task/host/ready | `{}`; unrestricted manage + tools required | `{ready:true}`; register current desktop connection |
| task/subscribe | `taskId` | Atomic snapshot and subsequent task/updated notifications |
| task/unsubscribe | `taskId` | `{removed:true}`; does not cancel execution |
| channel/read | `taskId, afterSequence?, limit?` | `{taskId, channelSequence, data, nextSequence, hasMore}` |
| channel/reply | `requestId, taskId, runId, questionId, answers` | `{accepted:true, messageId, taskId, runId, channelSequence}` |
| inbox/list | `after?, limit?` | `{data:[{taskId, objective, message}], nextCursor}` |

`task/pause` also accepts optional `expectedRunId`, advertised by `features.taskPauseRunGuard`. After receipt lookup, Core checks it against the latest Run together with `expectedRevision` under the same Task lock; a missing or changed Run conflicts. Supplying it to resume, cancel, or delete is invalid. An identical accepted duplicate returns its original receipt even after revision/Run changes or restart; changing the Run under the same request key conflicts. Omission preserves existing callers and receipt digests. For scheduled Tasks pause affects future triggers only; stopRun stops current work. Run and worker settlement determine when execution has stopped.

Task projections contain `id, revision, channelSequence, owner, mode, interactionMode, objective, threadId, sourceThreadId?, deletedAt?, schedule, nextRunAt, paused, cancelled, tokenBudget, maxTurns, maxActiveSeconds, runs, runCount, archivedRunCount, runsComplete, skippedRuns, lastSkippedAt, pendingQuestions`, without embedded messages. A Run contains `id, threadId, goalId, status, reason, objective?, trigger, scheduledAt, startedAt, completedAt, usage, waitRequested, workers`. Workers contain `threadId, turnId, status, settled`, with running/completed/cancelled/failed status.

Run status is `queued/running/waitingForInput/waitingForAgents/paused/blocked/completed/failed/cancelled`; the last three are terminal. Task paused/cancelled fields express control intent; the Run can remain running during cleanup. Determine settlement from Run termination and worker.settled, not a control response or coordinator Turn completion.

Cancelling a Task removes future dispatches and terminates unfinished Runs. Runs that have already ended retain their status, completion time and usage ledger as history, including after restart.

ChannelMessage contains `id, sequence, runId, author, kind, status, createdAt, expiresAt, questions, required, inReplyTo, answers, text`. kind is question/reply/workerReport/report. Question status is pending/answered/expired/cancelled; other messages are published. questionId references the question message id. answers maps each question ID to one nonempty string of at most 4096 bytes, covering exactly all questions; closed-choice answers must match an offered option.

A question must belong to the specified Task/Run, remain pending and not have expired. New replies are rejected for cancelled Tasks, completed/failed/budget-limited Goals or replaced Goals. Valid replies may be accepted during pause without resuming execution. Successful retries with the same requestId still return their receipt. Errors use Core codes: `-32602` invalid arguments, `-32009` state/revision conflict, `-32003` permission denied, `-32004` not found, `-32001` capacity exhausted; storage failures use the actual returned Core error.

## Schedules in ordinary conversations

Writable ordinary desktop root Threads expose `scheduled_task_list/create/update/control/receipt`. Core checks the source Thread's bound Host against the currently registered identity and connection ID. Side conversations, children, workers, Task execution anchors and Run Threads, read-only Threads, and Workflow Threads cannot use these tools. The immutable Turn tool allowlist still applies. Knowing a Task ID does not grant access to another source conversation's tasks.

| Tool | Arguments | Result |
|---|---|---|
| scheduled_task_list | `taskId?` | `{tasks}` belonging to this source, including tombstones |
| scheduled_task_create | `objective, scheduleV2: ScheduleIntent` | `{task, receipt:{requestId,method}}` |
| scheduled_task_update | `taskId, expectedRevision, objective?, scheduleV2?` | The same write result; omitted fields stay unchanged |
| scheduled_task_control | `taskId, expectedRevision, action, expectedRunId?` | action is pause, resume, runNow, delete, or stopRun |
| scheduled_task_receipt | `requestId` | `{receipts,retention}` visible to the current Host identity and source |

Core derives the requestId from durable Thread, Turn, and tool-call IDs. The model cannot choose it. Error results retain `error.reason`, `error.outcome.kind`, and `error.recovery`. Stale revisions return `REVISION_CONFLICT`, denied access returns `PERMISSION_DENIED`, and uncertain storage returns `UNKNOWN` with the original requestId. UNKNOWN permits receipt inspection, not another write with a new tool-call ID. An empty receipt does not prove rejection.

Creation binds the source Thread and cwd, creates a separate execution anchor, and calls the existing task_create owner. Public `TaskCreate.sourceThreadId` also requires an existing ordinary source, the same cwd and registered Host connection, and a separate anchor. The objective contains the complete execution method, required references, and output requirements. Runs do not continuously read the source conversation. Each Run still gets an independent Thread and the current default model, while its workspace may be shared.

Chat cards bind the Task identity and receipt from an actual successful tool result. On reload they read the current Task, keeping historical success separate from paused, deleted, or unavailable current state. The source list in Thread resources and the global center read the same Core Task. Direct pause, enable, run-now, and delete commands do not require a model. Historical task-draft management conversations remain readable and retain their existing management path.

`task/delete` uses the existing cancellation settlement path and persists a `deletedAt` UTC Unix seconds tombstone. It sets `cancelled=true` and `nextRunAt=null`, rejecting later updates, enabling, and run-now. Success confirms durable deletion intent. A nonterminal Run or unsettled worker keeps the deletion pending and its history reachable. Tasks, Channels, Runs, and original receipts are retained. Tombstones still count toward the 1024-Task limit. `task/list` and `task/read` include tombstones; active catalogs may hide them only after all execution settles. Restore and physical purge are unsupported.

`sourceThreadId` and `deletedAt` are optional. Old snapshots default to no source and no deletion. The v5 Task ledger stores these fields without a migration or inferred source relation. Older binaries that ignore the tombstone field still honor the existing cancelled state. Deleting or archiving the source Thread does not cancel its Tasks.

## Independent Inbox and subscriptions

Clients can answer the same question from a global Inbox or Task detail without opening the coordinator Thread. Unrestricted identities retain deployment-wide shared-workspace access. Identities restricted by threadIds can see only Tasks bound to allowed Threads and cannot create or inspect unbound background Tasks. owner records the creator; it does not introduce a private mailbox ACL. Competing authorized identities can answer a question only once.

`areal/task/updated` carries `{taskId, revision, channelSequence, runId, task}`. Subscription does not depend on thread/resume. task/subscribe captures a snapshot and registers its receiver under one lock; the response precedes subsequent events. Task and Thread subscriptions share the 128-subscription connection limit and bounded send queue. Backpressure closes the connection; clients reconnect and obtain a new snapshot.

Replace task state with the task/subscribe snapshot and subsequent event task projections. When channelSequence advances, page channel/read and **replace** messages by id. State changes give a question a new sequence, so it can reappear in incremental pages. Save nextSequence only after processing the page. Cursors are neither Turn IDs, Task revisions nor read markers. Channel pagination provides changes to latest message state, not a complete immutable event log. Server-side read receipts are not implemented.

limit is 1–100, defaulting to 30 for Task/Inbox and 50 for Channel. Use nextCursor for Task/Inbox and nextSequence/hasMore for Channel. Pages also have an approximate 128 KiB budget; a single Task projection may exceed it. Do not assume pages reach limit. Refresh Inbox through inbox/list; no global Inbox subscription exists yet.

## Run a saved Task immediately

`areal/task/runNow` admits a real manual Run for a scheduled Task. It requires interact permission, an unrestricted Thread scope, an accepting Core, and a live desktop Host registered through `task/host/ready`. The workspace remains shared. The caller does not need to be the Task creator.

Core atomically persists the queued Run, its objective snapshot, and the original request receipt before Host preparation. `accepted:true` confirms this durable admission. Preparation, credentials, model availability, and execution can still fail. Preparation failure blocks the same Run. `task/resumeRun` continues that Run with its existing identity and budget.

Manual execution preserves `schedule`, `nextRunAt`, `paused`, and `skippedRuns`. A paused plan or a naturally completed one-time plan can run manually. A cancelled Task cannot. Every nonterminal Run prevents another admission. After receipt replay and Task eligibility checks, an overlap returns `-32009` with `{reason:"activeRun",taskId,runId,revision,outcome:{kind:"rejected"},recovery:{kind:"none"}}` before the generic revision check. Otherwise, admission requires the current `expectedRevision`. Concurrent edits and due triggers use the same admission lock. A due tick that loses to a manual Run keeps the existing busy-skip policy.

`TaskRun.trigger` is `schedule` or `manual`. Old stored Runs default to `schedule`. A manual Run uses its logical admission time as `scheduledAt`; clients label it as a manual trigger. Total Task usage includes hot and archived Runs and reserved tokens. Exhausted total budget can admit a Run that then becomes blocked before Goal execution. Manual execution never grants additional budget or permissions.

To reconcile a lost reply, call `areal/request/read` with the full original `{requestId,taskId,expectedRevision}`. This Task selector cannot contain `threadId` or other fields. Current Task visibility is checked before the original identity and digest are looked up in hot and cold receipts. The response is `{data:[{identity,requestId,method:"areal/task/runNow",digest,result}],retention:"taskLifetime"}`. `result` is the exact compact acceptance. An absent receipt returns an empty data array and does not prove rejection. Changed arguments under the same identity and request ID conflict. Clients keep UNKNOWN pending until an original receipt is found; they do not replay the write or infer acceptance from Run counts. Existing thread and deployment request selectors retain their behavior.

## Updating a scheduled Task

`areal/task/update` accepts `{requestId, taskId, expectedRevision, objective?, schedule?, scheduleV2?}`, with at least one changed field. Only non-cancelled scheduled Tasks can be updated. A schedule must use a future UTC timestamp and the same interval bounds as creation. Omitted fields retain their values. Authorization, durable idempotency receipts and revision conflicts follow the existing mutation contract. The response and `areal/task/updated` notification contain the full Task projection.

Updates preserve Task, Thread and Run identity, history, pause state and budgets. A new schedule replaces `nextRunAt`. An accepted Goal retains its original objective, and its controls do not overwrite the updated Task objective. New Runs persist an objective snapshot at admission. Updates are allowed while Host preparation is pending and leave admitted work unchanged. An ended one-shot Task can be scheduled again at a future time. Updating neither immediately executes the Task nor changes its workspace. Clients first check that methods includes `areal/task/update`.

## Calendar rules and previews

New plans use `scheduleV2`, mutually exclusive with legacy `schedule`. Preview, create, and update accept the same `{version:1,rule,misfire,overlap:"skip"}` intent. Misfire is `{kind:"coalesce"}` or `{kind:"skip",maxLatenessSeconds:0..86400}`. The desktop explicitly saves and displays the default 300-second skip window.

The canonical rules are `once {at}`, `interval {anchorAt,intervalSeconds}`, and `calendar {timeZone,frequency,interval,localTime,anchorDate,weekdays?,monthDays?}`, each with the matching kind. Fixed intervals are 1..31536000 seconds. Calendar interval is 1..366. Daily excludes selectors, weekly requires distinct ISO weekdays 1..7, and monthly requires distinct values 1..31 or "last". Unrelated selectors are rejected.

Dates are strict YYYY-MM-DD in 1970..9999, localTime is HH:mm, and integer Unix seconds range from 0 to 253402300799. Pinned chrono-tz 0.10.4 supplies bundled IANA data independently of the host zoneinfo. Weekly periods align to the anchor's ISO Monday; monthly periods align to its month. No occurrence precedes anchorDate. Missing month dates and DST gaps are skipped. Folds select the earlier UTC instant once. Day31 and last deduplicate when they refer to the same date. A lookup or due range examines at most 146097 candidate dates or occurrences. Exceeding the bound returns SCHEDULE_EVALUATION_LIMIT without committing a partial cursor.

Management input may use onceLocal or intervalLocal with timeZone, localTime, and date, plus intervalSeconds for intervalLocal. Date is `{kind:"date",date:"YYYY-MM-DD"}`, `{kind:"relative",days:0..366}`, or `{kind:"next"}`. Calendar input may omit anchorDate to use Core's current local date. Next searches at most 370 local days and never selects the second fold instant. An explicit nonexistent local time fails. Existing ISO consumers may use onceIso with atIso or intervalIso with atIso and intervalSeconds. These accept offset-bearing RFC3339 whole seconds without fractions. Output persists only canonical once, interval, or complete calendar rules.

Context and preview require observe permission. Preview from is inclusive and defaults to one captured Core now. The response contains the canonical schedule, zone, up to count occurrences as `{at,localTime}`, and missing-date/DST warnings. Preview is advisory. Save captures Core time again but replays a matching original-intent receipt before resolving relative dates. A retry therefore cannot drift an accepted plan. New once/interval creation retains the supplied instant or anchor, including overdue values. Calendar creation chooses the first occurrence at or after Core now. Update chooses a cursor strictly after now, retaining an interval's original anchor. Reads and restarts never recalculate a saved cursor.

A nonterminal Run, including blocked, takes overlap precedence. An idle task without a Host remains pending. Coalesce admits one Run at the earliest pending instant. Skip admits that earliest instant when lateness is at most the configured window; otherwise it skips every point through now and advances beyond now. With a 300-second window, 300 admits and 301 skips. A missed once has no fabricated Run.

The fixed-size Task lastTriggerDecision contains sequence, decidedAt, planRevision, originalScheduledAt, dueThrough, dueCount, nextRunAt, and outcome. Outcomes are admitted with runId, skippedOverlap, or missedWindow. skippedRuns counts only overlap. Each new Run's acceptedSchedule retains its rule, policy, and Task revision. Automatic Runs also retain their admission decision; manual snapshots omit decision. Edits and Run Now preserve these facts; historical display uses the accepted rule's zone. Old Runs receive no invented snapshot. Run Now also preserves scheduleV2 and lastTriggerDecision.

The v5 root retains index_version3. Upgrade preserves the complete original v1..4 root bytes and immutable referenced files, legacy seconds and display zone, original receipts, pending cursor, and existing Run facts. Old readers reject v5. Downgrade requires restoring the complete pre-upgrade state; no online downgrade is provided.

## Scheduling, budgets and recovery

schedule is `{at: UTC Unix seconds, intervalSeconds?: 1..31536000, timeZone?: IANA time zone}` and is valid only for scheduled Tasks. timeZone records the interpretation zone without changing UTC/fixed-interval semantics. One-time, daily (86400 seconds) and fixed intervals are supported. Core and the registered desktop Host must be online. Missed offline triggers coalesce into one catch-up; triggers during unfinished Runs are skipped and counted. Each Run creates a fresh Thread using current environment configuration; model history is not inherited and workspace files remain shared. Interrupted Runs retain their Thread and require explicit resumeRun. The legacy field always remains fixed seconds. RRULE and OS power-on wakeup are unsupported.

Task tokenBudget covers confirmed and reserved consumption across all Runs. maxTurns/maxActiveSeconds apply per Run, retaining Goal conservative admission and unknown-usage handling. Active time is the union of coordinator and detached-worker execution intervals; overlapping work is not counted twice. Waiting for a user after all execution releases capacity adds no active time. Workers inherit frozen configuration, permissions and the same Goal budget. Their cumulative count per Run is bounded by deployment maxChildrenPerTurn; maxModelRounds defaults to the smaller of 16 and the parent limit; explicit values cannot exceed the parent configuration. Workers of interactive coordinators use asynchronous mode; headless remains headless. Workers cannot recursively spawn Task workers or change the root Goal. Shared-workspace writers still need explicit file ownership.

For scheduled tasks, pause/resume affects future triggers only, including while current coordinators and workers continue. stopRun settles current work without cancelling recurrence. resumeRun requires the latest Run ID, keeps its Thread/configuration and checks Host readiness, permissions and unknown operations. Approval defaults to 300 seconds; expiry records approvalExpired, settles Turn/resources and retains a blocked Run. Continuing requests fresh approval. foreground/background keep their existing controls; cancel removes future triggers and stops current work.

Core requests `areal/task/prepare {taskId,runId,threadId,scheduledAt,intent:"start"|"resume"}` from the authenticated live Host. Start replies provide ThreadStart configuration fields (model, agentProfile, parameters, dynamicTools); Core fixes cwd, business request key and new Thread identity. Resume preserves frozen configuration. Preparation and Thread receipts are durable; unknown responses never cause a new-key replay, and retired connections cannot admit execution. Already-started legacy scheduled Runs settle under their original rules; later Runs use the new Host admission.

`desktop/task-mode.json` is the sole version 5 commit root. It references immutable hot Tasks, history segments, and receipt and ownership indexes in `desktop/task-ledger/`. A deployment retains the 1024-Task limit and 32 MiB ordinary hot-state budget. Each immutable file has a separate 256 MiB hard read limit. The 128-Run and 1024-message values are hot retention targets. Cold storage preserves full history and original idempotency responses, so historical counts no longer pause recurring Tasks. Archival requires a terminal Run, confirmed usage, no unknown requests, settled workers, and no pending questions. Unknown tool effects, approvals, and Thread history that cannot be proved safe in a bounded check remain hot. A live retention pass inspects at most 16 Thread snapshots. A Run referencing more than 16 Threads stays hot until the full startup inspection, so it can still consume the ordinary hot-state budget; the default worker limit is 64. Ordinary growth at capacity returns `taskHotStateCapacity`; control and bounded terminal settlement of admitted work use reserved capacity. A physical write failure or uncertain commit freezes Task writes and new dispatch. Restart validates and syncs the committed root and every referenced file before resuming. Running or suspended Runs pause after a Core restart and require explicit resumeRun (scheduled) or resume; schedules that have not fired remain registered. Unknown tool effects are not replayed. server/drain closes admission and stops current work while preserving scheduled enablement. server/status.activeTasks includes pending timestamps, so ifIdle does not treat them as idle.

The private receipt and ownership indexes use 256 bucket heads and a compressed radix over complete SHA-256 keys. A lookup visits at most 64 nodes and searches a sorted terminal leaf of at most 64 rows. Branch files have a 2 KiB read bound. Ordinary packed leaves have a 128 KiB serialized bound; a single larger historical response may use the 256 MiB file limit. Updates rewrite the terminal leaf and its ancestor path. Catalog index version 3 uses node version 2. The unreleased experimental index version 2 is rejected without replacing its root. Deployed Task store versions 1–4 migrate with the original root bytes and immutable referenced files preserved. Original receipts, pending cursors, and existing Run facts are not recalculated.

Thread snapshot version is 13; the API remains areal.core.v1. Old Threads/Goals remain readable; legacy Goals register a Task on their first resume. Older binaries cannot read new snapshots. Embedded hosts call `Engine::start_task_scheduler()` after model/tool assembly; app-server calls it automatically.

For a scheduled Task with a total Token cap, updating or resuming its Goal checks the per-Run limit against the total minus confirmed and reserved usage of other Runs. The per-Run limit cannot be removed. Exceeding it returns `TASK_TOKEN_BUDGET` as an invalid-arguments error without saving the update or resuming execution. There is currently no public operation to change a scheduled Task total cap; additional total allowance requires explicitly creating a new Task.

## Request examples

Create background work, then subscribe to its taskId:

```json
{"id":1,"method":"areal/task/create","params":{"requestId":"audit-1","mode":"background","objective":"Inspect the module and provide verification evidence","interactionMode":"asynchronous","tokenBudget":200000,"maxTurns":20,"maxActiveSeconds":1800}}
```

```json
{"id":2,"method":"areal/task/subscribe","params":{"taskId":"<id returned by create>"}}
```

Inbox returns the original Channel question; reply using its runId and id:

```json
{"id":3,"method":"areal/inbox/list","params":{"limit":30}}
```

```json
{"id":4,"method":"areal/channel/reply","params":{"requestId":"answer-1","taskId":"<taskId>","runId":"<message.runId>","questionId":"<message.id>","answers":{"target":"B"}}}
```

A model may choose an asynchronous question inside a foreground Goal:

```json
{"questions":[{"id":"target","title":"Choose the target version","options":["A","B"],"allowFreeText":false}],"mode":"async","required":true,"timeoutSeconds":3600}
```

Example schedule:

```json
{"id":5,"method":"areal/task/create","params":{"requestId":"daily-1","mode":"scheduled","threadId":"<existing root Thread>","objective":"Inspect new failures and prepare a report","schedule":{"at":2000000000,"intervalSeconds":86400},"interactionMode":"interactive","maxTurns":10,"maxActiveSeconds":600}}
```

Task worker model rounds are unlimited when neither caller nor parent config supplies a limit; explicit limits remain inherited and enforced. A deployment Goal ceiling of 0 means unlimited, not a zero-call allowance. Task/Channel record capacities below remain separate service resource limits.

Task storage writes version 5 and migrates versions 1, 2, 3, and 4. Original legacy bytes are backed up under `desktop/task-legacy/`. Migration syncs immutable files before atomically replacing the original path with a version 5 root, which older binaries reject. Backups, copies, and restores must include the root and its reachable files. Orphan files do not establish acceptance; this phase performs no automatic collection. Preparation configuration leaves hot state after durable Goal binding or Run termination. TaskWorker preserves legacy threadId/turnId and adds optional execution/executionId for shared and isolated workers. Models use agent_spawn; legacy task_spawn remains callable but hidden. Undelivered candidates cannot complete a Run. When no Turn is active, Core wakes the original coordinator without repeating execution.

Thread-restricted clients cannot create scheduled Tasks that generate fresh Threads. Snapshot and event visibility is rechecked; a subscription ends when a new Run Thread is not authorized.

## Full Run history and capacity diagnostics

The Task projection's `runs` field is a hot window. `runCount` includes hot and cold Runs, `archivedRunCount` counts archived Runs, and `runsComplete=false` requires the history API. `task/runs/list` defaults to 30 rows and accepts 1–100. Rows sort by `(scheduledAt,id)` from newest to oldest. A cursor binds the Task, the first page's upper ordering bound, and the last returned row. Archival location and restart do not change its meaning. `task/run/read` returns the original TaskRun; a single record above the 128 KiB response budget returns an explicit capacity error. History, Channel, list, and subscription reads authorize and project the same captured snapshot. Archival does not expand a scoped client's Thread access.

Channel returns each message ID once in its final state, ordered by sequence. `nextSequence` is the last sequence actually returned. Gaps left by status updates do not imply another page. A message above the response budget returns an explicit error instead of an empty page that keeps claiming more data.

Capacity diagnostics use the existing RPC error boundary. A hot-state capacity error uses `-32001` with `data` equal to `{reason:"taskHotStateCapacity",resource:"taskHotState",recovery:"settleOrCancelExistingWork",retryable:false}`. A failed Task write or frozen store uses `-32603` with `{reason:"taskStorageRecoveryRequired",resource:"taskStorage",recovery:"restartCore",retryable:false}`. A failed write does not fabricate persisted disk-health state. Accepted stop intent, worker settlement, and a terminal Run remain separate observations.
