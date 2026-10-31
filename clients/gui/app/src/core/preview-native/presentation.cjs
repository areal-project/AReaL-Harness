// @ts-check
"use strict";
const { isDeepStrictEqual } = require("node:util");
const { workspaceKey, pageKey } = require("./identity.cjs");

class PreviewPresentation {
  /**
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {(page?: import("./model.js").Page) => void} cancelHumanGesture
   * @param {import("electron").BrowserWindow} window
   */
  constructor(workspace, cancelHumanGesture, window) {
    this.workspace = workspace;
    this.cancelHumanGesture = cancelHumanGesture;
    this.window = window;
    /** @type {string|null} */
    this.owner = null;
    /** @type {import("electron").WebContentsView|null} */
    this.view = null;
    /** @type {{page:import("./model.js").Page|undefined,view:import("electron").WebContentsView|null,visible:boolean}|null} */
    this.suppressedPresentation = null;
  }
  /** @param {import('./model.js').LivePage} page @param {import('./model.js').Bounds} available */
  layout(page, available) {
    const c = page.view.webContents;
    const viewport = page.commandViewport;
    const guiZoom = this.window.webContents.getZoomFactor();
    const fit = viewport
      ? Math.min(1, available.width / viewport.width, available.height / viewport.height)
      : 1;
    const bounds = viewport
      ? {
          x: available.x + Math.floor((available.width - Math.floor(viewport.width * fit)) / 2),
          y: available.y,
          width: Math.max(1, Math.floor(viewport.width * fit)),
          height: Math.max(1, Math.floor(viewport.height * fit)),
        }
      : available;
    const scale = viewport
      ? Math.min(bounds.width / viewport.width, bounds.height / viewport.height)
      : 1;
    const key = JSON.stringify([viewport ?? null, scale]);
    if (
      isDeepStrictEqual(bounds, page.view.getBounds()) &&
      page.guiZoom === guiZoom &&
      page.emulationKey === key
    )
      return;
    page.activeRead?.cancel("plan_stale");
    page.activeSelection?.cancel();
    page.view.setBounds(bounds);
    if (viewport) {
      c.setZoomFactor(1);
      c.enableDeviceEmulation({
        screenPosition: "desktop",
        screenSize: viewport,
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        viewSize: viewport,
        scale,
      });
    } else if (page.viewportScale !== undefined) c.disableDeviceEmulation();
    page.emulationKey = key;
    page.viewportScale = viewport ? scale : undefined;
    page.guiZoom = guiZoom;
    page.viewportKey = null;
    page.viewportRevision++;
    page.lastCapture = null;
    page.plans.clear();
    page.needsObservation = true;
    this.workspace.changed(page, "viewportChanged");
  }

  /**
   * @param {boolean} suppressed
   */
  setPresentationSuppressed(suppressed) {
    if (suppressed) {
      if (this.suppressedPresentation) return;
      const page = this.owner === null ? undefined : this.workspace.pages.get(this.owner),
        view = this.view;
      this.suppressedPresentation = { page, view, visible: view?.getVisible() === true };
      view?.setVisible(false);
      page?.activeSelection?.cancel();
      page?.activeRead?.cancel();
      this.cancelHumanGesture(page);
      return;
    }
    const previous = this.suppressedPresentation;
    this.suppressedPresentation = null;
    if (!previous?.visible) return;
    const { page, view } = previous;
    if (
      page &&
      view &&
      this.workspace.pageStillOwned(page) &&
      page.view === view &&
      this.view === view &&
      this.owner === pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id) &&
      this.workspace.selected.get(
        workspaceKey(page.coreInstanceId, page.projectId, page.threadId),
      ) === page.id &&
      !page.crashed &&
      !view.webContents.isDestroyed() &&
      page.requestedVisible &&
      page.control !== "transferring" &&
      !page.activeAction
    )
      view.setVisible(true);
  }

  /**
   * @param {import('./model.js').Page} page
   */
  developmentPromptFence(page) {
    return {
      view: page.view,
      pageGeneration: page.pageGeneration,
      documentGeneration: page.documentGeneration,
      controlEpoch: page.controlEpoch,
    };
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {{view: import('electron').WebContentsView|null,pageGeneration:number,documentGeneration:number,controlEpoch:number}} fence
   */
  currentDevelopmentPrompt(page, fence) {
    if (this.workspace.profile.status().busy) return false;
    if (!this.workspace.pageStillOwned(page) || !page.view || page.view.webContents.isDestroyed())
      return false;
    const key = pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id);
    const workspace = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    // A blank initial page is bound by the current trusted `show` request even
    // before there is a URL to make its native view visible.
    const initialBlank = !page.url && !page.view.webContents.getURL();
    return (
      this.owner === key &&
      this.view === fence.view &&
      page.view === fence.view &&
      this.workspace.selected.get(workspace) === page.id &&
      page.control === "human" &&
      !page.annotationCaptureId &&
      page.pageGeneration === fence.pageGeneration &&
      page.documentGeneration === fence.documentGeneration &&
      page.controlEpoch === fence.controlEpoch &&
      (page.requestedVisible || initialBlank)
    );
  }

  /**
   * @param {import('./model.js').Page|null|undefined} page
   */
  state(page = this.owner === null ? undefined : this.workspace.pages.get(this.owner)) {
    const contents = page?.view?.webContents;
    const c = contents && !contents.isDestroyed() ? contents : null;
    const state = {
      url: c?.getURL() || page?.url || "",
      title: c?.getTitle() ?? page?.title ?? "",
      loading: c?.isLoading() ?? false,
      canGoBack: c?.navigationHistory.canGoBack() ?? false,
      canGoForward: c?.navigationHistory.canGoForward() ?? false,
      error: page?.error ?? "",
      browser: page
        ? {
            pageId: page.id,
            viewport: page.commandViewport
              ? { mode: "device", ...page.commandViewport }
              : { mode: "auto" },
            control: page.control,
            frameOriginGrant: page.frameGrant
              ? { origin: page.frameGrant.origin, status: page.frameGrant.status }
              : null,
            trialActive: !!page.styleTrial,
            trialStale: !!page.styleTrial?.stale,
            transferError: page.transferError ?? null,
            resource: page.view ? (page.crashed ? "crashed" : "ready") : "suspended",
            stateLoss: page.stateLoss ?? null,
            downloadIntentExpiresAt:
              page.fileHandoff?.kind === "download" ? page.fileHandoff.expiresAt : null,
          }
        : null,
    };
    return page
      ? { ...state, workspace: this.workspace.snapshot(page.projectId, page.threadId) }
      : state;
  }
}

module.exports = { PreviewPresentation };
