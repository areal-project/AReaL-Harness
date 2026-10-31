// @ts-check
"use strict";
const { boundsWithinWindow } = require("../preview/geometry.cjs");
const { performance } = require("node:perf_hooks");

/** @typedef {{readers:number,ownsAttachment:boolean,detached:boolean,onDetach:()=>void}} ReadSession */
/** @type {WeakMap<import("electron").WebContents,ReadSession>} */
const browserReadSessions = new WeakMap();
/** @param {import("electron").WebContents} contents @param {string} code @returns {Promise<unknown>} */
async function readIsolated(contents, code) {
  const debuggerApi = contents.debugger;
  let session = browserReadSessions.get(contents);
  if (!session || session.detached) {
    session = {
      readers: 0,
      ownsAttachment: !debuggerApi.isAttached(),
      detached: false,
      onDetach: () => {},
    };
    const current = session;
    session.onDetach = () => {
      current.detached = true;
    };
    debuggerApi.on("detach", session.onDetach);
    try {
      if (session.ownsAttachment) debuggerApi.attach("1.3");
    } catch (error) {
      debuggerApi.removeListener("detach", session.onDetach);
      throw error;
    }
    browserReadSessions.set(contents, session);
  }
  session.readers++;
  let invalidated = false;
  /** @param {unknown} _event @param {string} _url @param {boolean} _inPlace @param {boolean} main */
  const onNavigation = (_event, _url, _inPlace, main) => {
    if (main) invalidated = true;
  };
  const onDestroyed = () => {
    invalidated = true;
  };
  contents.on("did-start-navigation", onNavigation);
  contents.on("destroyed", onDestroyed);
  const assertCurrent = () => {
    if (invalidated || session?.detached || contents.isDestroyed() || !debuggerApi.isAttached())
      throw new Error("Browser isolated read failed");
  };
  /** @type {import("electron").WebContents["debugger"]["sendCommand"]} */
  const send = async (method, parameters) => {
    assertCurrent();
    const result = await debuggerApi.sendCommand(method, parameters);
    assertCurrent();
    return result;
  };
  try {
    // Electron script injection waits for load completion, including pending subresources.
    const frames = await send("Page.getFrameTree");
    const world = await send("Page.createIsolatedWorld", {
      frameId: frames.frameTree.frame.id,
      worldName: "areal-browser-read",
    });
    if (!Number.isInteger(world.executionContextId))
      throw new Error("Browser isolated read failed");
    const result = await send("Runtime.evaluate", {
      expression: code,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails || result.result?.value === undefined)
      throw new Error("Browser isolated read failed");
    return result.result.value;
  } finally {
    contents.removeListener("did-start-navigation", onNavigation);
    contents.removeListener("destroyed", onDestroyed);
    if (--session.readers === 0) {
      if (browserReadSessions.get(contents) === session) browserReadSessions.delete(contents);
      if (
        session.ownsAttachment &&
        !session.detached &&
        !contents.isDestroyed() &&
        debuggerApi.isAttached()
      )
        debuggerApi.detach();
      debuggerApi.removeListener("detach", session.onDetach);
    }
  }
}
/** @template T @param {Promise<T>} promise @param {number} deadline @returns {Promise<T>} */
async function nativeWithin(promise, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("等待原生输入结算超时，请停止或关闭页面");
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      /** @type {Promise<never>} */ (
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("等待原生输入结算超时，请停止或关闭页面")),
            remaining,
          );
        })
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** @template T @param {Promise<T>} promise @param {number} deadline @returns {Promise<T>} */
async function batchWithin(promise, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("not_sent");
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      /** @type {Promise<never>} */ (
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("not_sent")), remaining);
        })
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** @param {import("electron").BrowserWindow} window @param {import("./model.js").LivePage} page @param {import("./model.js").Viewport} viewport */
function viewportFacts(window, page, viewport) {
  const pageZoom = page.view.webContents.getZoomFactor();
  const guiZoom = window.webContents.getZoomFactor();
  const nativeBounds = page.view.getBounds();
  const key = JSON.stringify([
    viewport.width,
    viewport.height,
    viewport.scrollX,
    viewport.scrollY,
    pageZoom,
    viewport.deviceScaleFactor,
    guiZoom,
    nativeBounds,
    page.viewportScale,
  ]);
  return { ...viewport, pageZoom, guiZoom, nativeBounds, displayScale: page.viewportScale, key };
}
/** @param {import("./model.js").Bounds} value @param {import("electron").BrowserWindow} window */
function rendererBoundsWithinWindow(value, window) {
  const zoom = window.webContents.getZoomFactor();
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error("无效 GUI 缩放");
  if (!value) throw new Error("无效预览区域");
  return boundsWithinWindow(
    {
      x: value.x * zoom,
      y: value.y * zoom,
      width: value.width * zoom,
      height: value.height * zoom,
    },
    window.getContentSize(),
  );
}
/** 网页没有 preload/Node/产品 IPC；任务拥有独立内容与导航历史。 */

/** @param {import("electron").WebContents} contents */
function retainDebuggerAttachment(contents) {
  const session = browserReadSessions.get(contents);
  if (session) session.ownsAttachment = false;
}
/** @param {import("electron").WebContents} contents @returns {Promise<import("./model.js").Viewport>} */
async function readViewport(contents) {
  const value = await readIsolated(
    contents,
    "({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})",
  );
  if (!isViewport(value)) throw new Error("Browser isolated read failed");
  return value;
}
/** @param {unknown} value @returns {value is import("./model.js").Viewport} */
function isViewport(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    "width" in value &&
    typeof value.width === "number" &&
    "height" in value &&
    typeof value.height === "number" &&
    "scrollX" in value &&
    typeof value.scrollX === "number" &&
    "scrollY" in value &&
    typeof value.scrollY === "number" &&
    "deviceScaleFactor" in value &&
    typeof value.deviceScaleFactor === "number"
  );
}
module.exports = {
  readViewport,
  retainDebuggerAttachment,
  readIsolated,
  nativeWithin,
  batchWithin,
  viewportFacts,
  rendererBoundsWithinWindow,
};
