// @ts-check
"use strict";
const { webUrl } = require("../preview/urls.cjs");
const { isPinned, reserveDecision } = require("../preview-residency.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");
const { randomUUID } = require("node:crypto");
const { attachAgentDialogPresentation } = require("../agent-dialog-presentation.cjs");
const { invalidateDocumentPlans } = require("../preview/observation-state.cjs");
const { performance } = require("node:perf_hooks");
const { readIsolated, nativeWithin } = require("./read-session.cjs");

class NativePageLifecycle {
  /** @type {Map<import('electron').WebContents,{view:import('electron').WebContentsView,done:Promise<void>}>} */
  #closing = new Map();
  /** @type {Error|null} */
  #firstCloseFailure = null;
  #activeDrains = 0;
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./downloads.cjs').HumanDownloads>} downloads
   * @param {InstanceType<typeof import('./human-input.cjs').HumanBrowserInput>} human_input
   * @param {InstanceType<typeof import('./native-targets.cjs').NativePageTargets>} native_targets
   * @param {InstanceType<typeof import('./page-diagnostics.cjs').PageDiagnostics>} page_diagnostics
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {typeof import("electron").WebContentsView} WebContentsView
   */
  constructor(
    control,
    downloads,
    human_input,
    native_targets,
    page_diagnostics,
    presentation,
    workspace,
    WebContentsView,
  ) {
    this.control = control;
    this.downloads = downloads;
    this.human_input = human_input;
    this.native_targets = native_targets;
    this.page_diagnostics = page_diagnostics;
    this.presentation = presentation;
    this.workspace = workspace;
    this.WebContentsView = WebContentsView;
  }
  /** @param {string|null|undefined} key */
  release(key, { preserveContext = false, notifyRevocation = true } = {}) {
    if (key === null || key === undefined) return;
    const page = this.workspace.pages.get(key);
    if (!page) return;
    this.control.revoke(page, { notify: notifyRevocation });
    page.activeRead?.cancel();
    page.activeSelection?.cancel();
    this.workspace.pages.delete(key);
    this.closeNative(page);
    if (this.presentation.owner === key) {
      this.presentation.owner = null;
      this.presentation.view = null;
    }
    const workspace = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    if (this.workspace.selected.get(workspace) === page.id) {
      const next = this.workspace.workspacePages(page.projectId, page.threadId)[0];
      if (next) this.workspace.selected.set(workspace, next.id);
      else this.workspace.selected.delete(workspace);
    }
    this.workspace.changed(page, "pageRemoved");
    if (
      !this.workspace.owns(page.projectId, page.threadId) ||
      page.coreInstanceId !== this.workspace.coreIdentity(page.projectId, page.threadId)
    )
      this.workspace.fileReceipts.delete(workspace);
    if (!preserveContext && !this.workspace.workspacePages(page.projectId, page.threadId).length)
      this.workspace.releaseWorkspaceContext(page);
  }

  releaseInvalidOwners() {
    for (const [key, page] of this.workspace.pages)
      if (
        (!this.workspace.owns(page.projectId, page.threadId) &&
          !this.workspace.retainsOwner(page.projectId, page.threadId)) ||
        page.coreInstanceId !== this.workspace.coreIdentity(page.projectId, page.threadId)
      )
        this.release(key);
  }

  /**
   * @param {import('./model.js').Page} page
   */
  closeNative(page) {
    this.control.revoke(page);
    page.activeRead?.cancel();
    page.activeSelection?.cancel();
    page.activeAction?.cancel();
    page.activeBatch?.cancel();
    page.document?.revoke();
    this.human_input.cancelHumanGesture(page);
    page.dialogPresentation?.dispose();
    page.dialogPresentation = null;
    if (!page.view) return;
    page.styleTrial = null;
    const view = page.view;
    const c = view.webContents;
    const converging = page.converging;
    const action = page.activeAction;
    page.networkPolicy?.revokeFrameGrant(c.id);
    page.frameGrant = null;
    this.downloads.cancelFileOperations(page, "page_closed_after_dispatch");
    const recording = page.commandRecording;
    recording?.controller.abort();
    page.commandDownloadIntent = null;
    for (const download of page.commandDownloads.values()) download.item?.cancel();
    if (page.commandArtifactRoot) {
      const artifactRoot = page.commandArtifactRoot;
      page.commandArtifactRoot = null;
      void Promise.resolve(recording?.promise)
        .finally(() =>
          require("node:fs/promises").rm(artifactRoot, { recursive: true, force: true }),
        )
        .catch(() => {});
    }
    if (page.openingDevTools && !page.openingDevTools.isDestroyed()) page.openingDevTools.close();
    page.openingDevTools = null;
    page.unregisterProfilePage?.();
    page.unregisterProfilePage = null;
    page.diagnosticsReady = false;
    page.diagnosticRequests?.clear();
    page.claiming?.cancel();
    /** @type {() => void} */
    let complete = () => {};
    /** @type {Promise<void>} */
    const done = new Promise((resolve) => {
      complete = resolve;
    });
    /** @type {Promise<void>} */
    const destroyed = new Promise((resolve) => {
      if (c.isDestroyed()) resolve();
      else c.once("destroyed", () => resolve());
    });
    this.#closing.set(c, { view, done });
    page.view = null;
    const deadline = performance.now() + 10000;
    /** @param {unknown} error */
    const failed = (error) => {
      this.#firstCloseFailure ??=
        error instanceof Error ? error : new Error("原生页面关闭失败", { cause: error });
    };
    const close = async () => {
      try {
        view.setVisible(false);
        const settled = await nativeWithin(
          Promise.allSettled([c.isDestroyed() ? undefined : converging, recording?.promise]),
          deadline,
        );
        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        // 原生命令的 finally 负责归还临时 surface；必须先等它释放旧 view。
        while (action && page.activeAction === action)
          await nativeWithin(new Promise((resolve) => setTimeout(resolve, 10)), deadline);
        // 新建页可在首次导航前关闭，此时还没有可清理的 DOM。
        if (!c.isDestroyed() && !c.isCrashed() && c.getURL() !== "")
          await nativeWithin(
            Promise.race([
              readIsolated(
                c,
                `(() => {
            const active = document.activeElement;
            if (!(active instanceof HTMLSelectElement) || !CSS.supports('selector(select:open)') || !active.matches(':open')) return false;
            HTMLElement.prototype.blur.call(active);
            return true;
          })()`,
              ),
              destroyed,
            ]),
            deadline,
          );
      } catch (error) {
        failed(error);
      } finally {
        try {
          if (!this.presentation.window.isDestroyed())
            this.presentation.window.contentView.removeChildView(view);
        } catch (error) {
          failed(error);
        }
        try {
          if (!c.isDestroyed()) c.close();
        } catch (error) {
          failed(error);
        }
      }
    };
    void close()
      .then(() => destroyed)
      .then(() => {
        this.#closing.delete(c);
        complete();
      });
  }

  /** @param {number} deadline */
  async drain(deadline) {
    this.#activeDrains++;
    try {
      while (this.#closing.size)
        await nativeWithin(
          Promise.all([...this.#closing.values()].map((entry) => entry.done)),
          deadline,
        );
      if (this.#firstCloseFailure) throw this.#firstCloseFailure;
    } catch (error) {
      throw this.#firstCloseFailure ?? error;
    } finally {
      if (--this.#activeDrains === 0) this.#firstCloseFailure = null;
    }
  }

  /**
   * @param {import('./model.js').Page} page
   */
  suspend(page) {
    if (isPinned(page)) throw new Error("页面正在使用，不能驱逐");
    const c = page.view?.webContents;
    if (!c) throw new Error("页面正在使用，不能驱逐");
    page.url = c.isDestroyed() ? page.url : c.getURL() || page.url;
    page.title = c.isDestroyed() ? page.title : c.getTitle() || page.title;
    page.refs.clear();
    page.plans.clear();
    page.lastObservation = null;
    page.needsObservation = true;
    page.stateLoss = "页面已驱逐；只恢复网址，表单和临时登录可能需要重做";
    this.closeNative(page);
    this.workspace.changed(page);
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {boolean} replacing
   * @param {import('./model.js').Page|null} excluded
   */
  reservePageSlot(projectId, threadId, replacing = false, excluded = null) {
    this.releaseInvalidOwners();
    const decision = reserveDecision(this.workspace.pages.values(), {
      workspacePageCount: this.workspace.workspacePages(projectId, threadId).length,
      replacing,
      excluded,
    });
    if (decision.kind === "workspaceFull") throw new Error("当前浏览工作区已达4页，请先关闭页面");
    if (decision.kind === "allPinned") throw new Error("浏览页面已达8页且都在使用，请先关闭页面");
    if (decision.kind === "evict") this.suspend(decision.page);
  }

  /** @param {string} owner @param {string} projectId @param {string} threadId
   * @param {{id?:string;pageGeneration?:number;replacing?:boolean;openerId?:string|null;origin?:string;stateLoss?:string|null}} options */
  create(owner, projectId, threadId, options = {}) {
    this.workspace.profile.assertAvailable();
    this.workspace.unregisterProfileHost ??= this.workspace.profile.registerHost(
      this.workspace.profileHost,
    );
    this.workspace.profile.assertAvailable();
    this.reservePageSlot(projectId, threadId, options.replacing === true);
    const partition = this.workspace.profile.partition;
    const view = new this.WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: this.workspace.profile.session,
      },
    });
    /** @type {import("./model.js").LivePage} */
    const page = {
        id: options.id ?? randomUUID(),
        pageGeneration: options.pageGeneration ?? 1,
        view,
        partition,
        session: view.webContents.session,
        networkPolicy: this.workspace.profile.policy,
        coreInstanceId: this.workspace.coreIdentity(projectId, threadId),
        projectId,
        threadId,
        openerId: options.openerId ?? null,
        origin: options.origin ?? "human",
        title: "",
        error: "",
        url: "",
        committedUrl: "",
        crashed: false,
        control: "human",
        controlEpoch: 0,
        documentGeneration: 0,
        viewportRevision: 0,
        refs: new Map(),
        nativeControls: new Map(),
        optionIds: new Map(),
        nativeControlKey: randomUUID(),
        observedViewportKey: null,
        plans: new Map(),
        lastObservation: null,
        needsObservation: true,
        nextRef: 0,
        heldButtons: new Map(),
        heldKeys: new Map(),
        inputPending: new Set(),
        requestedVisible: false,
        downloads: new Set(),
        downloadRecords: new Map(),
        dialogPending: false,
        fileHandoff: null,
        commandDownloads: new Map(),
        commandFrameSessions: new Map(),
        commandDialog: null,
        commandLifecycle: "active",
        fileChooserIntercepted: false,
        stateLoss: options.stateLoss ?? null,
        diagnosticsReady: false,
        diagnosticsStartedAt: null,
        diagnosticEvents: [],
        diagnosticRequests: new Map(),
        diagnosticBytes: 0,
        diagnosticSequence: 0,
        diagnosticLoss: null,
      },
      c = view.webContents;
    try {
      page.networkPolicy = this.workspace.ensureWorkspaceContext(page);
    } catch (error) {
      if (!c.isDestroyed()) c.close();
      throw error;
    }
    page.dialogPresentation = attachAgentDialogPresentation(c, {
      ownership: () => ({ control: page.control }),
      onFault: (error) => {
        page.error = error.message;
        this.control.revoke(page);
      },
    });
    this.page_diagnostics.attachDiagnostics(page);
    c.debugger.on("detach", () => {
      page.commandFrameSessions.clear();
      page.fileChooserIntercepted = false;
      this.page_diagnostics.clearDiagnostics(page, "debugger_detached");
      if (page.control === "agent") this.control.revoke(page);
    });
    c.on("devtools-opened", () => {
      page.openingDevTools = null;
      if (page.styleTrial) page.styleTrial.stale = true;
      this.control.revoke(page);
    });
    c.on("devtools-closed", () => {
      if (!this.workspace.pageStillOwned(page)) return;
      page.pageGeneration++;
      page.documentGeneration++;
      this.human_input.cancelHumanGesture(page);
      page.refs.clear();
      page.plans.clear();
      page.needsObservation = true;
      this.page_diagnostics.clearDiagnostics(page, "devtools_closed");
      this.workspace.changed(page);
    });
    page.onDownload = this.downloads.downloadHandler(page);
    page.unregisterProfilePage = this.workspace.profile.registerPage({
      contents: c,
      current: () =>
        this.workspace.pageStillOwned(page) && page.view?.webContents === c && !c.isDestroyed(),
      devToolsContents: () =>
        c.isDestroyed() ? null : (c.devToolsWebContents ?? page.openingDevTools),
      download: page.onDownload,
      documentRequest: (details) => page.document?.request(details) ?? null,
    });
    c.setWindowOpenHandler((details) => {
      // Electron must never create an unowned BrowserWindow. A local human click
      // may create a sibling only after URL and current ownership checks.
      if (
        page.document ||
        page.control !== "human" ||
        !this.workspace.pageStillOwned(page) ||
        !this.workspace.owns(projectId, threadId) ||
        page.coreInstanceId !== this.workspace.coreIdentity(projectId, threadId) ||
        Date.now() > (page.userPopupIntentUntil ?? 0)
      )
        return { action: "deny" };
      page.userPopupIntentUntil = 0;
      let url;
      let source;
      try {
        url = webUrl(details.url);
        source = new URL(c.getURL());
      } catch {
        return { action: "deny" };
      }
      // A popup can reuse the existing site context; it cannot create a new
      // network grant from page-controlled URL text, even after a local click.
      if (
        new URL(url).origin !== source.origin ||
        !page.networkPolicy.permits({ url, resourceType: "mainFrame" })
      )
        return { action: "deny" };
      if (!["foreground-tab", "background-tab", "new-window"].includes(details.disposition))
        return { action: "deny" };
      const id = randomUUID();
      let child;
      try {
        child = this.create(
          pageKey(page.coreInstanceId, projectId, threadId, id),
          projectId,
          threadId,
          { id, openerId: page.id, origin: c.isFocused() ? "human" : "unknown" },
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        page.error = error.message;
        this.workspace.changed(page);
        return { action: "deny" };
      }
      if (c.isFocused() && details.disposition !== "background-tab")
        this.workspace.selected.set(
          workspaceKey(page.coreInstanceId, projectId, threadId),
          child.id,
        );
      child.url = url;
      void child.view.webContents.loadURL(url).catch((error) => {
        if (
          this.workspace.pageStillOwned(child) &&
          error.code !== "ERR_ABORTED" &&
          error.errno !== -3
        )
          child.error = error.message;
      });
      this.workspace.changed(child);
      return { action: "deny" };
    });
    /** @param {{preventDefault:()=>void}} event @param {string} url */
    const navigate = (event, url) => {
      try {
        webUrl(url);
        if (
          page.frameGrant ||
          !page.networkPolicy.permits({
            url,
            resourceType: "mainFrame",
            webContentsId: c.id,
            frame: c.mainFrame,
          })
        )
          event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    c.on("will-navigate", navigate);
    c.on("will-redirect", navigate);
    c.on("will-frame-navigate", (event) => {
      try {
        webUrl(event.url);
        if (
          !page.networkPolicy.permits({
            url: event.url,
            resourceType: event.isMainFrame ? "mainFrame" : "subFrame",
            webContentsId: c.id,
            frame: event.frame,
          })
        )
          event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    c.on("did-start-navigation", (_event, url, inPlace, main) => {
      if (!this.workspace.pageStillOwned(page)) return;
      if (main && !inPlace) page.dialogPresentation?.cancel();
      page.dialogPending = false;
      page.activeSelection?.cancel();
      if (main) {
        if (page.document && !page.document.matchesEntry(url)) page.document.revoke();
        page.frameDocumentGeneration = (page.frameDocumentGeneration ?? 0) + 1;
        if (page.frameGrant) {
          const grant = page.frameGrant;
          if (
            grant.status === "reloading" &&
            !grant.navigationStarted &&
            !inPlace &&
            url === grant.parentURL
          ) {
            grant.navigationStarted = true;
            grant.documentGeneration = page.frameDocumentGeneration;
          } else {
            page.activeRead?.cancel();
            this.closeNative(page);
            page.stateLoss = "嵌入授权因文档变化已撤销，页面已关闭";
            this.workspace.changed(page);
            return;
          }
        }
        // A new document discards its inline trial values. A same-document
        // navigation may retain them, so fence the trial until an explicit
        // refresh; never auto-reload and discard an unsaved form.
        if (page.styleTrial) {
          if (inPlace) page.styleTrial.stale = true;
          else page.styleTrial = null;
        }
        page.activeRead?.cancel("plan_stale");
        // 同文档且完整 URL 未变的 history 更新不产生新导航权限；旧观察仍在下方失效。
        const unchangedDocument =
          inPlace === true && !!page.committedUrl && url === page.committedUrl;
        const approvedCommand =
          page.activeAction?.command &&
          !page.activeAction.cancelled &&
          page.activeAction.controlEpoch === page.controlEpoch &&
          page.networkPolicy.canAuthorize(url);
        const approvedAction =
          !unchangedDocument &&
          (approvedCommand || this.native_targets.acceptActionNavigation(page, url));
        if (!unchangedDocument) {
          if (page.approvedNavigation === url) page.approvedNavigation = null;
          else if (!approvedAction) this.control.revoke(page);
        }
        page.documentGeneration++;
        this.human_input.cancelHumanGesture(page);
        if (
          (approvedAction || (unchangedDocument && page.control === "agent")) &&
          page.activeAction
        )
          page.activeAction.navigationDocument = page.documentGeneration;
        page.needsObservation = true;
        page.refs.clear();
        invalidateDocumentPlans(page);
        page.url = url;
        page.error = "";
      } else {
        page.documentGeneration++;
        this.human_input.cancelHumanGesture(page);
        // 按键释放可完成，但后续动作仍须重新观察，不能沿用子 Frame 变化前的计划。
        page.needsObservation = true;
        page.refs.clear();
        invalidateDocumentPlans(page);
        page.activeRead?.cancel("plan_stale");
      }
      if (this.workspace.pageStillOwned(page)) this.workspace.changed(page);
    });
    /** @param {string} url */
    const commitNavigation = (url) => {
      if (!this.workspace.pageStillOwned(page)) return;
      if (page.frameGrant && url !== page.frameGrant.parentURL) {
        page.activeRead?.cancel();
        this.closeNative(page);
        page.stateLoss = "嵌入授权因文档变化已撤销，页面已关闭";
        this.workspace.changed(page);
        return;
      }
      if (
        page.frameGrant?.status === "reloading" &&
        page.frameGrant.navigationStarted &&
        page.frameGrant.valid() &&
        url === page.frameGrant.parentURL
      )
        page.frameGrant.status = "active";
      page.document?.committed(url);
      page.committedUrl = url;
      page.url = url;
      if (page.fileHandoff) {
        clearTimeout(page.fileHandoff.timer);
        page.fileHandoff = null;
      }
      this.workspace.changed(page);
    };
    // A download link can start navigation without committing a document.
    // Keep the arm through that start, but never carry it into a new Page URL.
    c.on("did-navigate", (_event, url) => commitNavigation(url));
    c.on("did-navigate-in-page", (_event, url, main) => {
      if (main) commitNavigation(url);
    });
    c.on("did-fail-load", (_event, code, message, url, main) => {
      if (!this.workspace.pageStillOwned(page)) return;
      page.dialogPending = false;
      if (main && code !== -3 && url === page.url) page.error = message;
      if (this.workspace.pageStillOwned(page)) this.workspace.changed(page);
    });
    c.on("did-finish-load", () => {
      if (!this.workspace.pageStillOwned(page)) return;
      page.dialogPending = false;
      this.workspace.changed(page);
    });
    c.on("will-prevent-unload", () => {
      if (!this.workspace.pageStillOwned(page)) return;
      page.dialogPending = true;
      this.workspace.changed(page);
    });
    c.on("page-title-updated", () => {
      if (this.workspace.pageStillOwned(page)) this.workspace.changed(page);
    });
    c.on("render-process-gone", () => {
      if (this.workspace.pages.get(owner) !== page) return;
      page.title = c.isDestroyed() ? page.title : c.getTitle() || page.title;
      // A started download navigation has no committed document. Restoring its
      // provisional URL would repeat an UNKNOWN transfer after a renderer crash.
      page.url = page.committedUrl;
      page.document?.revoke();
      this.control.revoke(page);
      this.downloads.cancelFileOperations(page, "native_crash_after_dispatch");
      page.crashed = true;
      page.error = "预览页面已退出，请重新加载";
      this.workspace.changed(page);
    });
    this.human_input.attachNativeInput(page);
    this.presentation.window.contentView.addChildView(view);
    view.setVisible(false);
    this.workspace.pages.set(owner, page);
    const workspace = workspaceKey(
      this.workspace.coreIdentity(projectId, threadId),
      projectId,
      threadId,
    );
    if (!this.workspace.selected.has(workspace)) this.workspace.selected.set(workspace, page.id);
    this.workspace.changed(page, "pageAdded");
    return page;
  }
}

module.exports = { NativePageLifecycle };
