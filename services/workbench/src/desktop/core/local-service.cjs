// @ts-check
"use strict";

const { realpath } = require("node:fs/promises");
const { isAbsolute, join } = require("node:path");
const { desktopError } = require("@areal/workbench/desktop-contract");
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {import('@areal/runtime-client/core').CoreClient} CoreClient */
/** @typedef {{registration:{projectId:string},service?:ServiceDescriptor}} HostProjectStatus */
/** @typedef {{protocolVersion:1,state:'ready',serviceId:string,generation:string,configFingerprint:string,workspace:string,dataDir:string,endpoint:string,authFile:string,owner?:unknown,[key:string]:unknown}} ServiceDescriptor */
/** @typedef {SavedProject & {service?:ServiceReference|null,endpoint?:string|null,reconnectTimer?:NodeJS.Timeout|null,client?:CoreClient|null,model:{connection:(connected:boolean,error?:string|null)=>void},taskNotificationMonitor?:{stop:()=>void}}} ServiceProject */
/** @typedef {{binary:string,home:string,applicationOwner?:import('./application-owner.cjs').ApplicationOwner,hooks:{environment:()=>NodeJS.ProcessEnv},providers:{redact:(value:string)=>string},host?:InstanceType<typeof import('./gui-host-projects.cjs').GuiHostProjects>,hostRegistry?:string,hostCall?:((method:string,params?:unknown)=>Promise<unknown>),projects:Map<string,ServiceProject>,saved:SavedProject[]}} ServiceHost */
/** @typedef {Pick<ServiceHost,'binary'|'home'|'hooks'|'providers'> & Partial<Pick<ServiceHost,'applicationOwner'|'host'|'hostRegistry'|'hostCall'>>} ServiceReader */
/** @typedef {{serviceId:string,generation:string}} ServiceReference */
/** @typedef {ServiceReference & {projectId:string,requestId:string}} StopTarget */
/** @typedef {ServiceReference & {configFingerprint:string,dataDir:string}} RecoveryTarget */
/** @typedef {{service:ServiceReference & {configFingerprint:string,workspace:string,dataDir:string,owner:unknown,state?:unknown},recovery:{version:1,generation:string,eligible:boolean,reason:string},[key:string]:unknown}} RecoveryStatus */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @param {ServiceReader} backend */
function requireHost(backend) {
  if (!backend.host) throw Object.assign(new Error("原 Host 登记不可用，无法证明历史 Core 状态；不会启动或替换原实例。"), { code: "LIFECYCLE_INCOMPLETE", submissionUnknown: true });
  return backend.host;
}
/** @template T @param {ServiceReader} backend @param {(client:InstanceType<typeof import('@areal/client/node').HostClient>)=>Promise<T>} use */
async function withOriginalHost(backend, use) {
  if (backend.host) return use(backend.host.client);
  const registry = backend.hostRegistry ?? backend.hooks.environment().AREAL_HARNESS_SERVICE_HOME;
  if (!registry) throw Object.assign(new Error("原 Host 登记目录不可用"), { code: "LIFECYCLE_INCOMPLETE", submissionUnknown: true });
  const { HostClient } = require("@areal/client/node");
  const client = new HostClient();
  try { await client.connect(registry); return await use(client); }
  finally { client.close(); }
}
/** @param {ServiceReader} backend @param {string[]} args @returns {Promise<unknown>} */
async function request(backend, args) {
  const at = (/** @type {string} */ name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const instance = at("--instance"), generation = at("--expected-generation");
  return withOriginalHost(backend, async (client) => {
    if (args[0] === "operation") {
      const id=at("--request-id"); if (!id) throw new Error("缺少原停止请求标识");
      return client.operation(id);
    }
    const status = await client.status();
    const selected = status.projects.filter((/** @type {HostProjectStatus} */ row) => row.service?.serviceId === instance && (!generation || row.service?.generation === generation));
    if (selected.length !== 1) throw Object.assign(new Error("原 Core 代际无法核对"), { code: "CONFIRMATION_STALE", submissionUnknown: true });
    const row = selected[0];
    if (args[0] === "status") return row.service;
    if (args[0] === "stop") return client.stopProject(at("--request-id") || require("node:crypto").randomUUID(), row.registration.projectId, generation || row.service.generation, args.includes("--cancel") ? "cancel" : "ifIdle");
    throw new Error("此服务操作必须经 Host 受理");
  });
}
/** @param {ServiceReader} backend @param {string} operation @param {string[]} args @param {NodeJS.ProcessEnv} environment @param {{root:string,id?:string}} project @param {string} dataDir */
async function connectService(backend, operation, args, environment, project, dataDir) {
  if (operation !== "status" || !project.id) throw new Error("项目启动必须经 Host ensure");
  return requireHost(backend).observe(project.id);
}

/** @param {InstanceType<typeof import('./gui-host-projects.cjs').GuiHostProjects>} host @param {string} id @param {unknown} descriptor */
async function authenticateService(host, id, descriptor) {
  const binding = host.resolve(id);
  return readServiceConnection(descriptor, binding.workspace, binding.dataDir, {
    kind: "host",
    hostId: host.client.hostId,
    generation: host.client.generation,
  });
}

/** @param {unknown} descriptor @param {string} workspace @param {string} dataDir @param {unknown} owner */
async function readServiceConnection(descriptor, workspace, dataDir, owner) {
  let endpoint;
  try {
    endpoint = new URL(
      record(descriptor) && typeof descriptor.endpoint === "string" ? descriptor.endpoint : "",
    );
  } catch {
    throw Object.assign(new Error("Core 返回了无效的服务地址"), { code: "CORE_INCOMPATIBLE" });
  }
  if (
    !serviceDescriptor(descriptor) ||
    descriptor.workspace !== (await realpath(workspace)) ||
    descriptor.dataDir !== (await realpath(dataDir)) ||
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    !isAbsolute(descriptor.authFile)
  ) {
    throw Object.assign(new Error("Core 服务描述与当前工作区不匹配"), {
      code: "CORE_INCOMPATIBLE",
    });
  }
  if (owner && !require("node:util").isDeepStrictEqual(descriptor.owner, owner))
    throw Object.assign(new Error("Core 服务所有者与当前连接不匹配"), {
      code: "CORE_OWNER_MISMATCH",
    });
  return { descriptor, token: "" };
}

/** @param {ServiceReference} target */
const targetArguments = (target) => [
  "--instance",
  target.serviceId,
  "--expected-generation",
  target.generation,
];

/** @param {ServiceReader} backend @param {ServiceReference} target */
async function lifecycleCapabilities(backend, target) {
  if (backend.host) {
    backend.host.client.requireCapability("stopOperations");
    return { version: 1, stopOperations: 1 };
  }
  return withOriginalHost(backend, async (client) => { client.requireCapability("stopOperations"); return { version: 1, stopOperations: 1 }; });
}

/** @param {ServiceReader} backend @param {StopTarget} target @param {boolean} cancel @param {boolean} [suppressScheduling] */
async function requestStop(backend, target, cancel, suppressScheduling = true) {
  if (backend.host)
    return hostStopOperation(
      await backend.host.stop(
        target.requestId,
        target.projectId,
        target.generation,
        cancel ? "cancel" : "ifIdle",
        suppressScheduling,
      ),
      target,
      backend.host.resolve(target.projectId).projectId,
    );
  const result = await request(backend, ["stop", "--instance",target.serviceId,"--expected-generation",target.generation,"--request-id",target.requestId,...(cancel?["--cancel"]:[])]);
  return hostStopOperation(result,target);
}

/** @param {ServiceReader} backend @param {StopTarget} target */
async function readStop(backend, target) {
  if (backend.host)
    return hostStopOperation(
      await backend.host.operation(target.requestId),
      target,
      backend.host.resolve(target.projectId).projectId,
    );
  return withOriginalHost(backend, async (client) => hostStopOperation((await client.operation(target.requestId)).operation, target));
}

/** @param {ServiceHost} backend @param {ServiceReference & {projectId:string}} target */
function detachStoppedProject(backend, target) {
  const project = backend.projects.get(target.projectId);
  if (
    project?.service?.serviceId !== target.serviceId ||
    project.service.generation !== target.generation
  )
    return;
  project.service = null;
  project.endpoint = null;
  clearTimeout(project.reconnectTimer ?? undefined);
  project.reconnectTimer = null;
  project.taskNotificationMonitor?.stop();
  project.client?.close();
  project.client = null;
  project.model.connection(false);
}

/** @param {CoreClient} client @param {string} threadId @param {string} turnId @param {{observe?:()=>Promise<unknown>,assertCurrent?:()=>void}} [options] */
async function readTurnMetadata(
  client,
  threadId,
  turnId,
  { observe, assertCurrent = () => {} } = {},
) {
  const invalid = () =>
    Object.assign(new Error("原轮次历史元数据不完整或身份不匹配"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
  const features = client.capabilities?.features;
  const bounded =
    record(features) && features.boundedObservation === true && features.boundedHistory === true;
  assertCurrent();
  let result;
  if (!bounded) result = await client.request("thread/read", { threadId, includeTurns: true });
  else if (observe) result = await observe();
  else {
    for (const maxBytes of [262144, 1048576]) {
      try {
        result = await client.request(
          "areal/thread/observe",
          { threadId, mode: "bounded", maxBytes },
          { maxResponseBytes: maxBytes },
        );
        break;
      } catch (error) {
        assertCurrent();
        if (maxBytes === 1048576 || desktopError(error).reason !== "HISTORY_BUDGET_TOO_SMALL")
          throw error;
      }
    }
  }
  assertCurrent();
  if (
    !record(result) ||
    !record(result.thread) ||
    result.thread.id !== threadId ||
    !Array.isArray(result.thread.turns)
  )
    throw invalid();
  const found = result.thread.turns.find(
    /** @param {unknown} turn */ (turn) => record(turn) && turn.id === turnId,
  );
  if (record(found)) {
    return { id: turnId, status: found.status };
  }
  if (!bounded) return null;
  const history = result.history;
  if (
    !record(history) ||
    typeof history.snapshotId !== "string" ||
    typeof history.complete !== "boolean"
  )
    throw invalid();
  let cursor = history.nextCursor;
  if (cursor != null && typeof cursor !== "string") throw invalid();
  while (!history.complete && cursor) {
    assertCurrent();
    const page = await client.request(
      "areal/conversation/history",
      { threadId, view: "own", cursor, maxBytes: 262144 },
      { maxResponseBytes: 262144 },
    );
    assertCurrent();
    if (
      !record(page) ||
      page.snapshotId !== history.snapshotId ||
      !Array.isArray(page.data) ||
      page.data.some(
        /** @param {unknown} entry */ (entry) =>
          !record(entry) || entry.sourceThreadId !== threadId,
      ) ||
      typeof page.complete !== "boolean"
    )
      throw invalid();
    const entry = page.data.find(
      /** @param {unknown} entry */ (entry) => record(entry) && entry.sourceTurnId === turnId,
    );
    if (record(entry)) {
      return { id: turnId, status: entry.sourceTurnStatus };
    }
    if (page.complete) return null;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor)
      throw invalid();
    cursor = page.nextCursor;
  }
  if (!history.complete) throw invalid();
  return null;
}

/** @param {ServiceReader & {saved:SavedProject[]}} backend @param {ServiceReference & {projectId:string,dataDir?:string}} target @param {string} threadId @param {string} turnId */
async function readOriginalTurn(backend, target, threadId, turnId) {
  const host = requireHost(backend);
  const { descriptor } = await host.observe(target.projectId);
  if (descriptor.serviceId !== target.serviceId || descriptor.generation !== target.generation)
    throw Object.assign(new Error("原 Core 代际已变化，不能用新实例代替核查"), { code: "CONFIRMATION_STALE" });
  const call = backend.hostCall;
  if (!call) throw Object.assign(new Error("原 Host 核查通道不可用"), { code: "LIFECYCLE_INCOMPLETE", submissionUnknown: true });
  const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
  const client = new HostCoreClient({ host: call, sourceId: host.sourceId, projectId: host.resolve(target.projectId).projectId, scope: "observer" });
  try {
    await client.connect();
    const identity = client.identity();
    if (identity?.coreInstanceId !== target.serviceId || identity?.coreGeneration !== target.generation)
      throw Object.assign(new Error("原 Core 代际已变化"), { code: "CONFIRMATION_STALE" });
    return await readTurnMetadata(client, threadId, turnId);
  } finally { client.close(); }
}

/** @param {ServiceReader} backend @param {ServiceReference & {projectId:string,root:string}} target @returns {Promise<{descriptor:Record<string,unknown>,cleanupConfirmed:boolean,status?:unknown}>} */
async function inspectOriginalService(backend, target) {
  const host = requireHost(backend);
  const state = await host.status(target.projectId);
  const descriptor = state.service;
  if (!record(descriptor) || descriptor.serviceId !== target.serviceId || descriptor.generation !== target.generation || descriptor.workspace !== await realpath(target.root))
    throw Object.assign(new Error("原 Core 身份或代际无法核对"), { code: "CONFIRMATION_STALE", submissionUnknown: true });
  // 普通状态不等于清理证明；历史缺回执继续 UNKNOWN，不根据进程消失放行。
  return { descriptor, cleanupConfirmed: false };
}

/** @param {unknown} value @returns {value is ServiceDescriptor} */
function serviceDescriptor(value) {
  return (
    record(value) &&
    value.protocolVersion === 1 &&
    value.state === "ready" &&
    typeof value.serviceId === "string" &&
    /^[a-f0-9]{24}$/.test(value.serviceId) &&
    typeof value.generation === "string" &&
    typeof value.configFingerprint === "string" &&
    typeof value.workspace === "string" &&
    typeof value.dataDir === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.authFile === "string"
  );
}
module.exports = {
  authenticateService,
  connectService,
  lifecycleCapabilities,
  requestStop,
  readStop,
  detachStoppedProject,
  readOriginalTurn,
  readTurnMetadata,
  inspectOriginalService,
  serviceRequest: request,
};

/** @param {unknown} value @param {StopTarget} target @param {string} [projectId] */
function hostStopOperation(value, target, projectId) {
  if (value === null) return null;
  if (
    !record(value) ||
    value.version !== 1 ||
    value.requestId !== target.requestId ||
    value.serviceId !== target.serviceId ||
    value.serviceGeneration !== target.generation ||
    (projectId !== undefined && value.projectId !== projectId) ||
    !["ifIdle", "cancel"].includes(String(value.strategy))
  )
    throw Object.assign(new Error("Host stop receipt identity mismatch"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
  return { ...value, generation: value.serviceGeneration, cancel: value.strategy === "cancel" };
}
