// @ts-check
"use strict";
const { hasNativePage } = require("./workspace.cjs");
const { webUrl } = require("../preview/urls.cjs");
const { workspaceKey, pageKey } = require("./identity.cjs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
/** @type {typeof import("@areal/workbench/desktop-contract").validatePreview} */
const validatePreview = require("@areal/workbench/desktop-contract").validatePreview;
const { WorkspaceNetworkPolicy } = require("../browser-network.cjs");
const { readIsolated, nativeWithin, rendererBoundsWithinWindow } = require("./read-session.cjs");
const DOWNLOAD_INTENT_MS = 30000;

class HumanBrowserCommands {
  /**
   * @param {InstanceType<typeof import('./annotations.cjs').PageAnnotations>} annotations
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./human-capture.cjs').HumanPageCapture>} human_capture
   * @param {InstanceType<typeof import('./human-input.cjs').HumanBrowserInput>} human_input
   * @param {InstanceType<typeof import('./lifecycle.cjs').NativePageLifecycle>} lifecycle
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./style-trials.cjs').PageStyleTrials>} style_trials
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {() => import("./model.js").PreviewPreferences} preferences
   * @param {() => string[]} controlEndpoints
   * @param {(prompt:import("./model.js").DevelopmentPrompt) => Promise<boolean>} confirmDevelopmentOrigin
   */
  constructor(
    annotations,
    control,
    human_capture,
    human_input,
    lifecycle,
    presentation,
    style_trials,
    workspace,
    preferences,
    controlEndpoints,
    confirmDevelopmentOrigin,
  ) {
    this.annotations = annotations;
    this.control = control;
    this.human_capture = human_capture;
    this.human_input = human_input;
    this.lifecycle = lifecycle;
    this.presentation = presentation;
    this.style_trials = style_trials;
    this.workspace = workspace;
    this.preferences = preferences;
    this.controlEndpoints = controlEndpoints;
    this.confirmDevelopmentOrigin = confirmDevelopmentOrigin;
  }
  /**
   * @param {import('./model.js').Page|null|undefined} page
   * @param {string} operation
   */
  async frameOriginCommand(page, operation) {
    if (operation === "revokeFrameOrigin") {
      if (!page || !this.workspace.pageStillOwned(page) || page.control !== "human")
        throw new Error("页面归属已变化");
      if (!page.frameGrant) throw new Error("嵌入站点授权已失效");
      this.lifecycle.release(pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id));
      return this.presentation.state(this.workspace.page(page.projectId, page.threadId));
    }
    if (!hasNativePage(page)) throw new Error("请先接管并显示当前页面，再授权嵌入站点");
    const c = page.view.webContents;
    const fence = this.presentation.developmentPromptFence(page);
    const valid = () =>
      !!c &&
      !c.isDestroyed() &&
      this.presentation.currentDevelopmentPrompt(page, fence) &&
      this.presentation.window.isVisible() &&
      !this.presentation.window.isMinimized() &&
      this.presentation.window.isFocused() &&
      page.view.getVisible() &&
      !c.isDevToolsOpened() &&
      !page.activeRead &&
      !page.activeSelection &&
      !page.activeAction &&
      !page.activePrepare &&
      !page.claiming &&
      !page.styleTrial &&
      !page.fileHandoff &&
      !page.downloads.size &&
      !page.dialogPending;
    if (!valid()) throw new Error("请先接管并显示当前页面，再授权嵌入站点");
    if (operation === "reloadFrameOrigin") {
      const grant = page.frameGrant;
      if (
        !grant ||
        grant.status !== "pending" ||
        Date.now() > grant.expiresAt ||
        !this.presentation.currentDevelopmentPrompt(page, grant.fence) ||
        c.getURL() !== grant.parentURL
      )
        throw new Error("嵌入站点授权已失效，请重新授权");
      grant.status = "reloading";
      grant.navigationStarted = false;
      page.networkPolicy.bindFrameGrant(grant);
      c.reload();
      this.workspace.changed(page);
      return this.presentation.state(page);
    }
    if (page.frameGrant || page.pendingDevelopmentPrompt)
      throw new Error("已有嵌入站点授权或确认正在进行");
    const source = c.getURL(),
      parentOrigin = new URL(source).origin;
    const origins = await nativeWithin(
      readIsolated(
        c,
        `(() => [...new Set([...document.querySelectorAll('iframe,frame')].map(frame => {
      try { const url = new URL(frame.getAttribute('src'), document.baseURI); return ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password && url.origin !== location.origin ? url.origin : null; } catch { return null; }
    }).filter(Boolean))])()`,
      ),
      performance.now() + 5000,
    );
    if (
      !valid() ||
      c.getURL() !== source ||
      !Array.isArray(origins) ||
      origins.length !== 1 ||
      typeof origins[0] !== "string" ||
      origins[0] === parentOrigin ||
      !page.networkPolicy.canAuthorize(origins[0])
    )
      throw new Error("当前页面需要恰好一个可授权的独立嵌入站点");
    const prompt = (page.pendingDevelopmentPrompt = randomUUID());
    let confirmed;
    try {
      confirmed = await this.confirmDevelopmentOrigin({
        kind: "frame",
        origin: origins[0],
        page,
        fence,
      });
    } finally {
      if (page.pendingDevelopmentPrompt === prompt) page.pendingDevelopmentPrompt = null;
    }
    if (!confirmed || !valid() || c.getURL() !== source)
      throw new Error("嵌入站点授权已取消或失效");
    /** @type {import("./model.js").FrameGrant} */
    const grant = {
      origin: origins[0],
      parentURL: source,
      contents: c,
      fence,
      status: "pending",
      expiresAt: Date.now() + 60000,
      documentGeneration: page.frameDocumentGeneration ?? 0,
      valid: () =>
        page.frameGrant === grant &&
        this.workspace.pageStillOwned(page) &&
        page.view?.webContents === c &&
        !c.isDestroyed() &&
        page.control === "human" &&
        page.pageGeneration === fence.pageGeneration &&
        page.controlEpoch === fence.controlEpoch &&
        (page.frameDocumentGeneration ?? 0) === grant.documentGeneration,
    };
    page.frameGrant = grant;
    this.workspace.changed(page);
    return this.presentation.state(page);
  }

  /** @param {Extract<import('@areal/workbench/desktop-contract').PreviewRequest,{operation:'hide'}>} request */
  hide(request) {
    const page =
      typeof request.projectId === "string" &&
      typeof request.threadId === "string" &&
      (request.pageId === undefined || typeof request.pageId === "string")
        ? this.workspace.page(request.projectId, request.threadId, request.pageId)
        : null;
    const key = page ? pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id) : null;
    this.human_input.cancelHumanGesture(
      page ??
        (this.presentation.owner === null
          ? undefined
          : this.workspace.pages.get(this.presentation.owner)),
    );
    const hidden =
      page ??
      (!request.projectId
        ? this.presentation.owner === null
          ? undefined
          : this.workspace.pages.get(this.presentation.owner)
        : null);
    const frozen = hidden?.annotationCapture;
    // 只有本页当前截图凭据允许标注临时隐藏；卸载和普通隐藏必须销毁授权文档。
    const annotationHide =
      !!request.captureId &&
      !!hidden &&
      this.workspace.pageStillOwned(hidden) &&
      request.captureId === hidden.annotationCaptureId &&
      hidden.control === "human" &&
      frozen?.nativeWebContentsId === hidden.view?.webContents.id &&
      frozen?.pageGeneration === hidden.pageGeneration &&
      frozen?.controlEpoch === hidden.controlEpoch;
    if (page) {
      page.requestedVisible = false;
      page.activeSelection?.cancel();
      if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
      page.fileHandoff = null;
      if (page.control === "human" && page.annotationCaptureId) page.activeRead?.cancel();
    }
    if (!request.projectId || this.presentation.owner === key) {
      if (!page) {
        const displayed =
          this.presentation.owner === null
            ? undefined
            : this.workspace.pages.get(this.presentation.owner);
        if (displayed) displayed.requestedVisible = false;
      }
      this.presentation.view?.setVisible(false);
      this.presentation.owner = null;
      this.presentation.view = null;
    }
    if (hidden?.frameGrant && !annotationHide) {
      hidden.activeRead?.cancel();
      this.lifecycle.closeNative(hidden);
      hidden.stateLoss = "嵌入授权因关闭预览已撤销，页面已关闭";
      this.workspace.changed(hidden);
    }
    return this.presentation.state(page);
  }

  /**
   * @param {unknown} request
   */
  async command(request) {
    validatePreview(request);
    if (request.operation === "hide") return this.hide(request);
    if (!["state", "subscribe", "hide", "stop", "release", "endRegion"].includes(request.operation))
      this.workspace.profile.assertAvailable();
    if (request.operation === "state" && !this.workspace.owns(request.projectId, request.threadId))
      return this.presentation.state(null);
    const workspace = workspaceKey(
      this.workspace.coreIdentity(request.projectId, request.threadId),
      request.projectId,
      request.threadId,
    );
    let page = this.workspace.page(request.projectId, request.threadId, request.pageId);
    let key = page && pageKey(page.coreInstanceId, request.projectId, request.threadId, page.id);
    if (!page && request.operation === "state") {
      page = this.workspace.page(request.projectId, request.threadId);
      key = page && pageKey(page.coreInstanceId, request.projectId, request.threadId, page.id);
    }
    if (request.pageId && !page && !["state", "endRegion"].includes(request.operation))
      throw new Error("页面已关闭");
    if (request.operation === "subscribe")
      return this.workspace.snapshot(request.projectId, request.threadId);
    // A read must not touch LRU order or publish another metadata event.
    if (request.operation === "state")
      return page
        ? this.presentation.state(page)
        : {
            ...this.presentation.state(null),
            workspace: this.workspace.snapshot(request.projectId, request.threadId),
          };
    if (
      ["authorizeFrameOrigin", "reloadFrameOrigin", "revokeFrameOrigin"].includes(request.operation)
    )
      return this.frameOriginCommand(page, request.operation);
    if (
      page?.frameGrant &&
      ["navigate", "back", "forward", "reload", "devtools"].includes(request.operation)
    )
      throw new Error("请先撤销嵌入站点授权并关闭页面，再导航或打开开发者工具");
    if (request.operation === "release") {
      if (!page) return this.presentation.state(null);
      if (page.origin !== "agent" && request.userIntent !== true)
        throw new Error("关闭人工页面需要明确用户操作");
      this.lifecycle.release(key);
      return this.presentation.state(this.workspace.page(request.projectId, request.threadId));
    }
    if (request.operation === "allowNextDownload") {
      const c = page?.view?.webContents;
      if (
        request.userIntent !== true ||
        !page ||
        page.id !== request.pageId ||
        !c ||
        !hasNativePage(page) ||
        !this.workspace.pageStillOwned(page) ||
        page.control !== "human" ||
        page.crashed ||
        c.isDestroyed() ||
        c.isDevToolsOpened() ||
        page.fileHandoff ||
        page.downloads.size ||
        page.annotationCaptureId ||
        page.styleTrial ||
        page.activeSelection ||
        page.activeRead ||
        page.activePrepare ||
        page.activeAction ||
        page.claiming ||
        page.dialogPending ||
        !c.getURL() ||
        this.presentation.owner !== key ||
        this.workspace.selected.get(workspace) !== page.id ||
        !page.requestedVisible ||
        !page.view.getVisible() ||
        !this.presentation.window.isVisible() ||
        this.presentation.window.isMinimized() ||
        !this.presentation.window.isFocused()
      )
        throw new Error("请先接管并显示当前页面，再允许下一次下载");
      const downloadPage = page;
      /** @type {import("./model.js").FileHandoff} */
      const intent = {
        kind: "download",
        pageGeneration: page.pageGeneration,
        documentGeneration: page.documentGeneration,
        controlEpoch: page.controlEpoch,
        url: c.getURL(),
        expiresAt: Date.now() + DOWNLOAD_INTENT_MS,
      };
      intent.timer = setTimeout(() => {
        if (downloadPage.fileHandoff === intent) {
          downloadPage.fileHandoff = null;
          this.workspace.changed(downloadPage);
        }
      }, DOWNLOAD_INTENT_MS);
      page.fileHandoff = intent;
      this.workspace.changed(page);
      return this.presentation.state(page);
    }
    if (request.operation === "cancelFileHandoff") {
      if (
        !page ||
        page.id !== request.pageId ||
        page.control !== "human" ||
        !this.workspace.pageStillOwned(page)
      )
        throw new Error("文件交接页面已变化");
      if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
      page.fileHandoff = null;
      this.workspace.changed(page);
      return this.presentation.state(page);
    }
    if (request.operation === "cancelDownload") {
      if (
        request.userIntent !== true ||
        !page ||
        page.id !== request.pageId ||
        !this.workspace.pageStillOwned(page) ||
        page.control !== "human"
      )
        throw new Error("文件交接页面已变化");
      const entry = [...page.downloadRecords].find(
        ([, record]) => record.id === request.downloadId,
      );
      if (!entry) throw new Error("下载已结束");
      const [item, record] = entry;
      record.status = "unknown";
      record.reason = "user_cancelled_after_dispatch";
      record.networkOutcome = "unknown";
      this.workspace.fileReceipt(page, record);
      item.cancel();
      return this.presentation.state(page);
    }
    if (request.operation === "captureRegion")
      return this.human_capture.captureRegion(request.projectId, request.threadId, request.pageId);
    if (request.operation === "captureElement")
      return this.annotations.captureElement(request.projectId, request.threadId, request.pageId);
    if (request.operation === "cancelElementSelection") {
      page?.activeSelection?.cancel();
      return this.presentation.state(page);
    }
    if (request.operation === "selectElement")
      return this.annotations.selectElement(
        request.projectId,
        request.threadId,
        request.pageId,
        request.captureId,
        request.x,
        request.y,
      );
    if (request.operation === "checkElement")
      return this.annotations.checkElement(
        request.projectId,
        request.threadId,
        request.pageId,
        request.captureId,
        request.elementId,
      );
    if (request.operation === "beginStyleTrial")
      return this.style_trials.beginStyleTrial(
        request.projectId,
        request.threadId,
        request.pageId,
        request.captureId,
        request.elementId,
      );
    if (
      request.operation === "applyStyleTrial" ||
      request.operation === "undoStyleTrial" ||
      request.operation === "redoStyleTrial"
    )
      return this.style_trials.styleTrialCommand(
        request.projectId,
        request.threadId,
        request.pageId,
        request.trialId,
        request.operation,
        request.operation === "applyStyleTrial" ? request.property : "",
        request.operation === "applyStyleTrial" ? request.value : "",
      );
    if (request.operation === "styleTrialState") {
      const trial = page?.styleTrial;
      if (!trial || trial.trialId !== request.trialId) throw new Error("页面试改已失效");
      return this.style_trials.styleTrialState(trial);
    }
    if (request.operation === "captureStyleTrialAfter")
      return this.style_trials.captureStyleTrialAfter(
        request.projectId,
        request.threadId,
        request.pageId,
        request.trialId,
      );
    if (request.operation === "clearStyleTrial") {
      if (!page?.styleTrial || page.styleTrial.trialId !== request.trialId)
        throw new Error("页面试改已失效");
      return this.style_trials.clearStyleTrial(page);
    }
    if (request.operation === "endRegion") {
      if (!page) return this.presentation.state(null);
      if (
        !this.workspace.owns(request.projectId, request.threadId) ||
        page.annotationCaptureId !== request.captureId
      )
        throw new Error("标注页面已变化");
      if (page.control === "human") page.activeRead?.cancel();
      await this.human_capture.discardAnnotationCapture(page, request.captureId);
      return this.presentation.state(page);
    }
    if (
      !this.workspace.owns(request.projectId, request.threadId) ||
      !this.workspace.coreIdentity(request.projectId, request.threadId)
    )
      throw new Error("请选择已连接 Core 的有效任务");
    if (request.operation === "openLink") {
      const url = webUrl(request.url),
        host = new URL(url).hostname;
      if (
        !(page?.networkPolicy ?? new WorkspaceNetworkPolicy(this.controlEndpoints)).canAuthorize(
          url,
        )
      )
        throw Object.assign(new Error("浏览安全策略拒绝该地址"), {
          code: "BROWSER_PERMISSION_DENIED",
        });
      const local =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "[::1]" ||
        host.startsWith("127.");
      const settings = this.preferences();
      const destination = local
        ? (settings.browserLocalTarget ?? "internal")
        : (settings.browserLinkTarget ?? "external");
      if (destination === "external") await require("electron").shell.openExternal(url);
      return { destination, url };
    }
    if (request.operation === "newPage") {
      const id = randomUUID();
      const child = this.lifecycle.create(
        pageKey(
          this.workspace.coreIdentity(request.projectId, request.threadId),
          request.projectId,
          request.threadId,
          id,
        ),
        request.projectId,
        request.threadId,
        { id, openerId: page?.id ?? null, origin: "human" },
      );
      this.workspace.selected.set(workspace, child.id);
      this.workspace.changed(child);
      return this.presentation.state(child);
    }
    const target = request.operation === "navigate" ? webUrl(request.url) : null;
    const restoreUrl = page?.url || request.url;
    if (
      page &&
      (!page.view || page.crashed || page.view.webContents.isDestroyed()) &&
      ["show", "navigate", "reload"].includes(request.operation)
    ) {
      const previous = page;
      this.lifecycle.reservePageSlot(request.projectId, request.threadId, true, previous);
      const wasSelected = this.workspace.selected.get(workspace) === previous.id;
      const saved = {
        id: previous.id,
        pageGeneration: previous.pageGeneration + 1,
        partition: previous.partition,
        openerId: previous.openerId,
        origin: previous.origin,
        stateLoss:
          previous.stateLoss ??
          (previous.crashed ? "页面崩溃；只恢复网址，表单和临时登录可能需要重做" : null),
        replacing: true,
      };
      this.lifecycle.release(key, { preserveContext: true });
      key = pageKey(previous.coreInstanceId, previous.projectId, previous.threadId, previous.id);
      page = this.lifecycle.create(key, request.projectId, request.threadId, saved);
      page.title = previous.title;
      page.url = previous.url;
      page.error = previous.error;
      page.commandViewport = previous.commandViewport;
      if (wasSelected) this.workspace.selected.set(workspace, page.id);
    }
    if (!page && ["show", "navigate", "reload"].includes(request.operation)) {
      const id = randomUUID();
      key = pageKey(
        this.workspace.coreIdentity(request.projectId, request.threadId),
        request.projectId,
        request.threadId,
        id,
      );
      page = this.lifecycle.create(key, request.projectId, request.threadId, { id });
    }
    if (
      hasNativePage(page) &&
      ["show", "navigate", "reload"].includes(request.operation) &&
      !page.view.webContents.getURL() &&
      !page.view.webContents.isLoadingMainFrame()
    ) {
      const restored = request.operation === "show" && restoreUrl ? webUrl(restoreUrl) : null;
      if (restored) {
        page.url = restored;
        void page.view.webContents.loadURL(restored).catch((error) => {
          if (
            this.workspace.pageStillOwned(page) &&
            error.code !== "ERR_ABORTED" &&
            error.errno !== -3
          )
            page.error = error.message;
        });
      }
    }
    if (!page)
      return {
        ...this.presentation.state(null),
        workspace: this.workspace.snapshot(request.projectId, request.threadId),
      };
    if (!hasNativePage(page)) {
      if (request.operation === "selectPage") {
        this.workspace.selected.set(workspace, page.id);
        this.workspace.changed(page);
      }
      return this.presentation.state(page);
    }
    key = pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id);
    this.workspace.pages.delete(key);
    this.workspace.pages.set(key, page);
    const view = page.view,
      nativeGeneration = page.pageGeneration;
    const c = view.webContents;
    if (target) {
      if (!page.networkPolicy.canAuthorize(target))
        throw Object.assign(new Error("浏览安全策略拒绝该地址"), {
          code: "BROWSER_PERMISSION_DENIED",
        });
      if (!page.networkPolicy.allowHumanNavigation(target))
        throw Object.assign(new Error("浏览安全策略拒绝该地址"), {
          code: "BROWSER_PERMISSION_DENIED",
        });
    }
    if (
      ["navigate", "back", "forward", "reload", "devtools"].includes(request.operation) &&
      page.styleTrial
    ) {
      const cleared = await this.style_trials.clearStyleTrial(page);
      this.workspace.profile.assertAvailable();
      if (!cleared.cleared && request.operation !== "reload")
        throw new Error("试改已失效，请刷新页面后继续导航");
    }
    if (
      request.operation === "setViewport" &&
      (page.annotationCaptureId || page.styleTrial || page.commandSurface)
    )
      throw new Error("请先结束批注、页面试改或浏览器命令，再调整视口");
    if (["navigate", "back", "forward", "reload", "setViewport"].includes(request.operation)) {
      if (
        !this.workspace.pageStillOwned(page) ||
        page.view !== view ||
        page.pageGeneration !== nativeGeneration ||
        page.crashed ||
        c.isDestroyed()
      )
        throw new Error("页面已关闭");
      this.control.revoke(page); // Fence old Agent work before waiting on the local native channel.
      const controlEpoch = page.controlEpoch;
      if (page.control === "transferring") await this.control.convergeInput(page);
      this.workspace.profile.assertAvailable();
      if (
        !this.workspace.pageStillOwned(page) ||
        page.view !== view ||
        page.pageGeneration !== nativeGeneration ||
        page.crashed ||
        c.isDestroyed()
      )
        throw new Error("页面已关闭");
      if (page.control !== "human" || page.controlEpoch !== controlEpoch)
        throw new Error("原生输入尚未收敛，请停止或关闭页面");
    } else if (request.operation === "stop") this.control.revoke(page);
    if (
      page.control === "transferring" &&
      !["state", "show", "hide", "stop", "release", "selectPage"].includes(request.operation)
    )
      throw new Error("原生输入尚未收敛，请停止或关闭页面");
    if (request.bounds) {
      page.presentationBounds = rendererBoundsWithinWindow(
        request.bounds,
        this.presentation.window,
      );
      if (!page.commandSurface) this.presentation.layout(page, page.presentationBounds);
    }
    switch (request.operation) {
      case "setViewport":
        page.commandViewport =
          request.viewport.mode === "device"
            ? { width: request.viewport.width, height: request.viewport.height }
            : null;
        this.presentation.layout(page, page.presentationBounds ?? page.view.getBounds());
        break;
      case "selectPage":
        {
          const outgoing =
            this.presentation.owner === null
              ? undefined
              : this.workspace.pages.get(this.presentation.owner);
          if (outgoing?.fileHandoff?.timer) clearTimeout(outgoing.fileHandoff.timer);
          if (outgoing) outgoing.fileHandoff = null;
        }
        if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
        page.fileHandoff = null;
        this.workspace.selected.set(workspace, page.id);
        this.workspace.changed(page);
        break;
      case "show":
        // 标注 hide 会保留冻结草稿；真正切换 Page/Thread 时仍撤销其他页面的临时授权。
        for (const other of this.workspace.pages.values())
          if (other !== page && other.frameGrant) {
            other.activeRead?.cancel();
            this.lifecycle.closeNative(other);
            other.stateLoss = "嵌入授权因切换页面已撤销，页面已关闭";
            this.workspace.changed(other);
          }
        if (this.presentation.owner !== key) {
          const outgoing =
            this.presentation.owner === null
              ? undefined
              : this.workspace.pages.get(this.presentation.owner);
          if (outgoing) {
            this.human_input.cancelHumanGesture(outgoing);
            outgoing.requestedVisible = false;
            if (outgoing.frameGrant) {
              outgoing.activeRead?.cancel();
              this.lifecycle.closeNative(outgoing);
              outgoing.stateLoss = "嵌入授权因切换页面已撤销，页面已关闭";
              this.workspace.changed(outgoing);
            }
          }
          this.presentation.view?.setVisible(false);
        }
        this.presentation.owner = key;
        this.presentation.view = page.view;
        page.requestedVisible = request.visible !== false;
        page.view.setVisible(
          !this.presentation.suppressedPresentation &&
            page.requestedVisible &&
            page.control !== "transferring" &&
            !page.activeAction,
        );
        break;
      case "navigate":
        page.document?.revoke();
        if (target === null) throw new Error("无效浏览地址");
        page.url = target;
        page.error = "";
        void c.loadURL(target).catch((error) => {
          if (
            this.workspace.pageStillOwned(page) &&
            error.code !== "ERR_ABORTED" &&
            error.errno !== -3 &&
            page.url === target
          )
            page.error = error.message;
        });
        break;
      case "back":
        page.document?.revoke();
        if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack();
        break;
      case "forward":
        page.document?.revoke();
        if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward();
        break;
      case "reload":
        page.error = "";
        if (c.getURL()) c.reload();
        else if (page.url)
          void c.loadURL(page.url).catch((error) => {
            if (
              this.workspace.pageStillOwned(page) &&
              error.code !== "ERR_ABORTED" &&
              error.errno !== -3
            )
              page.error = error.message;
          });
        break;
      case "stop":
        c.stop();
        break;
      case "external":
        if (page.document) await page.document.openExternal();
        else await require("electron").shell.openExternal(webUrl(c.getURL() || page.url));
        break;
      case "devtools":
        this.control.revoke(page);
        await this.control.convergeInput(page);
        this.workspace.profile.assertAvailable();
        if (page.control !== "human") throw new Error("原生输入尚未收敛，请停止或关闭页面");
        // Electron 在首个文档加载后才公开 devToolsWebContents；
        // 在这次可信调用期间绑定其内部创建的前端。
        {
          const { app } = require("electron");
          /** @param {Electron.Event} _event @param {import("electron").WebContents} contents */
          const created = (_event, contents) => {
            if (contents.getType() === "remote" && contents.session === c.session)
              page.openingDevTools = contents;
          };
          app.on("web-contents-created", created);
          try {
            c.openDevTools({ mode: "detach" });
          } finally {
            app.removeListener("web-contents-created", created);
          }
        }
        break;
    }
    if (["navigate", "reload", "stop"].includes(request.operation)) this.workspace.changed(page);
    return this.presentation.state(page);
  }
}

module.exports = { HumanBrowserCommands };
