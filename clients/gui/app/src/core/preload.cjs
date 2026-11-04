// @ts-check
"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");
/** @type {import('@areal/workbench/desktop-contract').DesktopInvoke} */
const invokeDesktop = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
/** @type {import('@areal/workbench/desktop-contract').DesktopSend} */
const sendDesktop = (channel, ...args) => ipcRenderer.send(channel, ...args);
/** @template {keyof import('@areal/workbench/desktop-contract').DesktopEventArguments} N
 * @param {N} channel @param {(event:import('electron').IpcRendererEvent,...args:import('@areal/workbench/desktop-contract').DesktopEventArguments[N])=>void} listener */
function onDesktopEvent(channel, listener) {
  return ipcRenderer.on(channel, listener);
}
/** @typedef {import("@areal/workbench/desktop-contract").QuitProgress} QuitProgress */
/** @typedef {import("@areal/workbench/desktop-contract").McpAppDeepLink} McpAppDeepLink */
/** @typedef {import("@areal/workbench/desktop-contract").NotificationTarget} NotificationTarget */
/** @typedef {{pending:number|null,listener:()=>boolean|Promise<boolean>}} QuitSubscription */
/** @type {QuitSubscription|null} */
let quitSubscription = null;
/** @type {QuitProgress} */
let quitProgress = { state: "idle" };
/** @type {Set<(progress:QuitProgress)=>void>} */
const quitProgressListeners = new Set();
onDesktopEvent(
  "areal-core:quit-progress",
  /** @param {unknown} value */ (_event, value) => {
    if (!value || typeof value !== "object" || !("state" in value)) return;
    if (value?.state === "idle") quitProgress = { state: "idle" };
    else if (
      value?.state === "quitting" &&
      "phase" in value &&
      (value.phase === "checking" || value.phase === "stopping" || value.phase === "finishing")
    )
      quitProgress = { state: "quitting", phase: value.phase };
    else return;
    for (const listener of quitProgressListeners) listener(quitProgress);
  },
);
/** @param {QuitSubscription} subscription @param {boolean} allowed */
function answerQuitRequest(subscription, allowed) {
  if (subscription.pending === null) return;
  const id = subscription.pending;
  subscription.pending = null;
  sendDesktop("areal-core:quit-decision", { id, allowed });
}
onDesktopEvent(
  "areal-core:quit-request",
  /** @param {unknown} id */ (_event, id) => {
    if (typeof id !== "number") return;
    const subscription = quitSubscription;
    if (!subscription || subscription.pending !== null) {
      sendDesktop("areal-core:quit-decision", { id, allowed: false });
      return;
    }
    subscription.pending = id;
    void Promise.resolve()
      .then(() => (subscription === quitSubscription ? subscription.listener() : false))
      .then(
        (allowed) => answerQuitRequest(subscription, allowed === true),
        () => answerQuitRequest(subscription, false),
      );
  },
);
/** @satisfies {import("@areal/workbench/desktop-contract").DesktopBridge} */
const desktopBridge = {
  getSnapShotState: () => invokeDesktop("areal-core:snap-shot-state"),
  /** @param {unknown} includeAccessibility */
  requestSnapShotPermissions: (includeAccessibility) =>
    invokeDesktop("areal-core:snap-shot-permissions", includeAccessibility),
  /** @param {unknown} action */
  setupSnapShot: (action) => invokeDesktop("areal-core:snap-shot-setup", action),
  captureSnapShot: () => invokeDesktop("areal-core:snap-shot-capture"),
  /** @param {unknown} shortcut */
  checkSnapShotShortcut: (shortcut) =>
    invokeDesktop("areal-core:snap-shot-shortcut-check", shortcut),
  /** @param {unknown} suppressed */
  setSnapShotShortcutSuppressed: (suppressed) =>
    invokeDesktop("areal-core:snap-shot-shortcut-suppressed", suppressed),
  listPendingSnapShots: () => invokeDesktop("areal-core:snap-shot-pending"),
  /** @param {unknown} id */
  readSnapShot: (id) => invokeDesktop("areal-core:snap-shot-read", id),
  /** @param {unknown} destination */
  setSnapShotAnimationDestination: (destination) =>
    invokeDesktop("areal-core:snap-shot-destination", destination),
  /** @param {unknown} id */
  dismissSnapShotAnimation: (id) => invokeDesktop("areal-core:snap-shot-dismiss", id),
  /** @param {unknown} id */
  acknowledgeSnapShot: (id) => invokeDesktop("areal-core:snap-shot-acknowledge", id),
  /** @param {(event:unknown)=>void} listener */
  onSnapShotEvent: (listener) => {
    /** @param {Electron.IpcRendererEvent} _event @param {unknown} value */
    const handler = (_event, value) => listener(value);
    onDesktopEvent("areal-core:snap-shot-event", handler);
    return () => ipcRenderer.removeListener("areal-core:snap-shot-event", handler);
  },

  /** @param {File} file */
  droppedFilePath: (file) => webUtils.getPathForFile(file),
  getHostTicket: () => ipcRenderer.invoke("areal-native:host-ticket"),
  /** @param {unknown} locale */
  setInterfaceLocale: (locale) => sendDesktop("areal-core:interface-locale", locale),
  /** @returns {Promise<unknown>} */
  presentReady: () => invokeDesktop("areal-core:present-ready"),
  /** @returns {Promise<unknown>} */
  installCommandLineTools: () => invokeDesktop("areal-core:install-command-line-tools"),
  /** @param {(progress:QuitProgress)=>void} listener */
  onQuitProgress: (listener) => {
    quitProgressListeners.add(listener);
    listener(quitProgress);
    return () => quitProgressListeners.delete(listener);
  },
  /** @param {QuitSubscription["listener"]} listener */
  onQuitRequested: (listener) => {
    if (quitSubscription) answerQuitRequest(quitSubscription, false);
    /** @type {QuitSubscription} */
    const subscription = { listener, pending: null };
    quitSubscription = subscription;
    return () => {
      if (quitSubscription === subscription) quitSubscription = null;
      answerQuitRequest(subscription, false);
    };
  },
  /** @returns {Promise<unknown>} */
  updateState: () => invokeDesktop("areal-core:update-state"),
  /** @returns {Promise<unknown>} */
  downloadUpdate: () => invokeDesktop("areal-core:update-download"),
  /** @returns {Promise<unknown>} */
  recoverUpdateResources: () => invokeDesktop("areal-core:update-recover-resources"),
  /** @param {(value:unknown)=>void} listener */
  onUpdate: (listener) => {
    /** @param {import("electron").IpcRendererEvent} _event @param {unknown} value */
    const handler = (_event, value) => listener(value);
    onDesktopEvent("areal-core:update-changed", handler);
    return () => ipcRenderer.removeListener("areal-core:update-changed", handler);
  },
  /** @param {(target:McpAppDeepLink)=>void|Promise<void>} listener */
  onMcpAppDeepLink: (listener) => {
    let active = true;
    /** @type {number|null} */
    let pending = null;
    const handler = () => {
      void invokeDesktop("areal-core:mcp-app-deep-link-target")
        .then(
          /** @param {unknown} target */ async (target) => {
            if (!active || !isMcpAppDeepLink(target) || pending === target.id) return;
            pending = target.id;
            try {
              await listener(target);
              if (active) await invokeDesktop("areal-core:mcp-app-deep-link-consumed", target.id);
            } finally {
              pending = null;
            }
          },
        )
        .catch(() => {});
    };
    onDesktopEvent("areal-core:mcp-app-deep-link", handler);
    handler();
    return () => {
      active = false;
      ipcRenderer.removeListener("areal-core:mcp-app-deep-link", handler);
    };
  },
  /** @param {unknown} operation @param {unknown} request @returns {Promise<unknown>} */
  mcpFormResource: (operation, request) =>
    invokeDesktop("areal-core:mcp-form-resource", operation, request),
  /** @param {unknown} request @returns {Promise<unknown>} */
  mcpApp: (request) => invokeDesktop("areal-core:mcp-app", request),
  /** @param {(value:unknown)=>void} listener */
  onMcpAppEvent: (listener) => {
    /** @param {import("electron").IpcRendererEvent} _event @param {unknown} value */
    const handler = (_event, value) => listener(value);
    onDesktopEvent("areal-core:mcp-app-event", handler);
    return () => ipcRenderer.removeListener("areal-core:mcp-app-event", handler);
  },
  /** @param {unknown} request @returns {Promise<unknown>} */
  preview: (request) => invokeDesktop("areal-core:preview", request),
  /** @param {(value:unknown)=>void} listener */
  onPreviewEvent: (listener) => {
    /** @param {import("electron").IpcRendererEvent} _event @param {unknown} value */
    const handler = (_event, value) => listener(value);
    onDesktopEvent("areal-core:preview-event", handler);
    return () => ipcRenderer.removeListener("areal-core:preview-event", handler);
  },
  /** @returns {Promise<unknown>} */
  snapshot: () => invokeDesktop("areal-core:snapshot"),
  /** @returns {Promise<unknown>} */
  chooseProject: () => invokeDesktop("areal-core:choose-project"),
  /** @returns {Promise<unknown>} */
  chooseTaskDirectory: () => invokeDesktop("areal-core:choose-task-directory"),
  /** @returns {Promise<unknown>} */
  chooseProjectlessDirectory: () => invokeDesktop("areal-core:choose-projectless-directory"),
  /** @param {unknown} request @returns {Promise<unknown>} */
  fileOpen: (request) => invokeDesktop("areal-core:file-open", request),
  /** @param {unknown} name @param {unknown} params @returns {Promise<unknown>} */
  command: (name, params) => invokeDesktop("areal-core:command", name, params),
  /** @param {unknown} id @returns {Promise<unknown>} */
  theme: (id) => invokeDesktop("areal-core:theme", id),
  /** @param {(target:NotificationTarget)=>void} listener */
  onNotificationOpen: (listener) => {
    let active = true;
    /** @type {number|null} */
    let delivered = null;
    const handler = () => {
      void invokeDesktop("areal-core:notification-target")
        .then(
          /** @param {unknown} target */ (target) => {
            if (!active || !isNotificationTarget(target) || delivered === target.id) return;
            delivered = target.id;
            listener(
              typeof target.taskId === "string"
                ? {
                    projectId: target.projectId,
                    taskId: target.taskId,
                    runId: target.runId,
                    questionId: target.questionId,
                  }
                : { projectId: target.projectId, threadId: target.threadId },
            );
            return invokeDesktop("areal-core:notification-consumed", target.id);
          },
        )
        .catch(() => {});
    };
    onDesktopEvent("areal-core:notification-open", handler);
    handler(); // A click while the renderer was loading stays pending in Main.
    return () => {
      active = false;
      ipcRenderer.removeListener("areal-core:notification-open", handler);
    };
  },
  /** @param {unknown} requestId */
  requestProjection: (requestId) => sendDesktop("areal-core:projection-request", requestId),
  /** @param {(value:unknown)=>void} listener */
  onProjection: (listener) => {
    /** @param {import("electron").IpcRendererEvent} _event @param {unknown} value */
    const handler = (_event, value) => listener(value);
    onDesktopEvent("areal-core:projection", handler);
    return () => ipcRenderer.removeListener("areal-core:projection", handler);
  },
  /** @param {(value:unknown)=>void} listener */
  onTheme: (listener) => {
    /** @param {import("electron").IpcRendererEvent} _event @param {unknown} value */
    const handler = (_event, value) => listener(value);
    onDesktopEvent("areal-core:theme-changed", handler);
    return () => ipcRenderer.removeListener("areal-core:theme-changed", handler);
  },
};
contextBridge.exposeInMainWorld("arealDesktop", desktopBridge);

/** @param {unknown} value @returns {value is McpAppDeepLink} */
function isMcpAppDeepLink(value) {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "number" &&
    "pluginId" in value &&
    typeof value.pluginId === "string" &&
    "toolName" in value &&
    typeof value.toolName === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    (!("marketplace" in value) ||
      value.marketplace === undefined ||
      typeof value.marketplace === "string")
  );
}
/** @param {unknown} value @returns {value is NotificationTarget & {id:number}} */
function isNotificationTarget(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !("projectId" in value) ||
    typeof value.projectId !== "string"
  )
    return false;
  if ("taskId" in value && value.taskId !== undefined)
    return (
      typeof value.taskId === "string" &&
      value.taskId.length > 0 &&
      (!("runId" in value) || value.runId === undefined || typeof value.runId === "string") &&
      (!("questionId" in value) ||
        value.questionId === undefined ||
        typeof value.questionId === "string")
    );
  return "threadId" in value && typeof value.threadId === "string";
}
