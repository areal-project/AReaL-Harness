[中文](worktrees.md) | **English**

# Desktop worktrees

A new desktop conversation can select a starting branch and project environment to create a worktree within the same Git repository. Each isolated checkout has its own Core and Runtime. The sidebar continues to show threads under the original logical project. Workspace preparation happens before the first message executes. Existing conversations are not moved transparently.

## Workspace selection for a new conversation

Open the gear above the Composer on the right. Enable **New worktree**, then select a starting branch and a project environment. Search filters the branch list. The environment configuration link opens **Settings > Worktrees > Environments** for the project. The selection applies to the current unsent draft. New conversations do not inherit old global or project worktree preferences. Creation begins when you send the first prompt. The source must share the repository's Git common directory. The host pins its ref to a commit before creating an independent named branch. It does not reuse an occupied branch or overwrite a directory. Projects opened in repository subdirectories keep their relative execution root. Preparation fails if that directory is absent from the selected commit.

Ordinary new conversations use the current directory and branch, sharing the current Core. A separate checkout is created only when you explicitly enable **New worktree** for this creation. Missing selections, legacy drafts, saved preferences, and existing conversations do not trigger automatic isolation.

Preparation shows its stage, output, and the submitted prompt preview. Cancellation blocks the first message and confirms that preparation has stopped. Created directories remain. **Don't use worktree** creates a new explicit request for the original checkout only after cancellation is confirmed. Unknown results never trigger an automatic fallback. The sidebar fork icon and creation status reflect the actual worktree binding.

## General settings and directory management

**Settings > Worktrees > General** stores the root, branch prefix, fetch preference, automatic cleanup, and retention count. An empty root uses `~/.areal/worktrees`, with a directory per project. The default branch prefix is `areal`. An unnamed branch uses that prefix and the request UUID. Changes affect future creations only. They do not move existing directories or rename branches. Fetch is off by default. When enabled, the host fetches before pinning the starting commit.

The management list groups registered worktrees by project. Deletion verifies the checkout and execution host, runs the selected environment's cleanup, and checks Git again before a non-force removal. Branches and history remain. Active tasks, unknown operations, dirty files, untracked files, ignored files, and unmerged commits can block deletion. The primary checkout cannot be deleted here. Automatic cleanup is off by default. It considers archived, unpinned conversations and unbound checkouts, using the same checks. Protected worktrees can keep the total above the retention limit.

## Project environments

**Environments** stores a name, setup script, cleanup script, and custom actions per project. Scripts have **Default**, **macOS**, and **Linux** tabs. A nonempty platform script replaces Default. An empty override uses Default. Creation freezes the selected environment. Later edits do not change existing worktrees.

Choose a project, then open its environment list to add or edit an environment. Setup, cleanup, and each action have independent platform tabs. Switching tabs preserves unsaved scripts for other platforms. Variables explains the supported variables. Expand an action row to edit it. Saving configuration does not run scripts. Returning preserves project context and protects unsaved changes.

Setup runs in the new worktree's project root. The first prompt is sent only after setup succeeds. An empty bound thread can exist during preparation. Cleanup runs before deletion. Run an action explicitly from the current worktree to build, test, or run another project command. Scripts use Core managed processes and their existing permission, timeout, output, and cleanup rules.

Scripts receive `AREAL_WORKTREE_PATH`, `AREAL_PROJECT_PATH`, and `AREAL_WORKTREE_BRANCH`. Paths and branch names are passed as environment variables. Only a saved, selected environment runs. Repository setup scripts and Git hooks are not discovered or executed automatically. The script entry supports macOS and Linux. Each script runs for at most 10 minutes and retains up to 64 KiB of output. It is a managed command and does not leave an unmanaged background service.

Setup failure preserves the draft, journal, and checkout without sending the prompt. Unknown script outcomes are inspected through their original receipts and never rerun automatically. Failed or unknown cleanup preserves the directory. Before an explicit retry with a new request, inspect any effects the original script may have produced.

## Source changes and compatibility

A new worktree contains only the selected commit. Staged, unstaged, untracked, and ignored source content is not copied. Source HEAD, index, and files remain unchanged. The host does not stash, commit, or run Git hooks. Setup runs only for a selected saved environment. It does not automatically copy `.worktreeinclude` files. The new host uses the deployment's global or default resources. Source-project-specific Skills, MCP configuration, and Profiles are not cloned. An unavailable selected resource cannot silently redirect execution to the source checkout.

The old `source: "working-tree"` snapshot entry created a temporary Git commit. That mode now returns an explicit error asking for a commit or branch. Its old "include uncommitted changes" meaning is not silently replaced. Existing worktrees and legacy creation records remain. They are not automatically moved. A user who needs uncommitted content must explicitly prepare a suitable source commit or independent directory first.

## Creation, binding, and recovery

Each creation uses a stable `requestId`. An identical request returns its original directory and thread. Reusing the identifier with different model, options, or worktree parameters fails. After a timeout or disconnect, inspect the original request. A new identifier is not evidence that the first operation did not run.

| State | Meaning and recovery boundary |
|---|---|
| `creating` | Creation intent is saved, but the Git result is not confirmed. A repeated request cannot create a second directory. |
| `created` | The Git checkout is confirmed. Thread binding remains incomplete, so model execution is not ready. |
| `binding` | The execution host is selected. Thread creation or its receipt is still unconfirmed. Recovery reads the original Core receipt without replaying an unknown submission. |
| `settingUp` | An empty thread is bound while environment setup is checked. The first prompt has not been sent. |
| `cancelling` | Cancellation is requested. The original operation must stop before another checkout is selected. |
| `cancelled` | Preparation is confirmed cancelled. The draft and any created checkout remain. |
| `ready` | Thread identity, execution host, and environment preparation are confirmed. The first prompt can be sent. |
| `failed` | Failure is confirmed. The source and created resources remain. A corrected attempt uses a new explicit request. |
| `unknown` | Part of the Git outcome is uncertain. Query and inspect existing branches, directories, and records before any retry or cleanup. |

If creation remains uncertain, first use **Check operation status** to query the original UUID. After that check, **Keep original result and return to draft** requires confirmation. It archives the original request information and preserves its directory and any empty conversation. It neither replays the request nor sends the draft. You can then manually choose a new workspace and send a new request, creating a separate resource. The original outcome still requires inspection.

Creation events belong to the desktop host's durable journal. The UI projects them into the conversation flow and shows the branch and directory on the thread and workspace context. It does not fabricate Core messages or model tool results. Reconnection restores the original records and host snapshot. If Git succeeds but registration, resource initialization, or binding fails, the checkout remains available for inspection. Execution does not fall back to the source directory.

Explicit worktree creation rejects an existing target branch, directory collision, invalid ref, foreign-repository source, or non-Git source. Non-Git directories support multiple ordinary conversations. Root directories reject traversal and symlink ancestors. Concurrent creation uses independent request records and destination reservations. `git worktree lock` is not a file-write mutex. Deletion and optional automatic cleanup act only on verified managed worktrees. They do not merge worktrees.

## Execution-isolation scope

The logical project, source checkout, and execution host have separate identities. Tool paths, default shell cwd, managed processes, child agents, and queues belong to the actual Core and Runtime. Desktop file editing, Git, media, history, process control, and browser callbacks also route through the thread's owner. Native file opening follows that directory. Unsaved file caches distinguish the logical project and actual root.

The system does not automatically choose a worktree or move ordinary threads when other conversations or writes exist. Existing worktrees and earlier automatic-isolation requests retain their original directory and Core. Recovery preserves the original binding.

Ordinary conversations, Forks, and child agents in the same Session can share the current directory. Desktop still verifies Core thread identity. Ordinary Side discussions remain read-only, and executable Side discussions verify their source and cwd. Ordinary conversations in a shared directory can write the same files concurrently. Users explicitly choose worktrees when their tasks need separate checkouts.

Ordinary execution still reads the full paginated Task catalog for the same checkout. Uncancelled scheduled tasks retain their dedicated directory even when sleeping, paused, or reporting `activeTasks` as zero. Only the verified original task family can execute there. Failed reads, unknown catalogs, and invalid pagination block execution without pausing, deleting, or moving tasks. Read-only inspection, explicit cancellation, and resource cleanup remain available.

Task operations first resolve durable execution-host ownership, then use a Core-verified thread anchor for the same author admission. Unknown or conflicting ownership, a removed host, or a read timeout never falls back to the logical project's source checkout. `taskRunNow`, `taskResumeRun`, `taskReply`, and `taskResume` require a verifiable thread anchor. A caller-supplied thread cannot override recorded task ownership.

Scheduled tasks use dedicated admission. One task family exclusively reserves an automatically allocated projectless directory through the same directory-author registry. Read-only planning start, send, and the original autosave-confirmation flow remain available. Reservation precedes execution-anchor and task creation; creation receipts are checked before task binding. A `scheduled` creation can use a trusted existing anchor or create one after reservation. Later start and resume preparation recheck the Task, run, thread anchor, and actual cwd. Foreground and background tasks still require trusted thread anchors without acquiring permanent exclusive ownership of ordinary directories.

Interactions in the current scheduled Run can map to its reserved family author only for strictly verified `respond` and `continue` requests. The reservation, unique active Run, goal, current Turn, actual cwd, and Core-registered workers with a bounded parent chain must match. Question and approval responses must also match the unexpired pending interaction, thread, Turn, requestId, and answer kind. This does not authorize arbitrary descendants, foreign Sessions, ordinary sends, edits, or manage writes. Native Task Agent research and tool restrictions remain in force, including the restriction on recursive delegation.

Answering a valid question or approval lets Core automatically continue the original Run. Ordinary Core Continue remains unsupported for goal-owned scheduled-execution threads. Use `taskResumeRun` for paused or blocked Runs; it creates a fresh Turn in the same Run and thread. Host disconnect during a pending interaction pauses the Run. The old requestId cannot be replayed; after resume, answer only the new Turn's new question. Cancelled, paused, completed, or foreign Run identities cannot supply the interaction-author mapping.

Shared directories, user-selected existing directories, and legacy schedules without an original reservation cannot activate or resume execution. They return `SCHEDULE_WORKSPACE_REQUIRED` or the applicable author-admission error. Pause and cancellation remain available. `taskDraftConfirm` creation, updates, and resume with an eligible directory reservation remain available.

Direct Core or CLI calls, hosts using different desktop data directories, and native scheduling outside the desktop entry do not share this author registry. Admission does not retroactively stop already prepared or running legacy autonomous work, so those paths do not gain an equivalent isolation guarantee.

Schedule-family author records live in `workspace-authors` under the desktop data directory. Legacy ordinary-author records remain, but ordinary conversations no longer acquire or enforce their permanent exclusivity. `claim.lock` serializes new author registration and is released after normal completion. A crash-stale lock is not automatically removed on timeout. Before manual recovery, confirm that every original desktop host, Core, Runtime, child agent, and background process has stopped. Back up the complete desktop data directory and inspect author records, tasks, and creation receipts. Only after proving that the lock is stale and no old execution remains may it be moved aside manually. Preserve author records; deleting them must not transfer directory ownership. If evidence is incomplete, keep execution blocked.

An independent Runtime root is not a filesystem security sandbox. A `full-access` shell can use absolute paths to reach another checkout. Trusted MCP services, plugin Hosts, and external programs can also produce outside-root or delayed effects. Git worktrees still share objects, refs, and some repository configuration. OS permissions, external-service authorization, and existing author leases, read-set version checks, and process-cleanup protections remain in force. These mechanisms do not establish a universal no-concurrent-write guarantee.

## Differences from Codex

The [Codex App worktree guide](https://learn.chatgpt.com/docs/environments/git-worktrees) describes a selected starting branch, detached HEAD by default, optional application of source-branch uncommitted changes, and a configurable Worktree root. AReaL's named branches, `areal` prefix, and committed-content-only behavior are explicit product choices, not Codex defaults.

The [pinned public model-tool contract](https://github.com/openai/codex/blob/e6ebdfe00b520e21ed50ac0362656f32dd64d2fc/codex-rs/tui/src/managed_worktree_tool_specs.rs) includes `create_worktree`, `get_worktree_creation_status`, and `list_worktrees`. That TUI contract defaults to the remote default branch, excludes uncommitted changes, uses an operationId for polling, and does not change the calling thread's cwd. It differs from the App's new-conversation entry.

AReaL uses one host-managed creation capability without adding a tool the model must voluntarily call. Pre-write separation is host admission policy. A model tool cannot enforce it. Independent Core and Runtime deployments avoid changing only `Thread.cwd` while retaining an old execution root. The tradeoff is more service instances, durable routing, and aggregated state. Icons use the existing design system's branch and worktree meanings without claiming to reproduce private Codex code.

## Verification entry points

Run the Git, host, and desktop-contract tests from the repository root:

```sh
node --test clients/gui/scripts/worktree-git.test.cjs clients/gui/scripts/worktree-host.test.cjs clients/gui/scripts/worktree-contract.test.cjs clients/gui/scripts/worktree-admission.test.cjs clients/gui/scripts/worktree-task-routing.test.cjs clients/gui/scripts/schedule-admission.test.cjs
```

`node clients/gui/scripts/worktree-ui-smoke.mjs` checks production component interactions with Chromium and a deterministic desktop-action fixture. It is not native Electron, package, or macOS acceptance.

After building the real Core, run the integration in an environment that supports native execution:

```sh
make build
AREAL_CORE_BIN="$PWD/target/debug/areal" node clients/gui/scripts/worktree-integration.mjs
```

Run environment checks with a trusted Core executable. The first checks real managed scripts, a 40-second preparation and cancellation, cleanup, and removal. The second drives isolated Electron settings, the first prompt, actions, failure, cancellation, and explicit source selection. Only the file picker and external model use fixtures.

```sh
AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:worktree-environment
AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:worktree-environment-ui
```

Verify the real Core scheduled-interaction protocol separately:

```sh
AREAL_CORE_BIN="$PWD/target/debug/areal" node clients/gui/scripts/worktree-schedule-interactions.mjs
```

From `clients/gui`, `node scripts/worktree-schedule-interactions.mjs` also defaults to the repository-built Core. The script uses a deterministic local model boundary with real CoreBackend/Core. It covers question answers, foreign and stale-request rejection, approval denial, allowOnce, manager reconnect, and same-Run resume. It retains raw logs and a manifest with separate protocol and payload results. A protocol pass does not establish successful file-tool execution: an admitted allowOnce can still fail at Runtime reaper startup without writing its target file. It does not run Electron or establish macOS or real-provider acceptance.

Linux requires working Bubblewrap namespaces and `/proc/self/task/<pid>/children` readable by the Runtime reaper. Missing capability or cleanup evidence must remain a failure rather than disabling protection. GUI behavior, platform behavior, and actual tool mutations require separate verification. Full host fields are in the [desktop host contract](../api/desktop.en.md#desktop-host-worktree-contract).
