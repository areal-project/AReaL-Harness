// @ts-check
"use strict";
const { app } = require("electron");
const { join } = require("node:path");
const { handleDesktopIpc, sendDesktopEvent } = require("../desktop-ipc.cjs");
/** @type {typeof import("./DesktopSnapShots.js")} */
const { DesktopSnapShots } = require("./build/DesktopSnapShots.cjs");
const snapShotContract = require("@areal/workbench/desktop-contract/snapshots");
/**
 * @param {{window:()=>Electron.BrowserWindow|null,revealWindow:()=>void,
 * trusted:(event:Electron.IpcMainInvokeEvent)=>Electron.BrowserWindow}} options
 */
function startSnapShots({ window, revealWindow, trusted }) {
  const snapShots = new DesktopSnapShots({
    directory: join(app.getPath("userData"), "snap-shots"),
    workerPath: app.isPackaged
      ? join(
          process.resourcesPath,
          "app.asar.unpacked/src/core/snapshots/build/SnapShotAccessibilityWorker.cjs",
        )
      : join(__dirname, "build/SnapShotAccessibilityWorker.cjs"),
    window,
    revealWindow,
    emit: (value) => {
      const target = window();
      if (
        target &&
        !target.isDestroyed() &&
        target.webContents.mainFrame.url.startsWith("areal-ui://app/")
      )
        sendDesktopEvent(target.webContents, "areal-core:snap-shot-event", value);
    },
  });
  app.on("will-quit", () => snapShots?.close());

  handleDesktopIpc("areal-core:snap-shot-state", async (event) => {
    trusted(event);
    const result = await snapShots.getSnapShotState();
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-permissions", async (event, includeAccessibility) => {
    trusted(event);
    if (typeof includeAccessibility !== "boolean") throw new Error("Invalid SnapShot flag");
    const result = await snapShots.requestSnapShotPermissions(includeAccessibility);
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-setup", async (event, action) => {
    trusted(event);
    if (
      action !== "test-mac-capture" &&
      action !== "allow-screen-recording" &&
      action !== "allow-accessibility" &&
      action !== "retry-shortcut"
    )
      throw new Error("Invalid SnapShot setup action");
    const result = await snapShots.setupSnapShot(action);
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-capture", async (event) => {
    trusted(event);
    const result = await snapShots.captureSnapShot();
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-shortcut-check", async (event, shortcut) => {
    trusted(event);
    const result = await snapShots.checkSnapShotShortcut(
      snapShotContract.readSnapShotShortcut(shortcut),
    );
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-shortcut-suppressed", async (event, suppressed) => {
    trusted(event);
    if (typeof suppressed !== "boolean") throw new Error("Invalid SnapShot flag");
    const result = await snapShots.setSnapShotShortcutSuppressed(suppressed);
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-pending", async (event) => {
    trusted(event);
    const result = await snapShots.pending.list();
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-read", async (event, id) => {
    trusted(event);
    const result = await snapShots.pending.read(snapShotContract.readSnapShotId(id));
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-destination", async (event, destination) => {
    trusted(event);
    const result = await snapShots.setSnapShotAnimationDestination(
      snapShotContract.readSnapShotAnimationDestination(destination),
    );
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-dismiss", async (event, id) => {
    trusted(event);
    const result = await snapShots.dismissSnapShotAnimation(snapShotContract.readSnapShotId(id));
    trusted(event);
    return result;
  });
  handleDesktopIpc("areal-core:snap-shot-acknowledge", async (event, id) => {
    trusted(event);
    const result = await snapShots.acknowledgeSnapShot(snapShotContract.readSnapShotId(id));
    trusted(event);
    return result;
  });
  return snapShots;
}
module.exports = { startSnapShots };
