// @ts-check
"use strict";
const { ipcMain, protocol, dialog } = require("electron");
const { readFile } = require("node:fs/promises");
const { resolve, sep, extname } = require("node:path");
const { nativeText } = require("@areal/workbench-service/desktop/core/native-i18n.cjs");
/** @typedef {import('@areal/workbench/desktop-contract').DesktopInvokeArguments} InvokeArguments */
/** @typedef {import('@areal/workbench/desktop-contract').DesktopSendArguments} SendArguments */
/** @typedef {import('@areal/workbench/desktop-contract').DesktopEventArguments} EventArguments */

/** @template {keyof InvokeArguments} N @param {N} channel @param {(event:import('electron').IpcMainInvokeEvent,...args:InvokeArguments[N])=>unknown} listener */
function handleDesktopIpc(channel, listener) {
  ipcMain.handle(channel, listener);
}
/** @template {keyof SendArguments} N @param {N} channel @param {(event:import('electron').IpcMainEvent,...args:SendArguments[N])=>void} listener */
function onDesktopIpc(channel, listener) {
  ipcMain.on(channel, listener);
}
/** @template {keyof EventArguments} N @param {import('electron').WebContents} contents @param {N} channel @param {EventArguments[N]} args */
function sendDesktopEvent(contents, channel, ...args) {
  contents.send(channel, ...args);
}

/** @param {string} guiRoot @param {()=>Promise<{connectSource:string,frameSource:string}>} hostConnectSource */
function registerUiProtocol(guiRoot, hostConnectSource) {
  /** @type {Record<string,string>} */
  const mime = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };

  protocol.handle("areal-ui", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    const path = resolve(
      guiRoot,
      "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!path.startsWith(guiRoot + sep)) return new Response("Not found", { status: 404 });
    try {
      const { connectSource, frameSource } =
        extname(path) === ".html"
          ? await hostConnectSource().catch(() => ({ connectSource: "", frameSource: "" }))
          : { connectSource: "", frameSource: "" };
      return new Response(await readFile(path), {
        headers: {
          "Content-Type": mime[extname(path)] ?? "application/octet-stream",
          "Content-Security-Policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ${connectSource}; worker-src 'self' blob:; object-src 'none'; frame-src areal-mcp: ${frameSource}`,
        },
      });
    } catch {
      return new Response(nativeText("gui.notBuilt"), { status: 404 });
    }
  });
}

/** @param {()=>import('electron').BrowserWindow|undefined} getWindow */
function desktopDialogs(getWindow) {
  /** @param {Electron.MessageBoxOptions} options */
  function showMessageBox(options) {
    const window = getWindow();
    return window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }
  /** @param {Electron.OpenDialogOptions} options */
  function showOpenDialog(options) {
    const window = getWindow();
    return window && !window.isDestroyed()
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options);
  }
  /** @param {Electron.SaveDialogOptions} options */
  function showSaveDialog(options) {
    const window = getWindow();
    return window && !window.isDestroyed()
      ? dialog.showSaveDialog(window, options)
      : dialog.showSaveDialog(options);
  }
  return { showMessageBox, showOpenDialog, showSaveDialog };
}

/** @param {import('electron').App} app @param {typeof import('@areal/workbench-service/desktop/core/diagnostics.cjs')} diagnostics */
function registerDesktopShell(app, diagnostics) {
  app.on("child-process-gone", (_event, details) =>
    diagnostics.record({
      type: "child-process-gone",
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  app.on("render-process-gone", (_event, _contents, details) =>
    diagnostics.record({
      type: "renderer-gone",
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  app.on("will-quit", () => diagnostics.record({ type: "exit-requested", exitCode: 0 }));
  protocol.registerSchemesAsPrivileged([
    { scheme: "areal-mcp", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: "areal-ui", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}
module.exports = {
  registerDesktopShell,
  desktopDialogs,
  handleDesktopIpc,
  onDesktopIpc,
  sendDesktopEvent,
  registerUiProtocol,
};
