// @ts-check
"use strict";
const { hasNativePage } = require("./workspace.cjs");
const { captureGuardStopScript } = require("../preview/capture-guard.cjs");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { readIsolated, nativeWithin, viewportFacts, readViewport } = require("./read-session.cjs");

const { validateEdit, mutate: mutateStyleTrial } = require("../browser-style-trial.cjs");

class PageStyleTrials {
  /**
   * @param {InstanceType<typeof import('./annotations.cjs').PageAnnotations>} annotations
   * @param {InstanceType<typeof import('./human-capture.cjs').HumanPageCapture>} human_capture
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   */
  constructor(annotations, human_capture, presentation, workspace) {
    this.annotations = annotations;
    this.human_capture = human_capture;
    this.presentation = presentation;
    this.workspace = workspace;
  }
  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   * @param {string} captureId
   * @param {string} elementId
   */
  async beginStyleTrial(projectId, threadId, pageId, captureId, elementId) {
    const page = this.workspace.page(projectId, threadId, pageId);
    const selected = page?.annotationElement;
    const frozen = page?.annotationCapture;
    if (
      !hasNativePage(page) ||
      !selected ||
      selected.captureId !== captureId ||
      selected.elementId !== elementId ||
      !frozen ||
      page.styleTrial ||
      page.control !== "human" ||
      page.claiming
    )
      throw new Error("请重新选择当前页面元素");
    if (
      (await this.annotations.checkElement(projectId, threadId, pageId, captureId, elementId))
        .stale ||
      page.annotationElement !== selected ||
      page.annotationCapture !== frozen
    )
      throw new Error("选择的元素已变化");
    if (
      !frozen.guardToken ||
      (await nativeWithin(
        readIsolated(
          page.view.webContents,
          captureGuardStopScript(frozen.guardToken, frozen.guardSequence),
        ),
        performance.now() + 1000,
      )) !== false ||
      page.annotationCapture !== frozen
    )
      throw new Error("选择的元素已变化");
    const trialId = randomUUID();
    page.styleTrial = {
      trialId,
      backendNodeId: selected.backendNodeId,
      pageGeneration: frozen.pageGeneration,
      documentEpoch: frozen.documentEpoch,
      controlEpoch: frozen.controlEpoch,
      nativeWebContentsId: frozen.nativeWebContentsId,
      sourceUrl: frozen.sourceUrl,
      evidence: selected.result,
      history: [],
      cursor: 0,
      commandCount: 0,
      busy: false,
      stale: false,
    };
    page.annotationCaptureId = null;
    page.annotationCapture = null;
    page.annotationElement = null;
    return {
      trialId,
      element: selected.result,
      active: true,
      sourceMapping: selected.result.sourceMapping,
    };
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   * @param {string} trialId
   * @param {string} operation
   * @param {string} property
   * @param {string} value
   */
  async styleTrialCommand(projectId, threadId, pageId, trialId, operation, property, value) {
    const page = this.workspace.page(projectId, threadId, pageId),
      trial = page?.styleTrial;
    const c = page?.view?.webContents;
    if (!trial || trial.trialId !== trialId || !c || trial.busy) throw new Error("页面试改已失效");
    if (operation === "applyStyleTrial") validateEdit(property, value);
    if (operation === "applyStyleTrial" && trial.cursor >= 20)
      throw new Error("页面试改最多20步；请先撤销或发送意图");
    if (trial.commandCount >= 60) throw new Error("页面试改操作已达上限；请清除并重新选择元素");
    /** @type {import("./model.js").CancelableRead|null} */
    let read = null;
    const valid = () =>
      page.styleTrial === trial &&
      !trial.stale &&
      this.workspace.pageStillOwned(page) &&
      this.workspace.owns(projectId, threadId) &&
      page.control === "human" &&
      !page.claiming &&
      page.pageGeneration === trial.pageGeneration &&
      page.documentGeneration === trial.documentEpoch &&
      page.controlEpoch === trial.controlEpoch &&
      page.view?.webContents === c &&
      c.id === trial.nativeWebContentsId &&
      !c.isDestroyed() &&
      !c.isDevToolsOpened() &&
      c.getURL() === trial.sourceUrl &&
      !page.activeAction &&
      page.activeRead === read &&
      !page.activePrepare;
    if (!valid()) {
      trial.stale = true;
      throw new Error("页面试改已失效，请刷新页面");
    }
    const step =
      operation === "undoStyleTrial"
        ? trial.history[trial.cursor - 1]
        : operation === "redoStyleTrial"
          ? trial.history[trial.cursor]
          : null;
    if (operation !== "applyStyleTrial" && !step) return this.styleTrialState(trial);
    const editedProperty = step?.property ?? property;
    const latest = new Map();
    for (const applied of trial.history.slice(0, trial.cursor))
      latest.set(applied.property, applied.after);
    if (operation === "redoStyleTrial" && step && !latest.has(editedProperty))
      latest.set(editedProperty, step.before);
    const checks = [...latest].map(([property, expected]) => ({ property, expected }));
    const replacement =
      operation === "applyStyleTrial"
        ? { value, priority: "" }
        : step
          ? operation === "undoStyleTrial"
            ? step.before
            : step.after
          : { value, priority: "" };
    trial.busy = true;
    trial.commandCount++;
    const deadline = performance.now() + 3000;
    /** @type {(reason:Error)=>void} */
    let rejectCancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      rejectCancel = reject;
    });
    void cancelled.catch(() => {});
    read = { requestId: randomUUID(), cancel: () => rejectCancel(new Error("页面试改已取消")) };
    page.activeRead = read;
    try {
      const result = await mutateStyleTrial(
        c,
        trial.backendNodeId,
        editedProperty,
        checks,
        replacement,
        (promise) => Promise.race([nativeWithin(promise, deadline), cancelled]),
      );
      if (!valid() || result.stale) {
        trial.stale = true;
        throw new Error("应用已修改或替换目标，试改已失效");
      }
      if (operation === "applyStyleTrial" && isDeepStrictEqual(result.before, result.after))
        throw new Error("试改值未改变当前属性");
      if (operation === "applyStyleTrial") {
        trial.history.length = trial.cursor;
        trial.history.push({ property, before: result.before, after: result.after });
        trial.cursor++;
      } else if (operation === "undoStyleTrial") trial.cursor--;
      else trial.cursor++;
      return this.styleTrialState(trial);
    } finally {
      trial.busy = false;
      if (page.activeRead === read) page.activeRead = null;
    }
  }

  /**
   * @param {import('./model.js').StyleTrial} trial
   */
  styleTrialState(trial) {
    return {
      trialId: trial.trialId,
      active: !trial.stale,
      stale: trial.stale,
      canUndo: trial.cursor > 0,
      canRedo: trial.cursor < trial.history.length,
      edits: trial.history.slice(0, trial.cursor).map((step) => ({
        property: step.property,
        before: step.before.value,
        after: step.after.value,
      })),
      element: trial.evidence,
      sourceMapping: trial.evidence.sourceMapping,
    };
  }

  /**
   * @param {string} projectId
   * @param {string} threadId
   * @param {string | undefined} pageId
   * @param {string} trialId
   */
  async captureStyleTrialAfter(projectId, threadId, pageId, trialId) {
    const page = this.workspace.page(projectId, threadId, pageId),
      trial = page?.styleTrial;
    if (
      !hasNativePage(page) ||
      !trial ||
      trial.trialId !== trialId ||
      trial.stale ||
      trial.busy ||
      !trial.cursor
    )
      throw new Error("请先在当前页面完成试改");
    const c = page.view.webContents;
    /** @type {import("./model.js").CancelableRead|null} */
    let read = null;
    const same = () =>
      page.styleTrial === trial &&
      !trial.stale &&
      !trial.busy &&
      this.workspace.pageStillOwned(page) &&
      this.workspace.owns(projectId, threadId) &&
      page.control === "human" &&
      !page.claiming &&
      page.activeRead === read &&
      !page.activeAction &&
      !page.activePrepare &&
      page.pageGeneration === trial.pageGeneration &&
      page.documentGeneration === trial.documentEpoch &&
      page.controlEpoch === trial.controlEpoch &&
      page.view?.webContents === c &&
      c &&
      !c.isDestroyed() &&
      !c.isDevToolsOpened() &&
      c.id === trial.nativeWebContentsId &&
      c.getURL() === trial.sourceUrl;
    if (!same() || c.debugger.isAttached()) throw new Error("试改目标已变化，请刷新页面");
    const deadline = performance.now() + 3000;
    /** @type {(reason:Error)=>void} */
    let rejectCancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      rejectCancel = reject;
    });
    void cancelled.catch(() => {});
    read = { requestId: randomUUID(), cancel: () => rejectCancel(new Error("试改截图已取消")) };
    page.activeRead = read;
    /** @type {import("./model.js").PromiseBound} */
    const bounded = (promise) => Promise.race([nativeWithin(promise, deadline), cancelled]);
    let attached = false,
      cssX,
      cssY,
      viewportKey;
    try {
      const viewport = await bounded(readViewport(c));
      if (!same()) throw new Error("试改目标已变化，请刷新页面");
      viewportKey = viewportFacts(this.presentation.window, page, viewport).key;
      c.debugger.attach("1.3");
      attached = true;
      /** @template {import("./model.js").CdpMethod} M
       * @param {M} method @param {object} [params]
       * @returns {Promise<import("./model.js").CdpResult<M>>} */
      const send = (method, params = {}) => bounded(c.debugger.sendCommand(method, params));
      const [frames, box] = await Promise.all([
        send("Page.getFrameTree"),
        send("DOM.getBoxModel", { backendNodeId: trial.backendNodeId }),
      ]);
      if (!same() || !frames.frameTree?.frame?.id) throw new Error("试改目标已变化，请刷新页面");
      const quad = box.model?.border;
      if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite))
        throw new Error("试改目标已离开页面，请刷新页面");
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.max(0, Math.min(...xs)),
        right = Math.min(viewport.width, Math.max(...xs));
      const top = Math.max(0, Math.min(...ys)),
        bottom = Math.min(viewport.height, Math.max(...ys));
      if (right <= left || bottom <= top) throw new Error("试改目标已离开截图视口，请刷新页面");
      cssX = (left + right) / 2;
      cssY = (top + bottom) / 2;
    } finally {
      if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
      if (page.activeRead === read) page.activeRead = null;
      read = null;
    }
    if (
      !same() ||
      viewportFacts(this.presentation.window, page, await nativeWithin(readViewport(c), deadline))
        .key !== viewportKey
    )
      throw new Error("试改目标已变化，请刷新页面");
    const capture = await this.human_capture.captureRegion(projectId, threadId, pageId);
    try {
      // Recheck the current private node against a new privacy-guarded bitmap.
      // The original screenshot coordinates are invalid after a layout edit.
      if (!same() || page.annotationCapture?.viewportKey !== viewportKey)
        throw new Error("截图期间试改目标已变化，请刷新页面");
      const x = Math.min(
        capture.viewport.bitmapWidth - 1,
        Math.floor(cssX * capture.viewport.bitmapScale.x),
      );
      const y = Math.min(
        capture.viewport.bitmapHeight - 1,
        Math.floor(cssY * capture.viewport.bitmapScale.y),
      );
      const element = await this.annotations.selectElement(
        projectId,
        threadId,
        pageId,
        capture.captureId,
        x,
        y,
        trial.backendNodeId,
      );
      if (!element.available || page.styleTrial !== trial || trial.stale)
        throw new Error("试改目标在截图时已变化，请撤销或刷新");
      return { capture, element, trial: this.styleTrialState(trial) };
    } catch (error) {
      await this.human_capture.discardAnnotationCapture(page, capture.captureId);
      throw error;
    }
  }

  /**
   * @param {import('./model.js').Page} page
   */
  async clearStyleTrial(page) {
    const trial = page?.styleTrial;
    if (!trial) return { cleared: true, stale: false };
    if (trial.busy) throw new Error("页面试改操作仍在进行");
    const c = page.view?.webContents;
    const same =
      c &&
      !c.isDestroyed() &&
      this.workspace.pageStillOwned(page) &&
      page.control === "human" &&
      page.pageGeneration === trial.pageGeneration &&
      page.documentGeneration === trial.documentEpoch &&
      page.controlEpoch === trial.controlEpoch &&
      c.id === trial.nativeWebContentsId &&
      c.getURL() === trial.sourceUrl;
    if (!same || trial.stale) {
      trial.stale = true;
      return { cleared: false, stale: true };
    }
    trial.busy = true;
    const deadline = performance.now() + 3000;
    let cleared = false;
    /** @type {(reason:Error)=>void} */
    let rejectCancel = () => {};
    /** @type {Promise<never>} */
    const cancelled = new Promise((_, reject) => {
      rejectCancel = reject;
    });
    void cancelled.catch(() => {});
    const read = {
      requestId: randomUUID(),
      cancel: () => rejectCancel(new Error("页面试改已取消")),
    };
    if (page.activeRead) {
      trial.busy = false;
      throw new Error("页面正在执行其他原生操作");
    }
    page.activeRead = read;
    try {
      while (trial.cursor > 0) {
        const step = trial.history[trial.cursor - 1];
        const latest = new Map();
        for (const applied of trial.history.slice(0, trial.cursor))
          latest.set(applied.property, applied.after);
        const checks = [...latest].map(([property, expected]) => ({ property, expected }));
        const result = await mutateStyleTrial(
          c,
          trial.backendNodeId,
          step.property,
          checks,
          step.before,
          (promise) => Promise.race([nativeWithin(promise, deadline), cancelled]),
        );
        if (
          result.stale ||
          page.styleTrial !== trial ||
          !this.workspace.pageStillOwned(page) ||
          page.documentGeneration !== trial.documentEpoch ||
          c.getURL() !== trial.sourceUrl
        ) {
          trial.stale = true;
          return { cleared: false, stale: true };
        }
        trial.cursor--;
      }
      cleared = true;
      return { cleared: true, stale: false };
    } finally {
      trial.busy = false;
      if (page.activeRead === read) page.activeRead = null;
      if (cleared && page.styleTrial === trial) page.styleTrial = null;
    }
  }
}

module.exports = { PageStyleTrials };
