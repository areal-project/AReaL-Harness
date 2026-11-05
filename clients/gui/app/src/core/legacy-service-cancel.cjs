// @ts-check
"use strict";

const { readFile, readdir, writeFile, rename, rm, realpath } = require("node:fs/promises");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const WebSocket = require("ws");
const { desktopError } = require("@areal/workbench/desktop-contract");
const { readRecoveryService, readResourceInspections } = require("@areal/workbench-service/desktop/core/resource-observation.cjs");
const { record } = require("@areal/workbench-service/desktop/core/service-transport-contract.cjs");
/** @typedef {InstanceType<typeof import('./service-connection.cjs').ServiceConnection>} Connection */
/** @typedef {{connection:Connection,home:string}} ConnectedHome */
/** @typedef {ConnectedHome & {metadata:{pid:number,identity:string}}} SourceHome */
/** @typedef {{id:string,status:string,workers?:Array<{settled:boolean}>}} LegacyRun */
/** @typedef {{threadId:string|null,mode:string,paused:boolean,cancelled:boolean,revision:number,schedule:unknown,nextRunAt?:unknown,runs:LegacyRun[]}} LegacyTask */
/** @typedef {{projectId:string,root:string,taskId:string,revision:number,fingerprint:ReturnType<typeof fingerprint>,phase:'cancelPending'|'pausePending'|'paused'|'resumePending'}} ScheduleEntry */
/** @typedef {{version:1,home:string,source:{pid:number,identity:string},entries:ScheduleEntry[]}} ScheduleJournal */
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} state @param {string[]} endpoints */
async function coreEndpoint(state, endpoints) {
  const launchHome = join(state, "launcher-state");
  const entries = await readdir(launchHome, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".run-")) continue;
    try {
      const endpoint = (await readFile(join(launchHome, entry.name, "ready"), "utf8")).trim();
      // 仅连接旧后台仍持有的本机 Core，避免误用遗留的 launcher 文件。
      if (/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint) && endpoints.includes(endpoint))
        return endpoint;
    } catch (error) {
      if (desktopError(error).code !== "ENOENT") throw error;
    }
  }
  throw new Error("找不到旧 Core 的管理连接");
}

/** @param {string} home @param {string} projectId @param {string[]} endpoints */
async function coreDrainCancel(home, projectId, endpoints) {
  if (!/^[a-f0-9]{24}$/.test(projectId)) throw new Error("旧后台项目标识无效");
  const state = join(home, projectId, "state");
  const endpoint = await coreEndpoint(state, endpoints);
  /** @type {unknown} */
  const auth = JSON.parse(await readFile(join(state, "security", "auth.json"), "utf8"));
  const token =
    record(auth) && Array.isArray(auth.principals)
      ? auth.principals.find(
          (principal) =>
            record(principal) &&
            Array.isArray(principal.permissions) &&
            principal.permissions.includes("manage"),
        )?.token
      : undefined;
  if (typeof token !== "string" || !token) throw new Error("旧 Core 未提供管理凭据");
  const { CoreClient } = await import("@areal/runtime-client/core");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        maxPayload: 4 * 1024 * 1024,
      }),
  });
  try {
    await client.connect();
    await client.request(
      "areal/server/drain",
      { strategy: "cancel", timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
  } finally {
    client.close();
  }
}

// 仅用于缺少 cancelStop 能力的旧后台；凭据留在可信 Main，不传给 Renderer。
/** @param {ConnectedHome} options */
async function cancelLegacyService({ connection, home }) {
  const { service } = await legacySnapshot(connection);
  if (service.clients > 1) throw new Error("请先退出其他连接此后台服务的 GUI");
  if (service.activeCommands || service.providerUpdating || service.starting)
    throw new Error("请等待后台操作完成后重试");
  const projects = readResourceInspections(
    await connection.request("resources", { operation: "inspect" }),
  );
  if (!projects.length) throw new Error("旧后台没有可取消的 Core 项目");
  for (const project of projects)
    await coreDrainCancel(home, project.projectId, service.browserControlEndpoints);
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const { service: current } = await legacySnapshot(connection);
    if (current.clients > 1) throw new Error("请先退出其他连接此后台服务的 GUI");
    if (
      !current.busy &&
      current.activeCommands === 0 &&
      !current.providerUpdating &&
      current.starting === 0
    )
      return;
    await sleep(200);
  }
  throw new Error("取消已发送，但旧后台尚未完成收尾");
}

/** @param {unknown} cause @param {Record<string,unknown>} service */
function legacyBusy(cause, service) {
  const error = desktopError(cause);
  if (
    service.cancelStop ||
    service.lifecycleVersion !== undefined ||
    error.submissionUnknown ||
    error.code === "DISCONNECTED"
  )
    return false;
  if (error.code === "CORE_BUSY" || error.message.startsWith("后台仍有任务")) return true;
  const prefix = "Core 服务请求失败：";
  if (!error.message.startsWith(prefix)) return false;
  try {
    /** @type {unknown} */
    const value = JSON.parse(error.message.slice(prefix.length));
    const failure = record(value) && record(value.error) ? value.error : undefined;
    return (
      failure?.code === "localServiceError" &&
      failure.message === "service is busy; wait for work to settle or stop with --cancel"
    );
  } catch {
    return false;
  }
}
/** @param {string} home */
const journalPath = (home) => join(home, "legacy-schedule-recovery.json");
/** @param {LegacyRun} run */
const liveRun = (run) =>
  ["queued", "running", "waitingForInput", "waitingForAgents"].includes(run.status) ||
  run.workers?.some((worker) => !worker.settled);
/** @param {LegacyTask} task */
const fingerprint = (task) => ({
  threadId: task.threadId,
  schedule: task.schedule,
  nextRunAt: task.nextRunAt ?? null,
  runIds: task.runs.map((run) => run.id),
});
/** @param {string} home @returns {Promise<ScheduleJournal|null>} */
async function readJournal(home) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(await readFile(journalPath(home), "utf8"));
    if (!scheduleJournal(value) || value.home !== (await realpath(home)))
      throw new Error("旧版安排恢复记录无效，请保留文件并人工核对");
    return value;
  } catch (error) {
    if (desktopError(error).code === "ENOENT") return null;
    throw error;
  }
}
/** @param {string} home @param {ScheduleJournal} journal */
async function saveJournal(home, journal) {
  if (!journal.entries.length) {
    await rm(journalPath(home), { force: true });
    return;
  }
  const temporary = `${journalPath(home)}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
  await rename(temporary, journalPath(home));
}
/** @param {Connection} connection */
async function legacyGuard(connection) {
  const { service } = await legacySnapshot(connection);
  if (service.clients > 1 || service.activeCommands || service.providerUpdating || service.starting)
    throw new Error("请先退出其他 GUI，并等待后台操作完成");
  return service;
}
/** @param {SourceHome} options */
async function captureLegacySchedules({ connection, home, metadata }) {
  if (
    !Number.isSafeInteger(metadata?.pid) ||
    metadata.pid <= 1 ||
    typeof metadata.identity !== "string"
  )
    throw new Error("旧后台进程身份不完整，不能取消后自动恢复安排");
  await legacyGuard(connection);
  /** @type {ScheduleJournal} */
  const journal = (await readJournal(home)) ?? {
    version: 1,
    home: await realpath(home),
    source: { pid: metadata.pid, identity: metadata.identity },
    entries: [],
  };
  if (journal.source.pid !== metadata.pid || journal.source.identity !== metadata.identity)
    throw new Error("存在另一后台的安排恢复记录，请先核对");
  const projects = readResourceInspections(
    await connection.request("resources", { operation: "inspect", includeTasks: true }),
  );
  for (const project of projects)
    for (const summary of project.tasks ?? []) {
      if (summary.mode !== "scheduled" || summary.paused) continue;
      const request = { projectId: project.projectId, taskId: summary.id };
      const task = readLegacyTask(
        await connection.request("command", {
          name: "manage",
          request: { ...request, operation: "task" },
        }),
      );
      if (task.mode !== "scheduled" || task.cancelled || task.paused) continue;
      if (
        typeof project.root !== "string" ||
        typeof task.threadId !== "string" ||
        !task.schedule ||
        !Number.isSafeInteger(task.revision)
      )
        throw new Error("旧安排身份不完整，不能取消后自动恢复");
      if (
        !journal.entries.some(
          (e) => e.projectId === request.projectId && e.taskId === request.taskId,
        )
      )
        journal.entries.push({
          ...request,
          root: project.root,
          revision: task.revision,
          fingerprint: fingerprint(task),
          phase: "cancelPending",
        });
    }
  await saveJournal(home, journal);
}
/** @param {ConnectedHome} options */
async function reconcileLegacySchedules({ connection, home }) {
  const journal = await readJournal(home);
  if (!journal) return;
  for (const entry of Array.from(journal.entries)) {
    if (entry.phase !== "cancelPending") continue;
    const deadline = Date.now() + 35000;
    let task;
    for (;;) {
      task = readLegacyTask(
        await connection.request("command", {
          name: "manage",
          request: {
            projectId: entry.projectId,
            taskId: entry.taskId,
            operation: "task",
          },
        }),
      );
      if (task.cancelled || !isDeepStrictEqual(fingerprint(task), entry.fingerprint))
        throw new Error("取消期间安排或运行身份已变化，恢复记录已保留，请手动核对");
      if (!task.runs.some(liveRun)) break;
      if (Date.now() >= deadline) throw new Error("旧 Run 尚未确认结算，恢复记录已保留");
      await sleep(100);
    }
    // 更早的 Core 在 drain 内就会暂停安排，必须同样保存原启用状态。
    if (task.paused) {
      entry.revision = task.revision;
      entry.phase = "paused";
    } else journal.entries = journal.entries.filter((e) => e !== entry);
    await saveJournal(home, journal);
  }
}
/** @param {SourceHome} options */
async function pauseLegacySchedules({ connection, home, metadata }) {
  if (
    !Number.isSafeInteger(metadata?.pid) ||
    metadata.pid <= 1 ||
    typeof metadata.identity !== "string"
  )
    throw new Error("旧后台进程身份不完整，不能临时暂停安排");
  const service = await legacyGuard(connection);
  if (service.lifecycleVersion !== undefined) throw new Error("当前后台无需旧版安排兼容处理");
  const projects = readResourceInspections(
    await connection.request("resources", { operation: "inspect", includeTasks: true }),
  );
  if (
    projects.some(
      (p) =>
        !p.resources ||
        p.resources.length ||
        p.activeTurns ||
        p.goalThreads?.length ||
        p.unresolvedTools ||
        p.compactions ||
        p.workgroups ||
        p.waitingMessages,
    )
  )
    throw new Error("旧 Core 仍有执行、排队输入或未确认资源；不会暂停安排来绕过结算保护");
  /** @type {ScheduleJournal} */
  const journal = (await readJournal(home)) ?? {
    version: 1,
    home: await realpath(home),
    source: { pid: metadata.pid, identity: metadata.identity },
    entries: [],
  };
  if (journal.source.pid !== metadata.pid || journal.source.identity !== metadata.identity)
    throw new Error("存在另一后台的安排恢复记录，请先核对");
  let count = 0;
  for (const project of projects)
    for (const summary of project.tasks ?? []) {
      if (summary.mode !== "scheduled" || summary.paused) continue;
      const request = { projectId: project.projectId, taskId: summary.id };
      const task = readLegacyTask(
        await connection.request("command", {
          name: "manage",
          request: { ...request, operation: "task" },
        }),
      );
      if (task.mode !== "scheduled" || task.cancelled || task.paused) continue;
      if (task.runs.some(liveRun)) throw new Error("定时 Run 尚未结算，不能当成未来安排暂停");
      if (
        !Number.isSafeInteger(task.revision) ||
        typeof task.threadId !== "string" ||
        !task.schedule ||
        typeof project.root !== "string"
      )
        throw new Error("旧安排身份或修订号不完整，不能自动恢复");
      if (
        journal.entries.some(
          (e) => e.projectId === request.projectId && e.taskId === request.taskId,
        )
      )
        throw new Error("原安排暂停结果待核对，不会自动重发");
      /** @type {ScheduleEntry} */
      const entry = {
        ...request,
        root: project.root,
        revision: task.revision + 1,
        fingerprint: fingerprint(task),
        phase: "pausePending",
      };
      journal.entries.push(entry);
      await saveJournal(home, journal);
      await legacyGuard(connection);
      const paused = readLegacyTask(
        await connection.request(
          "command",
          {
            name: "manage",
            request: { ...request, operation: "taskPause", expectedRevision: task.revision },
          },
          true,
        ),
      );
      if (
        !paused.paused ||
        paused.revision !== entry.revision ||
        !isDeepStrictEqual(fingerprint(paused), entry.fingerprint)
      )
        throw Object.assign(new Error("安排暂停结果待核对，恢复记录已保留"), {
          submissionUnknown: true,
        });
      entry.phase = "paused";
      await saveJournal(home, journal);
      count++;
    }
  if (!count) throw new Error("未找到可临时暂停的未来安排，请核对旧 Core 状态");
  return count;
}
/** @param {SourceHome} options */
async function restoreLegacySchedules({ connection, home, metadata }) {
  const journal = await readJournal(home);
  if (!journal) return { restored: 0, attention: [] };
  if (metadata.pid === journal.source.pid || metadata.identity === journal.source.identity)
    return { restored: 0, attention: ["旧后台尚未替换；临时暂停安排的恢复记录已保留。"] };
  await require("./service-client.cjs").waitForServiceProcessExit(home, journal.source);
  const { snapshot } = await legacySnapshot(connection);
  /** @type {string[]} */
  const attention = [];
  let restored = 0;
  for (const entry of Array.from(journal.entries)) {
    /** @param {string} message */
    const keep = (message) =>
      attention.push(`${entry.root} / ${entry.taskId}：${message}，恢复记录已保留。`);
    const project = snapshot.projects.find(
      (p) => p.id === entry.projectId && p.root === entry.root,
    );
    if (!project) {
      keep("工作区归属已变化，请手动核对");
      continue;
    }
    const request = { projectId: entry.projectId, taskId: entry.taskId };
    try {
      const task = readLegacyTask(
        await connection.request("command", {
          name: "manage",
          request: { ...request, operation: "task" },
        }),
      );
      if (
        task.mode !== "scheduled" ||
        task.cancelled ||
        !isDeepStrictEqual(fingerprint(task), entry.fingerprint)
      ) {
        keep("任务或安排已变化，请手动核对");
        continue;
      }
      if (
        (!task.paused && task.revision === entry.revision - 1 && entry.phase === "pausePending") ||
        (!task.paused && task.revision === entry.revision + 1 && entry.phase === "resumePending")
      ) {
        journal.entries = journal.entries.filter((e) => e !== entry);
        await saveJournal(home, journal);
        continue;
      }
      if (
        ["cancelPending", "resumePending"].includes(entry.phase) ||
        task.revision !== entry.revision ||
        !task.paused ||
        task.runs.some(liveRun)
      ) {
        keep("暂停/恢复结果或修订号待核对，不会自动重发");
        continue;
      }
      entry.phase = "resumePending";
      await saveJournal(home, journal);
      const result = readLegacyTask(
        await connection.request(
          "command",
          {
            name: "manage",
            request: { ...request, operation: "taskResume", expectedRevision: task.revision },
          },
          true,
        ),
      );
      if (
        result.paused ||
        result.revision !== entry.revision + 1 ||
        !isDeepStrictEqual(fingerprint(result), entry.fingerprint)
      ) {
        keep("恢复结果待核对");
        continue;
      }
      journal.entries = journal.entries.filter((e) => e !== entry);
      await saveJournal(home, journal);
      restored++;
    } catch (error) {
      keep(desktopError(error).message);
    }
  }
  return { restored, attention };
}
module.exports = {
  cancelLegacyService,
  legacyBusy,
  captureLegacySchedules,
  reconcileLegacySchedules,
  pauseLegacySchedules,
  restoreLegacySchedules,
};

/** @param {unknown} value @returns {value is LegacyRun} */
function legacyRun(value) {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    (value.workers === undefined ||
      (Array.isArray(value.workers) &&
        value.workers.every((worker) => record(worker) && typeof worker.settled === "boolean")))
  );
}
/** @param {unknown} value @returns {LegacyTask} */
function readLegacyTask(value) {
  if (
    !record(value) ||
    typeof value.mode !== "string" ||
    typeof value.paused !== "boolean" ||
    typeof value.cancelled !== "boolean" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.threadId !== null && typeof value.threadId !== "string") ||
    !Array.isArray(value.runs) ||
    !value.runs.every(legacyRun)
  )
    throw new Error("旧安排状态不完整，请保留恢复记录并核查");
  return {
    threadId: value.threadId,
    mode: value.mode,
    paused: value.paused,
    cancelled: value.cancelled,
    revision: value.revision,
    schedule: value.schedule,
    nextRunAt: value.nextRunAt,
    runs: value.runs,
  };
}
/** @param {unknown} value @returns {value is ScheduleEntry} */
function scheduleEntry(value) {
  return (
    record(value) &&
    typeof value.projectId === "string" &&
    typeof value.root === "string" &&
    typeof value.taskId === "string" &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    record(value.fingerprint) &&
    typeof value.fingerprint.threadId === "string" &&
    !!value.fingerprint.schedule &&
    Array.isArray(value.fingerprint.runIds) &&
    value.fingerprint.runIds.every((id) => typeof id === "string") &&
    ["cancelPending", "pausePending", "paused", "resumePending"].some(
      (phase) => phase === value.phase,
    )
  );
}
/** @param {unknown} value @returns {value is ScheduleJournal} */
function scheduleJournal(value) {
  return (
    record(value) &&
    value.version === 1 &&
    typeof value.home === "string" &&
    Array.isArray(value.entries) &&
    value.entries.every(scheduleEntry) &&
    record(value.source) &&
    typeof value.source.pid === "number" &&
    Number.isSafeInteger(value.source.pid) &&
    value.source.pid > 1 &&
    typeof value.source.identity === "string"
  );
}
/** @param {Connection} connection @returns {Promise<{service:import('@areal/workbench-service/desktop/core/resource-observation.cjs').RecoveryService & {browserControlEndpoints:string[]},snapshot:{projects:Array<{id:string,root:string}>}}>} */
async function legacySnapshot(connection) {
  const value = await connection.request("snapshot");
  if (!record(value)) throw new Error("旧后台快照无效");
  const service = readRecoveryService(value.service);
  const endpoints = service.browserControlEndpoints ?? [];
  if (
    !Array.isArray(endpoints) ||
    !endpoints.every((endpoint) => typeof endpoint === "string") ||
    !record(value.snapshot) ||
    !Array.isArray(value.snapshot.projects)
  )
    throw new Error("旧后台快照无效");
  const projects = value.snapshot.projects.map((project) => {
    if (!record(project) || typeof project.id !== "string" || typeof project.root !== "string")
      throw new Error("旧后台工作区登记无效");
    return { id: project.id, root: project.root };
  });
  return { service: { ...service, browserControlEndpoints: endpoints }, snapshot: { projects } };
}
