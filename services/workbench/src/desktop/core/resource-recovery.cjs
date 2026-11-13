// @ts-check
"use strict";
const { isAwaitingResponse } = require("./project-state.cjs");
const { randomUUID } = require("node:crypto");
const {
  readQueueCounts,
  readResourceStatus,
  readResourceProcesses,
  readResourceTasks,
  readResourceGoal,
  readResourceInspections,
} = require("./resource-observation.cjs");
/** @typedef {InstanceType<typeof import('./backend.cjs').CoreBackend>} Backend */
/** @typedef {import('./resource-observation.cjs').ResourceInspection} Inspection */
/** @typedef {import('./resource-observation.cjs').RecoveryResource} Resource */
/** @typedef {(options:Electron.MessageBoxOptions)=>Promise<Electron.MessageBoxReturnValue>} Notify */
/** @param {string} message */
const blocked = (message) => Object.assign(new Error(message), { code: "CORE_RESOURCES" });
const { coreLifecycle } = require("./lifecycle.cjs");
/** @param {unknown} status */
const restartSafe = (status) => coreLifecycle(status).ifIdle.allowed;
const QUIT_INSPECTION_TIMEOUT_MS = 5000;
/** @param {unknown} error */
const unavailableRead = (error) =>
  ["DISCONNECTED", "RESPONSE_UNKNOWN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].some(
    (code) => code === require("@areal/workbench/desktop-contract").desktopError(error).code,
  );

// Observe every connected Workspace before touching any of them. No drain here:
// drain closes Core admission and cannot be undone by the GUI.
/** @param {Backend} backend @param {{includeTasks?:boolean,purpose?:string}} [options] @returns {Promise<Inspection[]>} */
async function inspectResources(backend, { includeTasks = false, purpose } = {}) {
  await backend.refreshHostProjects();
  const deadline = purpose === "quit" ? Date.now() + QUIT_INSPECTION_TIMEOUT_MS : null;
  /** @type {Inspection[]} */
  const projects = [];
  const engines = new Map(backend.projects);
  for (const [projectId, project] of engines) {
    await backend.loadProjectJournal(projectId);
    if (project.service && !project.client?.ready && backend.applicationOwner && purpose !== "quit")
      await backend.reconnectProject(project);
    const identity = {
      projectId,
      root: project.root,
      serviceId: project.service?.serviceId,
      generation: project.service?.generation,
    };
    if (!project.client?.ready) {
      if (project.service && purpose === "quit") {
        projects.push({ ...identity, observation: "unavailable" });
        continue;
      }
      if (project.service) throw new Error("Core 连接未恢复，无法确认是否可安全停止");
      continue;
    }
    const client = project.client;
    /** @template T @param {string} method @param {object|undefined} params @param {(value:unknown)=>T} decode */
    const request = (method, params, decode) => {
      const timeoutMs = deadline === null ? undefined : deadline - Date.now();
      if (timeoutMs !== undefined && timeoutMs <= 0)
        throw Object.assign(new Error("后台状态读取超时"), { code: "RESPONSE_UNKNOWN" });
      return client.request(method, params, {
        decode,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    };
    try {
      const status = await request("areal/server/status", undefined, readResourceStatus);
      /** @type {Resource[]} */
      const resources = [];
      const resourceThreads = (status.resources ?? [])
        .map((resource) => resource.threadId)
        .filter(/** @returns {id is string} */ (id) => typeof id === "string" && id.length > 0);
      for (const threadId of new Set(resourceThreads)) {
        const processes = await request("areal/process/list", { threadId }, readResourceProcesses);
        for (const p of processes.data ?? [])
          if (!p.cleanupConfirmed)
            resources.push({
              projectId,
              threadId,
              id: p.id,
              epoch: p.runtimeEpoch,
              state: p.state,
              // No command arguments: they can contain credentials.
              executable: p.argv?.[0] ?? "",
              stale:
                typeof (status.runtime?.runtimeEpoch ?? status.runtime?.epoch) === "string" &&
                p.runtimeEpoch !== (status.runtime?.runtimeEpoch ?? status.runtime?.epoch),
            });
      }
      /** @type {import('./resource-observation.cjs').RecoveryTask[]} */
      const tasks = [];
      /** @type {import('./resource-observation.cjs').RecoveryGoal[]} */
      const goals = [];
      if (includeTasks) {
        /** @type {string|null|undefined} */
        let after;
        /** @type {Set<string|null|undefined>} */
        const cursors = new Set();
        do {
          const page = await request(
            "areal/task/list",
            { limit: 100, ...(after ? { after } : {}) },
            readResourceTasks,
          );
          for (const task of page.data) {
            if (task.mode === "foreground") {
              const { goal } = await request(
                "areal/goal/get",
                { threadId: task.threadId },
                readResourceGoal,
              );
              if (goal && !["completed", "cancelled"].includes(goal.status))
                goals.push({
                  threadId: task.threadId,
                  status: goal.status,
                  objective: goal.objective,
                });
            } else if (!task.cancelled)
              tasks.push({
                id: task.id,
                threadId: task.threadId,
                mode: task.mode,
                objective: task.objective,
                paused: task.paused,
                nextRunAt: task.nextRunAt,
                running: task.runs.some((run) => run.status === "running"),
              });
          }
          after = page.nextCursor;
          if (after && cursors.has(after)) throw new Error("任务列表分页未前进，请刷新后台状态");
          cursors.add(after);
        } while (after);
      }
      projects.push({
        ...identity,
        observation: "known",
        lifecycle: coreLifecycle(status),
        restartSafe: restartSafe(status),
        resources,
        activeTurns: status.activeTurns?.length ?? 0,
        unresolvedTools: status.unresolvedTools?.length ?? 0,
        compactions: status.compactions?.length ?? 0,
        workgroups: (status.workgroups ?? []).filter(
          (g) => g.status === "running" || !g.cleanupConfirmed,
        ).length,
        activeThreads: (status.activeTurns ?? []).map((t) => ({
          threadId: t.threadId,
          turnId: t.turnId,
        })),
        goalThreads: status.activeGoals ?? [],
        activeTasks: status.activeTasks ?? 0,
        ...(includeTasks ? { tasks, goals } : {}),
        waitingMessages: status.pendingQueueItems ?? 0,
        queues: Object.entries(project.model?.state.queues ?? {})
          .map(([threadId, queue]) => ({
            threadId,
            paused: queue.paused === true,
            ...readQueueCounts(queue.items),
          }))
          .filter((queue) => queue.pending || queue.running),
        pendingRequests: (project.pending ?? []).map((entry) => ({
          threadId: entry.params.threadId,
          awaitingResponse: isAwaitingResponse(backend.awaitingResponses, project.id, entry),
        })),
      });
    } catch (error) {
      if (purpose !== "quit" || !project.service || !unavailableRead(error)) throw error;
      projects.push({ ...identity, observation: "unavailable" });
    }
  }
  return projects;
}
/** @param {Backend} backend @param {{projectId:string,threadId:string,id:string,epoch:string,operation:string,confirmed?:boolean}} request */
async function recoverResource(backend, request) {
  const projects = await inspectResources(backend);
  const target = projects
    .find((p) => p.projectId === request.projectId)
    ?.resources?.find((p) => p.threadId === request.threadId && p.id === request.id);
  if (!target || target.epoch !== request.epoch) throw new Error("资源状态已变化，请重新检查");
  const client = backend.projects.get(target.projectId)?.client;
  if (!client) throw new Error("Core 连接未恢复，无法确认资源清理");
  if (target.stale) {
    if (request.operation !== "acknowledge" || request.confirmed !== true)
      throw new Error("请先核实旧终端及其子进程已结束，再确认清理");
    await client.request("areal/process/acknowledgeCleanup", {
      threadId: target.threadId,
      id: target.id,
      note: "用户在 Harness 资源恢复对话框中明确确认：已检查旧终端及其子进程均已结束。仅确认资源清理，不改变历史执行结果。",
    });
  } else {
    if (request.operation !== "terminate")
      throw new Error("当前 Runtime 资源必须通过 Runtime 关闭");
    await client.request("areal/process/terminate", {
      threadId: target.threadId,
      id: target.id,
      requestId: randomUUID(),
    });
  }
  const remaining = await client.request(
    "areal/process/list",
    { threadId: target.threadId },
    { decode: readResourceProcesses },
  );
  if (!remaining.data?.find((p) => p.id === target.id)?.cleanupConfirmed)
    throw new Error("Core 尚未确认资源清理，请重新检查");
  return { cleanupConfirmed: true };
}
/** @param {Inspection[]} projects */
function summary(projects) {
  return projects
    .filter((p) => !p.restartSafe || p.activeTasks || p.goalThreads?.length || p.waitingMessages)
    .map(
      (p) =>
        `${p.root ?? p.projectId}\n终端 ${p.resources?.length ?? 0} · 活动轮次 ${p.activeTurns ?? 0} · 活动目标 ${p.goalThreads?.length ?? 0} · 后台任务 ${p.activeTasks ?? 0} · 排队消息 ${p.waitingMessages ?? 0}\n未确认工具 ${p.unresolvedTools ?? 0} · 上下文压缩 ${p.compactions ?? 0} · 子任务组 ${p.workgroups ?? 0}`,
    )
    .join("\n\n");
}
// Native main-process interaction; never expose an unrestricted attestation RPC
// or credentials to the renderer. Cancellation never changes Core records.
/** @param {{backend:Pick<InstanceType<typeof import('../../../../../clients/gui/app/src/core/service-client.cjs').SharedCoreBackend>,'resources'>,notify:Notify}} options */
function createResourceRecovery({ backend, notify }) {
  let opened = false;
  return async () => {
    if (opened) return;
    opened = true;
    try {
      const projects = readResourceInspections(await backend.resources({ operation: "inspect" }));
      const pending = projects.flatMap((p) =>
        (p.resources ?? []).map((r) => ({ ...r, root: p.root })),
      );
      if (!pending.length) {
        await notify({
          type: "info",
          message: projects.every((p) => p.restartSafe) ? "后台资源已就绪" : "还有其他操作阻止更新",
          detail: summary(projects) || "可以从“检查更新…”重试安装。",
          buttons: ["确定"],
        });
        return;
      }
      for (const r of pending) {
        const detail = `工作区：${r.root}\n会话：${r.threadId}\n资源：${r.id}\n程序：${r.executable}\n状态：${r.state}\n\n`;
        const answer = await notify({
          type: "warning",
          message: r.stale ? "检查旧终端的清理状态" : "关闭阻止更新的终端？",
          detail:
            detail +
            (r.stale
              ? "此终端属于已退出的 Runtime，应用无法确认其进程是否仍存在。请在系统活动监视器或终端中核实对应终端及其子进程已结束；无法确定时请选择稍后处理。确认仅记录清理证据，不会把历史执行改为成功。"
              : "将通过 Runtime 结束此终端及其资源。请先保存该终端中的工作。"),
          buttons: ["稍后处理", r.stale ? "确认已清理" : "关闭终端"],
          defaultId: 0,
          cancelId: 0,
          ...(r.stale
            ? { checkboxLabel: "我已核实该终端及其子进程均已结束", checkboxChecked: false }
            : {}),
        });
        if (answer.response !== 1) return;
        if (r.stale && !answer.checkboxChecked) {
          await notify({
            type: "info",
            message: "尚未确认清理",
            detail: "请完成进程核实后，再勾选确认。记录未修改。",
            buttons: ["确定"],
          });
          return;
        }
        await backend.resources({
          operation: r.stale ? "acknowledge" : "terminate",
          projectId: r.projectId,
          threadId: r.threadId,
          id: r.id,
          epoch: r.epoch,
          confirmed: r.stale,
        });
      }
      const after = readResourceInspections(await backend.resources({ operation: "inspect" }));
      await notify({
        type: "info",
        message: after.every((p) => p.restartSafe) ? "资源清理已确认" : "仍有操作阻止更新",
        detail: summary(after) || "可以从“检查更新…”重试安装，已下载的更新无需重复下载。",
        buttons: ["确定"],
      });
    } catch (error) {
      await notify({
        type: "error",
        message: "资源处理未完成",
        detail: require("@areal/workbench/desktop-contract").desktopError(error).message,
        buttons: ["确定"],
      });
    } finally {
      opened = false;
    }
  };
}
module.exports = {
  inspectResources,
  recoverResource,
  createResourceRecovery,
  summary,
  blocked,
  restartSafe,
};
