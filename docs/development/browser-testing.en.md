[中文](browser-testing.md) | **English**

# Browser behavior and release acceptance

The native B-10–B-13 fixture must verify a Core interaction contains the prepared page/target/Origin, denial causes zero server effects, approval sends exactly one native click/fill/press effect, and navigation, target replacement, viewport change, takeover, forged approval, and cross-Thread requests produce zero effects. Inject a prepare failure before any input and a lost reply after the fixture server receives input; assert `not_sent` and Core UNKNOWN respectively. Source checks cannot replace these native assertions.

The native fixture must exercise B-24–B-26 through public GUI/Core entry points: reach eight native Pages across Workspaces and four logical Pages in one Workspace; reject creation while execution, takeover, or dialog pins occupy candidates without increasing native object count; report state loss on idle eviction. Check native identity, form values, and scroll after hide. After crash and reopen, check `pageGeneration`, rejection of old Refs/plans/receipts, and UNKNOWN for a dispatched operation. Race delayed load/takeover callbacks with archive, project hide, and window close; assert no old Page reappears, a sibling keeps its shared Session, and the last Page leaves no orphan WebContents or download. Record the results of each real native acceptance run separately.

B-21–B-23 must use two Workspaces and a synthetic loopback login service through the public Core/GUI path. Set HTTPOnly cookies, localStorage, IndexedDB and a Service Worker in one Workspace; confirm sibling pages see them without recreating the claimed WebContents, and a second Workspace does not. Close one sibling and verify the first retains state; close the last page, then recreate and verify temporary state is gone. Navigate only after trusted exact-Origin authorization. Probe a separate unapproved loopback Origin, actual Core/adapter endpoints, a private/metadata destination, and redirects, frames, worker fetches and WebSocket from the fixture; assert zero prohibited server effects. Retain page/Session identities, requests and UI captures in the run manifest. Record the results of each native run separately.

This document defines the complete Browser testing contract. R0 has an isolated native experiment entry; results belong to individual runs and do not imply all scenarios have run. Subsequent acceptance follows the existing real Electron/Core/Runtime/deterministic-model smoke, connection and architecture pattern from the [GUI guide](../../clients/gui/README.en.md).

For the current same-page read slice, run `make build`, `make gui-install`, and `make gui-build`, then `node clients/gui/scripts/browser-read-smoke.mjs` for B-04/B-05/B-06. The fixture uses an isolated home, synthetic site, and local deterministic model. It records Core dynamic-tool call IDs, real native WebContents identity and in-memory sentinel, GUI/native captures, server request counts, and cross-Thread, forged-result, and missing-host outcomes. Source-build results do not establish packaged-app, real-account, or other-OS acceptance.

Use `node clients/gui/scripts/browser-evidence-smoke.mjs` at the same acceptance seam for B-07/B-08/B-09: retained Refs after a partial observation, stale Refs after duplicate-name replacement and Frame navigation, iframe/Shadow coverage, semantic state and parent association, and budget truncation. It isolates each sensitive root/Frame/Shadow/plaintext/cross-origin capture refusal, checks a viewport change and oversized native PNG, records which native observation surface was requested, then checks image input to the model, Core media retrieval in the GUI, and cross-Thread Blob denial. A scenario passes only when the script completes and retains its run manifest.

## Test layers

1. Behavioral unit tests exhaust reference identity, budgets, deduplication, generations and transitions, not private map/class details.
2. Real Core contract tests cover bidirectional requests, prepare/approve/execute, legacy attachment, observer non-rebinding, UNKNOWN and restart, reusing dynamic-tool fixtures.
3. Real desktop E2E is the primary seam: use public Core/user entry points and assert fixture-side effect counts, page sentinels, Core history and GUI projection. Direct Controller access that bypasses policy is not E2E.
4. Human visual/accessibility review covers native overlays, focus, image feedback, IME and the packaged app. Automation alone does not establish subjective visual quality.

Fixtures include separate-origin sites, simulated HTTPOnly-cookie login, cross-origin frames, Shadow DOM, duplicate names, DOM replacement, Canvas, popups, blocking dialogs, downloads/chooser, failed APIs, synthetic secrets in logs, delayed submissions and HMR/style pages. No personal Profiles. Endpoint-denial tests use test services, not scans of user services.

## Scenario matrix

| Scenario | Behavior | Required evidence | Ticket |
|---|---|---|---|
| B-01 | Native identity retained | Record native identity and an unchanged sentinel/form/scroll across inspection and hide. | 01 |
| B-02 | Real input fence | Shield blocks mouse/keys but takeover remains usable; do not only inspect CSS. | 01 |
| B-03 | Debugger conflict | DevTools detach and reattach invalidate old plans. | 01 |
| B-04 | Core same-page roundtrip | A model callback reads the existing page sentinel; GUI evidence matches the Core call. | 02 |
| B-05 | Identity/receipt forgery | Reject cross-Thread targets, same-id replies on a different socket and forged page/host epochs. | 02 |
| B-06 | Unavailable host | No Main/capability means no substitute browser; discovery and errors agree. | 02 |
| B-07 | Ref replacement | Test same-name replacement, frame navigation and partial snapshots without Ref aliasing. | 03 |
| B-08 | Observation coverage | Frames, Shadow DOM, mutation and overflow report honest coverage/truncation. | 03 |
| B-09 | Image/evidence authorization | Deliver an actual model image, deny cross-Thread Blob reads, respect Core frame limits. | 03 |
| B-10 | Actual approval chain | Deny sends no input; allow executes only the recorded actual target plan. | 04 |
| B-11 | Changed target after approval | Navigation, replacement, viewport change or takeover invalidates approved old targets. | 04 |
| B-12 | Forged permission | Model arguments/page instructions cannot create a grant. | 04 |
| B-13 | Dispatch classification | Prepare failure is non-dispatch; connection loss after send is UNKNOWN. | 04 |
| B-14 | Takeover priority | Long waits/full queue/unresponsive Core cannot block local fencing or allow later input. | 05 |
| B-15 | Manual privacy | A secret entered after takeover is absent from agent reads/captures/logs and later buffer delivery. | 05 |
| B-16 | Ambiguous takeover | Server saw one submit, receipt is lost, no second submit occurs; history remains UNKNOWN. | 05 |
| B-17 | Legacy attachment | Preserve old history/tools, attach idempotently, read after restart and run on the same page. | 06 |
| B-18 | Busy/tool conflicts | Reject active Thread, other host, conflicting schema and unsupported version. | 06 |
| B-19 | Tab/popup ownership | Popups retain opener/Thread/context; unknown-origin pages are not closed without consent. | 07 |
| B-20 | No focus theft | Background work does not switch chat/tab and active tab is not a global target. | 07 |
| B-21 | Transient storage isolation | Markers in cookies/localStorage/IndexedDB/SW are isolated across Workspaces. | 08 |
| B-22 | Temporary login handoff | Manual login works for siblings; exit/reopen makes no persistence promise. | 08 |
| B-23 | Internal/control endpoints | Allow the authorized development Origin and reject/gate control endpoints and unauthorized transports. | 08 |
| B-24 | Capacity/pinning | Enforce8-page cap; reject allocation when pinned, never evict an executing page. | 09 |
| B-25 | Crash/stale generation | After crash/rebuild, old Refs/events/receipts cannot affect the new Page. | 09 |
| B-26 | Hide/owner release | Hide retains state, archive releases, late show cannot resurrect. | 09 |
| B-27 | Region provenance | Region maps to the capture, sends to the right Thread and cancel does not navigate. | 10 |
| B-28 | Draft and IME | IME Enter, Thread switches and failed sends neither mis-send nor lose drafts. | 10 |
| B-29 | Stale element annotation | DOM replacement retains annotation evidence but demands a fresh action observation. | 11 |
| B-30 | Element fallback | Inaccessible frame/Canvas falls back to region feedback without invented selectors. | 11 |
| B-31 | Diagnostic redaction/bounds | Token-bearing Console/network fixtures are redacted and buffers bounded. | 12 |
| B-32 | Resume after DevTools | Automation pauses during DevTools and resumes explicitly with fresh observation. | 12 |
| B-33 | Coordinate matrix | DPR1/2, zoom, scroll and viewport changes hit known targets and reject old images. | 13 |
| B-34 | Canvas behavior | Keys/mouse/drag affect real Canvas state; cancellation releases synthetic keys. | 13 |
| B-35 | Development server routing | Reuse the real project server; conflict/failure never selects another project. | 14 |
| B-36 | Code/verification linkage | Fail before, pass after and after reload, with check/capture linkage to call and change. | 14 |
| B-37 | Style undo/HMR | Undo removes only owned overrides; HMR replacement does not restore stale application values. | 15 |
| B-38 | Verification without overrides | Style-only previews cannot satisfy source verification; clear them and inspect real output. | 15 |
| B-39 | Human-selected uploads | Reject model paths, accept chooser cancellation, do not auto-share human-selected files. | 16 |
| B-40 | Bounded downloads | Keep provenance/target/size/cancel receipts, clean up on limit/closure, never auto-execute. | 16 |
| B-41 | Batch prefix receipts | If step3 is rejected pre-dispatch, steps1–2 are retained and not repeated. | 17 |
| B-42 | Batch takeover/UNKNOWN | Fence each step; any UNKNOWN halts without replay. | 17 |
| B-43 | Observe without rebind | Atomic CLI observation preserves GUI ToolHost; other-socket replies do not settle calls. | 18 |
| B-44 | GUI exit isolation | GUI exit affects Browser while another Core task continues; adapter liveness is insufficient. | 18 |
| B-45 | Late receipts | Old-host/request replies cannot alter a new Turn/Page or finalized UNKNOWN. | 18 |
| B-46 | Reconnect without replay | Snapshots/rebind do not redispatch old calls and repeated requests remain idempotent. | 18 |
| B-47 | Keyboard/accessibility | Key controls are keyboard-accessible with readable status, correct focus and IME. | 19 |
| B-48 | Packaged self-containment | An isolated package passes without dev dependencies, global Chrome or exposed CDP. | 19 |
| B-49 | Full R2 workflow | A real package demonstrates the required development collaboration with review evidence. | 19 |

File handoff source checks cover trusted IPC scope, file limits and Agent file-input refusal only. The real Electron fixture must exercise human upload selection and cancellation plus an indirect Agent click on the same Page/Thread; an independent site counter must show no automatic replay after cancellation. For downloads, verify that no file is written before the system Save dialog, the user alone chooses the path, and unknown size, limit, timeout, close/crash, sibling Page ownership and cancellation receipts match actual files and GUI state. If a test injects OS dialog selection, disclose that substitution; it does not prove a human made the choice.

Temporary style source checks cover constrained IPC, Main node identity/current-value fences, and Composer draft wiring. Real native acceptance must exercise B-37/B-38 on a real native page: undo/redo, HMR node replacement, navigation, keyboard/IME, sensitive-content capture refusal, failed draft send, and actual page/Core receipts before and after clearing the trial. Source checks alone do not accept these scenarios.

## Fault injection

Cut before prepare, during approval, before execute, after input reaches the fixture but before receipt, before Core persistence, on Main/adapter exit, on Core restart and during Page replacement. Verify not_sent/confirmed/UNKNOWN classification, no replay and no stale writes. An aborted signal alone is not cancellation evidence.

## Performance and resources

Record tool calls, model text/image budget, separate prepare/approval/native/receipt latency, queue peaks, WebContents count and image encoding size. Fix machine/version/viewport/input for comparison. Do not use vendor speed claims as acceptance limits. Stress the policy bounds in the [contract](../api/browser.en.md) and report performance separately from correctness.

## Release gates

- R0: real native evidence for B-01 through B-03 and reviewable ADR-0003 choice.
- R1: Tickets01–09 and their scenarios pass with no known blocking approval/takeover/UNKNOWN/isolation issue; label as safe shared Browser, not full development experience.
- R2: all49 scenarios and Ticket19 pass in the installed app through same-page→annotation→source edit→verification; deferred features are explicit.
- Do not bypass a failed safety gate by disabling logging, weakening assertions or deleting tests.

## Proposed evidence format

Each run emits run-manifest.json containing git SHA, package/OS/arch/Electron/driver/fixture versions, entry point, scenario IDs, times, results and gaps. Attach Core call/Item linkage, synthetic side-effect counts, redacted logs and screenshots. Keep UNKNOWN distinct from0/failure. Captures are observation; success requires explicit assertions or human review.

The same-page read, observation/media, and existing-Thread attachment scripts use [`browser-evidence.mjs`](../../clients/gui/scripts/browser-evidence.mjs) to emit version 1 manifests:

- `runKind` explicitly distinguishes `acceptance` from `diagnostic`; `executionStatus` is `completed`, `failed`, or `blocked` and describes execution.
- `cases` declares stable case IDs and their requirements before execution. After assertions finish, record `passed`, assertion descriptions, and a copy of the observations at that boundary. Unexecuted cases remain `not_run`. Subcases such as `B-05.forged-receipt` do not stand for the whole requirement matrix.
- `provenance` binds the source commit, worktree diff, script, and Core binary SHA-256. Existing `hashes` also include the inspected implementation and shared fixture helpers.
- `acceptanceStatus` is derived from run kind, execution status, and all planned cases. Diagnostics are always `not_applicable`; partial runs cannot claim complete acceptance. `checks` is descriptive and cannot independently establish coverage.

Summarize evidence for an explicit case list on the same candidate, for example:

```sh
node clients/gui/scripts/browser-evidence.mjs B-04.same-page,B-05.forged-receipt /path/to/manifest.json
```

Exit 0 means these cases have evidence; missing cases or invalid formats exit 1. Multiple manifests report `mode: composite` and retain each execution status, never `cleanRun`. Different source/diff/Core identities cannot be combined automatically. Historical `passed: true` manifests require manual inspection rather than automatic promotion. Diagnostics add no accepted cases. Preserve original failures and targeted repair results. The summary covers only the requested cases, not the entire milestone or release gate.

Review whether a negative case distinguishes the intended wrong behavior: a forged receipt must use the actual in-flight request ID. Rejecting an arbitrary nonexistent ID does not establish same-ID isolation between sockets.

## Frozen-candidate startup check

Before business scenarios, these three scripts use [`browser-startup.mjs`](../../clients/gui/scripts/browser-startup.mjs) to run `config models read` in an isolated home from the actual Electron Main process. One probe per run replaces unrelated repeated `--version` comparisons. `startup.json` records parent/child PIDs, argv, binary hash, exit code, signal, timeout, and bounded stderr without configuration output. Startup failure is `blocked` and business cases remain unexecuted.

Display and visible-window counts do not prove an unlocked desktop; `desktop.unlocked` stays `unverified`. The sole native acceptance owner first confirms desktop availability. Preserve the candidate and evidence after a locked screen or explicit execution-policy denial; resume when the relevant condition changes. An old binary's version probe cannot establish the current candidate's real startup path. This check does not alter signatures or system policy.

## Tool-result readback

Use the Core media/Blob path to verify screenshot input to the model and GUI display. Read truncated large tool results through `read_tool_result(resultId, after)`, following `nextCursor`, authorized against the original Item in its Thread. The owner is [`core/engine/src/tools/results.rs`](../../core/engine/src/tools/results.rs); see the [Core API](../api/core.en.md). Internal result snapshots are not media attachments. Smaller inline results can verify independent cache assertions, but do not establish large-result pagination coverage.

## Commands

`pnpm --dir clients/gui run test:browser-contracts` runs the existing read, network, and diagnostics contract checks plus evidence classification and startup-probe checks. GUI CI runs it without desktop windows. It does not replace real Core/Native/GUI acceptance on a frozen candidate at milestone completion. During implementation run necessary local checks; causal repairs rerun affected cases while retaining earlier failures.

Existing commands include make gui-smoke; pnpm --dir clients/gui run test:connection, test:architecture and test:composer; GUI typecheck and verify. Use the Browser scripts listed here; do not assume an unadvertised test:browser command exists. Follow current repository documentation/type checks.

`pnpm --dir clients/gui run test:browser-annotations` verifies trusted GUI human annotations: freeze the same native page, select two elements, confirm separate Composer attachments while preserving the message body, isolate and restore drafts across chats, block blank comments, retain drafts on upload refusal with explicit retry, and rebuild messages from Core history after Renderer reload. PNG byte hashes compare the Composer crops with the images received by the model, proving that both images and comments use the existing Core channel. A synthetic composing Enter event only verifies composition guarding, not real Chinese IME behavior. The local model and trusted GUI site navigation do not establish real-provider or physical-focus acceptance; set `AREAL_GUI_EXECUTABLE` to use an isolated package. Run `node clients/gui/scripts/browser-frame-origin-smoke.mjs oopif` separately for cross-origin screenshot privacy boundaries.

The original design handoff performed only artifact checks. It did not run repository tests, Electron or the package and is not release evidence. Actual R0 runs use the isolated entry below and retain their own evidence.

## R0 native experiment entry

```sh
make gui-install
pnpm --dir clients/gui run test:browser-feasibility
```

The entry launches an isolated Electron fixture using the current `CorePreview` and its existing WebContentsView. It does not start Core, Runtime or the independent desktop adapter, or register `browser_v1`. Test control uses inherited private pipes without application-wide CDP/Inspector ports. The page retains a separate transient Session, sandbox and contextIsolation, with no Node, preload or product bridge. The experiment lives in GUI scripts and is not loaded by normal startup or packaging.

Three checkpoints require native desktop input: enter `HUMAN_DRAFT` and click CENTER; with the mask visible, use desktop coordinates to click the same target, press a letter key, then click Takeover in the trusted header; finally review the frozen screenshot and click Return to live page. Pointer input must pass through native window hit testing, rather than a DOM click. Use desktop automation or human input, and save window screenshots including native content and overlays at these checkpoints.

Assertions cover native identity, sentinel, form, scroll and AX reads; input reaching the mask while page counters stay unchanged; bitmap/CSS/zoom/scroll transforms and synthetic site receipts; `page_not_visible` when minimized; native DevTools detach/reattach with stale debug generation rejection; and returning to the original page after freezing. Capture waits for visible-page painting. A changed zoom property does not prove the compositor frame has updated, and automatic DevTools detach is not assumed. The fixture explicitly pauses and detaches before opening DevTools, then reattaches after closing it.

The command prints a temporary evidence directory containing `run-manifest.json`, scenario facts, screenshot metadata and page PNGs. The manifest records the worktree, source hashes, runtime versions, untested items and an empty Core call list. Native window screenshots are captured separately; renderer screenshots cannot replace them. Failed runs remain intact, and frames from different processes must not be combined into one continuous run. The experiment implements no production Browser permissions, Host callbacks, UNKNOWN recovery, region comments or packaged-app acceptance.

## Human cross-origin Frame slice

`node clients/gui/scripts/browser-frame-origin-smoke.mjs oopif boundaries` uses real Core, the independent adapter, the same Native Page, a deterministic model, and two local Origins. The `same-process` argument covers same-process cross-origin Frames; actual process identity and FrameTree distinguish OOPIFs, not port differences alone. It covers explicit reload, Main prompt cancellation and stale replies, parent misuse refusal, stricter site policies, full-image sensitivity/transient mutation/unavailable-context refusal, Agent capture refusal, original-Thread crop Blob/model SHA equality, revocation destruction, same-Native retention during annotation hide, grant destruction when Preview closes and the user switches Thread without opening a new preview, refusal to retain with an invalid capture token, and cross-Thread isolation. The fixture answers Main dialogs only for exact Origins; this is not operator confirmation. Point `AREAL_CORE_BIN` to the frozen Core and retain fixture/source hashes, call identity, images, and stop receipts.
