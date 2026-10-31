// @ts-check
"use strict";
const { captureBitmapScale } = require("../preview/geometry.cjs");
const { hasNativePage } = require("./workspace.cjs");
const { observationUrl } = require("../preview/urls.cjs");
const {
  sensitiveCaptureScript,
  captureGuardStartScript,
  captureGuardStopScript,
  captureGuardChangedScript,
} = require("../preview/capture-guard.cjs");
const { pageKey } = require("./identity.cjs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { readIsolated, nativeWithin, viewportFacts, readViewport } = require("./read-session.cjs");
const { captureHumanFrames } = require("./frame-capture.cjs");

class HumanPageCapture {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(control, presentation, workspace) {
    this.control = control;
    this.presentation = presentation;
    this.workspace = workspace;
  }
  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   */
  async captureRegion(projectId, threadId, pageId) {
    const page = this.workspace.page(projectId, threadId, pageId);
    if (!page || page.id !== pageId || !this.workspace.owns(projectId, threadId))
      throw new Error("页面已关闭");
    // A requested takeover is not human control until the native input barrier completes.
    if (page.control === "transferring") await this.control.convergeInput(page);
    if (!hasNativePage(page) || !this.workspace.pageStillOwned(page)) throw new Error("页面已关闭");
    const c = page.view.webContents;
    const bounds = page.view.getBounds();
    if (
      page.control !== "human" ||
      page.crashed ||
      c.isDestroyed() ||
      c.isDevToolsOpened() ||
      !this.presentation.window.isVisible() ||
      this.presentation.window.isMinimized() ||
      !page.view.getVisible() ||
      this.presentation.owner !== pageKey(page.coreInstanceId, projectId, threadId, pageId) ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      !c.getURL() ||
      page.activeRead ||
      page.activePrepare ||
      page.activeAction ||
      page.annotationCaptureId
    )
      throw new Error("请先接管并显示当前页面，再截图标注");
    const epoch = page.controlEpoch,
      documentEpoch = page.documentGeneration,
      sourceUrl = c.getURL();
    /** @type {()=>void} */
    let cancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(new Error("页面截图已取消或超时"));
    });
    const read = { requestId: randomUUID(), cancel };
    page.activeRead = read;
    const timer = setTimeout(cancel, 10000);
    /** @type {import("./model.js").PromiseBound} */
    const bounded = (promise) => Promise.race([promise, cancelled]);
    const guardToken = randomUUID();
    const guardSequence = (page.nextGuardSequence = (page.nextGuardSequence ?? 0) + 1);
    const valid = () =>
      page.control === "human" &&
      page.controlEpoch === epoch &&
      page.documentGeneration === documentEpoch &&
      this.workspace.pageStillOwned(page) &&
      this.workspace.owns(projectId, threadId) &&
      !c.isDestroyed() &&
      c.getURL() === sourceUrl &&
      page.view?.getVisible() === true &&
      this.presentation.owner === pageKey(page.coreInstanceId, projectId, threadId, pageId) &&
      page.activeRead === read &&
      this.presentation.window.isVisible() &&
      !this.presentation.window.isMinimized();
    /** @type {unknown} */
    let changed = true;
    let frameEvidence;
    try {
      const viewport = await bounded(readViewport(c));
      if (
        !valid() ||
        ![
          viewport.width,
          viewport.height,
          viewport.scrollX,
          viewport.scrollY,
          viewport.deviceScaleFactor,
        ].every(Number.isFinite) ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.deviceScaleFactor <= 0
      )
        throw new Error("页面截图条件已变化");
      const facts = viewportFacts(this.presentation.window, page, viewport);
      const viewportKey = facts.key;
      if (page.viewportKey !== viewportKey) {
        page.viewportKey = viewportKey;
        page.viewportRevision++;
      }
      let image;
      if (page.frameGrant?.status === "active") {
        const captured = await captureHumanFrames(
          c,
          page.frameGrant,
          bounded,
          valid,
          guardToken,
          guardSequence,
        );
        image = captured.image;
        frameEvidence = captured.frames;
        changed = false;
      } else {
        if (
          (await bounded(readIsolated(c, captureGuardStartScript(guardToken, guardSequence)))) !==
          true
        )
          throw new Error("页面截图保护不可用");
        if ((await bounded(readIsolated(c, sensitiveCaptureScript()))) !== false)
          throw new Error("页面包含敏感输入框，无法截图标注");
        image = await bounded(c.capturePage());
        if (!valid() || (await bounded(readIsolated(c, sensitiveCaptureScript()))) !== false)
          throw new Error("页面截图条件已变化");
        changed = await bounded(readIsolated(c, captureGuardChangedScript(guardToken)));
      }
      if (
        changed !== false ||
        !valid() ||
        viewportFacts(this.presentation.window, page, await bounded(readViewport(c))).key !==
          viewportKey
      )
        throw new Error("页面在截图期间发生变化，请重试");
      const size = image.getSize();
      const bitmapScale = captureBitmapScale(facts, size);
      if (
        size.width <= 0 ||
        size.height <= 0 ||
        size.width * size.height > 8_000_000 ||
        size.width > 4096 ||
        size.height > 4096
      )
        throw new Error("截图像素超出限制");
      const png = image.toPNG();
      if (png.length > 2 * 1024 * 1024) throw new Error("截图大小超出限制");
      if (!valid()) throw new Error("页面截图条件已变化");
      const captureId = randomUUID();
      page.annotationCaptureId = captureId;
      page.annotationCapture = {
        documentEpoch,
        controlEpoch: epoch,
        pageGeneration: page.pageGeneration,
        guardToken: frameEvidence ? null : guardToken,
        guardSequence,
        nativeWebContentsId: c.id,
        sourceUrl,
        viewport,
        zoom: facts.pageZoom,
        guiZoom: facts.guiZoom,
        nativeBounds: facts.nativeBounds,
        viewportKey,
        viewportRevision: page.viewportRevision,
        bitmapWidth: size.width,
        bitmapHeight: size.height,
        bitmapScale,
      };
      page.annotationElement = null;
      return {
        captureId,
        projectId,
        threadId,
        pageId,
        coreInstanceId: page.coreInstanceId,
        pageGeneration: page.pageGeneration,
        documentEpoch,
        controlEpoch: epoch,
        viewportRevision: page.viewportRevision,
        url: observationUrl(c.getURL()),
        capturedAt: new Date().toISOString(),
        viewport: {
          ...viewport,
          pageZoom: facts.pageZoom,
          guiZoom: facts.guiZoom,
          nativeBounds: facts.nativeBounds,
          bitmapWidth: size.width,
          bitmapHeight: size.height,
          bitmapScale,
        },
        ...(frameEvidence
          ? {
              frameEvidence,
              unavailableReason: "iframe 内容无法可靠识别，请使用区域标注；未生成选择器",
            }
          : {}),
        mimeType: "image/png",
        imageBase64: png.toString("base64"),
      };
    } finally {
      clearTimeout(timer);
      if (page.annotationCapture?.guardToken !== guardToken && !c.isDestroyed())
        await nativeWithin(
          readIsolated(c, captureGuardStopScript(guardToken, guardSequence)),
          performance.now() + 1000,
        ).catch(() => {});
      if (page.activeRead === read) page.activeRead = null;
    }
  }

  /**
   * @param {import('./model.js').Page} page
   * @param {string} captureId
   */
  async discardAnnotationCapture(page, captureId) {
    // 迟到的结束/失败只清理自身截图，不能移除新截图的变化保护。
    if (page.annotationCaptureId !== captureId) return;
    const frozen = page.annotationCapture,
      contents = page.view?.webContents;
    page.annotationCaptureId = null;
    page.annotationCapture = null;
    page.annotationElement = null;
    if (frozen?.guardToken && contents && !contents.isDestroyed())
      await nativeWithin(
        readIsolated(contents, captureGuardStopScript(frozen.guardToken, frozen.guardSequence)),
        performance.now() + 1000,
      ).catch(() => {});
  }
  // Human-only inspection of a point on the frozen native bitmap. The returned
  // evidence Ref deliberately never enters page.refs, which is Agent-owned.
}

module.exports = { HumanPageCapture };
