// @ts-check
"use strict";

// loadURL 等待全部资源；登录页的慢图片、统计请求不能把已提交的可交互文档变成 UNKNOWN。
// 只接受本次主文档的提交与 dom-ready，旧文档或仅收到导航请求不构成完成证据。
/**
 * @param {import("electron").WebContents} contents
 * @param {string} url
 * @param {Promise<never>} stopped
 * @returns {Promise<{url:string,readiness:"interactive"|"complete"}>}
 */
async function loadNavigationDocument(contents, url, stopped) {
  /** @type {string|null} */
  let committedUrl = null;
  /** @type {(value:{url:string,readiness:"interactive"})=>void} */
  let ready = () => {};
  /** @type {Promise<{url:string,readiness:"interactive"}>} */
  const documentReady = new Promise((resolve) => {
    ready = resolve;
  });
  /** @param {unknown} _event @param {string} _url @param {boolean} inPlace @param {boolean} main */
  const started = (_event, _url, inPlace, main) => {
    if (main && !inPlace) committedUrl = null;
  };
  /** @param {unknown} _event @param {string} nextUrl */
  const committed = (_event, nextUrl) => {
    committedUrl = nextUrl;
  };
  const interactive = () => {
    if (!contents.isDestroyed() && committedUrl && contents.getURL() === committedUrl)
      ready({ url: committedUrl, readiness: "interactive" });
  };
  contents.on("did-start-navigation", started);
  contents.on("did-navigate", committed);
  contents.on("dom-ready", interactive);
  try {
    return await Promise.race([
      contents
        .loadURL(url)
        .then(() => ({ url: contents.getURL(), readiness: /** @type {const} */ ("complete") })),
      documentReady,
      stopped,
    ]);
  } finally {
    contents.removeListener("did-start-navigation", started);
    contents.removeListener("did-navigate", committed);
    contents.removeListener("dom-ready", interactive);
  }
}

module.exports = { loadNavigationDocument };
