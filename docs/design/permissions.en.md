[中文](permissions.md) | **English**

# Permission architecture

Core resolves chat permissions, approvals and grant records. Runtime enforces resource boundaries for managed files and commands. Electron Main owns native browser pages, control and per-action target validation. Clients display state and submit intent.

## Chat presets

Optional `ClientOptions.permissionPreset` accepts `ask`, `autoReview` or `fullAccess`. The desktop application's `ApplicationSettings.defaultPermissionPreset` defaults to `autoReview`. An explicit selection in a new-chat draft or an existing chat's permission menu immediately saves that preset as the default for future chats, including `ask`.

A new-chat draft restores a valid saved permission choice before using the application default. Changes to the application default leave an open draft's permission unchanged. Clearing the draft uses the latest default. Existing chats always use Core configuration and never update automatically when the application default changes. If the current chat's update fails or returns UNKNOWN, the menu selection remains the default for new chats, and the current chat retains its existing recovery flow.

New Remote chats continue to select `ask` explicitly. Missing fields in old snapshots retain previous semantics and do not imply a new sandbox or reviewer.

| Preset | Managed execution range | Additional requests |
| --- | --- | --- |
| Ask for approval | Workspace and task scratch, command network denied | User approval |
| Approve for me | Same as Ask for approval | Independent model review with user fallback |
| Full access | Complete range allowed by deployment | Routine approvals skipped |

Plan mode adds an independent read-only restriction. Deployment denials, mandatory human approvals, Profiles, parent constraints and tool allowlists take precedence. Full access cannot exceed deployment ceilings or enable unsupported actions.

Core returns `EffectiveConfig.permissions` with `resources`, `reviewer` and `fullAccessAvailable`. Clients check `features.permissionPresets` and `features.permissionFullAccess`, rejecting unsupported presets instead of silently falling back to old tool arrays.

Thread creation atomically saves initial options. Updates retain idle and revision checks. Turns and queued messages freeze configuration at admission; recovery does not reinterpret historical permissions through the current Composer.

## Operation grants and cleanup

Core retains a private Turn authority scope that is never passed to tools. Base and approved-operation scopes are its children, sharing parent resource constraints and recursive cleanup.

`run_command.permissionRequest` explicitly requests extra read directories, write directories or networking for one operation. Core validates final arguments against deployment and parent ceilings and binds the digest before review. Approval creates only an operation scope without widening the base. Background process reads, input and termination remain bound to the original scope.

`read_file`, `search_files`, `image_read`, `fs_read`, `fs_list` and `fs_stat` reuse the same per-operation approval entry. Their `permissionRequest` accepts only `readRoots` and `justification`, rejecting write, network and unknown fields. Approved read scopes have `writeRoots=[]` and `network=deny`, without changing the original base scope. A directory reference remains task input; ordinary Markdown is never an automatic grant. Approved image reads enter the existing Core media path directly.

A denied compound command may already have partial effects and is never replayed automatically. Cancellation prevents new dispatch. Lost receipts or failed cleanup retain UNKNOWN rather than claiming rollback. Restart never replays unknown operations.

## Independent review

Approve for me makes a separate request through the frozen model adapter. Its input contains user intent, final arguments, requested access and mandatory restrictions. The reviewer receives no executable tools. Structured output must match the request digest. Core records reviewer identity, decision, rationale and usage. Review retains its 20-second overall deadline, 512-token output budget and no-tool restriction. Actual HTTP requests use the same model-capacity boundary as solve and summary: internal backoff releases capacity, retries queue and account again, and active responses retain their slot. Cancellation never dispatches the pending operation or replays unknown effects. Routing is isolated by Thread, Turn and permissionReview purpose.

Explicit refusal prevents execution. Uncertainty, invalid output, timeout or service failure uses the existing human approval path. Noninteractive tasks deny execution when required human approval is unavailable. Review cannot override hard denial, read-only or mandatory human gates. PermissionRequest hooks retain their existing contract and do not replace the reviewer.

## Browser tasks

Preparing describe reads the actual page identity and origin, or records an intention to create a blank page, without claiming, navigating or sending input. After Core's decision, execution validates the one-time plan, native target and admitted message entry before using the existing Main claim path.

Supported reads, waits, ordinary navigation and search inside the authorized task and page control do not ask again merely because snapshots or queries change. Each operation retains a concrete prepare/execute plan. Main validates arguments, target, page, host and control generations each time, including individual batch steps.

Human takeover revokes old plans and entries; an old Turn cannot reclaim control automatically. Privacy checks, native permission denial, stale references, unsupported actions and UNKNOWN handling remain across presets. Full access does not enable arbitrary JavaScript, full CDP or unsupported sensitive actions.

Browser operation grants are separate from command network isolation. Core, MCP and plugin hosts do not automatically share Runtime isolation either. Managed-command restrictions cannot be advertised as application-wide isolation.

Contracts are in [desktop API](../api/desktop.en.md), [Core](../api/core.en.md), [Runtime](../api/runtime.en.md) and [browser](../api/browser.en.md). Deployment configuration is in [permission modes](../guides/configuration.en.md#permissions).
