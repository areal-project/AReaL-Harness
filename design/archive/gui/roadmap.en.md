# From the Codex reference to real Electron journeys

[中文](roadmap.md). This page owns the coverage roadmap and acceptance order. It does not replace the [structured B workflow](../../../clients/gui/design-system/structured-flow.md) or component rules. E1 has now passed its selected real Electron journey. E2 has passed selected continuous slices; E3 has a bounded window/focus/native-composition and new-content slice; candidate overlays and the remaining host matrix are still pending; passing a phase does not automatically promote Base.

## Target and present evidence

The target is to make selected AReaL desktop journeys match the observed Codex reference in information hierarchy, feedback, reading continuity, and desktop interaction. Prove each journey separately; this does not promise product feature parity or parity on every platform.

The B workflow supplies video nominations → frame/event verification → difference decisions → implementation in existing owners → replay → rule updates. Electron acceptance must use the actual application. Expanding browser fixtures cannot substitute for that step.

| Area | Evidence available | Conclusion still unsupported |
| --- | --- | --- |
| Settings and decisions | Shared components, representative previews and exercises; P-SETTINGS / P-DECISION admitted to Base | Every settings page migrated, unseen tasks reuse the system, or all desktop states pass |
| Conversation flow | Production components in a stepped projection exercise; B reports cover commands, independent parent/child states, images, reading anchors and convergence | The browser fixture does not connect to Core. E1 separately covers actual commands/children, paused UNKNOWN inspection and GUI history recovery; full P-CONVERSATION remains unadmitted |
| Motion | Smoke assertions cover streaming append, sampled waiting-animation phases, completed Markdown and reduced motion | Continuous pacing, interruption/reentry, Electron frame presentation, or same-state Codex motion fidelity |
| Electron host | An isolated Electron/Core validation entry point already exists | E1/E3 cover selected journeys and window/focus/composition slices; E4 additionally covers same-app window reactivation and one native web preview; candidate overlays, cross-app/display switching, native file views and packages remain open |
| Agent constraints | Catalog/rule references, selected CSS and generated consistency checks | Every JSX composition complies, visuals are correct, or every agent automatically follows B |

Settings primarily combine stable controls. Conversation adds asynchronous arrivals, independent parent/child lifecycles, growing content, manual disclosure and reading position. Electron adds windows, IME, shortcuts and native views. Fix events, reader actions and host state together; more final screenshots alone cannot close these gaps.

## Sequence and acceptance

### E1: A complete conversation slice in real Electron

Status: the selected macOS dark-theme journey passed, including actual commands/children, image zoom/return, reading/convergence, paused UNKNOWN inspection and GUI reopen. See the [Electron scenario](exercises/conversation-flow.md#真实-electron-专项-e1) for the entry point, evidence and limits. UNKNOWN remains preserved; this does not establish a confirmed terminal outcome for every stop.

Reuse [migration-smoke](../../../clients/gui/scripts/migration-smoke.mjs) for isolated home/workspace, actual Core, and source/binary identity. Its existence does not mean this design worktree passed E1. Inspect its actual coverage, then add only this journey's missing assertions and evidence.

Fix one main journey: send → command execution with successive output → parallel child agent → open/zoom/close image → read history while output grows → return to latest and continue following → independent parent/child completion → convergence with revisitable details. Use separate short variants for stop and one recovery/failure path; do not splice mutually exclusive outcomes into one successful recording.

- Use the existing React → narrow IPC → Core/Runtime authority chain. A deterministic local model controls event ordering. Claim real command/child execution only with execution identity and result evidence. Identify model, tool, picker and other stubs separately; they do not establish live-provider or native-path acceptance.
- Bind runtime events, reader actions, reading anchors and video to one run. Reach states through observable conditions. Fixture intervals do not establish real latency or Codex pacing.
- Bind final evidence to source, dirty diff, build/Core identity and isolation. Check stable parent/child identity, uninterrupted history reading, resource-close return to the original position/focus, and independently readable final answer/process. Failures and skips are not passes.
- Fix only verified same-state differences through Messages, TurnProgress, CommandDetails, AgentConversationPane, MessageAttachment and existing reading/execution owners. Do not build another presentation system or business state machine.

### E2: Continuous motion around the accepted journey

Current status: the selected macOS dark-mode continuous slices passed. Fixes cover hidden outer scrolling, abrupt disclosure height changes and a sidebar waiting spinner that ignored reduced motion. See the [E2 scenario](exercises/conversation-flow.md#真实-electron-连续动效专项-e2) for evidence limits and retained differences. This does not close full motion fidelity or E3.


Select short segments that affect comprehension: streaming/waiting, tool disclosure, child-pane entry/exit, image return, return to latest and completion convergence. Retain the existing smoke checks and add continuous Electron evidence; sampled animation phases alone are insufficient.

- Record before, during and after each trigger, plus repeated triggers, reversal/interruption and reduced motion. Focus and reading position are acceptance conditions too.
- Keep animations enabled and record from before the trigger until settled. For reference and implementation, record frame timestamps, effective sampling, dropped frames/gaps and clock-alignment uncertainty. Where available, use animation/performance observations to distinguish recording loss, model arrival cadence and UI transitions.
- Video models nominate segments/events. B's analysis self-reported about 1 fps, which can miss an entire 100–240 ms transition. It cannot judge duration, easing or smoothness; inspect original recordings, dense frames and verifiable timing evidence.
- Current CSS values of 100/160/240 ms are product values, not measured Codex rules. Establish the motion's purpose and visible issue before changing them. Do not copy fixture playback intervals of 1400/3200 ms.

### E3: Desktop host, regression and admission

The selected macOS dark slice is complete: three actual content sizes and125% zoom, child/settings focus return, multiline drafts, native Doubao Pinyin composition/edit Escape, and a new library-content journey. See [E3](exercises/conversation-flow.md#真实-electron-宿主与新内容专项-e3). E4 additionally verifies same-app native window reactivation and one native web preview interaction/return, fixing lost composer focus on panel close; see [E4](exercises/conversation-flow.md#原生宿主补充-e4). The operator confirmed only entered text, so the candidate overlay was not triggered and remains unverified. Cross-app/display switching, native file views, the full condition matrix and packages remain open. Base is not promoted.

Within the same conversation, verify relevant window resizing, pane toggles/focus return, Chinese IME/shortcut boundaries, reading retention after window switching, and native file/browser previews actually used by the journey. Capture native views independently; injected pickers and renderer screenshots do not prove native paths.

Fix representative conditions for the accepted slice: light/dark, wide/narrow, font size, keyboard and reduced motion. Use one unseen-content journey to check the same Base/compositions transfer. Update rules, surfaces and catalog under [governance admission](../../../clients/gui/design-system/governance.md), then decide whether Base or the visual baseline can expand. Packages and other operating systems require separate acceptance.

## Delivery and stopping

Close only evidenced issues in each phase: matched reference/implementation states, accepted/rejected reasons, existing-owner changes, final-run evidence and remaining gaps. Extend existing runners/manifests only where needed; do not create a general capture platform.

Complete E1 before addressing its confirmed gaps in E2, then execute E3. Record no change when no difference is established. Stop after bounded acceptance rather than pursuing unlimited “looks like Codex” work. This plan does not resume the paused heartbeat or launch reference instances; preserve the resident reference application and CDP session. Continue through the existing Goal backlog when executing these phases.
