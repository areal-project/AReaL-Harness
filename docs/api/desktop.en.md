[中文](desktop.md) | **English**

# Desktop API: areal.core.v1

This contract extends [Core WebSocket](core.en.md), separately from Runtime JSONL and [CLI stdio](claude-cli.en.md). Full requests, responses, notifications and persistent types are in [areal-core-v1.json](../../schemas/areal-core-v1.json). Requests reject unknown fields.

Thread snapshots and Item notifications accept the optional `agentMessage.phase` field; see [Core message phases](core.en.md#agent-message-phase) for lifecycle, examples and legacy compatibility. This additive response field keeps `areal.core.v1` unchanged.

## Authentication and connection

Product servers listen on loopback and authenticate WebSocket/Blob requests. Trusted Main reads its Bearer token from authFile in ready metadata; Renderer receives neither that file nor model credentials. Built-in Web uses a separate HttpOnly, SameSite=Strict session cookie and validates Origin; see automatic local login below.

The auth file `{version:1,principals:[{id,token,permissions,threadIds?}]}` requires mode 0600. Permissions are observe/interact/manage/tools; explicit threadIds limit observation and interaction. Client names and Thread IDs are not authentication.

Use initialize → initialized → areal/capabilities (optional apiVersion). Request IDs are independent in each direction; item/tool/call is a server request requiring a response. Replace the baseline through thread/resume. See [Core](core.en.md) for subscriptions, queues and backpressure.

<a id="browser-auth"></a>
### Browser login

- `POST /areal/auth/bootstrap`: a trusted local client supplies `Authorization: Bearer <local token>` without Origin; success returns `200 {code,expiresIn:60}`. Cookies cannot mint codes; requests with Origin receive 403.
- `POST /areal/auth/bootstrap/exchange`: the page sends JSON `{code}` with an Origin exactly matching the service. Bodies are limited to 1 KiB and unknown fields are rejected. Success returns 204 with a session cookie. Invalid, expired, consumed or other-instance codes return 401; missing or mismatched Origin returns 403.
- `POST /areal/auth/session`: manual Bearer login remains available, returning 204 with an independent session cookie. Existing cookies cannot renew a session. Any supplied Origin must match the service.

Codes have 244 bits of random entropy, expire after 60 seconds and are consumed atomically once. The CLI opens `/ui#bootstrap=<code>`; fragments never enter HTTP request targets. The page uses `history.replaceState` to remove the fragment from the current history entry before exchanging it through POST, without localStorage/sessionStorage. Failed automatic login prompts another `areal web` invocation or manual login. Authentication responses use `Cache-Control: no-store`; clients disable proxies and redirects. Long-lived launcher tokens never enter URLs, service descriptors, logs or cookies.

Cookies are named `areal_session_<origin digest>`, omit Domain and use `HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`. Transport is restricted to HTTP loopback, so the HTTPS-dependent Secure attribute is omitted. Names distinguish local ports; cookies are not an isolation boundary against untrusted processes on the same host. Independent sessions inherit the original permissions and threadIds. The server stores SHA-256 digests of codes and session IDs and enforces a one-hour absolute lifetime: HTTP/new WebSocket authentication is rejected and existing browser connections close, without cancelling background tasks. Restart invalidates all codes and browser sessions. Each service retains at most 64 valid codes and 1024 valid sessions; capacity returns 429 without evicting existing sessions.

Compatibility: Bearer clients and the authentication file format are unchanged. Legacy `areal_session=<long-lived token>` cookies are rejected; run `areal web` again or sign in manually after upgrading. `areal web --json` preserves its descriptor and neither opens a browser nor mints a code. Request/response types are browserBootstrap / browserBootstrapExchange in [local-service-v1.json](../../schemas/local-service-v1.json).

## Method catalog

| Method (without `areal/`) | Permission | Behavior |
|---|---|---|
| capabilities | observe | Negotiate areal.core.v1, methods, events and effective limits |
| profile/list/read, skill/list/read | observe | Versioned definitions and on-demand resources |
| thread/start/configure | interact; tools for dynamic tools | Durable acceptance and idle configuration CAS |
| plan/read/update | observe / interact | Up to 64 steps, conditional expectedRevision update |
| permissions/read/forget | manage (unrestricted threadIds) | Read mode, sources, remembered grants; revoke memory |
| interaction/list/respond | observe / interact (allowProject also needs unrestricted manage) | Questions/approvals bound to Thread/Turn/requestId |
| provider/list/read/upsert/remove/probe | manage | Credential references, CAS writes and explicit probes; upsert/remove of TOML-managed IDs return `CONFIGURATION_MANAGED`; use shared configuration commands |
| model/list | observe | providerId/modelId, capabilities and availability |
| turn/start/enqueue, queue/list/update/remove/reorder/pause/resume | observe / interact | Durable submissions, frozen configuration and queue management |
| goal/get, goal/create/update/pause/resume/clear | observe / interact | Persistent Goals, CAS control and shared budgets; execution begins when a Goal is explicitly created; see the [Goal contract](core.en.md#goals) |
| request/read | observe | Recover receipts for the authenticated identity |
| process/start/list/get/read/wait/write/resize/closeStdin/terminate | observe / interact | Managed processes and shared terminals |
| process/acknowledgeCleanup | manage | External cleanup evidence for old epochs, retaining UNKNOWN |
| thread/closeResources | interact | Await managed resource cleanup |
| agent/spawn/wait, workflow/list/read/start | observe / interact | Configured child tasks or Workgroups |
| mcp/list/read/configure/connect/disconnect | manage | Separate configuration, connection and catalog revisions |
| thread/inspect, context/read/compact | observe / interact | Authoritative execution view, pagination and idle compaction |
| thread/archive, blob/release | interact | Cold history and release of unreferenced uploads |
| server/status/drain/gc | manage | Resource usage, settling and Blob collection |
| subscription/remove | observe | Unsubscribe observation without revoking tool hosts |

<a id="submissions"></a>
## Submissions, configuration and recovery

requestId is a durable business key; RPC id only correlates responses. Identical identity, method, key and normalized parameters return the original result; changed parameters conflict. Each Thread permits 1024 receipts; management logs permit 4096. Exhaustion rejects instead of forgetting keys. Accepted management records without results become UNKNOWN after restart and are not reexecuted.

turn/start/enqueue take `{requestId,threadId,input,expectedConfigRevision?,interactionMode?}`. Queues retain at most 128 historical items with frozen configuration. Only success advances automatically. Stop/failure/UNKNOWN/restart/drain pauses the queue until explicit resume. After timeout, query request/read or authoritative state rather than assuming no side effects.

`areal/queue/steer` accepts `{requestId,threadId,expectedRevision,queueItemId,expectedTurnId}` to atomically transfer a pending entry to the specified active Turn. Under one Thread lock, Core reserves steering capacity, validates the Turn and input, and persists the message, `steered` queue status and receipt together before notifying the executor. Rejection keeps the entry pending. Success returns `{queueRevision,queueItemId,turnId,itemId}`. Steering uses the active Turn model and mode; queue updates retain the original queued configuration. The same identity, request key and parameters return the recorded result; different parameters conflict. Query its receipt with `areal/request/read` and threadId. Unknown results are observed without automatic resubmission.

Composer edits queue entries in the main input after confirming a pause. Saving updates the original position and attachment references while retaining the queued model/mode; save or cancel restores the original draft. The previous unpaused state is restored only while the revision and pause reason still belong to that edit. External updates, deletion or UNKNOWN preserve the edit without implicit overwrite or state restoration. Existing unsent File drafts survive navigation within the current GUI process; no disk attachment cache is added. `pnpm --dir clients/gui run test:queue` checks the queue paths with isolated Electron/Core/Runtime and a deterministic HTTP/SSE model.

`EffectiveConfig.defaultModelRevision` is an optional opaque reference to a default-model snapshot, fixed when a Turn or queue item is submitted. Session defaults omit it; explicit Provider selections retain their semantics. The model archive belongs to the data directory and contains no environment credential values.

thread/configure requires expectedRevision and an idle, non-compacting Thread. resetModel=true clears the session model override to Profile/service defaults and cannot accompany a nonempty model. Omitted parameters retain values; `{}` selects target Provider defaults. `selectedSkills` accepts `{id,revision}` Skill references; an empty array clears the session override and restores the Profile, and every reference must belong to the active Profile. features.modelReset advertises support.

`areal/thread/start` accepts `{requestId,agentProfile:{id,revision},cwd?,model?,parameters?,dynamicTools?}` and creates a Thread with configuration frozen from that Profile. Clients can pass the same reference with `--agent id@revision`; a separate Workflow selection is unnecessary. The Profile `workflow` field is an Agent property: creating the Thread starts it once and records the Workgroup ID and startup status in `desktop.workflowRun`; query the Workgroup API for live status. Retrying the same requestId or resuming the Thread does not start it again. A Workflow-bound Profile can only be selected when creating a Thread, not switched through `thread/configure`. A Profile without a Workflow does not require a Workgroup policy and can still use tools permitted by its `toolAllowlist`.

Optional `parameters.reasoningSummary` accepts `auto` / `concise` / `detailed` for Responses only, merging Provider defaults with Thread overrides. Summary requests remain disabled when neither Provider/service defaults nor Thread overrides configure it. `areal/model/list.parameterCapabilities` includes `reasoningSummary` only for Responses providers; this advertises adapter support, not support for every upstream model or mode. See [Core reasoning progress](core.en.md#reasoning-progress) for events and parts.

options.readOnly narrows Scope write roots and networking. toolAllowlist narrows the Profile; preapprovedTools cannot remove mandatory deployment approvals and matches only the current tool name; preapproving a read tool does not exempt its hooks. maxModelRounds is 1–1024 with a handoff-only final round, not a team request budget. Profile/Workflow definitions use immutable id/revision pairs; Skill references do not freeze resource content, as described below.

`areal/model/list.reasoningEffortOptions` reports the existing HTTP adapter's accepted values (`none/minimal/low/medium/high/xhigh`; empty for other adapters). This does not guarantee support by every remote model. Composer reads these options from the catalog and submits parameters through the existing thread configuration path.

<a id="skills"></a>
## Skill metadata and resources

Trusted deployment manifests accept skills as `{id,revision,root,metadata?:{name,description}}`, with root relative to the manifest directory. When metadata is omitted, registration parses only the bounded SKILL.md header without scanning attachments. Explicit deployments and discovery share the same on-demand read behavior.

`areal/skill/list` accepts either `{threadId}` or `{agentProfile:{id,revision}}`. Drafts can observe registered Profile metadata without creating a Thread or reading content. `areal/skill/read` accepts the same mutually exclusive contexts for draft previews of resources allowed by that Profile. Profile reads do not register Thread loading state; sending reads again in the owning Thread. Composer stores skill references and sources, reads SKILL.md before sending, and attaches it to the current message. Read failures preserve the draft.

Entries in `areal/skill/list` data add name/description; resources is always null instead of a complete resource inventory. available and resourceRoot retain their meaning. Initial model prompts include only names and bounded descriptions; agents call skill_read for full instructions.

`areal/skill/read` / `skill_read` reads current disk content on each call, with maxBytes of 1–8192 and offset/nextOffset pagination. sizeBytes is the file size observed when opened for that call. Resources may exceed 256 KiB; binary content uses dataBase64. Concurrent changes may produce inconsistent pages. See the [Skill guide](../guides/skills.en.md) for path restrictions and discovery warnings.

Compatibility: Skill revision no longer guarantees immutable content, and legacy skillHashes are ignored. Existing `{id,revision,root}` manifests remain valid. Trusted launchers must register historical references or they are unavailable. Auto-discovered revisions now hash metadata; persistence semantics for Profile/Workflow definitions and session history are unchanged.

## Interactions and media

Approvals bind Thread/Turn/callId, Host generation, effective argument digest and permissions. allowOnce/deny are supported; effectivePermissions.rememberAllowed=true additionally permits allowSession/allowProject without expanding Runtime Scopes. Questions allow 8 questions/8 options each, 4096-byte answers and 256 historical interactions. Waiting holds no model permit; Stop wins, and late/cross-Turn responses fail.

`permissions/read {threadId}` returns configuration (mode/allow/ask/deny), source, sandbox, workspace, session/project grants and projectFile. `permissions/forget {threadId,project}` clears session or project memory and requires an idle target Thread. Project approval requires manage without a threadIds restriction. See [permission configuration](../guides/configuration.en.md#permissions) for memory and rule precedence. Old snapshots without permissionGrants read as empty. thread/start/resume add permissionMode; full-access Runtime projects as dangerFullAccess.

POST `/areal/blobs?threadId=...` uploads raw bytes with Content-Type matching signatures. Tool uploads also supply callId/hostGeneration and require tools permission. Limits are 16 MiB/file, 128 registered uploads/64 MiB per Thread; no global cumulative Blob quota. Supported types are PNG/JPEG/GIF/WebP, WAV/MP3, PDF and UTF-8 text. GET requires authentication, threadId and reference ownership; a digest is not an access token.

contentItems preserve inputText/arealMedia order and deliver actual bytes to models. Authenticated RPC rejects host localImage/localAudio paths; use uploaded areal://blob URIs. Unsupported modalities fail explicitly.

## Processes and retention

process/start defaults to lifetime=turn. Thread lifetime needs Profile allowThreadProcesses; writable services also need deployment allow-concurrent-writes. Input is attributed to authenticated identity. Output cursors and cleanup reuse Runtime facts. PTY resize uses actual ioctl; pipe EOF closes the FD, canonical PTY uses VEOF, and raw mode is unsupported.

Old-epoch handles return STALE_HANDLE without process restoration. Thread processes, UNKNOWN, active groups or compaction prevent restartSafe. Archiving requires idle, settled queues/resources and releases hot history while retaining disk snapshots and deduplication keys. GC after drain scans hot/cold references and cannot collect referenced Blobs.

Events use areal/ prefixes, including thread/configured/archived, plan/updated, queue/updated, goal/updated/cleared, interaction/requested/resolved, process/updated and server/draining. Their revisions are not output cursors. Unknown model windows/usage remain null or absent rather than guessed. See [direct protocol examples](../examples/desktop-api.en.md).

features.goals=true advertises Goal support without a separate configuration toggle. Goal events follow the same authorization and atomic subscription boundaries. drain closes automatic continuation admission and pauses Goals; archiving and explicit compaction require stopping the Goal and awaiting resource settlement.

Local service discovery, window-independent lifecycle and Desktop Main integration use the [local service contract](local-service.en.md). `server/status` and `server/drain` additionally return `activeGoals` (Thread IDs) and `pendingQueueItems` (pending/running queue count). These are additive response fields; restartSafe still describes execution cleanup rather than absence of scheduled work.

Shared services expose `server/status.configuration` as `{modelRevision,restartRequired,error}`; other deployments return null. Missing environment credentials during model reload may report both `restartRequired=true` and `error`, indicating that a local client with valid credentials must perform a safe restart; other reload errors do not trigger automatic restart. `areal/server/configurationChanged` publishes `{threadId,configuration}` to subscribed threads. `server/drain` also accepts `strategy="ifIdle"`: check idle state and close admission under one gate; busy rejection keeps work running. See [configuration reload](../guides/configuration.en.md).

## Task Mode integration

`task/create/list/read/pause/resume/cancel/subscribe/unsubscribe`, `channel/read/reply` and `inbox/list` form task control and communication APIs independent of Threads; see the [Task contract](tasks.en.md). task/updated carries a Task projection and channelSequence; clients retrieve Channel messages through pagination. server/status and drain add activeTasks, including future schedules. GUI/TUI/WebUI can share this Inbox; existing conversation interaction panels still handle synchronous questions and approvals.

Optional `parameters.contextWindowTokens` (1–2000000) declares model capacity and is retained in model defaults and Thread overrides. `areal/model/list.contextWindowTokens` remains null when undeclared; `effectiveContextWindowTokens` includes the global fallback. Context inspection adds budget fields windowTokens, outputReserveTokens, inputLimitTokens, targetTokens and windowSource (model/fallback). If model configuration or credentials are unavailable, context inspection still works and returns budget=null. This metadata controls local preflight; it does not change the provider model capacity.
