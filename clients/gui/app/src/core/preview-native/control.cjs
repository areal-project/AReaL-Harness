// @ts-check
"use strict";
const { hasNativePage } = require("./workspace.cjs");
const { clearCaptureGuardScript } = require("../preview/capture-guard.cjs");
const { pageKey } = require("./identity.cjs");
const { performance } = require("node:perf_hooks");
const { readIsolated, nativeWithin, retainDebuggerAttachment } = require("./read-session.cjs");

class PageControl {
  /**
   * @param {InstanceType<typeof import('./page-diagnostics.cjs').PageDiagnostics>} page_diagnostics
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {() => import("./model.js").HumanGesture | null} activeHumanGesture
   * @param {(page:import("./model.js").Page) => Promise<{cleared:boolean;stale?:boolean}>} clearStyleTrial
   * @param {(identity: import("./model.js").Revocation) => void} onRevoke
   */
  constructor(
    page_diagnostics,
    presentation,
    workspace,
    activeHumanGesture,
    clearStyleTrial,
    onRevoke,
  ) {
    this.page_diagnostics = page_diagnostics;
    this.presentation = presentation;
    this.workspace = workspace;
    this.activeHumanGesture = activeHumanGesture;
    this.clearStyleTrial = clearStyleTrial;
    this.onRevoke = onRevoke;
  }
  /** @param {import("./model.js").Page} page */
  revoke(page, { notify = true } = {}) {
    if (page.control !== "agent") return;
    // This local fence runs before any Core request and before awaiting native input.
    page.control = "transferring";
    page.controlEpoch++;
    page.refs.clear();
    page.plans.clear();
    page.dialogPresentation?.cancel();
    page.approvedActionNavigation = null;
    this.page_diagnostics.clearDiagnostics(page, "control_changed");
    page.lastObservation = null;
    page.lastCapture = null;
    page.needsObservation = true;
    page.view?.setVisible(false);
    page.activeRead?.cancel();
    page.activeSelection?.cancel();
    page.activeAction?.cancel();
    page.commandRecording?.controller.abort();
    page.commandDownloadIntent = null;
    for (const download of page.commandDownloads.values()) download.item?.cancel();
    if (notify)
      this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
    this.workspace.changed(page, "controlChanged");
    void this.convergeInput(page);
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {string} method
   * @param {{type?:string;button?:string;x?:number;y?:number;key?:string;[key:string]:unknown}} params
   * @param {string} [sessionId]
   */
  dispatchInput(page, method, params, sessionId) {
    const c = page.view?.webContents;
    if (!c) throw new Error("plan_stale");
    // Record the native call before awaiting its receipt. A lost receipt leaves
    // takeover transferring rather than pretending the held input was released.
    if (method === "Input.dispatchMouseEvent") {
      if (params.type === "mousePressed")
        page.heldButtons.set(params.button, { x: params.x, y: params.y });
      if (params.type === "mouseMoved" && page.heldButtons.has(params.button))
        page.heldButtons.set(params.button, { x: params.x, y: params.y });
    } else if (method === "Input.dispatchKeyEvent") {
      if (params.type === "keyDown" || params.type === "rawKeyDown")
        page.heldKeys.set(params.key, params);
    }
    // 设备缩放下的 CDP 鼠标坐标使用显示尺寸，计划与 Ref 仍保存网页 CSS 坐标。
    const input =
      method === "Input.dispatchMouseEvent" && page.viewportScale !== undefined
        ? {
            ...params,
            ...(typeof params.x === "number" ? { x: params.x * page.viewportScale } : {}),
            ...(typeof params.y === "number" ? { y: params.y * page.viewportScale } : {}),
          }
        : params;
    const pending = c.debugger.sendCommand(method, input, sessionId).then((value) => {
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased")
        page.heldButtons.delete(params.button);
      if (method === "Input.dispatchKeyEvent" && params.type === "keyUp")
        page.heldKeys.delete(params.key);
      return value;
    });
    page.inputPending.add(pending);
    void pending.finally(() => page.inputPending.delete(pending)).catch(() => {});
    return pending;
  }

  /**
   * @param {import('./model.js').Page} page
   */
  async convergeInput(page) {
    if (page.converging) return page.converging;
    if (!this.workspace.pageStillOwned(page) || !page.view) return;
    const c = page.view.webContents;
    const epoch = page.controlEpoch;
    page.converging = (async () => {
      await Promise.resolve();
      try {
        const deadline = performance.now() + 2000;
        // Commands already submitted to CDP must settle before releases are sent.
        // The deadline bounds the first attempt; a late settlement retries safely.
        while (page.inputPending.size) {
          const pending = [...page.inputPending];
          await nativeWithin(Promise.allSettled(pending), deadline);
        }
        if (c.isDestroyed()) return;
        if (!c.debugger.isAttached() && (page.heldButtons.size || page.heldKeys.size))
          throw new Error("原生输入通道已断开，请关闭页面");
        /** @type {[string,Record<string,unknown>][]} */
        const releases = [
          ...[...page.heldKeys.values()].map(
            /** @returns {[string,Record<string,unknown>]} */ (key) => [
              "Input.dispatchKeyEvent",
              {
                type: "keyUp",
                key: key.key,
                code: key.code,
                windowsVirtualKeyCode: key.windowsVirtualKeyCode,
              },
            ],
          ),
          ...[...page.heldButtons].map(
            /** @returns {[string,Record<string,unknown>]} */ ([button, point]) => [
              "Input.dispatchMouseEvent",
              { type: "mouseReleased", button, x: point.x, y: point.y, clickCount: 1 },
            ],
          ),
        ];
        for (const [method, params] of releases)
          await nativeWithin(this.dispatchInput(page, method, params), deadline);
        if (page.inputPending.size)
          await nativeWithin(Promise.allSettled(page.inputPending), deadline);
        if (page.heldButtons.size || page.heldKeys.size)
          throw new Error("原生输入释放未确认，请关闭页面");
        if (c.debugger.isAttached()) {
          if (page.fileChooserIntercepted) {
            await nativeWithin(
              c.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }),
              deadline,
            );
            page.fileChooserIntercepted = false;
          }
          c.debugger.detach();
        }
        if (page.control === "transferring" && page.controlEpoch === epoch) {
          page.control = "human";
          page.transferError = null;
          page.view?.setVisible(
            !this.presentation.suppressedPresentation &&
              this.workspace.pageStillOwned(page) &&
              this.presentation.owner ===
                pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id) &&
              page.requestedVisible === true,
          );
          this.workspace.changed(page, "controlChanged");
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        page.transferError = error.message;
        // Keep the view hidden. A later native receipt may allow convergence.
        if (
          page.control === "transferring" &&
          page.controlEpoch === epoch &&
          page.inputPending.size
        )
          void Promise.allSettled(page.inputPending).then(() => {
            page.converging = null;
            if (page.control === "transferring" && page.controlEpoch === epoch)
              void this.convergeInput(page);
          });
      } finally {
        page.converging = null;
      }
    })();
    return page.converging;
  }

  revokeAll() {
    for (const page of this.workspace.pages.values()) this.revoke(page);
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   */
  controlPermit(projectId, threadId, pageId) {
    this.workspace.profile.assertAvailable();
    const page = this.workspace.page(projectId, threadId, pageId);
    const c = page?.view?.webContents;
    if (
      !page ||
      !this.workspace.pageStillOwned(page) ||
      page.control !== "agent" ||
      !c ||
      !hasNativePage(page) ||
      c.isDestroyed() ||
      page.crashed
    )
      throw new Error("plan_stale");
    return {
      pageId: page.id,
      browserHostId: this.workspace.browserHostId,
      hostGeneration: this.workspace.hostGeneration,
      pageGeneration: page.pageGeneration,
      controlEpoch: page.controlEpoch,
      origin: new URL(c.getURL()).origin,
    };
  }

  /**
   * @param {import('./model.js').Page} page
   */
  noteHumanInput(page) {
    page.humanRevision = (page.humanRevision ?? 0) + 1;
    page.claiming?.cancel();
    // Human 阶段也撤销等待 Core 审批的潜在认领，防止审批迟到重新观察人工内容。
    if (page.control === "human")
      this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
    this.revoke(page);
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   */
  async claim(projectId, threadId, pageId) {
    this.workspace.profile.assertAvailable();
    const page = this.workspace.page(projectId, threadId, pageId);
    if (
      !page?.view ||
      page.crashed ||
      page.view.webContents.isDestroyed() ||
      page.view.webContents.isDevToolsOpened() ||
      !page.view.webContents.getURL() ||
      !this.workspace.owns(projectId, threadId)
    )
      throw new Error("当前聊天没有可认领的页面");
    if (page.frameGrant) throw new Error("请先撤销嵌入站点授权并关闭页面，再交还 Agent");
    if (
      page.control !== "human" ||
      this.activeHumanGesture()?.page === page ||
      page.claiming ||
      page.activeSelection ||
      page.annotationCaptureId ||
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      page.fileHandoff ||
      page.downloads.size
    )
      throw new Error("浏览页面当前不可认领");
    const dialogPresentation = page.dialogPresentation;
    if (!dialogPresentation) throw new Error("Browser page unavailable");
    dialogPresentation.assertClaimable();
    if (page.styleTrial && !(await this.clearStyleTrial(page)).cleared)
      throw new Error("页面试改已失效，请刷新页面后再交还 Agent");
    this.workspace.profile.assertAvailable();
    const c = page.view.webContents;
    const initial = {
      pageGeneration: page.pageGeneration,
      documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch,
      url: c.getURL(),
    };
    /** @type {(reason:Error)=>void} */
    let rejectClaim = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      rejectClaim = reject;
    });
    const claim = { cancel: () => rejectClaim(new Error("Browser claim was revoked")) };
    page.claiming = claim;
    page.activeRead = claim;
    const timer = setTimeout(claim.cancel, 5000);
    let grantedEpoch;
    try {
      // Any capture guard left by a revoked read observed only a private
      // boolean; discard it before re-enabling Agent observations.
      await Promise.race([readIsolated(c, clearCaptureGuardScript), cancelled]);
      this.workspace.profile.assertAvailable();
      if (
        !this.workspace.pageStillOwned(page) ||
        page.claiming !== claim ||
        page.control !== "human" ||
        page.pageGeneration !== initial.pageGeneration ||
        page.documentGeneration !== initial.documentEpoch ||
        page.controlEpoch !== initial.controlEpoch ||
        c.isDestroyed() ||
        c.getURL() !== initial.url ||
        c.isDevToolsOpened()
      )
        throw new Error("Browser claim was revoked");
      dialogPresentation.assertClaimable();
      retainDebuggerAttachment(c);
      page.control = "agent";
      grantedEpoch = ++page.controlEpoch;
      page.refs.clear();
      page.plans.clear();
      page.batchProgress = null;
      page.lastObservation = null;
      page.needsObservation = true;
      this.page_diagnostics.clearDiagnostics(page, "new_control_epoch");
      if (!c.debugger.isAttached()) c.debugger.attach("1.3");
      // Runtime.enable and Console.enable can replay earlier page messages.
      // Electron's live console-message event supplies Console evidence; CDP
      // Network starts only after this explicit enable receipt.
      await Promise.race([
        c.debugger.sendCommand("Network.enable", { maxPostDataSize: 0 }),
        cancelled,
      ]);
      // An indirect Agent click may open an <input type=file> chooser. Keep
      // Chromium's chooser suppressed for the entire Agent control epoch.
      await Promise.race([c.debugger.sendCommand("Page.enable"), cancelled]);
      await Promise.race([
        c.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }),
        cancelled,
      ]);
      page.fileChooserIntercepted = true;
      if (
        !this.workspace.pageStillOwned(page) ||
        page.claiming !== claim ||
        page.control !== "agent" ||
        page.pageGeneration !== initial.pageGeneration ||
        page.documentGeneration !== initial.documentEpoch ||
        page.controlEpoch !== grantedEpoch ||
        c.isDestroyed() ||
        c.getURL() !== initial.url ||
        c.isDevToolsOpened()
      )
        throw new Error("Browser claim was revoked");
      page.diagnosticsStartedAt = Date.now() / 1000;
      page.diagnosticsReady = true;
      this.workspace.changed(page, "controlChanged");
      return {
        protocol: "areal.browser.host.v1",
        operations: [
          "describe",
          "observe",
          "capture",
          "act",
          "wait",
          "navigate",
          "newPage",
          "diagnostics",
          "runBatch",
          "command",
        ],
        available: true,
        coreInstanceId: page.coreInstanceId,
        projectId,
        threadId,
        pageId: page.id,
        browserHostId: this.workspace.browserHostId,
        hostGeneration: this.workspace.hostGeneration,
        pageGeneration: initial.pageGeneration,
        controlEpoch: grantedEpoch,
      };
    } catch (error) {
      if (page.control === "agent" && page.controlEpoch === grantedEpoch) this.revoke(page);
      throw error;
    } finally {
      clearTimeout(timer);
      if (page.claiming === claim) page.claiming = null;
      if (page.activeRead === claim) page.activeRead = null;
    }
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   */
  takeover(projectId, threadId, pageId) {
    const page = this.workspace.page(projectId, threadId, pageId);
    if (page) {
      page.activeSelection?.cancel();
      page.claiming?.cancel();
      this.revoke(page);
    }
    return this.presentation.state(page);
  }
}

module.exports = { PageControl };
