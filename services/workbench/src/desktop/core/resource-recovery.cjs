// @ts-check
"use strict";
const { isAwaitingResponse } = require("./project-state.cjs");
const {
  readQueueCounts,
  readResourceStatus,
  readResourceProcesses,
  readResourceTasks,
  readResourceGoal,
} = require("@areal/workbench/desktop-contract/desktop-control-resources");
/** @typedef {InstanceType<typeof import('./backend.cjs').CoreBackend>} Backend */
/** @typedef {import('@areal/workbench/desktop-contract/desktop-control-resources').ResourceInspection} Inspection */
/** @typedef {import('@areal/workbench/desktop-contract/desktop-control-resources').RecoveryResource} Resource */
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
      /** @type {import('@areal/workbench/desktop-contract/desktop-control-resources').RecoveryTask[]} */
      const tasks = [];
      /** @type {import('@areal/workbench/desktop-contract/desktop-control-resources').RecoveryGoal[]} */
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
module.exports = { inspectResources };
