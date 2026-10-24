# Browser automation

This package connects implemented ZCode IAB commands at revision `3c5b227649371507ddc4eb46ac5133afe6db1cab` to AReaL Core approval and the existing Preview. The source is [zai-org/ZCode](https://github.com/zai-org/ZCode). [中文](README.md).

`src/upstream/browser` retains the executor's complete 16-file dependency closure, the WebM recorder and transparent-window screenshot bootstrap. `src/upstream/schema` retains the strict runtime schemas. `recordingScenario.ts` extracts BrowserGuestManager's recording action algorithms. `UPSTREAM.json` records original SHA-256 hashes, source paths and adaptations. See `LICENSE-ZCODE` for Apache-2.0 and `NOTICE` for attribution.

## Interface

The Core tool accepts `{operation:"command",parameters:{pageId,command}}`. A locator click is `{method:"playwright",action:{name:"locator",selector:"#continue",operation:"click"}}`. `describeBrowserCommands()` returns the full JSON schema, actual method manifest, limitations and a valid example. `validateBrowserCommand()` parses the upstream schema and bounds ordinary waits to 30 seconds and download waits to 120 seconds.

The default CommonJS entry is independent of Electron and exports schema, description, `executeBrowserCommandOnView` and recording orchestration. `@areal/browser-automation/electron` exports the actual Electron WebM recorder and background capture lease. Playwright `1.59.1` and Zod `4.6.6` are runtime dependencies. The executor reads injected source from the Playwright package, which must remain in packaged assets.

Preview remains the only owner of Pages, WebContentsViews, the debugger, control epochs and held-input accounting. Each command consumes an immutable single-use approval plan that binds its original parameters. Locators, coordinates, evaluation, downloads and recording actions use that boundary. Background captures temporarily borrow a transparent, nonfocusable window to establish a real compositor surface, then return the same WebContentsView. A recording retains its complete approved action program. Cancellation, closure and human takeover revoke later input.

## Implemented command groups

- Navigation, page state, semantic snapshots, page and element evaluation.
- Playwright locator queries, actionability, click, double click, fill, press, selection, checked state, waits and cross-origin iframes.
- CUA coordinate click, drag, keys, scrolling and virtual clipboard.
- Viewport, full-page, clipped and element PNGs; visibility and viewport settings.
- JavaScript alert/confirm state and handling; actual download events and completed paths.
- WebM recording start, status, cancellation, full action DSL and relative workspace publication.
- Tab creation, selection, claim, list, handoff, deliverable, finalization and closure.

## Limitations

Upstream generic `fill` and `waitFor` declarations have no executor implementation. Use their Playwright locator operations. Upload, file chooser and `networkidle` return explicit unsupported results. Locator `downloadMedia` uses the upstream download-anchor implementation and the same approval and download receipt as other downloads. Real Electron 44.5 WebContentsView evidence shows `prompt()` throws `prompt() is not supported`; retained schema fields do not establish runtime support.

This package does not provide CLI headless, extension or external CDP backends, or the ZCode JavaScript SDK. Preview retains sensitive-page protection. Main owns one shared persistent `persist:areal-embedded-browser` Session under the current GUI userData. All projects share cookies and site storage; Pages and control remain scoped to their project and chat. Closing a Page or workspace preserves login state. Explicit cache clearing, all-data clearing and trusted Chrome import first revoke control and close all browser Pages. Chrome import is supplied by the separate browser-data package.

## Verification

From the GUI root, run `node packages/browser-automation/scripts/build.mjs`. In this package, `npm run check` checks TypeScript and `npm run acceptance` launches real Electron with a temporary profile and local HTTP fixtures. `acceptance/SCENARIOS.md` records the failure scenarios written before implementation. `capture-prototype.cjs` reproduces hidden-page compositor behavior. Package acceptance does not establish Core model calls, installed packages, real providers or physical OS input.

`npm run acceptance:profile` uses three independent Electron processes to verify shared synthetic Cookie/localStorage/IndexedDB, restart persistence, isolation from another userData, download routing, product endpoint protection, cache/all clearing and a trusted synthetic importer. It never reads a personal Chrome profile or credentials.
