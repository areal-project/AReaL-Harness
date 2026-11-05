// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
/** @typedef {{kind:'completion'|'approval'|'question',projectId:string,threadId?:string,taskId?:string,runId?:string|null,questionId?:string,body:string,silent?:boolean}} NotificationContent */
/** @typedef {NotificationContent & {id:string}} Notice */
// 通知来自 Core 活动事件或定时投影的变化；去重提示不替代执行状态。
class CoreNotifications {
  /** @param {(notice:Notice)=>void} deliver */
  constructor(deliver) {
    this.deliver = deliver;
    this.seen = new Set();
  }
  /** @param {import('./project-state.cjs').CoreProject} project @param {string} method @param {import('./history-contract.cjs').HistoryNotification} params @param {{threads?:Record<string,{title?:string}>}} library */
  observe(project, method, params, library) {
    let kind, threadId, eventId;
    if (method === "turn/completed" && params?.turn?.status === "completed") {
      kind = "completion";
      threadId = params.threadId;
      eventId = params.turn.id;
      // Worker/coordinator turns are implementation steps, not user turn alerts.
      if (
        params.turn.goal ||
        (typeof threadId === "string" && project.model.state.threads[threadId]?.goalOwner)
      )
        return;
    } else if (
      method === "areal/interaction/requested" &&
      params?.interaction?.status === "pending"
    ) {
      const item = params.interaction;
      if (item.kind !== "approval" && item.kind !== "question") return;
      kind = item.kind;
      threadId = item.threadId;
      eventId = item.requestId;
    } else return;
    if (typeof threadId !== "string" || typeof eventId !== "string") return;
    const id = JSON.stringify([project.id, kind, threadId, eventId]);
    const title =
      library.threads?.[`${project.id}:${threadId}`]?.title ??
      project.model.state.threads[threadId]?.title ??
      project.summaries.find((t) => t.id === threadId)?.title;
    this.publish({
      id,
      kind,
      projectId: project.id,
      threadId,
      body: String(title || "打开任务查看详情").slice(0, 200),
    });
  }
  /** @param {unknown} notice */
  publish(notice) {
    if (!isNotice(notice)) return;
    if (this.seen.has(notice.id)) return;
    this.seen.add(notice.id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    this.deliver(notice);
  }
}

// Notice facts cover every committed event after the watch barrier. The first
// directory snapshot is only a baseline and never generates historical alerts.
class TaskNotificationMonitor {
  /** @param {InstanceType<typeof import('./task-catalog.cjs').OwnerTasks>} owner @param {import('./project-state.cjs').CoreProject} project @param {import('@areal/runtime-client/core').CoreClient} client @param {(notice:Notice)=>void} deliver @param {(error:unknown)=>void} report @param {(rows:import('@areal/workbench/desktop-contract/management-tasks').TaskDirectoryRow[],facts:import('@areal/workbench/desktop-contract/management-tasks').OwnerNoticeFact[],baselineTaskIds:string[])=>Promise<void>} reconcile */
  constructor(owner, project, client, deliver, report, reconcile) {
    this.projectId = project.logicalProjectId ?? project.id;
    this.deliver = deliver;
    this.report = report;
    this.reconcile = reconcile;
    this.hostReady = false;
    this.stopped = false;
    /** @type {Map<string,import('@areal/workbench/desktop-contract/management-tasks').TaskDirectoryRow>} */
    this.rows = new Map();
    /** @type {Map<string,import('@areal/workbench/desktop-contract/management-tasks').OwnerNoticeFact>} */
    this.completions = new Map();
    /** @type {Set<string>} */
    this.baselineTasks = new Set();
    /** @type {Promise<void>|null} */
    this.pending = null;
    /** @type {NodeJS.Timeout|undefined} */
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.observation = owner.attach(
      project,
      client,
      (facts) => {
        for (const fact of facts) {
          if (fact.kind === "taskCompleted" && fact.taskId && fact.runId)
            this.completions.set(`${fact.taskId}:${fact.runId}`, fact);
          const kind =
            fact.kind === "taskCompleted"
              ? "completion"
              : fact.interactionKind === "approval"
                ? "approval"
                : "question";
          const id =
            fact.kind === "taskCompleted"
              ? JSON.stringify([this.projectId, "task-completion", fact.taskId, fact.runId])
              : fact.kind === "questionPending"
                ? JSON.stringify([this.projectId, "task-question", fact.taskId, fact.questionId])
                : JSON.stringify([this.projectId, kind, fact.threadId, fact.interactionId]);
          if (fact.expiresAt != null && fact.expiresAt * 1000 <= Date.now()) continue;
          this.deliver({
            id,
            kind,
            projectId: this.projectId,
            ...(fact.taskId ? { taskId: fact.taskId } : {}),
            ...(fact.runId ? { runId: fact.runId } : {}),
            ...(fact.threadId ? { threadId: fact.threadId } : {}),
            ...(fact.questionId ? { questionId: fact.questionId } : {}),
            body: fact.objectivePreview.slice(0, 200),
          });
        }
      },
      async (rows, baseline) => {
        for (const row of rows) {
          this.rows.set(row.id, row);
          if (baseline && row.mode === "scheduled") this.baselineTasks.add(row.id);
        }
        void this.refresh();
      },
      report,
    );
  }
  start() {
    return this.observation.start();
  }
  ready() {
    this.hostReady = true;
    void this.refresh();
  }
  refresh() {
    if (!this.hostReady || this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.retryTimer) return Promise.resolve();
    const status = { failed: false };
    this.pending = Promise.resolve()
      .then(async () => {
        while (
          !this.stopped &&
          (this.rows.size || this.completions.size || this.baselineTasks.size)
        ) {
          const rows = [...this.rows.values()];
          const facts = [...this.completions.values()];
          const baselineTaskIds = [...this.baselineTasks];
          this.baselineTasks.clear();
          this.rows.clear();
          this.completions.clear();
          try {
            await this.reconcile(rows, facts, baselineTaskIds);
            this.retryAttempt = 0;
          } catch (error) {
            for (const row of rows) if (!this.rows.has(row.id)) this.rows.set(row.id, row);
            for (const fact of facts) this.completions.set(`${fact.taskId}:${fact.runId}`, fact);
            for (const id of baselineTaskIds) this.baselineTasks.add(id);
            status.failed = true;
            this.report(error);
            return;
          }
        }
      })
      .finally(() => {
        this.pending = null;
        if (this.stopped) return;
        if (status.failed) {
          this.retryTimer = setTimeout(
            () => {
              this.retryTimer = undefined;
              void this.refresh();
            },
            Math.min(250 * 2 ** Math.min(this.retryAttempt++, 7), 30000),
          );
          return;
        }
        if (this.rows.size || this.completions.size || this.baselineTasks.size) void this.refresh();
      });
    return this.pending;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.observation.stop();
  }
}

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

class BackgroundNotifications {
  /** @param {typeof import('electron').Notification} Notification @param {()=>unknown} launch */
  constructor(Notification, launch) {
    this.Notification = Notification;
    this.launch = launch;
    this.entries = new Set();
  }
  get active() {
    return this.entries.size > 0;
  }
  /** @param {unknown} notice @param {(target:import('@areal/workbench/desktop-contract').NotificationTarget)=>void} open */
  show(notice, open) {
    const notification = showCoreNotification(this.Notification, null, notice, open);
    if (!notification) return;
    this.entries.add(notification);
    const release = () => this.entries.delete(notification);
    notification.once("click", release);
    notification.once("close", release);
    notification.once("failed", release);
  }
  close() {
    for (const notification of this.entries) notification.close();
    this.entries.clear();
  }
}
/** @param {unknown} value @returns {value is Notice} */
function isNotice(value) {
  return isNotificationContent(value) && "id" in value && typeof value.id === "string";
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
module.exports = {
  readNotificationTarget,
  CoreNotifications,
  TaskNotificationMonitor,
  showCoreNotification,
  BackgroundNotifications,
};
