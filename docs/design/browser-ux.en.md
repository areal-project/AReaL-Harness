[中文](browser-ux.md) | **English**

# Shared Browser interaction specification

Current source interaction and remaining design constraints, bounded by the [spec](browser.en.md) and [contract](../api/browser.en.md). Reuse existing components, Composer, ApprovalRequest, resource and diff surfaces. Unified native and package acceptance of the natural browsing flow remains pending; design parameters and future acceptance requirements are not verified capabilities.

## 1. Structure

Use the existing right workspace with split/expanded viewing while retaining chat and Thread identity. The default toolbar keeps back/forward, reload/stop, address, Page tabs and independent annotations. Diagnostics, viewport and control details live under More. No Browser tool switch or human/Agent mode button is required. Background Thread activity must not steal focus, switch chat or open another panel.

Operation activity and results appear in chat and expandable details, showing target, progress and errors without raw CDP traffic or internal state in ordinary browsing. Verification cards link checks, evidence and code changes; a historical card is not a live interactive page.

## 2. Control states

| State | Presentation and behavior |
|---|---|
| human | Direct browsing and independent comments; details explain paused Agent observation; next explicit message/continuation requires Core approval to resume |
| agent | Chat/details show operation progress; direct page input intervenes after Main establishes the fence |
| transferring | Handoff progress with possible in-flight uncertainty; local takeover always works; no new agent input |
| waiting approval | Existing Core approval card showing actual site/action; clicking Allow is not local execution permission |
| unavailable | Specific host/page failure and restoration impact; no fake live preview |
| unknown | “Outcome unconfirmed; will not retry automatically”; inspect page/receipt and acknowledge without rewriting history |

Physical page input immediately establishes Main’s control fence, revokes the old Agent epoch and pauses actions and reads. After dispatched synthetic input settles and held keys are released, the first human event reaches the same Page. No takeover-button prerequisite exists. If input cannot converge, remain transferring and offer stop/closure without competing writers or waiting for Core approval. Ambiguous dispatched results remain UNKNOWN and are never retried automatically.

Stop loading, take over Browser, interrupt Turn and stop service are distinct controls. Browser takeover does not stop unrelated development servers.

## 3. Journeys

**A. Inspect the existing page.** With unsent state on a Page, the user explicitly asks in chat to inspect it or perform an ordinary search. New chats discover the fixed bundle; older chats append it on an explicit send while idle. The first Core-approved `describe` binds the same Page, lazily allocating a blank Page only if none exists. Subsequent reads and actions require Page/epoch-scoped approval. No tool switch or Page-claim button is needed. E2E compares native identity and a sentinel, not only URL; `thread/resume` cannot steal a host or rewrite history.

**B. Manual login then resume.** Keep the Page open when login, permissions or sensitive submissions need a person. Direct human input makes Main fence and drain old input, pausing automatic reads and diagnostics. After manual work, the next explicit chat instruction or continuation passes Core approval for a new epoch and fresh observation. No restart-persistent login is promised. Visibility changes and timers grant no control or automatic upload of human-period content.

When a conversation contains an uninspected tool UNKNOWN, Composer shows recovery beside the input. Sending opens inspection before submitting a message that Core would reject. Browser inspection asks the user to check the current page and operation result, including the visible state after login; technical parameters and original errors are collapsed by default. Cancellation, disconnection and inspection failure preserve the draft. Explicit sending resumes only after Core records the inspection. Historical UNKNOWN remains unchanged and the operation is not replayed. The main conversation presents an actionable inspection state, with original diagnostics still available on expansion.

**C. Region annotation.** Annotation and sending context do not require Agent tool activation or a Page claim. Take human control, capture a provenance-bearing page view, hide the native surface and annotate the frozen image. Label it as a capture whose live page may still change. The draft contains region/comment/thumbnail/URL/time and remains bound to its original Thread. Only explicit send submits; cancel restores the page without navigation. Region dragging uses the frozen image; element picking uses the visible native page's CDP Overlay inspect mode. Both use the same guarded capture and original-Thread draft path. Native B-29/B-30 acceptance remains pending.

Current source path: the user-initiated `captureRegion` preview command waits for native input convergence and captures only a visible human-controlled Page. The native Page remains pinned while its frozen editor is open, including across chat switches; cancel releases the pin and restores that Page without navigation. Selection maps rendered image coordinates to captured bitmap pixels. “Add to chat draft” appends the comment, Page/document/viewport/bitmap provenance, clip coordinates and cropped PNG to the original Thread's Composer draft; the user sends explicitly from Composer. Only the selected crop is uploaded through the existing Thread-scoped Core Blob/MediaRef path during explicit Composer send; the full capture stays local. Core history owns the annotation only after message admission. A pending or in-flight submission blocks staging another annotation until its outcome is inspected. The frozen editor remains in memory across chat switches; Composer text uses its existing local draft storage, while the image attachment follows the existing in-memory attachment lifetime.

**D. Element annotation.** Current source path: on a visible human-controlled native Page, the user starts “Select element and annotate.” Controller exclusively enables DOM/Overlay inspect mode on that Page, receives the native node hit, disables the overlay, then takes the existing privacy-guarded region capture. It reads actual AX role/name, bounds, Frame/document and control identity on that same Page and crops the frozen image. Cancellation, timeout, or a change in page/chat identity discards late results. The returned `human:` Ref is historical evidence and never enters the Agent action Ref cache; the Agent must freshly `observe`. Before staging, a check compares node identity, semantics, bounds and viewport; a change preserves the original image/text and marks it `stale`. The comment, crop and provenance enter only the original Thread's Composer draft. Explicit send uses the existing Core Blob/MediaRef upload and message admission. No privileged page bridge or raw model CDP exists. React source location remains unknown without an actual project-provided, attributed mapping.

Missing semantics, Canvas internals, and unresolvable iframe/Shadow content provide a reason and fall back to region feedback, never a guessed selector. If the existing privacy guard cannot read a cross-origin Frame, it refuses the image; the UI cannot claim a region crop in that case. Real native B-29/B-30 selection, stale, and fallback acceptance remains pending M2.

**E. Edit and verify.** Runtime starts/reuses the project service and supplies its observed endpoint. Inspect baseline, receive comments, edit source, wait for observed update conditions, then capture and check behavior/appearance. Link call, code change and evidence. Show behavioral checks, visual judgments and user acceptance separately; build success is not visual acceptance.

**F. Temporary style experiment.** Human-only constrained text/color/font/spacing/size edits with undo/redo, always labeled “Page preview; source unchanged”. Track old values and document identity; remove only overlays owned by the experiment. Navigation/HMR replacing the target invalidates it rather than overwriting new app state. Send intent and before/after evidence for a subsequent source edit. Clear temporary overlays before final verification, so an unchanged source cannot appear fixed.

The current source path starts with “Select element and preview style” on the visible native page and reuses human Overlay selection and a guarded before image. Its form retains the original chat owner and offers constrained values, undo/redo, Escape cancel, and Ctrl/Cmd+Enter draft staging; IME composition suppresses shortcuts. Before and after evidence crops only the rechecked same element; full images remain local. The trial is cleared before staging, and the verification card warns that an active trial cannot prove a source change. A replaced or application-edited target requires reload to remove uncertain remaining effects. Failed Composer send retains the existing draft and does not retry automatically.


Keyboard activation of “Select element and preview style” opens a local frozen-image coordinate picker: enter bitmap x/y coordinates, adjust with arrow keys, confirm with Enter, or cancel with Escape. Main reuses capture identity, document and viewport checks and element privacy restrictions; pointer activation retains native Overlay inspection. F6 returns focus from the current foreground human page to the app. Selection focuses the style property, cancellation returns to the initiating button, and staging focuses the original Composer for explicit send. This path does not establish manual IME or assistive-technology acceptance.

## 4. Native-view constraints

React z-index is not a WebContentsView overlay implementation. A trusted native overlay/local view must handle resizing, focus, IME, occlusion and display scale without granting remote pages a privileged preload. On physical input, Main revokes Agent admission and drains old input before preserving the first human event. A React shield must not make a takeover button a prerequisite for browsing. Capture web content without agent cursor/labels/toolbars by default.

Do not fabricate screenshots while minimized, hidden, zero-sized or unsupported. Request a visible page when needed rather than present an old capture as new evidence. Remote video infrastructure is not required initially.

Explicit DevTools opening pauses automation. Detach marks the driver unavailable. Closing reattaches with fresh generations/observation; old prepared actions expire. Never rely on incidental multiple-debugger behavior.

## 5. Responsive input and accessibility

Store page CSS viewport separately from GUI display zoom. An initial1280×720 viewport and configurable320–3840×320–2160 range are policy values, not browser guarantees. Record bitmap and CSS sizes. Test center/edge/scrolled/iframe/Canvas coordinates at1×/2× display scale and multiple page zoom values.

Genuine keyboard input can directly trigger human intervention; Main fences and drains before delivering the first event, without a manual mode switch. IME confirmation Enter must not submit a comment or chat. Clear synthetic keys without disrupting human composition. Keyboard navigation reaches approvals, address, tabs, More and comment actions, and restores focus to the initiating control. Use text labels and accessible state announcements, not color alone.

## 6. Files and permissions

Attribute popups to opener, Thread and transient context before accepting; no unowned windows. Ordinary cross-origin login redirects retain Chromium networking and control-endpoint protection without per-Origin prompts; Agent reads/actions remain separately permissioned. Deny camera/microphone/location by default initially and hand the flow to a person.

Show download origin, name, size-or-unknown and state; save only after user confirmation and never execute. Uploads use a trusted user chooser, not model-specified host paths. Cancellation is a normal outcome. Files selected during human control are not automatically read by the agent.

Current source path: the visible current human Page offers “Allow next download,” which permits one site-triggered item within 30 seconds. Electron's native Save dialog lets the user choose the destination; cancellation saves no file. Status shows the Page provenance, initiating origin (explicitly unknown when unavailable), filename, size or unknown, and completion/cancellation/interruption, with cancellation for active items. Files never open automatically, and a dispatched network request is never retried on cancellation. Uploads use the site's file control and the system chooser during human control; cancellation leaves the human Page usable. The next explicit message or continuation, after Core approval, lets the Agent freshly observe only visible site results, without receiving the chosen host path or file bytes. Native B-39/B-40 acceptance remains for M2.

## 7. Acceptance evidence

Capture real evidence for same-page action, takeover/resume, region/element comments, source verification after clearing style overlays, and unavailable/error states. Distinguish unverified/passed/failed/unknown rather than one generic success badge. See the [test matrix](../development/browser-testing.en.md).

The following is the original handoff concept diagram; the direct-input flow above supersedes its button prerequisite.

![Human handoff concept](diagrams/browser-takeover.svg)

[Editable takeover diagram](diagrams/browser-takeover.drawio)
