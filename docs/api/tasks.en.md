[中文](tasks.md) | **English**

# Task Mode and independent communication

This contract belongs to `areal.core.v1` and serves TUI, GUI, WebUI and other clients. Rust types are in [tasks.rs](../../core/protocol/src/tasks.rs); request, response and notification schemas are in [areal-core-v1.json](../../schemas/areal-core-v1.json). Complete [authentication and initialization](desktop.en.md), then check `features.taskModes/taskChannels/asyncQuestions/headlessInteractions`.

## Ownership and modes

A Task owns identity, objective, schedule, total token budget and a persistent Channel. A TaskRun represents one execution, associated with a Goal and coordinator Thread. The Goal manages progress, execution budgets and continuation across Turns. Threads/Sessions hold model history; closing a client does not delete the Task or Channel. Runtime processes retain existing Scope and permission boundaries.

| mode | threadId | Default interactionMode | Trigger |
|---|---|---|---|
| foreground | Required root Thread | interactive | Queued after acceptance |
| scheduled | Required root Thread | headless | UTC timestamp, optionally a fixed interval |
| background | Optional; Core creates a coordinator Thread | asynchronous | Queued after acceptance; workers may use independent Sessions |

`areal/goal/create` still atomically admits its first Turn and also registers a foreground Task; its response adds `taskId/runId`. `areal/task/create` persists acceptance before asynchronous dispatch; success does not mean the model has started. An existing Goal, active Turn or user queue on the bound Thread delays admission. Each Task has at most one unfinished Run.

Task identity is independent of the client connection, and communication does not target the execution Session. Moving a running coordinator to another Thread, migration across Core deployments and arbitrary mailbox addressing are not supported. Background workers have their own Threads/Sessions. Inbox projects pending questions from accessible Tasks without storing another copy.

## Interaction policy

| interactionMode | ask_user_question | Tools requiring human approval |
|---|---|---|
| interactive | Waits by default; the model may choose `mode="async"` | Existing Turn-bound approval |
| asynchronous | Forces a persistent asynchronous question and returns immediately | Immediate PermissionDenied |
| headless | Immediately returns `status="unavailable", reason="headless", waiting=false`; creates no question | Immediate PermissionDenied |

Headless never awaits users or automatically approves operations. The model can continue with justified assumptions or report a concrete blocker. Tools already permitted by effective policy still execute. scheduled/background reject interactive mode and Threads dependent on client dynamic-tool callbacks. They use server-owned tools under existing Runtime and Profile permissions.

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
| task/create | `requestId, mode, objective, threadId?, interactionMode?, schedule?, tokenBudget?, maxTurns?, maxActiveSeconds?` | Task projection |
| task/list | `after?, limit?` | `{data: Task[], nextCursor}` |
| task/read | `taskId` | Task projection |
| task/update | `requestId, taskId, expectedRevision, objective?, schedule?` | Updated Task projection |
| task/pause, task/resume, task/cancel | `requestId, taskId, expectedRevision` | Task projection after persisting control intent |
| task/subscribe | `taskId` | Atomic snapshot and subsequent task/updated notifications |
| task/unsubscribe | `taskId` | `{removed:true}`; does not cancel execution |
| channel/read | `taskId, afterSequence?, limit?` | `{taskId, channelSequence, data, nextSequence, hasMore}` |
| channel/reply | `requestId, taskId, runId, questionId, answers` | `{accepted:true, messageId, taskId, runId, channelSequence}` |
| inbox/list | `after?, limit?` | `{data:[{taskId, objective, message}], nextCursor}` |

Task projections contain `id, revision, channelSequence, owner, mode, interactionMode, objective, threadId, schedule, nextRunAt, paused, cancelled, tokenBudget, maxTurns, maxActiveSeconds, runs, pendingQuestions`, without embedded messages. A Run contains `id, threadId, goalId, status, reason, scheduledAt, completedAt, usage, waitRequested, workers`. Workers contain `threadId, turnId, status, settled`, with running/completed/cancelled/failed status.

Run status is `queued/running/waitingForInput/waitingForAgents/paused/blocked/completed/failed/cancelled`; the last three are terminal. Task paused/cancelled fields express control intent; the Run can remain running during cleanup. Determine settlement from Run termination and worker.settled, not a control response or coordinator Turn completion.

Cancelling a Task removes future dispatches and terminates unfinished Runs. Runs that have already ended retain their status, completion time and usage ledger as history, including after restart.

ChannelMessage contains `id, sequence, runId, author, kind, status, createdAt, expiresAt, questions, required, inReplyTo, answers, text`. kind is question/reply/workerReport/report. Question status is pending/answered/expired/cancelled; other messages are published. questionId references the question message id. answers maps each question ID to one nonempty string of at most 4096 bytes, covering exactly all questions; closed-choice answers must match an offered option.

A question must belong to the specified Task/Run, remain pending and not have expired. New replies are rejected for cancelled Tasks, completed/failed/budget-limited Goals or replaced Goals. Valid replies may be accepted during pause without resuming execution. Successful retries with the same requestId still return their receipt. Errors use Core codes: `-32602` invalid arguments, `-32009` state/revision conflict, `-32003` permission denied, `-32004` not found, `-32001` capacity exhausted; storage failures use the actual returned Core error.

## Independent Inbox and subscriptions

Clients can answer the same question from a global Inbox or Task detail without opening the coordinator Thread. Unrestricted identities retain deployment-wide shared-workspace access. Identities restricted by threadIds can see only Tasks bound to allowed Threads and cannot create or inspect unbound background Tasks. owner records the creator; it does not introduce a private mailbox ACL. Competing authorized identities can answer a question only once.

`areal/task/updated` carries `{taskId, revision, channelSequence, runId, task}`. Subscription does not depend on thread/resume. task/subscribe captures a snapshot and registers its receiver under one lock; the response precedes subsequent events. Task and Thread subscriptions share the 128-subscription connection limit and bounded send queue. Backpressure closes the connection; clients reconnect and obtain a new snapshot.

Replace task state with the task/subscribe snapshot and subsequent event task projections. When channelSequence advances, page channel/read and **replace** messages by id. State changes give a question a new sequence, so it can reappear in incremental pages. Save nextSequence only after processing the page. Cursors are neither Turn IDs, Task revisions nor read markers. Channel pagination provides changes to latest message state, not a complete immutable event log. Server-side read receipts are not implemented.

limit is 1–100, defaulting to 30 for Task/Inbox and 50 for Channel. Use nextCursor for Task/Inbox and nextSequence/hasMore for Channel. Pages also have an approximate 128 KiB budget; a single Task projection may exceed it. Do not assume pages reach limit. Refresh Inbox through inbox/list; no global Inbox subscription exists yet.

## Updating a scheduled Task

`areal/task/update` accepts `{requestId, taskId, expectedRevision, objective?, schedule?}`, with at least one changed field. Only non-cancelled scheduled Tasks can be updated. A schedule must use a future UTC timestamp and the same interval bounds as creation. Omitted fields retain their values. Authorization, durable idempotency receipts and revision conflicts follow the existing mutation contract. The response and `areal/task/updated` notification contain the full Task projection.

Updates preserve Task, Thread and Run identity, history, pause state and budgets. A new schedule replaces `nextRunAt`. An accepted Goal retains its original objective, and its controls do not overwrite the updated Task objective. Updates are rejected during the short window where a Run is queued but its Goal has not yet been accepted; retry after it starts. An ended one-shot Task can be scheduled again at a future time. Updating neither immediately executes the Task nor changes its workspace. Clients first check that methods includes `areal/task/update`.

## Scheduling, budgets and recovery

Only scheduled mode accepts schedule: `{at: UTC Unix seconds, intervalSeconds?: 1..31536000}`. Omitting intervalSeconds makes it one-shot. Repetition is anchored to at; missed timestamps coalesce into one trigger after service recovery. A trigger is skipped while an unfinished Run exists, preventing overlapping Runs. Cron, calendar timezone rules and waking a powered-off host are not supported. Core must remain running.

Task tokenBudget covers confirmed and reserved consumption across all Runs. maxTurns/maxActiveSeconds apply per Run, retaining Goal conservative admission and unknown-usage handling. Active time is the union of coordinator and detached-worker execution intervals; overlapping work is not counted twice. Waiting for a user after all execution releases capacity adds no active time. Workers inherit frozen configuration, permissions and the same Goal budget. Their cumulative count per Run is bounded by deployment maxChildrenPerTurn; maxModelRounds defaults to the smaller of 16 and the parent limit; explicit values cannot exceed the parent configuration. Workers of interactive coordinators use asynchronous mode; headless remains headless. Workers cannot recursively spawn Task workers or change the root Goal. Shared-workspace writers still need explicit file ownership.

pause durably stops dispatch and cancels current coordinator/workers. cancel also removes future timestamps and cannot be resumed. resume retains budgets and never replays ended workers; failed/cancelled workers are not successful dependencies. Goal pause/resume/update/clear synchronize the corresponding Task; a cancelled Task's Goal cannot resume. Recurring Runs clear the same Task's previous Goal while preserving history and accounting.

`desktop/task-mode.json` stores Tasks, Channels and idempotency receipts. Limits are 1024 Tasks, 8192 receipts and 32 MiB per deployment, plus 128 Runs and 1024 messages per Task. Capacity exhaustion rejects or pauses work without deleting history. Running or suspended Runs pause after a Core restart and require explicit resume; schedules that have not fired remain registered. Unknown tool effects are not replayed. server/drain pauses Tasks and time triggers. server/status.activeTasks includes pending timestamps, so ifIdle does not treat them as idle.

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
{"id":5,"method":"areal/task/create","params":{"requestId":"daily-1","mode":"scheduled","threadId":"<existing root Thread>","objective":"Inspect new failures and prepare a report","schedule":{"at":2000000000,"intervalSeconds":86400},"interactionMode":"headless","maxTurns":10,"maxActiveSeconds":600}}
```

Task worker model rounds are unlimited when neither caller nor parent config supplies a limit; explicit limits remain inherited and enforced. A deployment Goal ceiling of 0 means unlimited, not a zero-call allowance. Task/Channel record capacities below remain separate service resource limits.

Task storage writes version 2 and reads version 1. TaskWorker preserves legacy threadId/turnId and adds optional execution/executionId for shared and isolated workers. Models use agent_spawn; legacy task_spawn remains callable but hidden. Undelivered candidates cannot complete a Run. When no Turn is active, Core wakes the original coordinator without repeating execution.
