// @ts-check
"use strict";
const { bitmapPoint } = require("../preview/geometry.cjs");
const { hasNativePage } = require("./workspace.cjs");
const { safeText } = require("../preview/diagnostics.cjs");
const { captureGuardChangedScript } = require("../preview/capture-guard.cjs");
const { pageKey } = require("./identity.cjs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { readIsolated, nativeWithin, viewportFacts, readViewport } = require("./read-session.cjs");

class PageAnnotations {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./human-capture.cjs').HumanPageCapture>} human_capture
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, human_capture, presentation, workspace) {
    this.control = control;
    this.human_capture = human_capture;
    this.presentation = presentation;
    this.workspace = workspace;
  }
  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   */
  async captureElement(projectId, threadId, pageId) {
    const page = this.workspace.page(projectId, threadId, pageId);
    if (page?.control === "transferring") await this.control.convergeInput(page);
    if (page?.frameGrant?.status === "active")
      return {
        capture: await this.human_capture.captureRegion(projectId, threadId, pageId),
        element: {
          available: false,
          reason: "iframe 内容无法可靠识别，请使用区域标注；未生成选择器",
        },
      };
    const c = page?.view?.webContents;
    const key = page && pageKey(page.coreInstanceId, projectId, threadId, page.id);
    if (
      !page ||
      page.id !== pageId ||
      !c ||
      !hasNativePage(page) ||
      !this.workspace.pageStillOwned(page) ||
      !this.workspace.owns(projectId, threadId) ||
      page.control !== "human" ||
      page.crashed ||
      c.isDestroyed() ||
      c.isDevToolsOpened() ||
      c.debugger.isAttached() ||
      page.claiming ||
      page.activeRead ||
      page.activeSelection ||
      page.activeAction ||
      page.activePrepare ||
      page.annotationCaptureId ||
      !page.view.getVisible() ||
      this.presentation.owner !== key ||
      !this.presentation.window.isVisible() ||
      this.presentation.window.isMinimized()
    )
      throw new Error("请先接管并显示当前页面，再选择元素");
    const generation = page.pageGeneration,
      document = page.documentGeneration;
    const control = page.controlEpoch,
      url = c.getURL(),
      view = page.view;
    const valid = () =>
      this.workspace.pageStillOwned(page) &&
      this.workspace.owns(projectId, threadId) &&
      page.view === view &&
      this.presentation.owner === key &&
      page.control === "human" &&
      page.pageGeneration === generation &&
      page.documentGeneration === document &&
      page.controlEpoch === control &&
      !c.isDestroyed() &&
      c.getURL() === url &&
      page.activeSelection === selection &&
      !selection.cancelled &&
      view.getVisible() &&
      this.presentation.window.isVisible() &&
      !this.presentation.window.isMinimized();
    /** @type {(value:number)=>void} */
    let resolvePick = () => {};
    /** @type {(error:Error)=>void} */
    let rejectPick = () => {};
    /** @type {(error:Error)=>void} */
    let rejectCancel = () => {};
    /** @type {Promise<number>} */
    const picked = new Promise((resolve, reject) => {
      resolvePick = resolve;
      rejectPick = reject;
    });
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      rejectCancel = reject;
    });
    void picked.catch(() => {});
    void cancelled.catch(() => {});
    const selection = {
      cancelled: false,
      cancel: () => {
        selection.cancelled = true;
        rejectPick(new Error("元素选择已取消"));
        rejectCancel(new Error("元素选择已取消"));
        page.activeRead?.cancel();
      },
    };
    page.activeSelection = selection;
    let attached = false,
      timer,
      domEnabled = false;
    /** @param {unknown} _event @param {string} method @param {{backendNodeId?:number}} params */
    const onMessage = (_event, method, params) => {
      if (method === "Overlay.inspectNodeRequested" && typeof params?.backendNodeId === "number")
        resolvePick(params.backendNodeId);
      if (method === "Overlay.inspectModeCanceled") rejectPick(new Error("元素选择已取消"));
    };
    const onDetach = () => rejectPick(new Error("元素选择已中断"));
    let commandDeadline = performance.now() + 5000;
    /** @template {import("./model.js").CdpMethod} M
     * @param {M} method @param {object} [params]
     * @returns {Promise<import("./model.js").CdpResult<M>>} */
    const command = (method, params = {}) =>
      Promise.race([
        nativeWithin(c.debugger.sendCommand(method, params), commandDeadline),
        cancelled,
      ]);
    try {
      c.debugger.attach("1.3");
      attached = true;
      c.debugger.on("message", onMessage);
      c.debugger.on("detach", onDetach);
      // Chromium's Overlay agent requires DOM to be enabled first.
      await command("DOM.enable");
      domEnabled = true;
      await command("Overlay.enable");
      await command("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: {
          showInfo: true,
          showRulers: false,
          showExtensionLines: false,
          contentColor: { r: 44, g: 140, b: 255, a: 0.18 },
          borderColor: { r: 44, g: 140, b: 255, a: 0.9 },
        },
      });
      if (!valid() || page.activeSelection !== selection) throw new Error("元素选择已过期");
      timer = setTimeout(selection.cancel, 30000);
      const backendNodeId = await picked;
      if (!valid() || page.activeSelection !== selection || !Number.isSafeInteger(backendNodeId))
        throw new Error("元素选择已过期");
      commandDeadline = performance.now() + 3000;
      const box = await command("DOM.getBoxModel", { backendNodeId }).catch(() => null);
      if (!valid()) throw new Error("元素选择已过期");
      const quad = box?.model?.border;
      const centerX = Array.isArray(quad) ? (quad[0] + quad[4]) / 2 : null;
      const centerY = Array.isArray(quad) ? (quad[1] + quad[5]) / 2 : null;
      // The native inspect overlay is disabled before the guarded screenshot.
      await command("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
      await command("Overlay.disable");
      await command("DOM.disable");
      domEnabled = false;
      c.debugger.removeListener("message", onMessage);
      c.debugger.removeListener("detach", onDetach);
      c.debugger.detach();
      attached = false;
      if (!valid()) throw new Error("元素选择已过期");
      const capture = await this.human_capture.captureRegion(projectId, threadId, pageId);
      const x =
        typeof centerX === "number" && Number.isFinite(centerX)
          ? Math.max(
              0,
              Math.min(
                capture.viewport.bitmapWidth - 1,
                Math.floor(centerX * capture.viewport.bitmapScale.x),
              ),
            )
          : null;
      const y =
        typeof centerY === "number" && Number.isFinite(centerY)
          ? Math.max(
              0,
              Math.min(
                capture.viewport.bitmapHeight - 1,
                Math.floor(centerY * capture.viewport.bitmapScale.y),
              ),
            )
          : null;
      let element;
      try {
        element =
          x === null || y === null
            ? { available: false, reason: "此元素没有可核查的页面边界，请改用区域标注" }
            : await this.selectElement(
                projectId,
                threadId,
                pageId,
                capture.captureId,
                x,
                y,
                backendNodeId,
              );
      } catch (error) {
        await this.human_capture.discardAnnotationCapture(page, capture.captureId);
        throw error;
      }
      if (!valid() || page.annotationCaptureId !== capture.captureId) {
        await this.human_capture.discardAnnotationCapture(page, capture.captureId);
        throw new Error("元素选择已过期");
      }
      return { capture, element };
    } finally {
      clearTimeout(timer);
      if (!c.isDestroyed() && attached && c.debugger.isAttached()) {
        await nativeWithin(
          c.debugger.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }),
          performance.now() + 1000,
        ).catch(() => {});
        await nativeWithin(
          c.debugger.sendCommand("Overlay.disable"),
          performance.now() + 1000,
        ).catch(() => {});
        if (domEnabled)
          await nativeWithin(c.debugger.sendCommand("DOM.disable"), performance.now() + 1000).catch(
            () => {},
          );
        c.debugger.detach();
      }
      c.debugger.removeListener("message", onMessage);
      c.debugger.removeListener("detach", onDetach);
      if (page.activeSelection === selection) page.activeSelection = null;
    }
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   * @param {string} captureId
   * @param {number} x
   * @param {number} y
   * @param {number|null} expectedBackendNodeId
   */
  async selectElement(projectId, threadId, pageId, captureId, x, y, expectedBackendNodeId = null) {
    const page = this.workspace.page(projectId, threadId, pageId);
    const frozen = page?.annotationCapture;
    const c = page?.view?.webContents;
    if (
      !page ||
      page.id !== pageId ||
      page.annotationCaptureId !== captureId ||
      !frozen ||
      !c ||
      !hasNativePage(page) ||
      !this.workspace.pageStillOwned(page) ||
      !this.workspace.owns(projectId, threadId)
    )
      throw new Error("标注页面已变化");
    if (
      page.claiming ||
      page.activeRead ||
      page.activeAction ||
      page.activePrepare ||
      page.control !== "human" ||
      c.isDestroyed() ||
      c.isDevToolsOpened() ||
      c.debugger.isAttached()
    )
      throw new Error("元素选择当前不可用，请使用区域标注");
    if (page.frameGrant?.status === "active")
      return {
        available: false,
        reason: "iframe 内容无法可靠识别，请使用区域标注；未生成选择器",
      };
    if (
      ![x, y].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      x >= frozen.bitmapWidth ||
      y >= frozen.bitmapHeight
    )
      throw new Error("选择位置超出截图");
    const same = () =>
      page.annotationCaptureId === captureId &&
      page.annotationCapture === frozen &&
      this.workspace.pageStillOwned(page) &&
      this.workspace.owns(projectId, threadId) &&
      page.control === "human" &&
      page.controlEpoch === frozen.controlEpoch &&
      page.pageGeneration === frozen.pageGeneration &&
      page.documentGeneration === frozen.documentEpoch &&
      page.view?.webContents === c &&
      c.id === frozen.nativeWebContentsId &&
      !c.isDestroyed() &&
      c.getURL() === frozen.sourceUrl &&
      c.getZoomFactor() === frozen.zoom &&
      this.presentation.window.webContents.getZoomFactor() === frozen.guiZoom &&
      isDeepStrictEqual(page.view.getBounds(), frozen.nativeBounds) &&
      page.viewportRevision === frozen.viewportRevision;
    if (!same()) throw new Error("元素选择已过期，请重新截图");
    /** @type {()=>void} */
    let cancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error("元素选择已取消"));
    });
    void cancelled.catch(() => {});
    const read = { requestId: randomUUID(), cancel };
    page.activeRead = read;
    let attached = false;
    /** @param {string} reason */
    const unavailable = (reason) => ({ available: false, reason });
    const deadline = performance.now() + 3000;
    /** @type {import("./model.js").PromiseBound} */
    const bounded = (promise) => Promise.race([nativeWithin(promise, deadline), cancelled]);
    try {
      const currentViewport = await bounded(readViewport(c));
      if (
        !same() ||
        !isDeepStrictEqual(currentViewport, frozen.viewport) ||
        viewportFacts(this.presentation.window, page, currentViewport).key !== frozen.viewportKey
      )
        throw new Error("元素选择已过期，请重新截图");
      if (
        !frozen.guardToken ||
        (await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken)))) !== false
      )
        return unavailable("页面在截图后发生变化，请重新截图或使用区域标注");
      c.debugger.attach("1.3");
      attached = true;
      /** @template {import("./model.js").CdpMethod} M
       * @param {M} method @param {object} [parameters]
       * @returns {Promise<import("./model.js").CdpResult<M>>} */
      const command = (method, parameters = {}) =>
        bounded(c.debugger.sendCommand(method, parameters));
      const point = bitmapPoint(
        {
          ...frozen.viewport,
          bitmapWidth: frozen.bitmapWidth,
          bitmapHeight: frozen.bitmapHeight,
          bitmapScale: frozen.bitmapScale,
        },
        x,
        y,
      );
      const cssX = Math.floor(point.x);
      const cssY = Math.floor(point.y);
      const [hit, frames] = await Promise.all([
        command("DOM.getNodeForLocation", { x: cssX, y: cssY, includeUserAgentShadowDOM: false }),
        command("Page.getFrameTree"),
      ]);
      if (!same()) throw new Error("元素选择已过期，请重新截图");
      if (!hit.backendNodeId || (hit.frameId && hit.frameId !== frames.frameTree?.frame?.id))
        return unavailable("iframe 内容无法可靠识别，请改用区域标注");
      if (expectedBackendNodeId && hit.backendNodeId !== expectedBackendNodeId)
        return unavailable("页面元素在选择与截图之间变化，请改用区域标注");
      const described = await command("DOM.describeNode", {
        backendNodeId: hit.backendNodeId,
        depth: 0,
      });
      const node = described.node;
      if (!same()) throw new Error("元素选择已过期，请重新截图");
      if (!node || ["IFRAME", "FRAME"].includes(node.nodeName))
        return unavailable("iframe 内容无法可靠识别，请改用区域标注");
      if (node.nodeName === "CANVAS")
        return unavailable("Canvas 内部元素没有可核查的 DOM 身份，请改用区域标注");
      if (node.nodeName === "#document-fragment" || node.shadowRootType)
        return unavailable("Shadow DOM 内容无法可靠识别，请改用区域标注");
      const [ax, box] = await Promise.all([
        command("Accessibility.getPartialAXTree", { backendNodeId: hit.backendNodeId }),
        command("DOM.getBoxModel", { backendNodeId: hit.backendNodeId }),
      ]);
      if (!same()) throw new Error("元素选择已过期，请重新截图");
      const semantic = ax.nodes?.find(
        (item) => item.backendDOMNodeId === hit.backendNodeId && !item.ignored,
      );
      const quad = box.model?.border;
      if (!semantic || !Array.isArray(quad) || quad.length !== 8)
        return unavailable("此位置没有可核查的语义元素，请改用区域标注");
      const xs = [quad[0], quad[2], quad[4], quad[6]],
        ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.max(0, Math.floor(Math.min(...xs) * frozen.bitmapScale.x));
      const top = Math.max(0, Math.floor(Math.min(...ys) * frozen.bitmapScale.y));
      const right = Math.min(frozen.bitmapWidth, Math.ceil(Math.max(...xs) * frozen.bitmapScale.x));
      const bottom = Math.min(
        frozen.bitmapHeight,
        Math.ceil(Math.max(...ys) * frozen.bitmapScale.y),
      );
      if (right <= left || bottom <= top) return unavailable("元素已离开截图视口，请改用区域标注");
      const elementId = randomUUID();
      /** @type {import("./model.js").AnnotationEvidence} */
      const result = {
        available: true,
        elementId,
        evidenceRef: `human:${elementId}`,
        role: safeText(semantic.role?.value ?? "unknown", 80),
        name: safeText(semantic.name?.value ?? "", 200),
        bounds: { x: left, y: top, width: right - left, height: bottom - top },
        pageGeneration: frozen.pageGeneration,
        documentEpoch: frozen.documentEpoch,
        controlEpoch: frozen.controlEpoch,
        frameId: hit.frameId ?? frames.frameTree?.frame?.id ?? "main",
        sourceMapping: "unavailable",
      };
      if ((await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken)))) !== false)
        return unavailable("页面在截图后发生变化，请重新截图或使用区域标注");
      if (!same()) throw new Error("元素选择已过期，请重新截图");
      page.annotationElement = { elementId, captureId, backendNodeId: hit.backendNodeId, result };
      return result;
    } catch (error) {
      if (!same()) throw new Error("元素选择已过期，请重新截图");
      throw error;
    } finally {
      if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
      if (page.activeRead === read) page.activeRead = null;
    }
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   * @param {string} captureId
   * @param {string} elementId
   */
  async checkElement(projectId, threadId, pageId, captureId, elementId) {
    const page = this.workspace.page(projectId, threadId, pageId);
    const selected = page?.annotationElement;
    const frozen = page?.annotationCapture;
    const c = page?.view?.webContents;
    if (
      !hasNativePage(page) ||
      !selected ||
      selected.elementId !== elementId ||
      selected.captureId !== captureId ||
      !frozen ||
      !c
    )
      return { stale: true };
    if (
      page.control !== "human" ||
      page.controlEpoch !== frozen.controlEpoch ||
      page.pageGeneration !== frozen.pageGeneration ||
      page.documentGeneration !== frozen.documentEpoch ||
      !this.workspace.pageStillOwned(page) ||
      !this.workspace.owns(projectId, threadId) ||
      c.isDestroyed() ||
      page.view?.webContents !== c ||
      c.id !== frozen.nativeWebContentsId ||
      c.getURL() !== frozen.sourceUrl ||
      c.isDevToolsOpened() ||
      c.debugger.isAttached() ||
      page.viewportRevision !== frozen.viewportRevision ||
      this.presentation.window.webContents.getZoomFactor() !== frozen.guiZoom ||
      !isDeepStrictEqual(page.view.getBounds(), frozen.nativeBounds)
    )
      return { stale: true };
    /** @type {()=>void} */
    let cancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error("元素检查已取消"));
    });
    void cancelled.catch(() => {});
    const read = { requestId: randomUUID(), cancel };
    if (page.claiming || page.activeRead || page.activeAction || page.activePrepare)
      return { stale: true };
    page.activeRead = read;
    let attached = false;
    const deadline = performance.now() + 3000;
    /** @type {import("./model.js").PromiseBound} */
    const bounded = (promise) => Promise.race([nativeWithin(promise, deadline), cancelled]);
    try {
      const viewport = await bounded(readViewport(c));
      if (
        !isDeepStrictEqual(viewport, frozen.viewport) ||
        viewportFacts(this.presentation.window, page, viewport).key !== frozen.viewportKey
      )
        return { stale: true };
      if (
        !frozen.guardToken ||
        (await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken)))) !== false
      )
        return { stale: true };
      c.debugger.attach("1.3");
      attached = true;
      const box = await bounded(
        c.debugger.sendCommand("DOM.getBoxModel", { backendNodeId: selected.backendNodeId }),
      );
      const quad = box.model?.border;
      const centerX = quad && (quad[0] + quad[4]) / 2,
        centerY = quad && (quad[1] + quad[5]) / 2;
      const hit =
        Number.isFinite(centerX) && typeof centerY === "number" && Number.isFinite(centerY)
          ? await bounded(
              c.debugger.sendCommand("DOM.getNodeForLocation", {
                x: Math.round(centerX),
                y: Math.round(centerY),
                includeUserAgentShadowDOM: false,
              }),
            )
          : null;
      /** @type {import("./model.js").CdpResult<"Accessibility.getPartialAXTree">} */
      const ax = await bounded(
        c.debugger.sendCommand("Accessibility.getPartialAXTree", {
          backendNodeId: selected.backendNodeId,
        }),
      );
      const semantic = ax.nodes?.find(
        (item) => item.backendDOMNodeId === selected.backendNodeId && !item.ignored,
      );
      const xs =
        Array.isArray(quad) && quad.length === 8 ? [quad[0], quad[2], quad[4], quad[6]] : null;
      const ys =
        Array.isArray(quad) && quad.length === 8 ? [quad[1], quad[3], quad[5], quad[7]] : null;
      const bounds =
        xs && ys
          ? {
              x: Math.max(0, Math.floor(Math.min(...xs) * frozen.bitmapScale.x)),
              y: Math.max(0, Math.floor(Math.min(...ys) * frozen.bitmapScale.y)),
              right: Math.min(
                frozen.bitmapWidth,
                Math.ceil(Math.max(...xs) * frozen.bitmapScale.x),
              ),
              bottom: Math.min(
                frozen.bitmapHeight,
                Math.ceil(Math.max(...ys) * frozen.bitmapScale.y),
              ),
            }
          : null;
      const original = selected.result.bounds;
      return {
        stale:
          (await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken)))) !==
            false ||
          page.annotationElement !== selected ||
          page.annotationCapture !== frozen ||
          page.control !== "human" ||
          page.controlEpoch !== frozen.controlEpoch ||
          page.documentGeneration !== frozen.documentEpoch ||
          page.viewportRevision !== frozen.viewportRevision ||
          !this.workspace.pageStillOwned(page) ||
          !this.workspace.owns(projectId, threadId) ||
          c.isDestroyed() ||
          c.getURL() !== frozen.sourceUrl ||
          this.presentation.window.webContents.getZoomFactor() !== frozen.guiZoom ||
          !isDeepStrictEqual(page.view.getBounds(), frozen.nativeBounds) ||
          hit?.backendNodeId !== selected.backendNodeId ||
          !bounds ||
          Math.abs(bounds.x - original.x) > 1 ||
          Math.abs(bounds.y - original.y) > 1 ||
          Math.abs(bounds.right - (original.x + original.width)) > 1 ||
          Math.abs(bounds.bottom - (original.y + original.height)) > 1 ||
          safeText(semantic?.role?.value ?? "unknown", 80) !== selected.result.role ||
          safeText(semantic?.name?.value ?? "", 200) !== selected.result.name,
      };
    } catch {
      return { stale: true };
    } finally {
      if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
      if (page.activeRead === read) page.activeRead = null;
    }
  }
}

module.exports = { PageAnnotations };
