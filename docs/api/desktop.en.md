[中文](desktop.md) | **English**

# Desktop API: areal.core.v1

This contract extends [Core WebSocket](core.en.md), separately from Runtime JSONL and [CLI stdio](claude-cli.en.md). Full requests, responses, notifications and persistent types are in [areal-core-v1.json](../../schemas/areal-core-v1.json). Requests reject unknown fields.

## Authentication and connection

Product servers listen on loopback and authenticate WebSocket/Blob requests. Trusted Main reads its Bearer token from authFile in ready metadata; Renderer receives neither that file nor model credentials. Built-in Web exchanges credentials at POST /areal/auth/session for an HttpOnly, SameSite=Strict cookie and validates Origin.

The auth file `{version:1,principals:[{id,token,permissions,threadIds?}]}` requires mode 0600. Permissions are observe/interact/manage/tools; explicit threadIds limit observation and interaction. Client names and Thread IDs are not authentication.

Use initialize → initialized → areal/capabilities (optional apiVersion). Request IDs are independent in each direction; item/tool/call is a server request requiring a response. Replace the baseline through thread/resume. See [Core](core.en.md) for subscriptions, queues and backpressure.

## Method catalog

| Method (without `areal/`) | Permission | Behavior |
|---|---|---|
| capabilities | observe | Negotiate areal.core.v1, methods, events and effective limits |
| profile/list/read, skill/list/read | observe | Versioned definitions and on-demand resources |
| thread/start/configure | interact; tools for dynamic tools | Durable acceptance and idle configuration CAS |
| plan/read/update | observe / interact | Up to 64 steps, conditional expectedRevision update |
| interaction/list/respond | observe / interact | Questions/approvals bound to Thread/Turn/requestId |
| provider/list/read/upsert/remove/probe | manage | Credential references, CAS writes and explicit probes |
| model/list | observe | providerId/modelId, capabilities and availability |
| turn/start/enqueue, queue/list/update/remove/reorder/pause/resume | observe / interact | Durable submissions, frozen configuration and queue management |
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

turn/start/enqueue take `{requestId,threadId,input,expectedConfigRevision?}`. Queues retain at most 128 historical items with frozen configuration. Only success advances automatically. Stop/failure/UNKNOWN/restart/drain pauses the queue until explicit resume. After timeout, query request/read or authoritative state rather than assuming no side effects.

thread/configure requires expectedRevision and an idle, non-compacting Thread. resetModel=true clears the session model override to Profile/service defaults and cannot accompany a nonempty model. Omitted parameters retain values; `{}` selects target Provider defaults. features.modelReset advertises support.

options.readOnly narrows Scope write roots and networking. toolAllowlist narrows the Profile; preapprovedTools cannot remove mandatory deployment approvals. maxModelRounds is 1–1024 with a handoff-only final round, not a team request budget. Profile/Workflow definitions use immutable id/revision pairs; Skill references do not freeze resource content, as described below.

<a id="skills"></a>
## Skill metadata and resources

Trusted deployment manifests accept skills as `{id,revision,root,metadata?:{name,description}}`, with root relative to the manifest directory. When metadata is omitted, registration parses only the bounded SKILL.md header without scanning attachments. Explicit deployments and discovery share the same on-demand read behavior.

Entries in `areal/skill/list` data add name/description; resources is always null instead of a complete resource inventory. available and resourceRoot retain their meaning. Initial model prompts include only names and bounded descriptions; agents call skill_read for full instructions.

`areal/skill/read` / `skill_read` reads current disk content on each call, with maxBytes of 1–8192 and offset/nextOffset pagination. sizeBytes is the file size observed when opened for that call. Resources may exceed 256 KiB; binary content uses dataBase64. Concurrent changes may produce inconsistent pages. See the [Skill guide](../guides/skills.en.md) for path restrictions and discovery warnings.

Compatibility: Skill revision no longer guarantees immutable content, and legacy skillHashes are ignored. Existing `{id,revision,root}` manifests remain valid. Trusted launchers must register historical references or they are unavailable. Auto-discovered revisions now hash metadata; persistence semantics for Profile/Workflow definitions and session history are unchanged.

## Interactions and media

Approvals bind Thread/Turn/callId, Host generation, effective argument digest and permissions. Only allowOnce/deny are supported, without expanding grants. Questions allow 8 questions/8 options each, 4096-byte answers and 256 historical interactions. Waiting holds no model permit; Stop wins, and late/cross-Turn responses fail.

POST `/areal/blobs?threadId=...` uploads raw bytes with Content-Type matching signatures. Tool uploads also supply callId/hostGeneration and require tools permission. Limits are 16 MiB/file, 128 uploads/64 MiB per Thread, and 16384 Blobs/512 MiB globally. Supported types are PNG/JPEG/GIF/WebP, WAV/MP3, PDF and UTF-8 text. GET requires authentication, threadId and reference ownership; a digest is not an access token.

contentItems preserve inputText/arealMedia order and deliver actual bytes to models. Authenticated RPC rejects host localImage/localAudio paths; use uploaded areal://blob URIs. Unsupported modalities fail explicitly.

## Processes and retention

process/start defaults to lifetime=turn. Thread lifetime needs Profile allowThreadProcesses; writable services also need deployment allow-concurrent-writes. Input is attributed to authenticated identity. Output cursors and cleanup reuse Runtime facts. PTY resize uses actual ioctl; pipe EOF closes the FD, canonical PTY uses VEOF, and raw mode is unsupported.

Old-epoch handles return STALE_HANDLE without process restoration. Thread processes, UNKNOWN, active groups or compaction prevent restartSafe. Archiving requires idle, settled queues/resources and releases hot history while retaining disk snapshots and deduplication keys. GC after drain scans hot/cold references and cannot collect referenced Blobs.

Events use areal/ prefixes, including thread/configured/archived, plan/updated, queue/updated, interaction/requested/resolved, process/updated and server/draining. Their revisions are not output cursors. Unknown model windows/usage remain null or absent rather than guessed. See [direct protocol examples](../examples/desktop-api.en.md).
