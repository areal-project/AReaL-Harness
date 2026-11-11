[中文](areal-zcode-comparison-codex-spec.md) | **English**

# ZCode and AReaL Harness comparison of four capabilities and Codex implementation specifications

## Conclusions and how to use this document

Keep AReaL's Core ownership of execution and address sustained use and complete user workflows within the existing implementation. ZCode offers useful examples of browser action coverage, explicit headless execution, calendar schedules and manual triggers, UI page lifecycles, and how to present plugin components. Both projects have mature implementations and clear limits. Feature names alone cannot establish that either leads across the board.

This document is for engineers and Codex working on AReaL-Harness. It contains source comparisons, priority decisions, implementation boundaries, interface proposals, PR slices, failure handling, and acceptance requirements. It can inform implementation specifications under `docs/development/`. Every "new interface" and "new path" here is a proposal, not an implemented capability. When adding this material to repository documentation, follow AGENTS.md requirements for Chinese and English pairs, documentation navigation, and generated contracts.

Review baselines:

| Project | Fixed commit | Evidence scope |
| --- | --- | --- |
| ZCode | [0a1fc56d279fd1001f78387bd81aec1c26767411](https://github.com/zai-org/ZCode/tree/0a1fc56d279fd1001f78387bd81aec1c26767411) | Clients, services, CLI runtime, adapters, and related test definitions on main |
| AReaL-Harness | [dd3758cdbebbceb7b582bec0d357405f10bc8fba](https://github.com/areal-project/AReaL-Harness/tree/dd3758cdbebbceb7b582bec0d357405f10bc8fba) | Core, Runtime integration boundaries, Electron/Main, Renderer, and related test definitions |

The source was read on 2026-10-20. This was a static source review. Neither application, its packages, nor its test suites were run. Source-proven paths, documentation claims, and results that need runtime reproduction are identified separately. Future interfaces in AReaL browser design documents, branch notes in ZCode UI_PLUGIN documents, and the existence of test files do not establish acceptance of a released version.

### Priority criteria

- **P0** means a gap that compromises control of an existing feature, task continuity, or continuity of editing state. Establish a reproducible case before merging an implementation. Another project having a feature does not make it P0.

- **P1** completes a basic workflow for frequent tasks, with clear dependencies and value demonstrated by functional acceptance.

- **P2** adds an execution mode, ecosystem compatibility, or long-lived session capability. Implement it once a concrete use case and its dependencies are established.

The review provides no evidence for rewriting the entire browser, scheduler, or plugin system. These priorities are engineering recommendations. They do not mean the changes have occurred.

## Main differences across the four capabilities

| Capability | Current ZCode source | Current AReaL source | Recommended decision |
| --- | --- | --- | --- |
| Browser automation | browser-client with restricted JavaScript calls, Desktop and explicit headless adapters, and a broader set of locator and native actions | browser_v1, describe, Core prepare/approve/execute, Electron Main WebContentsView, and a narrower action set | Preserve permissions and the action ledger. Add common operations, then an optional headless Host. A general REPL or desktop view replacement is unnecessary. |
| Automation and scheduled tasks | Definitions and runs stored separately in SQLite, a separate scheduler for dispatch, calendar rules, Run Now, and Host-recorded actual results | One Core Task/Run/Goal system, UTC timestamps and fixed intervals, Host configuration preparation, and existing recovery, budgets, skips, and unread results | Repair ledger capacity and access to stop controls. Add Core calendar calculation and Run Now. Preserve non-overlap for entire executions of the same schedule. |
| Plugin | Multiple manifest formats, commands, agents, UI surfaces, component catalogs, and runtime integration | Existing portable, Codex, Claude, and Cursor packages, Git/npm/ZIP installation, digests/CAS, MCP, Skills, Hooks, OAuth, Apps, and extensions | Add component-level support reports first. Adapt proven ecosystem needs individually through existing installation and revocation. Do not create a second PluginStore. |
| UI Plugin | Stable page owners, surfaces, and page tools in addition to MCP Apps | Existing sandboxed AppBridge, messages/context, resources/files, and extensions. Tab switches currently unmount documents. No direct mount path for completed tool results. | Preserve live pages, then turn existing results into interactive pages. Defer page-provided tools, surfaces, and long-term persistence. |

Fixed source links, functions, and line numbers for this table appear in the evidence indexes for the three domains below. This is not a performance or security scorecard.

## Existing mechanisms that must remain

1. **Core exclusively owns Task, Run, Thread, Goal, call acceptance, and results.** The Host may own native resources and configuration preparation. The Renderer only projects state and submits intent.

2. **Evaluate authorization separately from execution capability.** Browser actions, plugin tools, and page bridges do not confer website, workspace, account, or background execution permission.

3. **Never disguise UNKNOWN as failure and retry automatically.** Preserve requestId/callId/stepIndex, original results, and confirmed prefixes. A new Host must not replay old page actions.

4. **Keep plugin installation, MCP trust, Hook trust, and page-instance authorization separate.** Installing a package must not expand a frozen Turn/Profile's permissions. Disabling or upgrading must still revoke the old generation.

5. **Create a new Thread for each recurring execution by default.** Carry continuity through explicit artifacts or checkpoints first. Growing conversation history cannot replace persistent business state.

6. **Keep pausing future triggers, stopping the current Run, and canceling the task distinct.** A receipt accepting a control request does not mean processes and workers have settled.

Evidence: [AReaL architecture](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/docs/design/architecture.md), [Task contract](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/docs/api/tasks.md#L93-L107), and [browser execution admission](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/tools/extensions.rs#L182-L252).

## Priorities and their rationale

| ID | Priority | Deliverable | Rationale | Cost of deferral or escalation condition |
| --- | --- | --- | --- | --- |
| AUTO-01 | P0 | A repairs control and adds minimal cold receipt storage. B archives Run/Channel data and adds history UI. | 128 Runs pause a schedule. 8192 receipts reject new requests before stopRun/cancel. These are identifiable control paths. | Higher usage reaches the limits sooner. Raising constants only delays the problem. |
| UI-01 | P0, gated on runtime reproduction | Preserve the page and bridge when switching tabs or hiding the panel. Release them on close. | Active-only rendering combined with teardown on unmount destroys page state. | Source confirms unmounting. A fixture must reproduce loss of a specific editor draft. Downgrade to P1 if editing continuity is not a public commitment. |
| AUTO-03 | P1 | Run Now, independent of schedule time and enabled state | Users can verify the actual execution path immediately after saving a schedule. | Model, plugin, or browser readiness problems otherwise emerge only at the next scheduled time. |
| AUTO-02 | P1 | Authoritative Core calendar rules, time zones, and trigger previews | Current rules cannot precisely express weekdays or monthly schedules. ZCode provides a calendar model to study. | Replacing a fixed local daily time with 86400 seconds confuses semantics. |
| B1 | P1 | scroll/hover/selectOption/setChecked and bounded state waits | Gaps in validator and describe are explicit. These operations cover common page tasks with manageable acceptance work. | Models continue using substitute operations or stop at ordinary controls. |
| PLG-01 | P1 | Component-level support matrix and runtime reasons | Package-level text diagnostics exist, but unified component support, activation conditions, and reasons do not. | Users cannot readily determine which parts of a package, including commands, agents, and UI surfaces, are usable. |
| UI-02 | P1 | Mount interactive results from an existing successful callId | Core already retains raw MCP results. Work can focus on secure mounting and UI routing. | Visual results remain text or raw files. A poorly designed entry point may call the original tool again. |
| B2 | P1, separate delivery | Explicit headless Browser Host, CLI first | ZCode demonstrates both adapters. AReaL browser execution currently requires a live GUI Main. | Browser tasks without Electron remain unavailable. Downgrade to P2 if this release only commits to desktop co-driving. |
| AUTO-04 | P2 | Configuration and Host admission for scheduled execution without a GUI | A headless browser alone does not remove the scheduled mode's interactive/desktop Host binding. | Escalate to P1 only for an explicit requirement to run recurring tasks after GUI exit. Existing schedule semantics do not change automatically. |
| PLG-02 | P2 | Adapt commands, agents, and surface packages with concrete samples | Ecosystem coverage requires semantic mapping. An installer already exists. | Defer without a target plugin. Do not silently ignore permission, model, or scope fields to claim compatibility. |
| UI-03 | P2 | A long-lived page request budgets. B page-provided tools. | A requires real pages reaching their budgets. B requires real Agent use of page state. | A depends on stable pages. B also depends on result mounting and support diagnostics. Accept each separately. |
| B3 | P2 | Dedicated persistent browser Profiles | Provides login continuity but introduces an account-state lifecycle. | Ephemeral contexts suffice for public pages and local QA. Do not import the user's primary Chrome profile by default. |

The long-term part of AUTO-01 targets sustainable recurring tasks. Its stop-control work does not depend on that product assumption. P2 items are conditional follow-up specifications. Codex need not implement them all in one task.

### Six architecture trade-offs

| Decision | Adopt | Reject and why |
| --- | --- | --- |
| Scheduler ownership | Keep Core Task/Run/Goal | Importing ZCode's utilityProcess scheduler adds dispatch state and recovery boundaries without need. |
| Task history | Reuse the Store rule of writing immutable segments durably before snapshots reference them. Use Task-specific models and archive roots. | Do not migrate the whole store to SQLite for P0 or delete deduplication and budget facts by age. If future index scale exceeds the file model, evaluate a Task-specific database in a separate ADR. |
| Time semantics | Distinguish once, interval, and calendar explicitly. Core is the sole calculator. | A timeZone field does not establish calendar scheduling. The model and GUI must not independently compute next trigger times. |
| Browser calls | Extend bounded actions and provider capabilities in browser_v1 | Arbitrary JavaScript/CDP, a general REPL, or a webview migration are not prerequisites for more actions. |
| Plugin and UI | Extend support diagnostics, page ownership, and result mounting in PluginStore/MCP Apps | No second Agent loop, installation state, or implicit trust in the Renderer. No unverified claim of universal format compatibility. |
| Automatic retries | Allow future bounded retries only for preparation failures proven to precede side effects | Dispatch retry does not mean Agent tool replay. Neither project can claim exactly-once external side effects on that basis. |

## Phases and parallel execution

GUI user paths are the primary delivery surface. CLI checks may validate Core or browser adapter contracts first, but they do not replace GUI entry points or real desktop acceptance. A headless Chromium process, noninteractive Core execution, and execution after GUI exit are separate capabilities.

### Confirmed delivery order

| Phase | Scope | Observable completion condition |
| --- | --- | --- |
| One | AUTO-01 and UI-01 | Receipt and history capacity do not block durable stop; hot and cold history preserve execution ownership and budgets; ordinary navigation retains live pages and unsaved edits. |
| Two | AUTO-03, B1, PLG-01 | Run Now preserves the schedule; browser actions have observable targets; component reports identify the exact package version. |
| Three | AUTO-02 and UI-02 | Core calendar previews match actual triggers; mounting selects the exact original result without executing the tool again. |
| Four | UI-03B | A fixed real editor supports bounded selection reads, revision-checked page edits, authorization, cancellation, and UNKNOWN. This remains part of the full plan; CLI, UI-02, PLG-01, and UI-03A are not mandatory prerequisites. |
| Demand-driven extensions | AUTO-04, B2, B3, PLG-02 | Background execution, terminal browsing, account login, and a fixed target plugin respectively justify these slices. They are not all enabled by default for this round. |

### Phase-one delivery units

1. Establish failing capacity-stop and page-navigation cases against isolated Core state and a real Electron page respectively.
2. AUTO-01A delivers v3 migration, committed cold receipt lookup, and control at capacity. Return accepted only after durable commit. Preserve each original request identity, digest, and response.
3. AUTO-01B archives safely settled Runs and closed Channel records, and retires their preparations. Resume, ensure, budget, prompt limits, approval classification, and history authorization retain the same Run/Goal provenance across hot and cold records. Channel pagination merges records by their original sequence.
4. UI-01 reuses the existing window apps descriptors. Stable token-keyed iframe hosts live outside the conditional SidePane and Thread key. Hidden pages route to their original project and Thread without stealing focus. Source revocation reaches every retained page.
5. Integrate GUI history entry points, capacity reasons, and public contracts. Verify Core recovery and real GUI paths separately, inspect the owned diff, and create local commits.

Core remains the sole Task ledger and execution owner. This round prefers JSON hot snapshots and immutable cold segments. Sync cold segments before committing snapshot references. Existing Thread archives provide a commit-protocol precedent, not a reusable Task data model. Archiving must neither grant old Goals new execution eligibility nor retain cumulative usage while losing original ownership.

### Contract corrections for later slices

- UI-02 selects a tool record by threadId, turnId, and Core itemId. Upstream callId values can repeat across Turns and are not sufficient historical identities. New snapshots carry source bindings; insufficient old evidence falls back to ordinary records. Old requests cannot revive closed pages.
- B1 supplies observable option facts and controlled option identities. State waits do not reuse action checks that reject disabled elements. When scroll or hover invalidates observations, batches stop with their confirmed prefix preserved.
- If B2 starts, the same CLI Core connection handles prepare/call/cancel and forwards through private IPC to the browser child. The child holds no Core credential. Reuse bidirectional stream-json approvals. A browser without a window does not authorize noninteractive execution.
- AUTO-03 extends `areal/request/read` with a strict Task selector carrying the original TaskRunNow parameters. It checks identity, digest and the original acceptance. A missing receipt stays UNKNOWN without replay. An active Run conflict returns its runId. Exhausted total budget blocks the same accepted Run.
- Native B1 selection uses a fixed Host operation bound to complete ordered OPTION identities and dispatches untrusted input/change events. Input confirmation remains separate from business verification. Observation invalidation preserves the batch call deduplication record and confirmed prefix.
- PLG-01 distinguishes candidate sourceDigest from actual installedDigest and reuses installation, connection, and trust projections. Static required components are declared only by portable `extensions.org.areal.componentRequirements={version:1,requiredKinds:[...]}`. Dynamic connection and trust do not affect static compatibility. Historical Skills are checked against their own immutable package digest. A compatible replacement cannot admit incompatible old content.
- AUTO-04 local shell/files first reuse Core server-owned execution where suitable. Background browsing depends on the necessary service adapter and scoped authorization, without requiring CLI B2 first.
- UI-03A starts only when a real page reaches the request budget. UI-03B needs stable pages and the Core tool boundary. Existing MCP tools remain preferred for durable documents; page tools address real selection, undo, or unsaved state.

AUTO-01 and UI-01 can proceed in isolated worktrees. One integrator serializes public protocol, generated schema, integration builds, and desktop focus. Each phase reports source, Core/CLI, real GUI, real-provider, and packaged-install evidence separately. This section takes precedence over conflicting candidate interfaces or older dependencies below. Unexecuted checks are not passes.

## Shared handoff requirements

### Starting work

Read the latest local AGENTS.md, architecture document, and target specification. Record `git status --short` and `git rev-parse HEAD`. The SHA in this document is an evidence baseline, not an instruction to force-reset. If a capability already exists, compare its behavior and acceptance evidence and report drift. Do not create a parallel module. Preserve unrelated workspace changes.

### Code and protocol

Synchronize new interfaces across `core/protocol`, app-server method registration, machine schemas, client types, public entry points, and documentation. Parse fields strictly. Older clients must degrade through capability/method detection. New paths below are marked as proposed. Locate the nearest actual module at implementation time. Do not describe nonexistent files as current implementations.

Extract a public function or module only for a real boundary or implementation in this change. Do not build a general platform first. Permission, concurrency, and cancellation tests must enter through public Core/Host interfaces, not only private helpers.

### Completion evidence

Each PR must provide the issue category and original failure evidence, actual changed files, interface and state changes, an acceptance table, executed commands with actual results, compatibility and migration notes, and remaining unverified items. Mark "not run" only when a test definition exists. Mark environmental blocks as blocked, never PASS.

Use deterministic cases to prove invariants for mechanism fixes. If changing default tool policies or context, or claiming model efficiency gains, also follow repository AGENTS.md and evaluation methods. Compare the same model and budget, retain every failure/UNKNOWN, and meet the project's minimum repetition count and independent confirmation-set requirement. Acceptance on one webpage cannot establish an overall gain in Agent capability.

### Task template for Codex

```text
Implement <ID / PR slice> from this specification in areal-project/AReaL-Harness.

First read local AGENTS.md, docs/design/architecture.md, and the relevant section.
Inspect relevant changes between current HEAD and review baseline
 dd3758cdbebbceb7b582bec0d357405f10bc8fba.
If an implementation exists, use current code and behavior acceptance as authority.
Do not duplicate it or reset the workspace.

Complete only this slice's user behavior and acceptance conditions.
Preserve Core ownership of Task/Run/Thread/Goal and execution results.
Preserve permissions, cancellation, generation/CAS, and no automatic UNKNOWN replay.
Respect this specification's non-goals. Do not also implement other P1/P2 items.

Establish the smallest behavioral or failure case that demonstrates the gap.
Then implement the smallest sufficient change.
Synchronize public protocols, generated schemas, client calls, and paired Chinese/English docs.
Run only affected checks that cover concrete risks.
Report checks that require a native environment accurately.

Report changes and rationale, each acceptance result, actual commands, source evidence,
and migration/rollback boundaries.
If a key assumption differs from current source, finish unaffected analysis,
state the difference, and then adjust the approach.
Do not report a missing test environment, existing failure, tool timeout,
or unknown side effect as success.
```

The following sections provide detailed comparisons, fixed source indexes, and execution specifications for browser automation, automation, and Plugin/UI Plugin. A/Z evidence identifiers are local to each domain. The final section adds UI-03 specifications for long-lived pages and page tools.

## 1. Browser automation

### Main assessment

The most useful ZCode patterns are Desktop and explicit headless Hosts under one browser-client capability model, capabilities exposed to the model according to actual implementation, and broader browser actions. AReaL already has authoritative Core history, prepare/approve/execute, Page/Thread/Turn/Host generations, read revocation on human takeover, and no UNKNOWN replay. Preserve them.

ZCode's Node REPL, `<webview>`, and global persistent account partition are implementation choices. AReaL does not need them to expand actions or add unattended execution. Electron `WebContentsView` can continue serving the desktop. A new headless provider must not silently move or copy the user's current pages.

### Detailed differences

| Dimension | Current ZCode code facts | Current AReaL code facts | Impact and assessment |
| --- | --- | --- | --- |
| Model calls | The official browser-use plugin publishes node_repl/client/skills/docs. Each JS kernel is fresh. The Host preserves browser tabs. The client facade has a Playwright-like object graph. Z1/Z2 | Fixed `browser_v1` dispatcher, describe before observe/act, and a second validator that rejects undeclared operations and parameters. A1/A2 | ZCode fits code-based orchestration. AReaL more readily retains granular approvals and result boundaries. No measurements prove that Node REPL necessarily uses fewer tokens or runs faster. |
| Execution | BrowserControlPort is the central interface, implemented by Desktop bridge and managed CLI CDP. CLI creates it only for explicit browserUse=headless and launches with headless:true. Z3/Z4 | DesktopService receives Core dynamic-tool requests and forwards them to Electron Main `preview`. Main requires a live window/preview. A3/A4/A5 | A live AReaL Core does not establish browser availability. Unattended and cloud browsing need an independent Host, not another scheduler. |
| Native desktop view | The UI is a `<webview>` guest. Main controls that same guest through CDP. Z5 | Main creates `WebContentsView` with sandbox/contextIsolation true and nodeIntegration false. A6 | Do not migrate views to resemble ZCode. Real overlay, input, or screenshot reproductions should drive fixes. |
| Account state | Desktop webview uses `persist:zcode-embedded-browser`. Actual Chrome cookies+localStorage import code exists. Z5/Z6 | Random non-persist partitions. Sibling pages in one Thread share a partition. Other Threads are isolated. The last reference releases the context. A6 | ZCode provides stronger login continuity. Logical tab scope does not mean Cookies/Storage are also isolated by Thread. AReaL's lack of login persistence across restarts is a clear product boundary. |
| CLI login persistence | CLI calls `browser.newContext` per session. This implementation passes neither storageState nor userDataDir. Login is not persistent. Z4 | No independent headless provider currently exists. A4 | Do not claim that ZCode headless already has persistent Profiles. Specify AReaL headless and persistent Profiles separately. |
| Action coverage | Desktop executor implements scroll/hover/select/check/drag. Locators implement selectOption/setChecked/waitFor and other actions. Z7 | describe exposes Ref click/fill/press and cropped-screenshot clickAt/drag/pressAt. Waits only support documentReady and accessibleName. A1/A2 | Reliable scrolling, selection, checkbox, and hover operations are missing. Infinite scrolling and native controls cause detours or stalls. Add bounded semantic operations first. |
| Page reading | Playwright DOM snapshots run in an isolated world with bounded iframe/OOPIF expansion. Z8 | Native AX snapshots with budgets, truncation, and sensitive-value protection. Action refNode explicitly accepts only the main frame. A7 | A document claiming cross-origin coverage does not prove frame actions exist. Full iframe action support is a later increment outside the initial operations. |
| Web side-effect policy | Scoped commands, generations, cancellation, and sideEffect=uncertain exist. Z9 | Core stores prepared plans and approves them. For public sites, Main allows only supported ordinary field actions, GET searches, and link navigation. Other actions require human takeover. A8/A9 | ZCode does have recovery protection. AReaL's narrower semantics are deliberate. More capabilities must not implicitly expand public-site or account permissions. |
| Capability discovery | Manifest and descriptor overrides use Proxy to hide unsupported members from property access, in checks, and enumeration. Z2. Desktop explicitly overrides claimTab/recording. Z9 | describe has actual actions and waits lists. browserClaim checks exact equality of the complete operations array. A2 | AReaL already discovers capabilities. It lacks structured negotiation of provider differences. Do not rebuild a generic tool-discovery platform. |
| Diagnostics and evidence | Desktop records WebM and has separate viewport, screenshot-surface, and recovery modules. Current APIs also have limits. Types alone do not establish all upload capabilities. Z9 | Bounded, redacted console/network metadata. Collection stops during human control. Screenshots enter Core Blob/MediaRef. Same-page annotations and style trials already exist. A10 | AReaL already has diagnostics and evidence. Recording is a P2 experience improvement. Screenshot counts are not success rates. |
| Cancellation and uncertain results | Bridge timeouts send cancellation back and return uncertain according to mayHaveSideEffects. Main runningRequests rejects duplicate requestId. Z9 | Failed preparation is not_sent. Ambiguous Core cancellation/dispatch is UNKNOWN. Main/input fences and human takeover converge control. Batches preserve confirmed prefixes. A3/A8/A11 | Both have substantive mechanisms. Preserve AReaL callId/stepIndex/epoch identities. Headless must not introduce automatic timeout retries. |
| Verification | Multilayer unit, desktop e2e, and headless e2e source files. Some e2e files are under manual-review/pending. | test:browser-contracts and native read/actions/invalidation/human/frame/evidence smoke tests. Docs explicitly say unified package acceptance is incomplete. A12 | File counts cannot rank stability. Run real end-to-end checks against fixed SHAs/package versions and retain blocked/not_run results accurately. |

### Recommended priorities

- **P1 B1 bounded semantic operations.** Add deterministic actions required for ordinary browser tasks without a second model tool. Current validators and executors directly show the gaps. Independent page counters can verify each action without general claims of better model performance.

- **P1 B2 explicit headless provider.** Initially support standalone CLI with the same browser tool contract in a process without Electron. AUTO-04 integrates background and scheduled modes. Defer to P2 if the product only supports users watching desktop actions. It is a P1 dependency if recurring browser tasks must work after GUI exit.

- **P2 B3 dedicated persistent Browser Profile.** Reduce repeated login through explicit creation, binding, and manual login. Do not import the user's primary Chrome by default. Accept it separately from B2, because ephemeral headless contexts already support public-site monitoring and local web QA.

- Exclude from this round a general node_repl engine, arbitrary evaluate, wholesale webview migration, one-click primary Chrome Profile cloning, multiple Agents writing the same page concurrently, and default full-session recording. They do not address the primary B1/B2 gaps and add authorization, runtime, and media costs.

### Spec B1 bounded semantic browser actions

#### Goal

On an explicitly authorized local development site, the model can use bounded actions to scroll for more content, select a native dropdown option, set a checkbox, hover to reveal a menu, and wait for a defined state. Every step still uses Core preparation, approval, and execution. Keep input confirmation separate from business verification.

#### Non-goals

No shell, raw CDP, arbitrary JS, desktop native-view changes, unknown public-site submissions, or iframe interaction. Do not guarantee every custom webpage component or change human-takeover rules for high-impact operations.

#### Handoff slices

1. **B1a native scroll and hover.** Add `act.action={kind:"scroll",target:"viewport",deltaX,deltaY}` and `{kind:"hover",ref}`. Bound parameters and retain pageId/snapshotId. During prepare and execute, the Host checks page/document/control/viewport identity. DOM changes from scrolling invalidate old observations through the existing mechanism. The model must observe again.

2. **B1b native select/checkbox and state waits.** Add `{kind:"selectOption",ref,value}`, initially single selection by exact value, and `{kind:"setChecked",ref,checked}`, initially native checkboxes with radio false explicitly unsupported. Add `wait.condition={kind:"checked",ref,value}` and `{kind:"enabled",ref,value}`. Use only native-control facts read by the Host. The model cannot supply arbitrary selector/backendNodeId values.

3. Extend describe actions/waits information and examples. Publish only deployed capabilities. Preserve the `browser_v1` envelope and current operations list. Do not rename the tool for act subtypes.

#### Change locations

- `clients/gui/app/src/core/browser-tool.cjs` owns validators, budgets, and wait schemas.

- `clients/gui/app/src/core/service-protocol.cjs` owns describe.actions/waits, action forwarding, and response validation. Preserve the current operations handshake.

- `clients/gui/app/src/core/preview.cjs` owns prepare/execute/actionTarget, current control, and input cleanup. Extend its existing boundaries. Extract a bounded-action module only for actual reuse.

- `core/engine/src/tools/extensions.rs` can reuse prepare+approval for existing act/wait. Do not rewrite execution beyond necessary contract fields.

- Extend existing fixtures and entry points in `clients/gui/scripts/browser-read-contract.test.mjs` and `browser-actions-smoke.mjs`.

- Update `docs/api/browser.md/.en.md`, `docs/development/browser-testing.md/.en.md`, and, if needed, `docs/features.md/.en.md`.

#### Invariants and errors

- Missing/expired approval, stale refs, or a stale viewport cause zero side effects and `not_sent`.

- A disconnect after hover/scroll/input dispatch must not claim no execution. Preserve UNKNOWN.

- Human takeover blocks undispatched actions and automatic reading. Late results from old work must not reach the model.

- If setChecked is already at the target value, return a confirmed no-op. Do not toggle again.

- A missing select value, disabled control, or wrong control type returns `target_unavailable` or explicit unsupported status. Do not try other values automatically.

- Undeclared public-site controls still require `human_takeover_required`. This specification does not change public-site semantic policy.

- Return inputConfirmed separately from verification. A changed DOM does not prove the user's business goal is complete.

#### Acceptance

- Enter through public Core → Host → Main → a real synthetic webpage, not only a private Controller.

- Include an infinite-scroll sentinel, a hover-only menu, native select, and a checkbox with a visible repeated-click counter.

- Assert final page state and independent site counters for every case, plus Core item/callId association.

- Two distinct, user-authorized setChecked(true) calls must not uncheck an already checked control.

- Replacing a node, changing control type, scrolling the viewport, or taking human control after prepare must prevent dispatch of the old plan.

- Inject failure after dispatch and before ACK. Preserve UNKNOWN and do not resend.

- Use both local and unauthorized public-site fixtures to show that policy boundaries remain intact.

- Run existing `pnpm --dir clients/gui run test:browser-contracts` and affected native smoke tests. Do not invent a `test:browser` command.

- Documentation must pass `python3 scripts/check-docs.py`.

- Until real-model comparisons exist, claim only functional behavior and invariants, not overall Agent capability gains.

#### Migration and rollback

New actions/conditions are additive. Old Threads keep their original tool definitions. describe reflects actual Host capabilities. A downgraded Host must reject unknown actions rather than execute substitutes. Preserve historical actions and media. Do not rewrite old schemas, storage versions, or receipts.

### Spec B2 explicit headless Browser Host, CLI only initially

#### Goal

A new CLI browser task that explicitly selects an independent headless browser can run on Linux without Electron. Existing GUI Main keeps GUI shared pages. Each Thread has one explicit execution Host. Initial support covers execution while the CLI Host remains alive. It does not establish unattended support for current scheduled/background modes.

#### Decision

Reuse `DynamicToolHost.prepare_browser/call`, `areal/browser/prepare`, `item/tool/call`, and Core's authoritative execution ledger. Add a trusted headless Host that can be released independently. Do not put browser logic in the model loop or a new scheduler. The first provider uses fixed Playwright/Chromium versions. The model still calls `browser_v1`, without raw Playwright/evaluate.

The suggested new directory is `clients/browser-host/`, **proposed and currently nonexistent**. It owns Chromium/context/page lifecycles and the browser_v1 Host adapter. It depends on contracts and connections, not GUI Renderer or Engine internals. First implement the desktop's read-only and bounded-action contracts. Shared tests can prove protocol consistency. Extract only executable contracts such as validators, plans, results, and fences. Do not copy all of preview.cjs or build a general provider platform first.

#### Non-goals

Do not migrate GUI live pages, import personal Chrome data, provide cloud operations or screen streaming, add a resident service by default, promise exactly-once external side effects, or let unattended tasks bypass approvals.

#### Data and interface proposal

Prepare each new CLI Thread with one immutable Browser execution binding. Future Task integration can reuse this contract.

```ts
type BrowserExecutionBinding =
  | { kind: "desktopShared"; hostIdentity: string }
  | { kind: "headless"; hostIdentity: string; profileMode: "ephemeral" };
```

Initially add the fields to new CLI Thread/Host configuration without changing Task admission. When integrating AUTO-04, add them to the Task prepared-config/Host binding contract. Do not create a parallel Task table. Provider capabilities must explicitly list implemented operations, actions, wait conditions, and capture/lifecycle capabilities. Both Core and Host must reject unknown operations. Unavailable capabilities must not return empty success.

Exact equality of the complete browserClaim operations array is the desktop adapter contract. The new headless Host can be an authenticated Core DynamicToolHost. It must not impersonate a desktop window or reuse GUI browserClaim. Maintain shared capability types through `core/protocol` and generated contracts. Changing desktop handshakes to set negotiation requires a separate compatibility upgrade with old-Host tests.

#### Lifecycle

- An explicit CLI launch request resolves the controlled executable, completes the Chromium handshake, registers Host capabilities, and then admits the new Thread. AUTO integration adds Task prepare/ready later.

- Missing Chromium, dependencies, or an unreachable Host must produce an accurate CLI preparation error. An empty tool set must not imply that browsing is enabled. Preserve blocking reasons in future Task integration.

- Default to one ephemeral context per Run/Thread. Parent and child lifecycles must not release another owner's context.

- Cancellation first revokes authorization and new dispatch, then settles in-flight input and receipts. Timeouts preserve uncertainty.

- A Host generation change invalidates old plans, refs, and call execution eligibility. A new browser must not replay old actions automatically.

- Process exit, launch timeout, and late launch completion must all clean up. Verify that no child processes remain at the OS level.

- If the GUI observes this Thread, display provider, Host status, and evidence. Do not represent headless execution as the same local live page.

#### Change locations

- Add `clients/browser-host/` with package and release entry points. The path is proposed.

- Add discoverable provider capabilities and bindings in `core/protocol/src/desktop.rs` and current CLI Thread/Host configuration. Do not change Task preparation initially. Leave configuration binding in `core/protocol/src/tasks.rs` to AUTO-04 integration.

- Reuse DynamicToolHost in `core/engine/src/tools/registry.rs`. Do not add another execution owner.

- Reuse prepare/approval/UNKNOWN in `core/engine/src/tools/extensions.rs`.

- Reuse authentication, connection association, and prepare/call in `core/app-server/src/dynamic_tools.rs`. Reject forged receipts across connections.

- Do not initially change `desktop_schedules.rs` or Task preparation admission. A single AUTO-04 Codex worker owns those later changes. Integrate through the binding contract to avoid concurrent conflicts.

- Locate CLI entry points in actual `clients/cli/src` files. There is no `clients/cli/src/lib.rs`. Do not list that nonexistent file as an existing change location.

- Update the browser ADR's provider-extension boundary, runtime guides, and packaging/installation instructions.

#### Acceptance

- In a Linux installation without DISPLAY or Electron, complete navigate/observe/act/capture through public Core entry points.

- Run the same synthetic task on desktopShared and headless with comparable action facts. Pixel identity is not required.

- After GUI exit, desktopShared returns accurate host_unavailable while an independent CLI headless Thread continues and produces Core events. CLI exit must settle child processes, not leave an implicit resident browser.

- Two Runs set different Cookies on the same site and cannot read each other's values. Closing A does not affect B.

- Inject cancellation during launch, prepare waits, disconnect after approval, input sent without ACK, and Host crash. Verify not_sent/UNKNOWN and zero replay.

- Missing binaries, sandbox dependency failures, and exhausted quotas produce accurate errors, not empty capabilities that hide failure.

- Reject unapproved input, arbitrary JS/CDP, and file-path parameters throughout the path. Host capability does not confer business authorization.

- Package validation covers fixed dependencies and offline-start boundaries. Do not imply a dependency release package already exists.

#### Migration and rollback

Existing Tasks retain desktopShared semantics by default. New headless bindings require explicit selection. On rollback or missing Host, mark affected CLI configuration unavailable. Do not silently fall back to desktop and acquire personal account access. Ephemeral contexts need not survive restarts. History restores execution facts and evidence only.

#### Explicit AUTO dependency and forbidden shortcuts

Current `core/engine/src/task_mode/mod.rs:346-348` rejects Background Task bindings to Threads with dynamic tools and requires asynchronous/headless interaction. `mod.rs:357-360` and `desktop_schedules.rs:426` fix Scheduled to Interactive. B2's CLI DynamicToolHost therefore **does not automatically satisfy background/scheduled admission**.

The later B2/AUTO-04 integration must first choose either a restricted browser provider assembled as a Core-trusted server-owned tool, or a new explicitly authenticated deployed tool-Host category with equivalent lifecycle guarantees. Do not delete the dynamic-tool guard, forge a desktop-owner, disable approvals, or auto-approve all scheduled work. This slice owns Host registry, unique identity/credentials, connection lifecycle, cancellation/process cleanup, and Task interaction policy. One owner must integrate shared files.

CLI-first limits Task contract changes and validates provider reuse earlier. It cannot alone deliver "automatically log into a website and work every day." Announce that scenario only after accepting AUTO-04, B2 integration, and B3 when login is required.

### Spec B3 dedicated persistent Browser Profile

#### Goal

Browser tasks that require login can reuse account state explicitly authorized for that purpose. Users can inspect, revoke, and clear that state. Split this into B3a and B3b. B3a delivers only CLI-specific Profiles and depends on B2. B3b integrates recurring Tasks and depends on B3a and AUTO-04. B3a alone does not change scheduler admission.

#### Decision and trade-offs

Keep ephemeral as the default. A `profileId` refers to a dedicated directory or persistent partition managed by the Host. Do not accept arbitrary userDataDir values from the Renderer or model. Users log into that Profile manually. The first version does not decrypt personal Chrome cookies or import all Chrome data. ZCode Desktop's shared persist partition demonstrates login reuse, but AReaL need not adopt its authorization boundary.

B3a manual login only supports local machines with an interactive desktop. The user explicitly opens headed Chromium with the same dedicated Profile, logs in, closes the window, and returns its lease before using headless CLI. A server without DISPLAY returns `needsLogin`. This slice does not promise manual login there, remote login streaming, cross-device import, or copying personal Chrome data.

Account-state reuse adds persistent storage, concurrent-write, revocation, and cross-site identity risks, so it follows headless foundations. Public information collection and local GUI QA do not need it.

#### Non-goals

No sharing of the default system browser Profile, cross-device cookie sync, password backup, JS heap recovery, or CAPTCHA bypass. Enabling a Plugin does not grant access to any Browser Profile.

#### Data contract

```ts
type BrowserProfile = {
  id: string;
  name: string;
  ownerProjectId: string;
  revision: number;
  status: "ready" | "needsLogin" | "inUse" | "unavailable";
};
type TaskBrowserProfileBinding = {
  profileId: string;
  expectedRevision: number;
};
```

These are proposed fields, not existing APIs. B3a binds profileId/revision to CLI Thread preparation. Only B3b introduces TaskBrowserProfileBinding. Enforce actual permissions at existing Core deployment/Thread/Task preparation and approval boundaries, not only through UI buttons. A Profile represents account storage and grants no website-action permission by itself. Initially allow only one execution lease per Profile. Return busy on conflict. Do not copy directories to bypass locks.

#### Work slices

1. **B3a Host and CLI.** Provide create/list/openForManualLogin/clear/remove and bounded use leases. Core stores an opaque profileId/revision binding. Login commands check actual display availability. CLI shows the dedicated purpose, owning project, current holder, and clear operation.

2. **B3a lifecycle and acceptance.** Same-origin account switching, renaming, clearing, and deletion all go through the Host. Document platform differences in directories and OS key storage. Do not claim all Chromium data is keychain-encrypted. Verify login persistence across restart, leases, and isolation without changing Task mode.

3. **B3b Task integration.** Task editing explicitly selects a Profile. Configuration snapshots freeze id/revision. After revocation, reject new executions and settle active execution through existing cancellation and UNKNOWN semantics. Reuse AUTO-04 Host identity and configuration validation. Do not add parallel admission logic.

4. **B3b management UI.** Show the Profile's project, active Run, and login/clear controls. Do not send raw cookies/storage to the Renderer. An execution Host without an interactive display remains needsLogin. Do not silently move work to the current desktop or another machine.

#### Acceptance

For B3a, manually log into a synthetic service on a local desktop, close the login window, restart the Host, and verify that headless CLI with the same Profile sees the login. Another Profile and an ephemeral context must not see it. A new Profile on a machine without DISPLAY explicitly reports needsLogin. Clearing invalidates the old CLI binding. Failure or interruption does not repeat business actions. A Profile directory lock prevents concurrent account writes. Deleting an in-use Profile returns an explicit conflict. UI, history, and logs contain no raw cookies, tokens, or Host directories.

For B3b, separately verify Task creation, Run preparation, Host restart, configuration CAS, and revocation. Revocation prevents old Task bindings from executing. Preserve accurate stopping and UNKNOWN for live Runs. Accept recurring login tasks only after both B3b and AUTO-04 browser integration pass.

#### Migration and rollback

All old data remains ephemeral and needs no automatic conversion. Persistent Profiles require explicit user creation. Disabling the capability preserves descriptions and blocking reasons. Clearing requires an explicit user instruction. Rollback must neither discard account data nor switch to the shared default Profile.


### Fixed source evidence index

All links use fixed SHAs and correspond to A/Z identifiers in this domain's comparison table.

#### AReaL

- A1 [browser-tool.cjs validator L45-L115](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/browser-tool.cjs#L45-L115) covers runBatch, act, wait, and the current allowed parameter set.

- A2 [service-protocol.cjs L429-L474](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/service-protocol.cjs#L429-L474) contains actual describe.actions/waits. [L210-L252](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/service-protocol.cjs#L210-L252) covers the exact-array handshake and cross-window claim conflicts.

- A3 [dynamic_tools.rs L103-L171](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/app-server/src/dynamic_tools.rs#L103-L171) covers prepare_browser and call on the same connection, plus cancellation.

- A4 [main.cjs L265-L289](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/main.cjs#L265-L289) requires live window/preview and claim/prepare/execute within the same Main.

- A5 [ADR-0002 L5-L11](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/docs/adr/0002-shared-browser-ownership.md#L5-L11) explicitly accepts browser unavailability when GUI resources disappear.

- A6 [preview.cjs L2374-L2394](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L2374-L2394) covers ephemeral random partitions, siblings in the same Workspace, WebContentsView, and security options.

- A7 [preview.cjs L1432-L1464](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L1432-L1464) covers Ref generations and the main-frame restriction. [L2154-L2168](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L2154-L2168) covers native AX and viewport.

- A8 [tools/extensions.rs L182-L252](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/tools/extensions.rs#L182-L252) covers Core plan preparation, persistence, approval, and Host identity rechecking after approval.

- A9 [preview.cjs L1465-L1553](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L1465-L1553) covers public-site semantics. [L1839-L1906](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L1839-L1906) covers local-only coordinates and plan binding.

- A10 [preview.cjs L1375-L1417](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L1375-L1417) covers bounded diagnostics and read generations.

- A11 [preview.cjs L575-L661](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/preview.cjs#L575-L661) covers input settlement on human takeover. [tools/extensions.rs L781-L790](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/tools/extensions.rs#L781-L790) promotes UNKNOWN output to the Core execution outcome.

- A12 [browser.md current status L5-L19](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/docs/api/browser.md#L5-L19) and [GUI package test:browser-contracts L47-L50](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/package.json#L47-L50).

#### ZCode

- Z1 [node-repl-host/server.ts L112-L163](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/node-repl-host/src/server.ts#L112-L163) creates a new NodeReplSession per call and disposes it in finally. [L253-L293](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/node-repl-host/src/server.ts#L253-L293) creates and terminates a new Worker per production call. The underlying NodeReplSession class can retain bindings, but the product MCP frontend does not reuse the instance. Its persistence comment alone is insufficient evidence.

- Z1 supplement [browser-use-plugin README L3-L14](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/browser-use-plugin/README.md#L3-L14) documents the release layout and fresh JS kernel. Cite this official description together with the actual adapter/facade code below.

- Z2 [manifest.ts L563-L594](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/core/src/browser-client/manifest.ts#L563-L594) hides members through Proxy. [playwright.ts L299-L377](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/core/src/browser-client/playwright.ts#L299-L377) covers locator select/fill/type/check/wait.

- Z3 [BrowserControlPort L541-L568](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts#L541-L568) and [headless-browser.ts L9-L20](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/cli/src/headless-browser.ts#L9-L20) show explicit opt-in.

- Z4 [adapters browser index L185-L215](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/browser/index.ts#L185-L215) contains the actual headless launch. [L240-L268](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/browser/index.ts#L240-L268) creates a session newContext that is ephemeral, not a persistent Profile.

- Z5 [BrowserViewportSurface.tsx L157-L166](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/browser-use/BrowserViewportSurface.tsx#L157-L166) contains the actual webview and persist partition. [UnifiedBrowserView.tsx L39-L50](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/browser-use/UnifiedBrowserView.tsx#L39-L50) describes the CDP-on-guest structure.

- Z6 [browserDataManager.ts L101-L192](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/browserDataManager.ts#L101-L192) implements Chrome Cookie/LocalStorage import. This does not claim coverage of all Chrome data.

- Z7 [browserCommandExecutor.ts L57-L112](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/browserView/browserCommandExecutor.ts#L57-L112) contains actual scroll/hover/select/check/drag/playwright dispatch.

- Z8 [browserPlaywrightDomSnapshot.ts L155-L166](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/browserView/browserPlaywrightDomSnapshot.ts#L155-L166) and [L315-L393](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/browserView/browserPlaywrightDomSnapshot.ts#L315-L393) cover bounded iframe/OOPIF reading.

- Z9 [browserControlMainBridge.ts L130-L167](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/host/browserControlMainBridge.ts#L130-L167) contains descriptor overrides. [L238-L273](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/host/browserControlMainBridge.ts#L238-L273) covers timeout/cancel/uncertain. [browserGuestManager.ts L960-L1015](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/browserView/browserGuestManager.ts#L960-L1015) covers scoped pending requests.

### Conflicting documentation

AReaL design specifications retain old milestones, future operation tables, and network-permission descriptions. Current `browser-network.cjs` provides dedicated isolation only for active product control ports. Chromium's system proxy, DNS, and site policies handle ordinary network access. Old test requirements do not prove that the current implementation blocks all private-network and metadata addresses by default. Network policy is a product choice. B2 deployment needs must separately determine whether headless server networking requires a broader policy. Do not silently apply desktop policy.

The comparison above does not rank either project as more secure or stable overall. Static code cannot establish those conclusions.

## 2. Automation and scheduled tasks

### Two execution paths

#### AReaL

The management UI or management conversation sends a proposal through `clients/gui/app/src/core/task-draft.cjs`, which validates it and saves a receipt. `areal/task/create` persists a Task in Core `task_mode`. Core's one-second poll/Notify creates a new TaskRun. An authenticated Desktop Host returns current configuration through `prepare_schedule`. Core fixes cwd/requestId, creates a Thread, freezes configuration, and creates a Goal. Execution reuses ordinary tools, permissions, and budgets. Core settles the Run/report. The GUI projects state, unread status, and the execution-conversation entry point.

Core owns all central state. The Host does not determine trigger times or create execution identities. An offline Host prevents new Run admission and pauses old active Goals. Existing Runs require explicit `resumeRun` to recover.

#### ZCode

The management page or CLI `cron_create` sends a calendar rule to automation service normalization. `AutomationRepo` writes automations/automation_runs into tasks-index.sqlite. Electron Main starts a resident utilityProcess scheduler. Every 20 seconds or on wake, a transaction runs claimDue with stable runId=`automationId:scheduledAt`. Main routes to the target Host. The Host creates a Task or resumes targetTaskId, fixes model selection, and sends sendPrompt(traceId=runId). The scheduler settles dispatch. The Host observes the actual terminal outcome and writes the result and unread status back.

This separates dispatch and execution state across Scheduler and Host. AReaL already has Run/Goal ownership in one Core and does not need another distributed boundary of this kind.

### Detailed differences and evidence

| Dimension | ZCode source facts | AReaL source facts | Assessment |
| --- | --- | --- | --- |
| State owner | The SQLite Repo separates automation definitions, run dispatch, and outcomes. A separate scheduler dispatches and the Host executes. | Core has one Task/Run/Goal system. The Host only prepares configuration. | Preserve AReaL's layers. ZCode having a process is not a reason to add one. |
| Trigger frequency | 20s poll plus wake. The cron library only calculates the next time. | 1s poll plus Notify, at most 32 concurrent dispatch preparations, and an in-process lease per task. | Neither depends on a Renderer timer. Without measurements, do not claim that 1s is faster overall or 20s uses fewer resources overall. |
| Time expressions | Five-field cron. scheduleRule supports minute/hourly/daily/weekly/monthly/yearly, intervals, weekdays/monthDays/months, maxRuns, and endAt. | once plus fixed intervalSeconds. timeZone records the interpretation zone without changing fixed UTC intervals. | AReaL lacks real user needs such as weekdays and monthly schedules. Add calendar rules and a unified preview in Core. |
| Time zones | Local Date and croner's default zone. The schema has no per-rule IANA timezone. | timeZone is persistent but currently metadata. | ZCode's local calendar is not complete cross-zone support. AReaL calendar rules should specify IANA zones. |
| Missed triggers | Initial dispatch more than 5min late is skipped. A missed one-shot becomes terminal without catch-up. Retries do not reapply misfire. | Host offline preserves nextRunAt and coalesces once on return. Busy execution advances nextRunAt and increments skippedRuns. | AReaL defaults fit catch-up reports. ZCode defaults fit time-sensitive reminders. Make policy explicit rather than copying it. |
| overlap | `markDispatched` releases running for scheduled work after successful dispatch. Manual claims heartbeat until actual terminal outcome. | No overlapping Run while the current Run is nonterminal, including paused/blocked/waiting. | A ZCode claim does not prove non-overlapping execution. AReaL's no-overlap rule for the same schedule is easier to reason about. |
| Execution context | Creation within a conversation can set targetTaskId to return to the original task. Management pages can create a new Task. | A new Thread per Run. Accepted objectives/configuration are frozen. Previous model history is not implicitly included. | Keep new Threads by default. Carry continuity through explicit artifacts/checkpoints before reusing ever-growing conversations. |
| Preparation failure | Persistent transient backoff from 30s exponentially to a 15min cap, at most five retries. Permanent failures disable the automation. | Errors set Blocked. The user calls resumeRun. A Run not yet started retries under its original id. | P1/P2 may add bounded retries only before Goal submission. Unknown tool side effects must not enter automatic retry. |
| Recovery/idempotency | SQLite BEGIN IMMEDIATE atomic claims, 10min stale claims, stable runId, Host traceId, and manual heartbeats. | Persistent request receipts, revision/CAS, fixed prepare/request keys. Core restart pauses active Runs for explicit resumption. | Neither establishes exactly-once external side effects. AReaL already has a real recovery path. |
| Run Now | Independent manual Run. runNow does not advance original nextRunAt/maxRuns/lifecycle. Terminal outcome releases the claim. | No runNow in Core methods or GUI writes. task-draft explicitly says immediate execution is unsupported. | Adopt this directly as P1 so users can verify a saved schedule without altering the next scheduled time. |
| Approvals/results | Permission mode is forwarded. Host terminal outcomes mark unread results. | scheduled is fixed to interactive. Approval expires after 300s. Blocked Runs require explicit continuation. Reports, budgets, reasons, and unread status exist. | Do not claim infinite approval waits or missing unread results. Unattended execution is an optional P2 strategy. |
| Long-term history | Separate run table with deleteRun and pruneRuns(maxAgeMs). No production automatic prune call was confirmed. | Whole Task snapshot limits are 1024 Tasks, 8192 receipts, and 32MiB. Each Task permits 128 Runs and 1024 channel messages. Full capacity pauses/rejects without automatic deletion. | Repair AReaL's recurring-task hard limits. ZCode offers a separate-ledger pattern, not justification to copy age-based deletion of deduplication evidence. |


### Fixed source link index

#### AReaL

A1. [Task types and Schedule](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/protocol/src/tasks.rs#L18-L66) define modes, RunStatus, and timezone/at/intervalSeconds.

A2. [Core scheduler loop and per-task lease](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/scheduler.rs#L3-L100) show 1s polling, 32 concurrent preparations, task-level deduplication, and Blocked on error.

A3. [Unique Host identity and exclusion of old connections](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/desktop_schedules.rs#L5-L43).

A4. [Pause on Host disconnection and explicit resume](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/desktop_schedules.rs#L52-L139).

A5. [due/skip/coalesce and the 128-Run limit](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/desktop_schedules.rs#L241-L281) checks the latest nonterminal Run for busy state. At 128 it only sets paused=true, after nextRunAt has already advanced.

A6. [Persistent prepare, new Thread, and frozen configuration](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/desktop_schedules.rs#L298-L435). After line 399, total budgets sum confirmed/reserved usage across all runs. Goal interactive is hard-coded.

A7. [Capacity and startup recovery](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/mod.rs#L16-L96) uses v3 task-mode.json, MAX_RUNS=128, MAX_RECEIPTS=8192, and MAX_BYTES=32MiB. Running/waiting becomes paused on restart.

A8. [Receipt-capacity precheck](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/mod.rs#L104-L145) and [task_control records receipts before applying control](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/mod.rs#L430-L531) show that at 8192, even new pause/stopRun/cancel requests return Exhausted before the match. This is a statically derivable reachable risk, without a runtime reproduction yet.

A9. [Whole-snapshot size limit and persist-before-notify](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/task_mode/mod.rs#L265-L285).

A10. [TaskCenter current state and reasons](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/TaskCenter.tsx#L15-L43) and [records/reports/controls](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/TaskCenter.tsx#L340-L357). Capacity pauses have no separate reason.

A11. [Management prompt capability boundaries](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/task-draft.cjs#L14-L22), [schedule parser](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/task-draft.cjs#L76-L112), and [GUI operation allowlist](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/tasks.cjs#L5-L20) have no calendar weekdays, monthly rules, or immediate execution.

A12. [Contract documentation](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/docs/api/tasks.md#L93-L105) explicitly defines the 300-second approval, current timezone meaning, offline/recovery behavior, and capacity policies.

A13. [Existing recovery test definitions through the real path](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/examples/desktop-api/schedule-host.mjs#L175-L235) cover offline coalescing, permission denial, and same-Run recovery after prepare failure. Later lines 285-375 cover Core restart and accepted stops.

A14. [Electron unread-recovery test definitions](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/scripts/schedule-desktop-smoke.mjs#L91-L159) cover new Threads without prior model history, unread results, busy skips, an optional approval-expiry path, and new unread results after same-Run recovery.

A15. [Existing Store cold-history principles](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/store/archive.rs#L254-L314) and [atomic metadata writes](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/store.rs#L681-L690) offer reusable persistence operations and the cold-segment-before-reference rule. This is Thread history archiving, not existing TaskRun archiving.

#### ZCode

Z1. [Types and calendar rules](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/shared/src/automation-types.ts#L34-L104).

Z2. [Calendar implementation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationCron.ts#L51-L219) uses a local calendar, five-field cron only for the next time, server clock for relative delays, and weekday/month/year rules.

Z3. [Scheduler and misfire](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/scheduler/index.ts#L1-L179) define 20s polling, a 5min grace period, stable runId, and terminal missed one-shots.

Z4. [SQLite transactional claims](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationRepo.ts#L734-L794).

Z5. [Lock release after scheduled dispatch and bounded retries](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationRepo.ts#L960-L1078), and [backoff/claim constants](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationRepo.ts#L38-L43).

Z6. [Separate queue and transaction for manual runNow](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationRepo.ts#L636-L732), and [manual settlement](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationRepo.ts#L1300-L1360).

Z7. [Host execution binding, new conversations, and fixed Run model/trace](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/host/index.ts#L995-L1118).

Z8. [Host terminal results and unread status](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/host/index.ts#L940-L988), and [manual heartbeat/terminal claim](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/host/cronRunLifecycle.ts#L38-L135).

Z9. [Independent history deletion and pruning](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/services/src/session/automationRepo.ts#L1431-L1456). Do not infer periodic pruneRuns calls. Age-based SQL deletion does not meet AReaL's need to retain deduplication and budget facts.

### Four handoff specifications

#### AUTO-01 P0 ledger capacity must preserve control and support long-lived schedules

**Problem.** Evidence A5/A7/A8/A9. The 129th due trigger only pauses the schedule, with no capacity reason. Resuming pauses it again on the next attempt. An hourly schedule reaches this limit in about five days, since 128 hours is five days and eight hours from the first trigger. Full receipts reject new control requests at the precheck, directly affecting stopping.

**Decision.** Keep Core as the sole scheduler owner. Use a bounded hot ledger plus immutable history segments/indexes, following existing Store persistence principles. First guarantee stopping at capacity, then implement cold history. Do not add an external queue, Temporal, or a second SQLite owner. Do not merely raise 128 or use `runs.shift()` to discard budgets and ownership.

**Split into two mergeable PRs.**

1. **AUTO-01A control, cold receipts, and diagnostics.** Reuse existing Task control fields and structured Core errors to expose capacity resources and recovery conditions. This slice includes immutable receipt indexes, committed-root queries, and v3 migration so new stopRun/cancel requests can still be durably accepted at capacity. Keep each Task's control state bounded. Complete historical receipts retain identity, method, requestId, digest, and the original response. One overwritable control slot cannot replace them. Migrate valid v3 snapshots already close to 32 MiB, rather than reserving capacity only for new schedules. Reject new work when capacity for growth is insufficient. Never return accepted before persistence. UI shows structured reasons and recovery conditions while retaining execution-settlement state. Report disk write failures through the current error and frozen state, rather than requiring another allegedly successful storageHealth write.

2. **AUTO-01B Run/Channel history and query UI.** Archive only terminal Runs whose workers have settled, usage accounting is complete, and no pending issue or unknown tool result needs inspection. The hot-record limit becomes a retention window rather than a schedule lifetime. Persist cold segments before committing their references in hot snapshots. Authorize paginated history by task/run. After migration, cumulative confirmed/reserved usage, total Run count, and thread/goal relationships remain auditable. Reuse A's cold-receipt queries. Compression must not reaccept old side effects. Keep deletion policy separate from archiving.

**Proposed files.**

- `core/engine/src/task_mode/mod.rs`, `desktop_schedules.rs`, and `overview.rs`.

- `core/engine/src/store.rs` and new `core/engine/src/task_mode/ledger.rs`. Reuse persistence operations from `store/archive.rs`, not Thread-specific models.

- `core/protocol/src/tasks.rs` and `core/app-server/src/task_mode.rs`.

- `clients/gui/app/src/core/tasks.cjs`, `clients/gui/renderer/src/TaskCenter.tsx`, and related client types.

- `docs/api/tasks.md/.en.md`, `docs/features.md/.en.md`, and `docs/development/testing.md/.en.md`.

**Phase-one interface contract.** `areal/task/runs/list {taskId,cursor?,limit?}` returns `{data:TaskRun[],nextCursor:string|null,hasMore:boolean,runCount:number}`. `areal/task/run/read {taskId,runId}` returns the original `TaskRun`. Task summaries expose `runCount`, `archivedRunCount`, and `runsComplete`. Limits are 1–100 with the existing response byte bound. Lists sort newest first by `(scheduledAt,id)`. Cursors retain the first read’s upper bound and do not depend on hot or cold storage location. GUI clients detect Core methods before using narrow management operations. Older Core versions expose only the inline window.

**Acceptance.**

- Fill 8192 old receipts, then submit stopRun(A) and cancel(B). Both are durably accepted. After kill/restart, retries of A/B return their respective original responses. Changing A's digest conflicts. Stop intent remains, and late Host replies cannot start execution. Reject ordinary new work explicitly when capacity is insufficient. Repeat migration and control acceptance with a valid v3 snapshot near 32MiB.

- After 128 completed Runs, admit the 129th and at least 2000 executions under a virtual clock. Keep the hot snapshot bounded without real waits or model consumption.

- Do not move the latest nonterminal Run, unsettled workers, unknown usage, or unknown tools out of the hot ledger during archiving.

- Budget balance, historical Run counts, current ownership, and old request receipts match before and after archiving. A different digest for an old request conflicts.

- Inject failures before/after segment writes and before/after reference commits. Restart exposes either the complete old state or complete new state, without lost records or duplicate Runs.

- Full disks or corrupt history references display storage error. Do not claim acceptance of unpersisted controls. Preserve accurate request-failed semantics when storage truly cannot be written.

- UI distinguishes capacity pauses from user pauses. Recovery resumes once without replaying every historical trigger.

**Migration/rollback.** Read and migrate v3 to a new version with atomic backups and a controlled migration tool. After new data is written, prevent old binaries from directly opening the new store. A rolled-back client may disable new pagination entry points. Service rollback across data schemas needs a compatible reader or controlled export. Restoring an old snapshot must not discard later actual executions.

#### AUTO-02 P1 Core calendar rules and previewable trigger policy

**Problem.** A1/A11/A12 establish fixed intervals only, which cannot express "9am every weekday" or "the last day of each month." Z1/Z2 provide broad calendar expressions, but local Date cannot directly become a cross-Host standard.

**Decision.** Core becomes the only next-run calculator. Client natural language produces structured rules only. UI and Host read the same preview. Start with once/interval/daily/weekly/monthly. Defer yearly and complex RRULE. Bind rules to IANA timezones. Preserve fixed-interval semantics for old data. A timeZone field does not justify automatic calendar conversion.

**Proposed rules.** `scheduleV2` uses a tagged union:

- `{kind:"once",at}`.

- `{kind:"interval",anchorAt,intervalSeconds}`.

- `{kind:"calendar",timeZone,frequency:"daily"|"weekly"|"monthly",interval,localTime:"HH:mm",weekdays?,monthDays?,anchorDate}`.

`monthDays` accepts 1..31 and a separate `"last"` value for month-end. Skip nonexistent dates by default and show them clearly in previews. Default DST gaps to skip and folds to earlier with one dispatch. Put these policies in versioned rules or the platform's default contract. Do not rely on silent Node Date correction. Explicitly define ISO weekday 1-7.

**Trigger policy.** Preserve current `misfirePolicy:"coalesce"` and `overlapPolicy:"skip"` as legacy defaults. Offer `misfirePolicy:"skip"` for time-sensitive tasks. Never default to catch-up-all. Each decision outputs a reason and originalScheduledAt. Legacy scheduledAt remains the original nextRunAt, the earliest pending time, not the latest missed instant. Optional missedFrom/missedThrough/count fields can describe the interval. Do not conflate busy skips with offline misses.

New `skip` rules must persist `maxLatenessSeconds`. The proposed product default is 300 seconds, visible during creation and preview. This is a new decision, not AReaL's current value. Evaluate the earliest pending scheduledAt. If `now - scheduledAt <= maxLatenessSeconds`, execution remains eligible. Only a larger delay counts as missed. Skip undispatched occurrences through now and advance to a time strictly after now. A missed one-shot creates no execution Run. Record a missed reason on the schedule and stop future triggers. Ordinary one-second polling lateness does not itself justify skipping. Do not apply this window to legacy coalesce. Record the missed interval without silently switching to catch-up at the latest instant.

**Proposed interface.** `areal/task/schedule/preview {schedule,from,count<=10}` returns `{timeZone,occurrences:[{at,localTime}],warnings}`. Creation and editing reuse the same validator. Before submitting execution, the Host must not independently calculate a different calendar instant. Save/preview use the Core clock so stale model notions of "now" cannot govern scheduling.

**Files.** `core/protocol/src/tasks.rs`, new pure functions in `core/engine/src/task_mode/schedule.rs`, `mod.rs`, `desktop_schedules.rs`, `core/app-server/src/task_mode.rs`, `clients/gui/app/src/core/task-draft.cjs`, `TaskDraft.tsx`, and `TaskCenter.tsx`. Update APIs, SDK examples, and paired docs.

**Acceptance.**

- For Asia/Shanghai at 9am every weekday, Friday's next occurrence is Monday. Monthly day 31 skips nonexistent dates. The last policy selects the correct month-end, including leap years.

- Use fixed America/New_York DST gap/fold transition fixtures. Preserve explanations and avoid duplicate execution. System timezone changes do not alter rule semantics.

- cron, natural-language, and GUI paths do not compute separate nextRunAt values. The first five preview times match five actual scheduler events under a virtual clock.

- A legacy 24h task remains a 24h interval across DST and does not become a fixed 9am wall-clock schedule.

- Several offline occurrences coalesce once. Skip policy does not catch up. Active/blocked Runs still prevent overlap. Editing does not change accepted Runs.

- With a fixed clock, test skip windows at at, at+1s, at+300s, and at+301s. With the 300-second default, the first three execute and the last skips. Missed one-shots and recurring advancement have queryable reasons without fabricated successful Runs.

- Core rejects unknown rule fields, invalid zones, too many weekdays, and out-of-range intervals. The model phrase "every weekday" must not silently normalize to 24h.

**Dependencies.** Pure rules can be developed independently. Ship after AUTO-01 to avoid more frequent schedules immediately hitting capacity. Distributed execution and waking powered-off machines are out of scope.

#### AUTO-03 P1 independent immediate execution without changing the schedule

**Problem.** AReaL can create, edit, pause, resume, and cancel, but has no runNow. Z6 shows how to separate a manual Run from its schedule so users can immediately check models, plugins, browsers, and result output after saving.

**Decision.** New operation `areal/task/runNow` admits one new TaskRun and fully reuses existing prepare/newThread/Goal/budget/permission/settlement behavior. Add a GUI **Run Now** button. Do not temporarily set nextRunAt to now or enable a paused schedule.

**Proposed protocol.** `{requestId,taskId,expectedRevision}` returns `{taskId,runId,revision,accepted:true}`. Add Run `trigger:"schedule"|"manual"`, defaulting legacy Runs to schedule. A manual scheduledAt is the logical acceptance time of this request. UI labels it as manually triggered, not the next cron time. Retrying a successfully accepted requestId returns the same runId. A different digest conflicts.

**Admission rules.**

- The Task exists, is not cancelled, passes owner/thread-scope authorization, and Core is accepting. Before admission, check only Host availability and declared capabilities. Do not call prepare_schedule early.

- If any Run is nonterminal, return a structured conflict pointing to that Run. Do not add a queue.

- A paused schedule allows manual execution without changing paused/nextRunAt. A naturally completed one-shot allows a new manual Run without restarting the schedule. Reject cancelled Tasks.

- Consume the same total tokenBudget. Do not add implicit budget or permissions. Reuse approval if a model or MCP needs authorization. This is actual execution, not a side-effect-free dry run.

- If the Host disconnects after acceptance, use existing wait/explicit-resume semantics. Do not resend under a new runId.

**Persistence order.** Atomically commit the manual Run, objective snapshot, and request receipt before waking the existing execution path. Actual prepare_schedule must use the persisted runId. Preparation failure marks that same Run Blocked. It does not revoke accepted, create another Run, or change nextRunAt. accepted means durable admission, not successful model, plugin, authentication, or browser preparation.

**Files.** `core/protocol/src/tasks.rs`, `core/engine/src/task_mode/mod.rs`, `desktop_schedules.rs`, `core/app-server/src/task_mode.rs`, `clients/gui/app/src/core/tasks.cjs`, `TaskCenter.tsx`, `task-draft.cjs` capability descriptions, and related types. Update paired Task API and usage docs.

**Acceptance.**

- nextRunAt, interval/calendar rules, and paused remain identical before and after Run Now. runCount increases. Any new schedule counter must count separately from manual Runs.

- Double clicks, lost network responses, and retries after Core restart with the same requestId produce only the same Run.

- Kill/restart after Run/receipt commit and before the prepare response. The original requestId still returns the same runId. Later recovery or preparation failure affects only that Run.

- When manual and due requests race on one tick, only one is admitted. Apply an explicit overlap policy to the other. Do not run them silently in parallel.

- While running, the button links to the current Run and disables new runNow. The backend also rejects attempts to bypass the UI.

- A manual Run opens its real execution conversation, exposes its report, and uses existing unread status. Failure or approval expiry can resume the same Run.

- runNow cannot reset an exhausted budget. Schedule edits racing with runNow obey revision CAS.

**Dependencies.** AUTO-02 shares only protocol edits, so merge serially by file ownership. Run Now can ship before calendar support. Implement it immediately after AUTO-01 while calendar rules are developed in parallel.

### Deferred P2 work and trade-offs

1. **Optional unattended Execution Profile.** Current scheduled interactive behavior and 300-second approval expiry are explicit decisions, not bugs. A server Host or headless mode needs an explicit target, interactionMode, and per-capability authorization. Reuse asynchronous/headless semantics without default schedule auto-approval. Creation must show Desktop Host browser dependencies and authenticated-Profile limits. Acceptance covers offline Hosts, credential challenges, permission boundaries, and recovery without replaying unknown side effects.

2. **Explicit checkpoints across Runs.** First let users declare input/output work files or structured state artifacts. The next Run reads the latest confirmed successful checkpoint. Default new Threads avoid unbounded model history and implicit propagation of errors. ZCode's targetTaskId deserves study but need not be copied.

3. **Bounded pre-execution retries.** Permit configurable bounded backoff only for transient prepare/model-selection failures proven idempotent and preceding Goal/tool submission. Availability recovery wakes offline Hosts. Permission/permanent failures become Blocked directly. Every UNKNOWN tool requires explicit inspection. Do not copy retries for any ZCode dispatch failure into Core execution.

4. **External result delivery.** Preserve current GUI unread results first. Add a reliable outbox and authorized recipients only when users explicitly configure a Bot/webhook. This comparison does not authorize message sending.

### AUTO-01 persistence decision and database trade-off

**P0 decision. Keep Core Store JSON and immutable files. Do not introduce SQLite.** The compact v4 catalog at `desktop/task-mode.json` is the sole commit root. It references full Task payloads, history segments, receipts, and provenance indexes in `desktop/task-ledger/`. Keep the existing in-memory `Task` and control fields without a separate control overlay. Retain the latest 128 Runs per Task and every record not yet safe to archive. The 128 limit becomes a retention window rather than a schedule lifetime. Keep Task files outside GC that only recognizes Thread history roots.

Commit protocol:

1. Select the oldest settled terminal Runs and closed Channel records. Their usage must be accountingComplete, with no unsettled workers or unknown side effects pending inspection.

2. Create an immutable segment with records, previousHead, version, and digest. fsync the file and directory first. Failure leaves hot state unchanged.

3. The new snapshot advances archiveHead/archiveCount and cold budget totals while removing hot records. Atomic snapshot replacement is the only commit point. A segment without a committed reference is an orphan. Queries must not treat it as an accepted Run/receipt.

4. Restart restores committed snapshot roots. Only explicit GC removes orphan segments. Do not infer execution facts from filenames.

5. Receipts retain the full identity, method, requestId, digest, and original response. Receipts and Task changes take effect in the same catalog commit. Queries use only committed roots. Fixed sets of 256 bucket heads reference immutable compressed radix indexes. Receipt keys and cold Run/Goal provenance keys use full SHA-256 values, with lookup depth at most 64. Terminal leaves sort full keys and hold at most 64 rows, with a 128 KiB ordinary packing limit. A single existing large result may exceed that packing target while remaining within the original 256 MiB file limit. Split along the radix when either bound is exceeded; never turn a bucket into an unbounded list. Leaves still verify original identity and reject hash collisions. History segments may remain chains, but the stop path must not traverse them.

6. Ordinary growth is subject to a 32 MiB hot-state budget. Already admitted work has a bounded settlement reserve derived from its existing Runs, workers, and settlement record sizes. This reserve covers stop/cancel and subsequent reports and usage settlement. It cannot admit new Runs, workers, or arbitrary configuration growth. Migrate old full v3 snapshots with this protection. Stop commits skip archiving, and unchanged Task files are not rewritten. Historical reads capture one immutable snapshot, then authorize and project outside the global Task lock. If disk writes fail, report unconfirmed persistence rather than success.

7. Total Task token usage equals settled cold totals plus hot confirmed/reserved usage. Count each archive once. In a failure window where records exist in both places, account according to the committed boundary. Do not reset Channel sequence.

8. Logical capacity failures provide a structured resource and recovery condition. GUI uses Core’s reason rather than guessing from a count of 128. A directory sync failure after atomic replacement leaves the commit outcome unconfirmed. Freeze Task writes and dispatch until restart validates and synchronizes referenced files and directories. Rereading the root alone does not prove durability. Do not pretend that storageHealth was persisted when disk writes failed.

Archiving must also preserve Task/Run provenance and authorization for old Threads/Goals. Existing app-server Task access checks Thread scope for associated Runs. Checking only hot Runs after archiving would expand historical visibility. Both pagination and individual reads go through Core authorization. Do not expose cold-segment file paths to clients.

**Further correction to the original design.** A fixed number of hash-bucket chains bounds the hot root, but not lookup work. As history grows, receipt lookup and provenance checks before a stop can hold the global lock for longer. Use bounded indexes and move read-only history scans outside that lock. Increasing bucket counts or capacity constants does not remove this failure mode. Real GUI cold migration also exposed the single-receipt file cost. The single-row leaf implementation required more than ten thousand index files for a valid snapshot with 8192 receipts and was terminated by the ordinary launcher deadline before root publication. Terminal leaves must therefore be packed within fixed bounds. Acceptance covers both cold v3 migration and subsequent v4 reopen, without offline warmup or relying solely on a longer startup deadline.

The private index uses `index_version=3` and node version 2, while the Task root remains v4. Unreleased experimental index version 2 is not a supported production migration source. New Core rejects it explicitly and preserves its bytes rather than silently interpreting the changed leaf shape. Deployed v1–3 snapshots remain fully backed up and migrated.

**Why not Task-only SQLite.** SQLite transactions, receipt uniqueness, and pagination have value. Introducing it for P0 also requires JSON migration, cross-store transactions with Thread persistence, backup/recovery, and dual-write handling. Store already provides cold segments and atomic snapshots, so reuse changes less. Only after demonstrating that cold lookup or global Task hot snapshots remain a bottleneck should a separate ADR migrate once to a single Task store. GUI must not store its own Task facts. Do not maintain two authoritative stores through dual writes.

### AUTO-04 P2 unattended schedules on a service Host

**Problem.** Scheduled work currently requires an online Desktop Host and interactive mode. That is an explicit existing scope. Continuing after GUI exit requires a real online service Host that owns tools and credentials. Moving a timer is insufficient. This capability does not promise execution while the operating system is shut down.

**Decision.** Reuse the same Core Task scheduler, Run/Goal, and permission boundaries. Model execution target, capabilities, and interaction mode explicitly and separately. Existing data keeps `target.kind=desktopHost` and `interactionMode=interactive`. An upgrade must not unexpectedly introduce background execution or automatic approvals.

**Proposed protocol and ownership.**

- Add Task `executionTarget:{kind:"desktopHost"|"serviceHost",hostId}`, `interactionMode`, and `requiredCapabilities?:string[]`.

- Trusted Hosts register actual capabilities such as shell/workspaceFiles. Declare browser only with a real browser backend. task.owner remains the creator's identity. hostId does not replace the authorization principal.

- Creation, editing, and every Run prepare validate Host availability, epoch, and capabilities. Frozen configuration stores tool/plugin version digests and safe credential references. Task data does not store plaintext credentials.

- Readiness returns online/hostUnavailable/missingCapability/needsInteractiveAuth with reasons. It checks declared capabilities only and cannot predict every future model tool call.

**Core invariant.** Effective Run capability = creator's effective authorization ∩ selected Profile ∩ Core/Runtime deployment limits ∩ target Host's actual capabilities ∩ current Run authorization. Changing target/interactionMode grants no permission. Permission expansion uses existing approval and controlled-configuration mechanisms.

**Execution rules.**

- desktopHost allows interactive. serviceHost allows only interaction modes for which it has a response channel. The creator explicitly selects headless/asynchronous.

- headless neither waits for users nor automatically approves. Unapproved permissions or MCP authentication challenges return typed unavailability. asynchronous reuses Task Channel questions, but current tool-approval semantics still reject immediately. Do not describe them as automatic approval.

- Until Desktop Browser has a service adapter, a Task requiring browser on serviceHost must be explicitly rejected. Do not silently downgrade and execute no work.

- Disconnection, restart, and UNKNOWN use existing Run recovery rules. Unattended operation does not justify replaying unknown external side effects. Only prepare failures proven to precede Goal/tool submission may retry automatically within limits.

- Closing the GUI affects projection only. The same Core owner maintains service execution. UI explicitly shows execution Host, availability, and latest results.

**Files and integration.** `core/protocol/src/tasks.rs`, `core/engine/src/task_mode/mod.rs`, `desktop_schedules.rs`, `core/app-server/src/task_mode.rs`, existing DynamicToolHost registration/lifecycle entry points, GUI tasks/task-draft/TaskCenter, SDK, and paired docs. Renaming desktop_schedules to host_schedules is possible, but do not add another scheduler. Share capability/owner definitions with the browser service adapter. Do not create separate hostId systems.

**Acceptance.**

- Upgraded v3 schedules remain Desktop+interactive with compatible behavior.

- A registered serviceHost runs a file-organization schedule. Close the GUI while keeping the service alive. Execute two consecutive rounds. Reopen the GUI and see the same Task/Run history.

- If browser is required but absent from the service, creation/prepare rejects with an explanation. Reject forged Hosts, stale epochs, and unauthorized credential/Profile permission expansion.

- A headless approval requirement returns unavailable immediately. With no other work available, the Run retains an actionable blocker rather than falsely waiting for someone to answer.

- After service restart, UNKNOWN for an already executed tool is not replayed automatically. Recovery retains the same Run.

- Offline Hosts follow the selected misfire policy. Desktop and Service never schedule the same Task twice.

**Dependencies/rollback.** Depend on AUTO-01 and unified Host/capability definitions. Reuse AUTO-03 for Run Now. Deliver shell/files first if appropriate. Only browser service tasks require B2 integration. State the limitation explicitly until the Browser backend exists. Disabling the feature flag prevents new service tasks. Drain or explicitly stop existing executions. Do not switch them to desktop and rerun. Tasks whose Host no longer exists remain visible and blocked.

### Verification entry points and handoff requirements

Existing verification entry points that can be reused, none run for this review:

- `cargo test --locked -p areal-engine task_mode::`. The Cargo package name was confirmed as areal-engine.

- `cargo test --locked -p areal-engine --test task_modes`. Read relevant assertions at implementation start and add the behavioral cases required here.

- `node examples/desktop-api/schedule-host.mjs` covers real Core/WS recovery and Host binding.

- `node clients/gui/scripts/schedule-desktop-smoke.mjs` covers Electron UI and production adapters. It currently uses /private/tmp and local Electron by default, so it needs an available desktop test environment. The approval-expiry branch requires `AREAL_SCHEDULE_APPROVAL_EXPIRY=1`. The ordinary command does not cover it automatically.

- After changes, follow repository AGENTS requirements for paired .md/.en.md files and `python3 scripts/check-docs.py`. Read development guides for formatting and static checks. Run only affected checks. This research ran none of these commands.

Tests must not mirror the implementation by checking the same function against itself. Prefer virtual clocks, old-data migration, process-kill windows, competing requests, missed/busy branches, and non-bypassable permissions and budgets. Scheduler refactoring does not require Redis, Temporal, or another service. First prove that the existing Core boundary can express and satisfy the invariants.

## III. Plugin and UI Plugin

### Main conclusions

AReaL already has substantial plugin infrastructure. It has a shared Core plugin Store, immutable content-digest installations, revision conflict detection, Git/npm/ZIP sources, MCP authentication and connections, separate hook trust, and MCP Apps. It also binds calls to a Thread, package digest, and connection generation, and provides file authorization, CAS, and durable result receipts. These boundaries should remain.

ZCode adds value in two areas. It projects more plugin components, including commands, plugin agents, and ui.surfaces. It also treats a UI Plugin as a workspace for continuous interaction, with successful tool-result mounting, a live page shared between inline and sidebar views, page tools, sampling, stable browser storage, and capacity admission. Its UI Plugin documentation and contracts limit support to Desktop local workspaces. That is not a reason for AReaL to take on the cost of remote Apps now.

The current gaps that can be confirmed in AReaL are:

1. Ordinary sidebar tab changes unmount the App iframe and bridge, retaining only the descriptor and Core instance. This creates a path that can lose edits that have not been persisted. This session has not reproduced it at runtime.

2. An API already reads the original MCP tool result, but ordinary tool records have no UI path for mounting a completed result as an App.

3. Plugin component compatibility has no structured contract for each component. Commands have a textual unsupported diagnostic, while agents and ui.surfaces have no corresponding component projection. A successful installation can mean that only part of the package is usable.

4. The limit of 512 requests over a page's lifetime is an explicit resource boundary, not a vulnerability. An editor left open for a long time can require reopening. An ordinary LRU must not discard deduplication records for requests with side effects.

### Comparison matrix for the two areas

| Dimension | ZCode source facts | AReaL source facts | Practical decision |
|---|---|---|---|
| Ordinary plugin scope | skills, MCP, hooks, commands, and agents, with optional ui.surfaces. UI Plugins use the ordinary installation flow | skills, MCP, hooks, and Apps/Connector, with shared Core/Runtime ownership | Keep one package lifecycle and treat UI as an optional package capability |
| Manifest | .zcode-plugin/.claude-plugin/.codex-plugin, with dedicated parsing for ui.surfaces | Agent Plugins 1.0 portable + .codex-plugin/.claude-plugin/.cursor-plugin. Unknown portable schemas are rejected | Keep AReaL portable as the internal standard. Add compatibility at the boundary when needed, without making the ZCode schema a new core model |
| Installation and versions | Marketplace dependency closure, atomic directory activation and rollback, and cache paths based on manifest.version | expectedRevision, expectedDigest, immutable cache, a second source verification, and fsync. Upgrades drain old calls, while disabling revokes authorization | Preserve AReaL's content addressing and transaction receipts. Do not replace them merely to resemble ZCode |
| Sources | Git/GitHub archive/ZIP. The npm marketplace source is explicitly Unsupported, and npm/pip plugin-source branches also explicitly reject those sources | npm ranges resolve to concrete versions, with tarball integrity verification. Git uses a pinned commit | AReaL's source support is not behind. There is no need to add npm |
| commands | Enter the runtime as command roots. Object mappings can materialize plain Markdown | package.rs explicitly reports commands migration not yet supported | P1 reports actual support. P2 provides read-only conversion for real plugin needs, without executing command scripts on its own |
| plugin agents | loadPluginAgentTemplates reads agents/*.md from enabled packages and normalizes names as pluginName:agentName | Package component parsing does not produce an agents directory or templates. Skills' agents/openai.yaml must not be mistaken for subagents | P2 adapts to existing TaskAgent profiles and intersects permissions, avoiding a second agent runtime |
| Effective plugin state | After configuration enables a plugin, MCP, hooks, skill roots, and command roots are combined. UI display is distinct from runtime injection | user/project overrides, the allowPluginSkills profile gate, and MCP digest trust independent of installation | Both have scope. AReaL should not add execution on installation |
| UI page protocol | Official MCP Apps/ext-apps, plus explicit zcode/* experimental extensions | Official AppBridge, plus openai/files/resource/modelContext/message extensions | Prefer public MCP Apps. Return an ordinary tool record when the platform is unavailable |
| UI entry points | Ordinary successful tool results can provide pages. ui.surfaces provides session panels, and tools can explicitly bind to a surface | openai/ui.entrypoints provides global/thread/file tool entry points, plugin details, settings, and an apps hub | First add completed callId-to-page mounting. Normalize the two surface declaration formats at the boundary later |
| Page lifecycle | The window PageManager owns the controller and guest. Cards and the sidebar hold only anchors. MCP suspend(false) rejects automatic reclamation | SidePane only calls render(active). AppHost runs teardown/bridge.close when the component unmounts. closeOnUnmount=false only prevents Main close | First preserve state during ordinary navigation, without copying the entire ZCode page system at once |
| UI state | Live pages remain. widgetState is memory-only, business data belongs to the plugin service, and stable appIdentity partitions provide localStorage/IDB | apps[] holds descriptor/hostContext, and Core stores instance/context. A random token forms the page origin. No durable widgetState contract was found | Preserve live pages first. Do not yet promise recovery of unsaved business data after a crash |
| Bidirectional tools | Tools register after App initialization. The Agent uses claim/resolve, with callId deduplication and AbortSignal. Sampling is limited to existing actionable tasks | The main path has pages call MCP tools on the same server, with durable Core Turns and approvals. AppHost has no app-provided tools or sampling handler | P2 only when an editor actually needs the model to operate on page state |
| Native permissions | Independent guest/partition and capability gates, with declared camera/microphone/geolocation/clipboardWrite permissions | Permissions-Policy disables all of these. No Node access, product bridge, or credentials are exposed | The current limits are deliberate. Do not enable hardware permissions by default |
| Files and forms | The UI plugin's business library or service owns the data | Existing native file entry points provide opaque URIs, a Runtime helper, ETag/CAS, forms/MRTR, and read-only copy uploads | Preserve the existing implementation. Do not build file authorization again |
| Platforms | Both the documentation and CONTRACT limit support to Desktop local workspaces. Web, mobile, and remote clients fall back to ordinary cards | AppHost currently uses the mcpAppDesktop desktop bridge path | Discuss remote UI only after P2. Define capability negotiation and fallback first |
| Completion evidence | Contract tests, unit tests, and Electron fixtures exist. The 53 Showcase cases do not mean that all 53 passed | Core/GUI smoke tests and acceptance documents exist, while full P1/P3, P2 hooks, and other items explicitly remain open | Neither file count nor the existence of a demo establishes completion |

### Execution paths and specific evidence

#### Ordinary plugins preserve useful AReaL boundaries

`Store::install` first verifies the candidate source and digest, then takes a snapshot and checks the digest again. It builds a read-only cache in staging and publishes the state through `transact(expectedRevision)`. The transaction holds a file lock and uses a temporary file, fsync, and atomic replacement. Project enablement or disablement overrides the user default. The two scopes are not permission levels.

- [Store transactions and enablement resolution](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/plugins/src/lib.rs#L211-L250)

- [Installation, digest verification, publication, and history retention](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/plugins/src/lib.rs#L476-L567)

- [npm version and integrity verification](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/plugins/src/remote.rs#L436-L509)

- [AReaL manifest selection](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/plugins/src/package.rs#L347-L389)

- [AReaL components and commands diagnostics](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/plugins/src/package.rs#L601-L650)

ZCode does not let plugins arbitrarily replace the Agent loop. NodePluginAdapter aggregates MCP, hooks, skills, and commands from enabled packages. Bootstrap converts plugin agent templates into its own profiles. ui.surfaces is parsed as manifest declarations. An invalid entry produces a warning without affecting the remaining components.

- [ZCode manifests and aggregation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L105-L113)

- [Enabled state and component aggregation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L173-L234)

- [command roots](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L452-L464)

- [Plain Markdown command mapping](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/plugins/index.ts#L716-L800)

- [Plugin agent templates and names](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/bootstrap/src/subagents.ts#L109-L147)

- [Dependency closure and atomic directory rollback](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts#L790-L848)

- [Unsupported npm marketplace](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts#L1804-L1809)

#### UI Plugins share a protocol but differ in product completeness

AReaL's page-call path is:
`McpAppHost AppBridge → Main McpAppsHost → management RPC → Engine::mcp_app_request → app_tool_turn → existing permissions/approvals/durable log`.
This already provides the correct identity and side-effect boundaries. Instance validation includes runtime_epoch, identity, thread, generation, cwd, and plugin digest. Closing an instance cancels its call owner and unsubscribes when the last subscriber leaves.

- [AppBridge and host capabilities](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/McpAppHost.tsx#L217-L307)

- [Instance binding validation](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/desktop/mcp_apps.rs#L354-L389)

- [Ordinary Core tool execution path](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/desktop/mcp_apps.rs#L1121-L1250)

- [Cancellation on close and subscription release](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/desktop/mcp_apps.rs#L885-L959)

- [iframe CSP and disabled permissions](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/mcp-apps.cjs#L420-L445)

##### Complete derivation of the UI lifecycle issue

1. `SidePane.tsx:315-317` renders only the active panel. Switching tabs replaces this React subtree.

2. `McpAppsWorkspace.tsx:507-515` renders the active App descriptor as `McpAppHost` with `closeOnUnmount={false}`.

3. The effect cleanup in `McpAppHost.tsx:371-381` unconditionally calls unsubscribe, teardownResource, and bridge.close. The false value only skips Main `operation: close`.

4. The iframe is an actual node under the component, so unmounting destroys its Document. The apps array retains descriptor/hostContext, not arbitrary page DOM, input, or private editor state.

5. Returning to the tab creates a new AppBridge and iframe and repeats the handshake against the same Core descriptor. Business data already saved to the plugin service can restore itself. Unsaved data held only in page memory cannot be recovered from the descriptor.

6. This does not establish that all business data must be lost, nor is it a runtime failure reproduced in this session. It is a failure path identified in source that needs validation with an unsaved-edit case.

- [Active subtree](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/app-shell/SidePane.tsx#L315-L319)

- [Descriptor rendering](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/McpAppsWorkspace.tsx#L493-L521)

- [Unmount logic](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/McpAppHost.tsx#L361-L383)

- [ZCode page owner](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/plugin-ui/app/pluginUiPageManager.ts#L1-L88)

- [ZCode MCP pages reject automatic offscreen reclamation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/plugin-ui/adapters/pluginUiManagedPage.ts#L417-L454)

##### Mounting completed tool results

- AReaL already has `Engine::mcp_tool_result(threadId,callId)`. It reads `mcpServer + mcpResult` from the actual persisted `execution.result_snapshot` through the `areal/mcp/tool/result` RPC.

- `ToolEvent.tsx` currently displays ordinary tools, images, files, and raw results. It has no button or panel that hydrates an App from a completed MCP call.

- The current manual `mcp_app_open` runs `app_tool_turn` when `arguments.is_some()`. Main currently always passes an arguments object. This execution uses the existing permissions, approvals, and receipts. It is not unauthorized execution.

- A new result entry point must distinguish reading and displaying an existing result from explicitly invoking an App's initial tool. Passing old tool arguments back to the existing open operation cannot implement a result preview.

- Do not claim that clicking history currently causes duplicate side effects. The click entry point itself is currently missing.

- [Existing durable result read](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/desktop/mcp_apps.rs#L1673-L1707)

- [Result-read RPC](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/app-server/src/plugin_runtime.rs#L84-L88)

- [Current tool-row rendering](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/ToolEvent.tsx#L53-L115)

- [Initial call in the current open operation](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/core/engine/src/desktop/mcp_apps.rs#L555-L575)

- [Main passes initial arguments](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/mcp-apps.cjs#L128-L142)

##### Capabilities to consider only in P2

ZCode UI Apps can provide page tools to the Agent and perform sampling within an existing actionable task. That does not justify allowing AReaL pages to schedule arbitrary model work now. Page tools are useful for selection and undo state known only to a live canvas. They require a complete contract for register→claim→execute→resolve, cancellation, deduplication, terminal states, revocation, schema freezing, and context budgets.

- [Page-tool registration and calls](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/plugin-ui/app/pluginUiAppTools.ts#L153-L237)

- [Capabilities declared according to availability](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/plugin-ui/domain/buildPluginUiHostCapabilities.ts#L30-L60)

- [Stable appIdentity partition](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/pluginSandbox/registry.ts#L137-L174)

- [Actual guest and instance-resource validation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/desktop/src/main/pluginSandbox/session.ts#L40-L100)

- [Platform boundaries in the documentation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/UI_PLUGIN.md#L18-L32)

### Four handoff specs

#### UI-01 Preserve live App pages during ordinary navigation

**Priority.** P0 if editing Apps are supported, otherwise P1. Establish a failing case in real Electron before changing the implementation.

**Why this comes first.** Tab switching is an ordinary action. The basic UI Plugin workflow is to edit, move to chat, and return to continue. Page tools, complex canvases, and more entry points all depend on this. Close the state-loss path before adding more plugins.

**Goal.** Within a window, one App instance has one live iframe/bridge owner. Switching tabs, hiding the sidebar, and switching sessions change only the display. Teardown occurs only on explicit close, source or generation revocation, task deletion, or window close.

**Non-goals.** Recovering arbitrary unsaved DOM after a crash, copying ZCode's webview/partition/capturer, unlimited background activity, remote Apps, broader native permissions, or separate Core state.

**Change boundaries.**

- `clients/gui/renderer/src/McpAppsWorkspace.tsx` changes from creating pages on demand during render to managing a stable page owner registry.

- `clients/gui/renderer/src/McpAppHost.tsx` decouples the connection and lifecycle from active-tab unmounting. It controls visibility, while authorization does not depend on whether the mount is in the active slot.

- `clients/gui/renderer/src/app-shell/SidePane.tsx` and `App.tsx` pass display targets or anchors to Apps and retain the existing ordinary-panel logic.

- `clients/gui/app/src/core/mcp-apps.cjs` and Core change close and event contracts only as needed. A page retained by the renderer must not be treated as an authorization fact.

- Add the proposed `clients/gui/scripts/mcp-app-lifecycle-smoke.mjs`, reusing the existing fixture helper for real Electron/Core.

**Proposed contract.**
`pageKey = {projectId, threadId, instanceId, generation, token}`. A token or generation change creates a different owner. The lifecycle is `opening → ready ↔ hidden → closing → closed`. Only actual load or connection errors enter `failed`. Hidden does not mean failed or closed. Do not implicitly merge pages by URL, toolName, or the same resource within one turn.

**Implementation steps.**

1. Build a RED fixture with unsaved text, a random bootId, initialization count, subscription count, and a slow tool callId inside the page. Check it after switching tabs, hiding and showing the page, and switching away from and back to a session.

2. Provide a stable page host and a single bridge. Display references change only the layout. Hidden pages do not take focus, and click-through behavior remains correct. Each instance records the window owner from open. Disposal and revocation use that recorded owner rather than reading a destroyed BrowserWindow during will-quit. Recheck owner and epoch after asynchronous open, and compensate stale results through the existing close path. Main IPC continues to validate the current window, sender, main frame, and application URL. An old token cannot transfer to a new owner.

3. Bound the page count and provide explicit capacity feedback. Commit the initial limit as explicit product configuration. Reject new pages when capacity is exhausted, without silently evicting editor pages. Choose the default through real Electron measurements with multiple pages, not by copying ZCode's 64.

4. Closing a page or revoking authorization cancels and unregisters only once. Late load completion or events do not revive an old owner.

**Acceptance.**

- The bootId stays the same. Unsaved text, cursor or selection state measurable by the fixture, and scroll position remain. initialize and the initial tool each run only once.

- Display changes do not cancel or replay an accepted slow operation while its page is hidden. Its result still belongs to the original call.

- Closing cancels calls, and disabling the source rejects new calls. Late messages from the old page do not affect a reopened instance.

- The same URI in projects A and B does not share state. Switching tasks does not attach model context to the wrong current task.

- Exhausted page capacity produces clear feedback without damaging existing pages. Actual close returns capacity.

- The owner change does not regress existing Apps file CAS, subscription, or forms smoke cases.

- If the real baseline shows that another layer already preserves the same iframe, record that counterevidence, skip this fix, and revise the spec around the failure actually observed.

**Testing and delivery.**
Run `pnpm --dir clients/gui typecheck` and `pnpm --dir clients/gui build`. Run the new Electron case, `node clients/gui/scripts/mcp-apps-smoke.mjs`, and the relevant `plugin-p3-extensions-smoke.mjs` cases. Follow the current repository development guide for build and environment requirements, and explicitly list checks not run. Update both language versions of the plugins guide and API documentation. Rollback removes only the stable owner UI path. It must not delete existing durable plugin/Core data.

#### UI-02 Open an interactive page from a completed MCP tool result

**Priority.** P1, dependent on UI-01.

**Why this work.** MCP result snapshots and AppBridge already exist. Turning a model-generated result into an interactive page costs less than inventing an editor protocol. It directly supports the core workflow of an Agent artifact, human edits, and a return to the conversation.

**Goal.** A successful MCP tool record offers "Open interactive result", which reads the original call result and proof of its source. On the first open, Core creates an App instance bound to that result. Success of the original MCP tool does not imply that an App already exists. If the corresponding page is already live, focus it and preserve the same token and iframe, without hydrating it again or overwriting edited state. Displaying the result never resends the original tool call.

**Non-goals.** Automatic history replay, opening all background results by default, app-provided tools, sampling, sharing ui.surfaces across entry points, remote guests, or ZCode's entire display policy.

**Proposed new interface.** This name is a proposal, not an existing API.
`areal/mcp/app/openFromResult({threadId, callId, requestId})`.
Core reads the stored call and validates terminal success, the MCP snapshot, the package, digest, server, and original connection generation. Clients cannot substitute arbitrary HTML, metadata, or original tool arguments for durable facts. The first creation returns `instanceId + generation + resource + initialArguments + initialResult + hostContext`, reusing existing descriptors and AppBridge without calling `app_tool_turn`. Main/Workspace reuses the exact live owner for the same call. Reusing only the Core instanceId while generating a new token and iframe does not meet acceptance.

The first P1 release explicitly accepts only results whose original source is still verifiable and whose original MCP connection generation is still valid. If the old generation has been cleaned up, keep the ordinary readable result. Do not automatically rebind to the current service across restarts. Future support for mounting across restarts needs separate rules for stable source fields, resource compatibility, and revocation. Matching generation numbers alone, or saying that the source is the same, is insufficient.

**Files.**

- `core/protocol/src/plugin_runtime.rs` defines strict DTOs.

- `core/app-server/src/plugin_runtime.rs` owns routing and identity/thread constraints.

- `core/engine/src/desktop/mcp_apps.rs` reuses `mcp_tool_result` and instance binding, and separates resource preparation from initial tool execution.

- `clients/gui/app/src/core/mcp-apps.cjs`, related management routes, and generated schemas.

- `clients/gui/renderer/src/ToolEvent.tsx`, `Messages.tsx`, and `McpAppsWorkspace.tsx` provide the open action for successful tools and safe fallback.

- First inspect which binding fields mcpServer contains in the original snapshot. Add missing fields only for new calls. Historical records without the bindings explicitly return ordinary results, without falsely associating old data with the current connection.

**States and errors.**

- `available / preparing / open / unavailable(reason)` is a UI projection, not a separate persisted tool-execution state.

- Failed, canceled, or UNKNOWN original calls do not automatically create Apps. The original tool record remains visible.

- If the current package is disabled or uninstalled, its digest differs, or the old generation has been cleaned up, report that the result cannot be opened and preserve the original readable result.

- UI-01's owner still handles switching after opening. Repeated clicks focus the same token and iframe without injecting initialResult again. A requestId is idempotent for the same arguments and conflicts for different arguments.

- Close is terminal for that owner. Retrying an old requestId returns only the original operation facts or stale. It does not revive a closed owner. An explicit reopen uses a new requestId, creates a new instance, and reads the same original result. The original source must still be valid, and the original business tool does not execute.

- Starting a new tool call with new arguments is a separate explicit action. Do not include it in "Open result".

**Acceptance.**

- Execute an MCP tool with a side-effect counter once. Opening, repeated clicks, and closing then reopening all leave the counter at 1. The App receives the original structuredContent.

- Upgrading or disabling the same package, copying a callId across projects, or forging a resourceUri cannot execute against the wrong source.

- Page errors, CSP rejection, and HTML limit violations explicitly fall back to an ordinary record. They neither lose the original result nor report false success.

- Reading the original result does not put private _meta into the model's message body. Preserve the existing strip_meta behavior.

- Separate live successful results from history restoration. Restoring history does not load all Apps without an explicit action.

- Old instances become invalid after a restart. P1 does not rebind an invalidated original MCP connection generation and clearly falls back to an ordinary result. If the original connection remains valid, closing and reopening can create a new instance without resending the business call.

- Repeated opens preserve the iframe, token, and edited content. After close, retrying an old requestId does not revive the owner. Only an explicit reopen with a new requestId creates a new owner once.

- Validate with new regression cases and relevant existing `core/engine/tests/plugin_mcp_runtime.rs` and GUI Apps smoke scenarios. Retain evidence of the fixture's original call count and its request/call/instance/generation.

**Tradeoffs and rollback.** Start with an explicit open action in the sidebar. Defer policies such as automatic inline display and automatically taking over the sidebar. The interface only reads the original result and continues to use the instance-resource boundary. A feature flag can remove the UI entry point while preserving backward-compatible result snapshot fields.

#### PLG-01 Publish component compatibility and support gates

**Priority.** P1, which can run in parallel with UI-01. If the user plans to publicly promise "full compatibility", the gate for that promise becomes P0. It does not require a new plugin system.

**Why this work.** Installed, Skill-discoverable, MCP-connectable, hooks-trusted, and App-renderable are different facts. A structured contract aligns the UI and CLI with what is actually usable. It also prevents Codex from enabling capabilities merely because documentation describes them as candidates.

**Goal.** Provide a clear, computable support status and reasons for each component declared by a package. Reuse the actual installation, profile, trust, and authentication state, without exporting several contradictory "available" booleans.

**Non-goals.** Rebuilding the installation Store, authentication, approvals, or receipts. Automatically trusting hooks, starting disconnected MCP by default, replacing the existing plugin marketplace UI, or claiming that all real OAuth and cross-platform acceptance checks have passed.

**Proposed structure.** This can extend an existing DTO. The field names are proposals.
`componentSupport[] = {kind, sourceField, status: supported|partial|unsupported, reasonCodes[], supportedSchema, activationRequirements[]}`.
The degree of support comes from the parser implementation. Effective state references the existing installation, enablement, connection, and permission projections. Keep static supports separate from current activation. Do not return permissions or secrets as results.

**Files.**
`core/plugins/src/package.rs`, `core/plugins/src/components.rs`, `core/engine/src/desktop/plugins.rs`, existing schemas, examples, and types, `clients/gui/renderer/src/settings/PluginCenter.tsx`, `clients/gui/renderer/src/settings/pluginResources.ts`, `clients/cli/src/plugins.rs`, the plugins guide, and the current acceptance document.

**Behavior.**

- Provide per-item diagnostics for commands, agents, and ui declarations even when they are unsupported. They must not silently disappear. Unknown portable schemas continue to fail closed, without a bypass through .claude fallback.

- An unsupported optional UI component must not disable an otherwise self-contained Skill. If a package's explicitly required component cannot be satisfied, return unavailable for activation and explain why. Define required-component semantics first, without guessing.

- Do not copy the meanings of ZCode's private fields. Explicitly report an unsupported format for .zcode-only packages and provide a documentation hint.

- Distinguish existing candidate hooks code from platform or test acceptance. CI evidence covers only reproducible deterministic contracts. Mark real-provider or OS-signing checks unverified when they are not run live.

- Preserve existing textual diagnostics for compatibility. New fields can be delivered incrementally.

**Acceptance.**

- Use fixed fixtures for portable, .codex, .claude, .cursor, .zcode-only, and unknown portable schemas, plus skills-only packages, disconnected MCP, unknown commands/agents/ui.surfaces, untrusted hooks, and resource paths outside the allowed boundary.

- GUI and CLI displays agree for the same package in the same project. A partial installation does not show "all available".

- Adding capability response fields does not execute package code, network operations, or models. Viewing the report does not reactivate a disabled package.

- Old clients can still read the original fields. Update generated schemas and both language versions of the documentation.

- Run targeted `cargo test --locked -p areal-plugins` checks, existing `scripts/plugin-wire-smoke.mjs` checks, and the GUI plugin-detail case. Do not mark checks green if they were not run locally.

**Tradeoffs and rollback.** Add a verifiable compatibility contract before attempting a broader ecosystem port. Clients can ignore the new fields, and durable State needs no migration. The UI presentation can be removed, while existing owners retain the actual permission semantics.

#### PLG-02 Add compatibility adapters at the boundary as needed

**Priority.** P2, dependent on PLG-01. Start only after selecting at least one real target plugin and its required components. Do not pursue "support all of ZCode".

**Why this is not P0 or P1.** AReaL already has sufficiently capable MCP/Skills packages. Adding aliases, agent profiles, and surfaces requires maintaining cross-project naming, permissions, update behavior, and history semantics. This work pays off only when a target plugin uses it.

**Implementation order.** These are optional independent slices, not one all-at-once change.

1. Normalize `.zcode-plugin` manifests into the existing package model only at the boundary. Do not override a valid portable definition with higher priority. Resolve conflicting manifests through defined precedence and diagnostics, without silently mixing them.

2. Convert plain Markdown commands into existing Skill or command descriptions that require explicit invocation. Return a specific unsupported result for unsupported shell or interpolation semantics, without attempting an approximate execution.

3. Convert agents into existing AReaL profiles or templates. Pin the package digest, use a stable `pluginId/componentId`, make naming conflicts explicit, and intersect the allowed tool set with parent permissions. Plugins cannot add sandbox, network, or provider permissions.

4. Normalize ui.surfaces and existing entrypoints into one host entry-point catalog. Preserve `resourceUri`, server binding, and scope. Only declared surfaces can share instances. Tool results still mount from the original call facts defined by UI-02.

5. Implement app-provided tools separately under UI-03. Sampling still needs its own ADR. First let the model operate on durable documents through the MCP service. Introduce the tool-registration and cancellation protocol only if editor state accessible solely through the page provides demonstrated value.

**Change boundaries.**
`core/plugins/src/package.rs` and `components.rs`. Before implementation, use rg to locate the actual owners of integration points with existing Skills/TaskAgent profile loaders. Also cover `core/engine/src/desktop/plugins.rs`, `mcp_apps.rs`, strict protocol definitions, and CLI/GUI projectors. Do not create a second plugin Store or Agent runtime.

**Core invariants.**

- Package updates retain the old digest for accepted Turns, while later executions use the new digest. Disabling revokes authorization immediately.

- Conversion only reads and normalizes. Installation does not execute shell, onboarding, or hooks.

- Agents or commands with the same name cannot impersonate components across plugins or workspaces. Directory references remain inside the fixed cache.

- Upstream private extensions that the internal standard model does not understand can only be reported as unsupported.

- Acceptance for a pinned target package does not establish compatibility with the entire ecosystem.

**Acceptance and rollback.**

- Use the real target package and malicious or boundary fixtures. Cover conflicting manifests, symbolic links and out-of-bound paths, components with identical names, live Turns during revocation, upgrades and history reads, and permission intersection with a restricted parent agent.

- Provide one compatibility checklist per package. Both the original and normalized definitions must have verifiable digests.

- Each slice has an independent switch. Removing an adapter does not delete existing packages or history, or silently convert unknown old components into other components.

- Pin official and vendor packages to a commit or integrity value. Do not claim compatibility with future main-branch revisions.

### Specific items to defer and why

- "Turn the UI into an unbounded mini-app OS" is unnecessary. Existing MCP Apps can already cover plugin business services.

- "Copy all of ZCode's persistent partitions, native permissions, 64-page limit, and sampling" carries substantial cost and risk. Concrete editor use cases must determine the need.

- "Add a new plugin installer or remote synchronization system" duplicates existing AReaL boundaries around the shared Store and local services. ZCode itself does not support remote UI Plugins, so the comparison cannot justify filling this gap immediately.

- "Use LRU to clear request records and solve the 512 limit" can repeat side effects. First define durable effect receipts, retention, and fail-closed rules for expired records. For now, a clearly documented capacity limit is sufficient.

- "Raise the HTML limit to ZCode's 16MiB" is unnecessary without a real need for larger pages. AReaL Core allows 2MiB and Main allows 8MiB, so the effective end-to-end limit is 2MiB. Align the documentation and capability descriptions first.

- "Declare existing P2 hooks candidates GA" is premature while the repository acceptance document still has open items. Clarify support, unverified areas, and platform boundaries, then complete acceptance for the necessary scenarios.

## IV. Separate follow-up specification for UI Plugin

### UI-03 P2 Page tools and request budgets for long-lived pages

**Entry conditions.** UI-03A requires UI-01 to be complete and a fixed editor use case to reach the request budget for a long-lived page. It does not require a need for page tools. UI-03B requires at least one real editor at a pinned version whose Agent needs to read or modify a selection, undo stack, or uncommitted canvas state that exists only in the live page. For operations that only create, read, update, or delete persistent business documents, continue to use the existing MCP service tools. Do not start slice B.

**Source evidence.** ZCode already implements page tool registration, claims, and result submission. AReaL's AppBridge currently lets pages call the same MCP service for most operations. The request deduplication tables in AReaL's Renderer and Main each have a lifetime limit of 512 requests. This is an explicit resource policy and must not be described as a discovered security vulnerability.

- [ZCode page tool registration and invocation](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/packages/ui/src/plugin-ui/app/pluginUiAppTools.ts#L153-L237).

- [Existing AReaL AppBridge capabilities](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/McpAppHost.tsx#L217-L307).

- [Renderer deduplication and request budget](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/McpAppHost.tsx#L99-L124). [Main deduplication and request budget](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/mcp-apps.cjs#L239-L271).

**Decision.** Divide the work into two independently deliverable slices. UI-03A handles the request budget for long-lived pages and can ship first. UI-03B permits a limited set of page tools registered through Core. Core remains the owner of execution and permissions. The page is the execution endpoint for an authenticated instance. MCP sampling is outside this specification. Any new model call requires its own real use case and a separate ADR.

#### UI-03A Bounded request handling for long-lived pages

**Goal.** After UI-01 preserves the same live page, typical editors must not have to destroy their documents solely because the cumulative request count reaches 512. Replay protection and bounded memory must remain intact.

**Proposed contract.** Account separately for the maximum number of in-flight requests, cached completed read-only responses, and execution identities and durable receipts for requests with side effects. The Host issues an explicit transport epoch and replay window. Ordinary packages continue to use the existing protocol and budget. Only pages that successfully negotiate the new mode enter it. Window rotation must not change the App instance or generation, or re-execute initialization tools.

The current implementation has three distinct identity layers. The page has a JSON-RPC ID. The Renderer sends a mountId/sequence to Main. Main generates a Core requestId on the first dispatch. The current cache ensures that the Core ID is generated only once. The new protocol names these `guestRequestId`, `bridgeRequestId`, and `coreOperationId`, respectively. Do not conflate them into a single requestId. [Renderer forwarding identity](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/renderer/src/McpAppHost.tsx#L241-L247). [Main creates the Core execution identity](https://github.com/areal-project/AReaL-Harness/blob/dd3758cdbebbceb7b582bec0d357405f10bc8fba/clients/gui/app/src/core/mcp-apps.cjs#L320-L350).

Before admitting a side effect, durably bind `(transportEpoch, guestRequestId, fingerprint)` within the authenticated instance to a unique `coreOperationId`. Use `bridgeRequestId` only for transport correlation. Neither Renderer nor Main may generate a new execution identity for that request after cache eviction or reconnection. Retransmission must reuse the mapping. If the mapping cannot be recovered, return expired or UNKNOWN without dispatching the request again. Atomic admission and queries depend on Core's commit. A separately written but uncommitted mapping does not prove that the operation was accepted.

1. First define which owner handles the side effects of each method class and which deduplication key it uses. Read responses may be evicted after the declared window. File writes, MCP tools, message submissions, and other side-effecting operations must reference an existing durable Core execution/receipt. Memory eviction must not lose their execution identity.

2. For the same transportEpoch/guestRequestId and the same parameters, look up the durable mapping and coreOperationId, then return the original result or the accepted status. Different parameters are a conflict. Only facts committed by Core can establish success.

3. For an old request outside the valid window whose execution cannot be established, return an explicit `request_expired` or the existing UNKNOWN state. Do not treat it as a new request. Do not suggest automatically resending an operation with side effects under a new ID.

4. Limit the number of in-flight requests, the bytes per request and across the cache, and the wait time. When capacity is insufficient, reject new requests while allowing the existing page and accepted calls to settle. Closing the page or revoking access continues to cancel requests as usual.

5. If a request class has no reusable durable receipt, retain its existing bounded budget and explicit rejection. Do not weaken its semantics to pass a long-session test.

**Acceptance.** Run at least 2,000 bounded reads in a fixture with the same bootId and check that memory remains stable. A write tool must execute at most once, or return an explicit UNKNOWN, after response loss, window rotation, repeated old requests, and Main reconnection. Automatic replay is forbidden. Reject both cross-epoch forgery and content conflicts. The old SDK continues to use the old budget. Read only existing durable facts. Do not "restore" the page through replay after a service restart.

#### UI-03B Limited tools provided by the page

**First fixture.** `getSelection()` returns the page document's revision and selection range. `applyPatch({expectedDocumentRevision, patch})` modifies only that page's document. A stale revision returns a conflict. Do not guess a new target location. Pages may declare tools only within the specified schema, size, and count limits. This must not provide arbitrary JS, shell execution, network proxies, or tool name overrides.

**Implementation contract.** Use exactly `areal/mcp/app/tools/register`, `revoke`, `claim`, and `resolve`. Resolve accepts completion, definite no-effect, or UNKNOWN. One settlement interface avoids a separate reject route and an outer tool reply. The [desktop contract](../api/desktop.en.md#finite-page-tools) owns types and budgets. Core reuses ordinary inventory, approval, and the ToolCall journal, without a page execution ledger. Admission freezes the following identity:

```ts
type AppToolBinding = {
  instanceId: string;
  generation: number;
  threadId: string;
  pluginId: string;
  pluginDigest: string;
  appsEpoch: string;
  toolHostId: string;
  ownerId: string;
  registrationId: string;
  documentId: string;
  kind: "getSelection" | "applyPatch";
  schemaDigest: string;
};
// Core generates callId and durably admits the call. The page cannot specify another Thread or bypass ToolCall.
// Freeze the binding above after admission. Tool list changes affect only the set visible to subsequent calls.
```

**State and boundaries.**

- Trusted Main may register only after the original source-bound bridge completes initialize. Core decides whether to expose its tools to the model based on the owning Thread, plugin state, and existing authorization. A hidden page that remains valid may execute calls. A closed or revoked generation may not.

- Only the original opening ToolHost and Main socket may claim a callId once. Core persists claim before returning execution permission. ownerId cannot replace original connection authorization. Repeated resolve submissions with identical content are idempotent. Different content is a conflict. An old connection cannot submit results for a new instance.

- The Agent's tool schema freezes when the Turn is admitted. Temporary page schema changes or plugin upgrades must not change the meaning of in-flight calls. Tool names must use a controlled namespace.

- Intersect the approval scope with existing permissions. A tool's readOnly flag is only a declaration and cannot justify elevated permissions. Modifications require a verifiable document revision and result evidence.

- When the user closes the page, cancels the Turn, disables the plugin, or the Host disconnects, revoke new claims and notify in-flight calls of cancellation. If the page has already made a change but its acknowledgment is lost, preserve UNKNOWN and require verification. A reopened page must not repeat applyPatch.

- Page tool output uses the existing result-size and context budgets. Do not inject private `_meta`, tokens, or the page's entire memory into the model.

**Files to change.** `core/protocol/src/plugin_runtime.rs`, `core/engine/src/desktop/mcp_apps.rs`, and `core/app-server/src/plugin_runtime.rs`. At the start of implementation, use `rg` to confirm the integration points with existing tool registration and execution entry points. Also update `clients/gui/app/src/core/mcp-apps.cjs`, `McpAppHost.tsx`, and the UI-01 page owner. Add the corresponding fixture and bilingual protocol documentation. Do not create a Renderer Agent loop or an independent plugin execution ledger.

**Acceptance.**

1. In real Electron, the tools visible to the model match the registered schema and act only on the page in the correct project and Thread.

2. Same-named tools on pages A and B, page closure and reopening, forged instances across tasks, old digests after upgrades, and stale schemas must not cause misrouting.

3. When two calls compete for the same document revision, one succeeds and the other returns an explicit conflict. Do not combine them into an unsupported success.

4. Check cancellation before claim, after claim but before execution, and after execution but before the reply. The last case may return UNKNOWN but must not trigger automatic replay.

5. Selection and document state persist while the page is hidden. After closure, its tools disappear from the set visible to subsequent calls. Previously accepted calls retain accurate terminal states.

6. Verify UI-03B registration, in-flight, byte, and deadline limits. Existing request budgets remain. MCP Apps file, CAS, and revocation cases must not regress.

**Implementation choices.** Use the CodeMirror version already pinned in the lockfile. UTF-16 ranges permit a synchronous revision comparison, transaction, and undo. Directed notices wake an executor without granting permission. One invocation writes claim and terminal state. Accepted terminal evidence must survive post hooks and generic finalization. Losing either original connection retains the page but revokes tools. Automatic ownership transfer and execution recovery are outside this slice.

**Dependencies and rollback.** UI-03A depends on UI-01. UI-03B depends on UI-01, UI-02, and support diagnostics PLG-01. The two capabilities negotiate independently and have separate switches. To disable a capability, first stop new registrations and dispatches, then drain or explicitly cancel in-flight calls. Preserve existing results and page content. Do not delete user business data. Remote UI, cross-device pages, sampling, and restoration of arbitrary DOM after a crash are outside this round's scope.


## Delivery and acceptance summary

| Specification | Independently mergeable slices | First result that establishes completion |
| --- | --- | --- |
| AUTO-01 | A Control, cold receipt segments, and v3 migration; B Run/Channel history | Stopping remains durable when logical capacity is exhausted; 2,000 simulated runs with consistent budgets and old receipts |
| UI-01 | Reproduction in the real app; stable pages; closure and revocation regression checks | The bootId and unsaved edits remain unchanged after switching tabs away and back |
| AUTO-03 | Core manual admission; GUI entry point | Run now creates exactly one new Run without changing nextRunAt or paused |
| AUTO-02 | Rules and migration; preview; GUI | Preview matches actual triggers, with explicit IANA, DST, and month-end policies |
| B1 | scroll/hover; select/checked/wait | Native control tasks complete with existing permissions and UNKNOWN semantics intact |
| PLG-01 | Component diagnostics protocol; GUI/CLI projections | Support and activation reasons for every component in the same package are visible and consistent |
| UI-02 | Source binding and read-only mounting; tool record entry point | Opening the original result any number of times leaves the original tool's side-effect count at 1 |
| B2 | CLI headless Host; dependency packaging; failure cleanup | The CLI completes the task without Electron and leaves no orphan browser processes on exit |
| AUTO-04 | Service configuration and admission; shell/files; joint integration with B2 | Two rounds execute while the GUI is closed and the service is alive; a missing browser capability produces an explicit rejection |
| PLG-02 | One adapter for each required component type | The pinned real target package passes acceptance for each component, without extrapolation to the entire ecosystem |
| UI-03 | A Request budget; B Page tools | A long-lived page has bounded memory; the correct instance modifies the correct revision, without replay on failure |
| B3 | a CLI Profile and local login; b Task binding and revocation | Login survives Host restarts, other Profiles cannot access it, and a fully displayless environment reports an explicit needsLogin |

Each slice must report actual test results and checks that were not run. The commands and completion criteria listed here belong to subsequent implementation acceptance. This delivery is a comparison of pinned source revisions and a specification. It is not an implementation, a claim that tests have passed, or a merged PR.
