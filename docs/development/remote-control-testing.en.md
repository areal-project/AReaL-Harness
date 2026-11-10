[中文](remote-control-testing.md) | **English**

# Remote Control testing and release gates

This is a plan to execute, not a report of tests passed in this handoff.

Independent Desktop Service acceptance is specified by ENV-01 through ENV-15 in the [environment service plan](environment-service-plan.en.md). Reuse this page's transport/business checks, with separate evidence for independent owners, real LaunchAgent registration, transition recovery, and signed packages. Existing exit scenarios do not automatically cover those new boundaries.

## Relay Host/PWA source and strict-TLS fixture

Run `pnpm --dir clients/gui test:remote-relay` (Node 24.2.0, OpenSSL and installed locked Relay dependencies required). Real Relay CLI/SQLite, production Host, wire factory and Noise run through isolated-CA HTTPS/WSS with certificate and hostname validation enabled. Cases cover untrusted CA, wrong SAN, expired certificates, encrypted enrollment persistence, pin/room/channel, shared transport budgets, revocation, observers, restart/replacement and actual TCP slow-reader isolation. Static tests use the actual Remote export and check CSP/content hashes.

The sequential large-history regression awaits each response while checking a second device, under both default and reduced service frame/byte limits. Record outer-JSON rolling-second byte/frame peaks, including close traffic and reserve for actual automatic pongs. Parallel backlog cases cannot replace this rate test. Also retain typed refusals on orderly close, immediate discard on queued revocation, old-generation timer cleanup, malformed/missing advertised limits and fail-closed unusable low budgets. Browser-state tests cover actual wire room on root/manifest restore, same-Host room refresh only after ready, refusal/transaction-abort preservation, old Direct records, guest no-database use and forget/revision fences.

This is source and local Node TLS evidence. Core public-protocol fixtures are not real Native/Core business acceptance, and running the wire factory is not production browser DOM execution. RC-16 must select transport within existing business suites and preserve the same assertions. Strict-TLS browser, real system keychain, phones, public port 443, signed packages and organization networks remain separate unrun gates.

## RC-16 transport selection and evidence boundaries

The six existing E2E entries accept `AREAL_REMOTE_TRANSPORT=direct|relay`; omission keeps Direct. Any other value fails before processes or listeners start. Relay in `test:remote-command-e2e` reuses the same Native business assertions, faults and counters, replacing only the real Relay CLI/SQLite, HTTPS/WSS endpoint and production `createRemoteWire`. After initial enrollment, Host restarts reuse the same encrypted configuration, identity and grants without enrolling again. Node device connections receive the isolated public CA per request; the Host child trusts it only through startup `NODE_EXTRA_CA_CERTS`. System trust and certificate/hostname verification remain unchanged.

With one frozen source, native bundle and exclusive acceptance lease, run each transport, for example:

```sh
AREAL_REMOTE_TRANSPORT=direct AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:remote-command-e2e
AREAL_REMOTE_TRANSPORT=relay AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:remote-command-e2e
```

The other RC05–RC10 selectors and default 100-race requirement remain unchanged. Manifests record requested/completed counts per case, check layers, source/binary identity, CA/configuration hashes, observed Host/CLI and native descendant processes, normal-stop errors and cleanup receipts. T18/T19/T22/T23/T25/T30 must actually complete at least 100 iterations for each transport. Historical Direct results from another source cannot establish this run's two-transport conformance. `fullConformance` is always false: one entry cannot certify the release matrix. Process absence or forced cleanup is not settlement of Runtime UNKNOWN; stop failure fails the whole run.

## Reproducible RC-01 checks

Run from the repository root:

```sh
make build
make gui-install
make gui-build
pnpm --dir clients/gui run test:remote-observation
pnpm --dir clients/gui run test:remote-observation-e2e
```

`test:remote-observation` exercises protocol rejection and resource budgets over real WebSocket/Noise; isolated dependency data does not replace real business validation. `test:remote-observation-e2e` connects the production browser page and encrypted public entry to an isolated real DesktopService/Core/Runtime, with a deterministic local model and preprovisioned test-device grants, to check the loopback read-only boundaries in T01–T04. Scripts report the isolation directory and manifest; preserve failures separately from repaired reruns.

The E2E also injects missing Direct static assets to confirm the existing desktop service still starts and a failed enable leaves no listener. After a successful connection, it closes the Host and checks that the page no longer displays stale online state. `remote-observation.png` in the isolation directory is a desktop Chrome demonstration screenshot, not mobile-device evidence.

These checks use no external model account and change no VPN or public deployment. System keychain, real iOS/Android devices, HTTPS/WSS reverse proxies, Relay, signed packages and the complete GUI-exit lifecycle require evidence from the corresponding later tickets. In particular, T04 loopback route/Origin checks are not public TLS acceptance.

## Repeatable RC-02 validation

After building, run `pnpm --dir clients/gui run test:remote-pairing-e2e`. It connects real isolated DesktopService/Core/Runtime and a deterministic local model, then uses production Electron settings and the Chrome Remote page for requests, fingerprint comparison, explicit project selection, Observer/Operator approval, scope narrowing and revocation. It does not preprovision active grants. Fault injection stays at secure storage, disk writes and Host clock boundaries.

It covers local T05/T06/T08/T09 behavior, T02 Host pin mismatch, and T07 invalidation of an existing encrypted connection/project-read scope. T07 subscription and artifact-stream subcases require RC-04/RC-10/RC-16 as those features ship; project-list checks cannot replace them. The output directory contains a manifest and desktop/browser screenshots; preserve original failed runs. System keychain, real phones, TLS, Relay and signed packages are outside this script's acceptance scope.

## Repeatable RC-03 validation

After building Core and GUI, run `pnpm --dir clients/gui run test:remote-work-overview`. It exercises the production encrypted Direct entry, actual device grant confirmation, isolated real Core/Runtime and deterministic model through work.list/attention.list and the production browser page. T10–T12 cover never-opened running/failed sessions, synchronous approvals/questions, a running Task with an asynchronous question and two workers, cross-project rejection, page cursors, partial count labels, bounded oversized summaries, and in-flight Runtime UNKNOWN after an explicit test-only Core crash/restart. A workspace effect marker checks no replay. It verifies real Chrome tab visibility through public CDP because Playwright enables focus emulation; no document visibility property is mocked.

Each run retains its manifest, source revision/diff identity, binary SHA-256, checks and browser screenshot in the printed isolated directory. Local real Chrome visibility is not mobile suspension evidence. Secure storage is a fixture boundary; real keychain, phones, TLS/Relay and signed packages remain separate gates. Earlier failures and repaired runs must remain separately attributable.

## Repeatable RC-04 validation

After building the GUI, run `AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-session-e2e`. The production Remote page and Electron connect to isolated real DesktopService/Core/Runtime for T13–T17 streaming baselines, stale events, gap recovery, slow-device isolation, history pagination, tool-host retention and restart UNKNOWN. `node clients/gui/scripts/remote-native-observation-oracle.mjs` tests counterexamples to the evidence assertions only; it does not replace native execution.

The Browser case first verifies the exact page, URL, loading state and native content, then edits and reads a real page input. Instrumentation records navigation events and the original `loadURL` Promise without replacing network-security listeners. One initial `-3` load failure may recover through the existing visible retry button; the manifest preserves the first failure and recovery action separately. Recovery does not establish successful first navigation. The tool-host check holds delivery of an actual matching Browser result, closes the phone detail while that request remains pending, receives closure confirmation, then delivers the original result unchanged and verifies successful content for the same Turn/call/page. This proves retention while a native response awaits delivery, not that Main is still executing. A locally answered `describe` call is not native-call evidence.

After oversized history rejection, the test requires a new Turn and a new actual Browser observation with the original page state. Restart binds the genuinely running tool Turn/Item/runtimeEpoch/scopeId/operationId and preserves that same UNKNOWN without replay or inspection acknowledgement. The manifest retains original requests, generations, page and tool records; failures remain separate evidence. This entry does not certify Relay, phones, system keychain, strict public TLS or signed installed packages.

## Reproducible RC-05 checks

`pnpm --dir clients/gui run test:remote-command` uses actual temporary files and production Backend/Gateway code with RPC fixtures. It checks concurrent identical keys, device/project isolation, persistence faults, grant-queue races, terminal-before-pending-removal ordering, offline reads, Desktop recovery/dismiss races, and preservation of observation references. Send admission gives ownership from the atomic Core observation priority: Task-owned sessions return TASK_CONTROL_REQUIRED even when the local projection already has an inProgress Turn or gains one while observation is pending; active ordinary sessions return TURN_BUSY. These refusals must not add journal writes, command admissions, or native dispatches. `test:remote-session` operates production page buttons to verify commandId retention before sending, unknown-result queries, conflicts, and drafts. These are not native execution evidence.

After native startup is authorized, run `AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`. A separate Node Host process owns the actual DesktopService/CoreBackend/RemoteControl and receives commands through Noise. The test ends and recreates the Host process after actual Core acceptance, then checks original receipts and Runtime file effects for T18–T22. Only fault boundaries and secure storage are fixtures; they do not replace native business results. The default is 100 race iterations; fewer iterations through `RC05_RACE_REPETITIONS` are diagnostic only. Output retains a manifest, source/binary identity, iteration count, and isolated service cleanup. An unexecuted run remains native-blocked; script availability or passing fixtures cannot establish acceptance.

The affected T21 admission check can run independently: `RC05_PREFLIGHT_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`. This mode skips the T18/T19/T20/T22 races. Its manifest reports selectedSuite as RC05_T21, coveredCases as T21 alone after success, requestedRepetitions/completedRaceIterations as 0, and both raceAcceptanceRequired and acceptanceRepetitionsMet as false. Preserve the previous successful 100-race evidence and combine it with the repaired T21 result without overwriting the original failed artifacts. The trusted fixture Profile control also updates the project's effective selection; T21 asserts and records flow/v1 in the actual native create parameters.

## RC-06 repeatable verification

Reuse `test:remote-command` and `test:remote-session`. Real file journals/Noise with fixture RPC cover strict targets, immutable semantics, interrupt capability, two devices, duplicates, durability/revocation races, Task rejection, finished A/current B, and unknown without native receipt queries or replay. Production DOM tests cover drafts, separate admission and settlement, absent/replaced targets, and terminal observations after lost replies without fabricated causal confirmation.

After native startup is authorized, run `RC06_STOP_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`. It reuses the Host/Core/Runtime/Noise harness. T23 defaults to 100 iterations: delay an admitted interrupt before native send, let actual A finish and B start, then release the original A request and verify B is unaffected. The T23 loop also checks two-device Stop and lost replies. T24 checks settlement after interrupting a real Runtime tool, Task-owned rejection, and offline saved receipts. Syntax checks and fixtures cannot replace this run; an unchanged startup blocker leaves native execution unrun. This invocation uses default Direct. Select Relay using the transport selector above; the Relay browser UNRUN boundary still applies. Neither invocation provides public-network or physical-device evidence.

`RC06_SETTLEMENT_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e` runs only T24 without repeating T23. It is mutually exclusive with other dedicated modes. The manifest reports selectedSuite RC06_T24, coveredCases containing only T24 once its business checks complete, requestedRepetitions/completedRaceIterations 0, and both raceAcceptanceRequired and acceptanceRepetitionsMet false. Retain the existing 100-race T23 evidence and dedicated T24 record separately for composite evaluation without overwriting original failed artifacts.

T24 reads the original Turn and tool as inProgress before Stop; the accepted Core atomic guard witnesses admission against that active original target. A separate read after the network receipt may observe either the original Turn still inProgress or already failed. The latter and the final settlement must retain UNKNOWN on the same original tool Item/runtimeEpoch/scopeId/operationId, tool status failed, success=false and no inspection acknowledgement. This does not guarantee network receipt delivery before physical cleanup. The gated scope.waitClosed Engine test expresses nonblocking native admission separately; replaying reduced Direct/Relay snapshots through the actual T24 assertions is source-only evidence, not execution of that Engine test or Native cleanup-order proof. Duplicate commands and receipt queries must not add native dispatches; the Runtime marker appends and must occur exactly once. Failed+UNKNOWN does not confirm tool or resource cleanup. The manifest retains resource uncertainty and service drain errors without automatic ACK. T21/T24 Task refusals use a fresh held ordinary Turn, wait for an actual queued Run on that Thread, and record Core atomic ownership, Task/Run, queue, configuration revision and the complete response before asserting. A future schedule alone is not evidence of Task ownership. Cleanup cancels and awaits queued Run/worker settlement before interrupting the held Turn. If cancellation or settlement is unconfirmed, keep the Turn held, record resource uncertainty and defer to outer service cleanup without releasing the queued Task.

## RC-07 reproducible checks

`pnpm --dir clients/gui run test:remote-interaction` uses production Gateway/SessionObservers, real disk journals and actual Noise/Direct, with deterministic Core RPC fixtures. It covers native interactionId versus independent operationId, sequential review proofs, partial/forged/stale pages, the 4 MiB read cap, denial without complete content, original Turn/digest/interaction binding, permanent-decision refusal, Core question sets and 4096/4097 UTF-8 boundaries, two devices, final revocation/service replacement, UNKNOWN after response/outcome loss and Host restart, delayed duplicate precedence, active Session preservation and read-queue budgets. After an unknown answer's original Turn settles, later Desktop configuration/send can proceed while the original unknown association remains; unknown create/send still blocks. `test:remote-session` drives production page buttons for pagination, incomplete-review allow disabling, Core forms, deep snapshots, original-command queries and independent observation.

After obtaining the native execution lease, run `RC07_INTERACTIONS_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`. T25 defaults to 100 deterministic races: hold original A's response before the actual Core call, settle A through another device's denial or Stop, start B, release the old decision and assert no Runtime file effect from A or B. T26 reviews exact 64 KiB original/effective arguments for complete paging, digest, wrong IDs, partial review and malicious permanent decisions, then denies them and verifies no Runtime effect. A separate 48 KiB multipage payload checks the single actual allow-once file effect, subsequent approval and lost-response UNKNOWN. Before and after each forged allowSession/allowProject decision, read `areal/permissions/read` for the original Thread and require its exact session and project grant sets to remain unchanged. The forced approval Profile prompts even when grants exist, so pending is not proof of grant absence. Repeating the same 64 KiB arguments and restrictions in the original Thread checks only the new Turn’s own interaction ID and fresh digest binding; deny that new interaction without effects and never reuse the old digest/token. The model argument limit differs from the encoded Runtime request-envelope limit; reviewing 64 KiB does not claim that size is executable. T27 checks actual Core questions, exact keys/options, UTF-8 limits, two-device single native answer and expiry.

`RC07_SETTLEMENT_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e` runs only T26/T27, skipping the existing T25 races. This mode is mutually exclusive with other dedicated modes. It reports selectedSuite RC07_T26_T27, requestedRepetitions/completedRaceIterations 0, raceAcceptanceRequired/acceptanceRepetitionsMet false, and only actually completed T26/T27 cases in coveredCases. Preserve the earlier 100 T25 races and original failed artifacts, and assess the dedicated results separately.

`RC07_RACE_REPETITIONS` below 100 is diagnostic only. Manifests separately record requestedRepetitions and completedRaceIterations; acceptanceRepetitionsMet is true only if the selected suite succeeds and at least 100 iterations actually complete. Startup failure or zero completed races cannot meet the threshold. This invocation uses default local Direct; Relay uses the transport selector above and retains the Relay browser UNRUN boundary. Public networking, phones, system keychain and packages need separate evidence. Syntax, fixture and DOM passes do not complete native T25–T27; preserve original failure artifacts and unrun status when blocked.

## Reproducible RC-08 checks

After obtaining the native execution lease, run `RC08_TASK_QUESTIONS_ONLY=1 AREAL_REMOTE_NATIVE_ALLOWED=1 AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:remote-command-e2e`. It reuses the existing Host/Core/Runtime/Noise pipeline. T28 checks actual Runtime effects and running state while a native question is pending, then replies to the same Run and verifies continuation. It covers paused replies without resume, original-ID and cross-project splices, expired/cancelled/terminal/answered targets and two-device contention. T29 restarts the Host after saving a known receipt, then separately drops the native response, fails outcome persistence and ends the Host process after actual Core acceptance. It requires UNKNOWN plus independent observation, no replay, one original Channel reply and one actual Runtime continuation effect. Failed pending persistence must prevent dispatch.

This mode is mutually exclusive with other dedicated modes and reports selectedSuite RC08_T28_T29, requestedRepetitions/completedRaceIterations 0 and raceAcceptanceRequired/acceptanceRepetitionsMet false. coveredCases includes only actually completed T28/T29 checks, without changing RC05–RC07's 100-race entries. Preserve original failures, source/binary identity and cleanup results. Source, syntax, fixture and DOM passes do not substitute for native execution; Relay, public networks, physical phones, system keychain and packages require independent evidence.

## Reproducible RC-10 checks

`pnpm --dir clients/gui run test:remote-review` covers production historical review/SessionObservers, actual Noise/Direct/CoreClient and native HTTP boundary fixtures, and production Remote DOM. It checks failed Turn partial output and independent TaskRun status, path-keyed hunks with reordered metadata, unsupported history, UTF-8 pages, exact Turn/Item media membership, same-blob cross-Turn/connection rejection, per-chunk revocation, service changes, vanished resources, stream cancellation, signature/dimension/pixel limits, and no URL resurrection after close or asynchronous decoding. The native boundary fixture does not launch Core/Runtime, and the DOM fixture does not establish actual browser decoding. Read-only observation does not take over production Desktop CoreClient callbacks.

Source contracts exercise native-shaped argument records through both shared `reviewTurnFiles` and Remote `review.read`: creation and complete read→overwrite→patch chains without an effective override, effective override precedence, rejection of present invalid overrides without fallback, missing/raw arguments, path/size/hash mismatches, missing before versions and UNKNOWN/failed records. Different current workspace text cannot replace original versions or cause a file write; existing NUL binary rejection remains covered. These fixtures preserve the native T32 available assertion and do not establish a native rerun or CPU/memory isolation for history reads/reconstruction.

Actual Noise ready and host.describe check capability intersections for Operator, Observer and legacy grants without pauseTask. Those actual responses plus native-boundary Task reads drive the production page: only Operator reaches the pause button after explicit review. This covers the RC-09 UI blocker caused by omitted pauseTask advertisement without changing device presets or authorization ownership.

After an exclusive native lease and review of the frozen source, run `AREAL_REMOTE_NATIVE_ALLOWED=1 RC10_REVIEW_ONLY=1 AREAL_CORE_BIN=/absolute/reviewed/areal pnpm --dir clients/gui run test:remote-command-e2e`. This mode is exclusive with RC05–RC09 modes, selects RC10_T32_T33_T34 and runs no race loop. T32 performs actual Runtime file writes, changes the current workspace while retaining the historical diff, and induces provider failure with partial output. T33 persists native AgentMedia from Responses image events, reads trusted blob HTTP and checks cross-device/project/reference rejection and identical bytes in distinct Turns. T34 rejects HTML bytes and excessive PNG dimensions in native records. The manifest records only completed cases, source/binary identity and cleanup. The entry then launches actual Chromium: the production Remote page pairs through an invitation and Noise, with Observer approval through a trusted RemoteControl fixture. It checks original historical diff, failed partial output, real raster decoding and A→B→A selection, retaining screenshots, page errors, static-manifest identity and browser close results. Safe storage and desktop confirmation remain fixtures, not Electron/system-keychain acceptance. Failed-load retry remains covered only by the source DOM fixture. Source fixtures for stream cancellation, vanished resources and oversized metadata do not count as native cases.

The result review container preserves original text and line breaks for output, errors and diffs, wraps long lines, and gives each `pre` a finite height with independent scrolling. Before every full-page screenshot, RC10 reads public DOM document width, computed text-block styles and scroll dimensions. It asserts viewport-bounded document width, wrapped text and finite block height, then compares each block’s character count, UTF-8 byte count and SHA-256 with the native review result; layout evidence records no body text. A failed layout check prevents the failure-page screenshot from allocating a giant bitmap. The source oracle verifies rejection of excessive width, missing container, unwrapped text, unlimited height and changed body text; it does not replace actual browser geometry and scrolling acceptance.

Source checks establish these call/state paths, not actual Host/Core/Runtime, browser or phone T32–T34 evidence. Native acceptance must separately record existing whole-blob Core HTTP allocation and the cost of reading the full blob again for each Remote chunk. No API/body/artifact cache or file-write authority is added.

## RC-11 repeatable checks

After building GUI, run `pnpm --dir clients/gui run test:remote-network`. It combines existing adapter CLI protocol checks, Host integration tests using a real local Direct listener, and source rendering of the production React Settings component. Every executable CLI is a fixture in an exclusive temporary directory. The suite never invokes real Tailscale or changes accounts, VPN, organization configuration or public networking.

Host tests enter the existing trusted `remoteControl` boundary and cover sanitized proposals/confirmation, renderer target/executable injection rejection, only the actual Remote port being mapped, stale proposals and vanished listeners, pending/final persistence failures, fixed-port restart/collision, owned/pending recovery without replay, mapping drift, durable disable before closing and awaited exact-ownership cleanup afterward. The CLI smoke also covers missing/old versions, login/HTTPS states, unknown schemas, timeout/output limits and foreign-configuration preservation. System secure storage is a fixture boundary, not real-keychain evidence.

A local HTTPS proxy preserves Host/Origin and verifies exact same-origin WSS, real Noise pairing and reading one authorized project, while rejecting Core/management paths and management methods. TLS uses the public test certificate in `tests/fixtures/proxy`, passing a CA only to the individual Node request. Missing trust and wrong hostname must fail. Certificate validation remains enabled and system trust is unchanged. Mixed HTTP/WS tuples and forged forwarded headers are rejected; origin changes cancel invitations and disconnect sockets.

These are source and local-protocol checks. React source rendering does not establish real clicks, browser CSP/TLS behavior or visual usability. Local TLS/Noise does not establish real Tailscale CLI, tailnet/organization ACL, iOS/Android, QR scanning, phone network changes, Electron/keychain, installed packages or public deployment. T35's real-phone/network gate remains independent and cannot be marked fully complete from fixture passes.

The existing `test:remote-pairing-e2e` also uses the production Electron settings → private DesktopService → RemoteControl path for inspection, a bound proposal, explicit consent, apply and disable/removal, then restores the local listener before the original pairing/migration checks. Only the test Node Host's existing constructor receives an isolated fake CLI, checking no configuration mutation before consent and the exact target/port applied and removed. No executable configuration is added to production Main or system PATH. The same wizard checks that neither scope consent alone nor public consent alone invokes the CLI; both are required for the fake Funnel mapping, and restoring private scope requires fresh consent before disable/removal. This does not certify public-network T44. The manifest's `networkWizard` separately records this layer and whether it actually executed. Script availability is not click acceptance; this fixture does not certify real Tailscale, organization ACLs, system keychain or phone connectivity.

## V1. Primary seam

Start at the real Web/PWA public Remote contract, through the existing DesktopService into isolated Core/Runtime and a deterministic local model. Generate fixed tool calls, synchronous approvals, async questions and settlement sequences without paid models. Record uniquely identified effects in an isolated workspace and count actual executions, not just RPC invocations.

Reuse existing connection/architecture smoke isolation. Fault-injection networking may be mocked; authorization, admission, journals, decisions and recovery under test must be real. Run the same conformance suite with Direct and Relay transport parameters.

On macOS, running `pnpm --dir clients/gui run test:architecture` requires an interactive, unlocked desktop and exclusive window focus. The test binds the displayed page to its project/thread owner through the production preview `show` path, then requires a visible, non-minimized, focused window before the first navigation. Preserve these guards; mocked focus does not establish Native evidence. The synthetic dialog fixture does not certify real human consent. When desktop conditions are unavailable, retain actual FAIL and executed scope for an attempted run whose guard times out; acceptance not attempted remains UNRUN. Wait for desktop conditions to change before running again.

## V2. Coverage matrix

Auto is automated; hybrid also needs real OS/network evidence; manual requires real devices/public connectivity. Every case starts as not executed.

| ID | Action/fault | Required observation | Type |
|---|---|---|---|
| T01 | Authenticated real Host/project observation | Readable authorized data; no Core credentials in responses/assets | auto |
| T02 | Replace the Host Noise identity | Pin failure before any invite secret is sent | auto |
| T03 | Unsupported version, legacy write, unknown fields/methods | Structured rejection without downgrade | auto |
| T04 | Probe privileged Core/desktop routes through remote ingress | No privileged route; invalid Origin rejected | auto |
| T05 | Expired or cancelled invitation | Host rejection with explicit re-pairing path | auto |
| T06 | Two devices claim one invitation | One claim, still requiring local confirmation | auto |
| T07 | Narrow/revoke grant during subscriptions/reads/streams | Future output/admission denied; no captured stale grant | auto |
| T08 | Fail grant/revocation persistence | No false success or unsaved authority | auto |
| T09 | Migrate legacy config and fail midway | Identity/projects preserved, review required, public ingress stays disabled on failure | auto |
| T10 | Unopened Threads running/awaiting approval/failed | Overview independent of GUI tab history | auto |
| T11 | Task asks asynchronously while workers continue | Running and attention coexist; no duplicate coordinator card | auto |
| T12 | Many items and oversized records | Bounded pages/cursors and honest partial counts | auto |
| T13 | Generate deltas during snapshot capture | No lost or duplicated snapshot-boundary content | auto |
| T14 | Deliver old events after reconnection | Old generation cannot mutate current projection | auto |
| T15 | Sequence gap and slow-consumer backlog | Isolated resync/disconnect without blocking Core/peers | auto |
| T16 | Restart Core during an operation | Preserve UNKNOWN without replay or acknowledgement | auto |
| T17 | Close remote detail/page during desktop tools | Tool hosting and accepted work continue | auto |
| T18 | Duplicate create, lost reply, Host restart after acceptance | One Thread with recoverable original identifier | auto |
| T19 | Duplicate send and same UUID from different devices | At-most-once intent dispatch with isolated namespaces | auto |
| T20 | Reuse key with changed text/target/answers | Conflict without changing the original meaning | auto |
| T21 | Busy, Task-owned, unknown, stale config, Workflow Profile or offline project | Explicit rejection, retained draft, no enqueue/start/privilege change | auto |
| T22 | Failures before journal, after Core admission and before reply | Persist-before-dispatch and read-only unknown recovery | auto |
| T23 | Stop A arrives after A ended and B started | B unaffected; target-change result | auto |
| T24 | Nonblocking native interrupt admission; competing devices | Active original target at atomic admission; independent terminal observation, no network receipt-before-cleanup guarantee or fabricated causal receipt | auto |
| T25 | Change arguments/Turn/digest after review | Reject stale approval and require renewed review | auto |
| T26 | Forge remembered permission or approve unread large arguments | No remembered grant; incomplete review cannot allow | auto |
| T27 | Expired/competing synchronous answer and UTF-8 overflow | Single native decision with strict question/byte checks | auto |
| T28 | Cross-project, expired or terminal Task question reply | Reject using Channel semantics; no chat injection | auto |
| T29 | Lost Task reply acknowledgement without native receipt lookup | Stored receipt or observed state only; no guessed causality | auto |
| T30 | Run changes between Gateway check and Core pause | Atomic Run/revision guard rejects stale pause | auto |
| T31 | Coordinator ends before workers settle during pause | No early settlement claim; future scheduling paused | auto |
| T32 | Partial failed output, concurrent diff, reordered file metadata | Honest outcome/provenance and path-keyed patches | auto |
| T33 | Guess blobs/paths, cross-Thread artifacts, fetch after revocation | Per-chunk authorization rejects foreign/stale references | auto |
| T34 | Malicious HTML/SVG/links and large images/diffs | No active execution/automatic exfiltration; budgets enforced | auto |
| T35 | Real Serve/organization HTTPS, network/certificate failure | Correct diagnostics, no public fallback, reversible durable mapping | hybrid |
| T36 | Forge Relay room/channel/Host slot and duplicate connections | Per-frame ownership with safe legitimate reconnect | auto |
| T37 | Relay restart/offline Host and network recovery | No execution queue; identity and baseline restored | auto |
| T38 | Unauthenticated floods, oversized frames, slow peers and logs | Bounded resources and no payload/token/cross-room leak | auto |
| T39 | Remembered/guest identity, clear storage and shell update | Correct identity lifecycle, no sensitive cache/draft replay | hybrid |
| T40 | GUI exit with remote activity, then OS sleep | Background continues; sleep means honest unavailability | hybrid |
| T41 | Real iOS/Android QR, IME, suspension and network switching | Usable UI and recoverable state without duplicate effects | manual |
| T42 | Clean public-source Direct/Relay deployment | No private service, vendor account or copied Core token | hybrid |
| T43 | Restore stale registration backup and protocol rollback | Restored Hosts disabled pending re-enrollment; no weaker authentication | hybrid |
| T44 | Optional Funnel enablement/pairing/removal/private restoration | Explicit consent, Remote-only exposure, no TLS bypass | manual |

## V3. Evidence and quantitative checks

Record transport, Host/Core/Client versions, command, isolated configuration, execution evidence and assertions without publishing sensitive payloads. UNKNOWN-effect tests verify no repeated effect. Repeat deterministic races T18/T19/T22/T23/T25/T30 at least 100 times per transport with zero duplicate effects, wrong targets or authorization failures; this is not a production reliability estimate.

Stall one consumer to its backlog budget while another observes and performs a legal action. Record page/frame/buffer high-water marks in bytes, not characters. Model/network waiting is not a stopped-agent outcome.

Existing commands are documented in the [development guide](README.en.md) and [GUI guide](../../clients/gui/README.en.md). Implementation tickets must add and register Remote-specific conformance/security commands. Distinguish nonexistent commands, unmet environment prerequisites, not-run, failure and pass in reports.

## V4. Release gate

Private Direct and Relay are required; optional Funnel requires T44 when enabled. Both required routes need automated conformance, actual macOS background/keychain evidence, iOS Safari and Android Chrome, and real HTTPS/WSS pairing. Mock networking or viewport screenshots do not certify mobile behavior.

Block release on duplicate effects, cross-project/device/room leaks, stale approvals accepted, old Stop cancelling a new Turn, incorrect Run pause, client/log Core credential leaks, ineffective revocation, UNKNOWN replay or reachable privileged local APIs.

A maintainer explicitly approves release. Untested platforms may receive controlled test builds but cannot be advertised as certified public write-control support. Document online-Host, trusted Web-origin, no-push/wake/mobile-ADE and idle-only send limitations.

`pnpm --dir clients/gui run test:remote-task-pause` exercises production Gateway, Task observation and real temporary journals: current Run/revision, missing guard, durable known receipts, original-command dedup, queued new Run, revocation and UNKNOWN versus independent worker observation. `test:remote-browser` checks original Run review, explicit confirmation and negative controls; harness model checks start no native processes.

Within an exclusive native window run `AREAL_REMOTE_NATIVE_ALLOWED=1 RC09_TASK_PAUSE_ONLY=1 RC09_RACE_REPETITIONS=100 AREAL_CORE_BIN=/absolute/reviewed/areal pnpm --dir clients/gui run test:remote-command-e2e`. T30 requires 100 actual races in which the original Run completed and a next Run appears while the Gateway pause request is held. T31 requires a real Runtime worker, completed coordinator Turn, worker cleanup after pause and future scheduling suppression. The manifest separates requestedRepetitions/completedRaceIterations; only 100 completed iterations satisfy race acceptance. Source fixtures, model tests and short diagnostic runs cannot substitute for this evidence.
