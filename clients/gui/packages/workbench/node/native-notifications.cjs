// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {{kind:'completion'|'approval'|'question',projectId:string,threadId?:string,taskId?:string,runId?:string|null,questionId?:string,body:string,silent?:boolean}} NotificationContent */
// 通知来自 Core 活动事件或定时投影的变化；去重提示不替代执行状态。
// The selected Electron Main owns native resources. A null window is used only
// by the shared service, whose click handler opens the existing GUI entrypoint.
/** @param {typeof import('electron').Notification} Notification @param {import('electron').BrowserWindow|null} window @param {unknown} notice @param {(target:import('@areal/workbench/desktop-contract').NotificationTarget)=>void} open */
function showCoreNotification(Notification, window, notice, open) {
  if (window?.isDestroyed() || !Notification.isSupported()) return;
  const titles = {
    completion: "任务已完成",
    approval: "任务需要授权",
    question: "任务需要你的回答",
  };
  if (
    !isNotificationContent(notice) ||
    (typeof notice.threadId !== "string" && typeof notice.taskId !== "string")
  )
    return;
  const target =
    typeof notice.taskId === "string"
      ? {
          projectId: notice.projectId,
          taskId: notice.taskId,
          runId: notice.runId ?? undefined,
          questionId: notice.questionId,
        }
      : typeof notice.threadId === "string"
        ? { projectId: notice.projectId, threadId: notice.threadId }
        : undefined;
  if (!target) return;
  try {
    const notification = new Notification({
      title: titles[notice.kind],
      body: notice.body,
      silent: notice.silent,
    });
    notification.on("click", () => {
      if (window?.isDestroyed()) return;
      if (window) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      open(target);
    });
    notification.on("failed", (_event, error) => console.warn("系统通知未送达：", error));
    notification.show();
    return notification;
  } catch (error) {
    console.warn("无法显示系统通知：", error instanceof Error ? error.message : String(error));
  }
}

/** @param {unknown} value @returns {value is NotificationContent} */
function isNotificationContent(value) {
  return (
    modelRecord(value) &&
    typeof value.projectId === "string" &&
    (value.kind === "completion" || value.kind === "approval" || value.kind === "question") &&
    typeof value.body === "string" &&
    ["threadId", "taskId", "questionId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.runId == null || typeof value.runId === "string") &&
    (value.silent === undefined || typeof value.silent === "boolean")
  );
}
/** @param {unknown} target @returns {import('@areal/workbench/desktop-contract').NotificationTarget|null} */
function readNotificationTarget(target) {
  if (!modelRecord(target) || typeof target.projectId !== "string") return null;
  if ("taskId" in target && typeof target.taskId === "string") {
    const runId = "runId" in target ? target.runId : undefined;
    const questionId = "questionId" in target ? target.questionId : undefined;
    if (
      (runId !== undefined && typeof runId !== "string") ||
      (questionId !== undefined && typeof questionId !== "string")
    )
      return null;
    return { projectId: target.projectId, taskId: target.taskId, runId, questionId };
  }
  if (!("threadId" in target) || typeof target.threadId !== "string") return null;
  return { projectId: target.projectId, threadId: target.threadId };
}
module.exports = { showCoreNotification, readNotificationTarget, isNotificationContent };
