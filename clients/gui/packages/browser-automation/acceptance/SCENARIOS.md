# Browser integration acceptance

Written before implementation on 2026-10-23. Run real Electron WebContentsView targets in temporary profiles and local HTTP fixtures. The test driver calls Preview prepare and execute with immutable approval plans. Root acceptance separately exercises the Core model tool and packaged app.

## Data and authority

The command is the imported strict BrowserCommand union. A prepared command binds the exact parameters, owner, original Page, targeted Page identities, document, control epoch and viewport. Existing Preview owns every Page, debugger connection and held input. Imported execution receives a fenced ControlledView. Recording owns an immutable approved action program and a cancellable lease.

## Scenarios and failure modes

1. Snapshot and locator tests read fixture DOM truth and operate role, text, label, CSS and cross-origin frame selectors. Fill Unicode, click, check, select, press, drag and scroll must change fixture state.
2. Coordinate commands must work on a permitted public-origin fixture. A sensitive form target and an unapproved command must dispatch zero input. Wrong owner, changed parameters, stale document, reused plan and human takeover must fail before dispatch.
3. Viewport, clip, full-page and element captures must have actual pixels and expected dimensions. Hidden-born and background Pages must capture without activating or focusing a window. Assert focus and selected Page before and after. Run the actual compositor prototype before choosing capture behavior.
4. Dialog information and accept/dismiss must match alert, confirm and prompt state. Download wait returns a real completed bounded file, not a path before completion. File chooser and upload return explicit unsupported responses.
5. New, activate, claim, list, finalize, handoff, deliverable and close operations must preserve same-workspace identity and control boundaries. Closing must terminate owned recording and release held input.
6. Recording must produce a nonempty playable WebM with actual fixture changes from the approved program. Status and cancellation are real job state. Takeover during drag or recording must stop subsequent input, release keys/buttons and report unknown after dispatch.
7. networkidle, file chooser and upload stay explicitly unsupported upstream capabilities. Missing selector, download timeout, renderer crash and cancellation return truthful failures.
8. Build and import the CommonJS package with runtime Playwright injected assets present. The package-local test does not establish Core, installed-package, real-provider or OS physical-input acceptance.

## Throughput checkpoint

Copy and compile the upstream executor, schemas and recorder first. Add the Page adapter and manager commands second. Run the real Electron fixture and repair observed failures third. Commit only the package and Preview changes after inspecting the diff.

## Shared persistent Profile follow-up

Added before implementation. Use one isolated `userData` in two independent Electron processes. Two different Preview hosts and projects must share synthetic HTTPOnly Cookie, localStorage and IndexedDB; closing either host and then restarting must retain them. DefaultSession and a second persistent partition must remain empty. A single download listener must route each source once. Unknown WebContents and product control endpoints must stay denied. Cache clearing must close Pages and preserve login data; all clearing must remove it. While a trusted synthetic importer is pending, a second data operation, new Page, claim and old approved command must fail, and a late development approval must not revive a Page. Importer helpers register only during the gate and never permit permissions, popups or downloads. No personal Chrome storage or credentials are read.

- Locator `downloadMedia` must trigger a real download with the upstream executor and return the exact fixture bytes. It must consume a mutating approval rather than a read permit; a dispatched failure remains UNKNOWN.
